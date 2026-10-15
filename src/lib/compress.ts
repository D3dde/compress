import { engine, WORK_DIR } from './engine'
import { probe, tail, type MediaInfo } from './probe'
import {
  buildEncodeArgs,
  type CrfSample,
  CODECS,
  maxPasses,
  nextCrf,
  planCompression,
  type Settings,
} from './encode'
import { formatBytes } from './format'

export type Phase = 'probing' | 'planning' | 'encoding' | 'finalizing' | 'done'

export interface CompressProgress {
  phase: Phase
  /** 0..1 across the whole job, all passes included. */
  ratio: number
  pass: number
  totalPasses: number
  message: string
  crf: number | null
  /** Size of the most recently finished attempt, for live size-vs-target feedback. */
  attemptBytes: number | null
}

export interface CompressResult {
  blob: Blob
  fileName: string
  bytes: number
  targetBytes: number
  sourceBytes: number
  /** Null when the final attempt was rate-controlled rather than CRF-driven. */
  crf: number | null
  rateControlled: boolean
  videoBitrate: number
  audioBitrate: number
  attempts: number
  hitTarget: boolean
  durationSec: number
  width: number
  height: number
  fps: number
  info: MediaInfo
  notes: string[]
}

export interface CompressJob {
  file: File
  settings: Settings
  signal?: AbortSignal
  onProgress?: (progress: CompressProgress) => void
}

interface Attempt {
  bytes: Uint8Array
  size: number
  crf: number
  /** True when the bitrate ceiling, not CRF, decided the size. */
  rateControlled: boolean
}

const OUTPUT_PATH = `${WORK_DIR}/output`
/** Stop the CRF search once an attempt lands this close to (or under) the target. */
const AIM_TOLERANCE = 0.98
/** Two attempts within this relative size difference count as a quality floor. */
const CONVERGED_DELTA = 0.04
/** Rate-controlled attempts allowed after the CRF search gives up. */
const CORRECTIVE_PASSES = 3
/** Scales each corrective ceiling down slightly to stay under the target. */
const CORRECTIVE_MARGIN = 0.97
const MIN_VIDEO_BITRATE = 30_000

/**
 * Encodes `file` until it fits `settings.targetBytes`.
 *
 * Quality-driven encoding comes first: CRF picks the detail per frame while the
 * file size is steered by nudging CRF, and each attempt is measured so the next
 * step can be a secant through the points already seen rather than a guess.
 * Footage that is too hard for the requested size bottoms out before it fits;
 * those cases switch to rate control, where the bitrate ceiling is what decides
 * the size and is recalibrated the same way until the file fits.
 */
export async function compressVideo({
  file,
  settings,
  signal,
  onProgress,
}: CompressJob): Promise<CompressResult> {
  const threads = engine.state.threads || 1
  const limit = maxPasses(settings.qualityMode)
  // Worst case for the progress bar: every CRF attempt plus every size attempt.
  const slots = limit + CORRECTIVE_PASSES

  // Progress bookkeeping: ffmpeg reports 0..1 for the command that is running
  // right now, so the overall bar is "finished passes + this pass" over the
  // worst-case number of passes.
  let passIndex = 0
  let passRatio = 0
  let activeMessage = 'Encoding…'
  const state: CompressProgress = {
    phase: 'probing',
    ratio: 0,
    pass: 0,
    totalPasses: slots,
    message: 'Reading video metadata…',
    crf: null,
    attemptBytes: null,
  }

  const emit = (patch: Partial<CompressProgress> = {}) => {
    Object.assign(state, patch)
    state.ratio =
      patch.ratio ??
      (state.phase === 'probing'
        ? 0
        : state.phase === 'planning'
          ? 0.01
          : state.phase === 'done'
            ? 1
            : Math.min(
                0.99,
                Math.min(Math.max(passIndex - 1, 0), slots - 1) / slots + passRatio * (1 / slots) * 0.95,
              ))
    onProgress?.({ ...state })
  }

  // Tell the UI the job has started before the first await.
  emit()

  // ffmpeg's own output is the only clue when something fails deep in a worker.
  const log: string[] = []

  return engine.withJob(
    file,
    {
      onLog: (line) => {
        log.push(line)
        if (log.length > 40) log.shift()
      },
      onProgress: (ratio) => {
        if (!Number.isFinite(ratio)) return
        passRatio = Math.min(1, Math.max(0, ratio))
        emit({ message: activeMessage })
      },
    },
    async (ffmpeg, inputPath) => {
      const info = await probe(ffmpeg, inputPath)
      signal?.throwIfAborted()

      emit({
        phase: 'planning',
        ratio: 0.01,
        message: 'Working out the bitrate budget…',
        crf: null,
      })

      const plan = planCompression({ info, settings })
      if (plan.infeasible) throw new Error(plan.infeasible)

      const profile = CODECS[settings.videoCodec]
      const encodeOnce = async (
        label: string,
        options: { crf?: number; bitrateCap?: number },
      ): Promise<Attempt> => {
        const outputPath = `${OUTPUT_PATH}${plan.extension}`
        await ffmpeg.deleteFile(outputPath).catch(() => {})
        const args = buildEncodeArgs(plan, settings, inputPath, outputPath, { ...options, threads })
        let code: number
        try {
          code = await ffmpeg.exec(args, -1, signal ? { signal } : undefined)
        } catch (error) {
          // ffmpeg.wasm turns a wasm abort into an unrelated TypeError, so the
          // captured log is the only useful thing to report here.
          throw new Error(
            `ffmpeg crashed during ${label}. ${log.length > 0 ? tail(log) : String(error).slice(0, 120)}`,
          )
        }
        if (code !== 0) throw new Error(`ffmpeg failed (exit ${code}) during ${label}. ${tail(log)}`)
        const data = await ffmpeg.readFile(outputPath)
        if (typeof data === 'string') throw new Error('Unexpected non-binary output from ffmpeg.')
        return {
          bytes: data,
          size: data.byteLength,
          crf: options.crf ?? plan.crf,
          rateControlled: options.bitrateCap !== undefined,
        }
      }

      let crf = plan.crf
      // The largest attempt that fits is the best quality available under the
      // target; the smallest miss is kept as a fallback so a near miss is never
      // thrown away.
      const keepers: { under: Attempt | null; over: Attempt | null } = { under: null, over: null }
      let previousSize: number | null = null
      const tried = new Set<number>([quantize(crf)])
      const history: CrfSample[] = []

      const record = (attempt: Attempt): boolean => {
        if (attempt.size <= plan.targetBytes) {
          if (!keepers.under || attempt.size > keepers.under.size) keepers.under = attempt
          return true
        }
        if (!keepers.over || attempt.size < keepers.over.size) keepers.over = attempt
        return false
      }

      for (let pass = 1; pass <= limit; pass += 1) {
        signal?.throwIfAborted()
        passIndex = pass
        passRatio = 0
        activeMessage = `Encoding pass ${pass} of ${limit} · CRF ${crf.toFixed(1)}`
        emit({ phase: 'encoding', pass, crf, message: activeMessage })

        const attempt = await encodeOnce(`pass ${pass}`, { crf })
        history.push({ size: attempt.size, crf })
        passRatio = 1

        if (record(attempt)) {
          if (attempt.size >= plan.targetBytes * AIM_TOLERANCE) break
        } else if (
          previousSize !== null &&
          Math.abs(attempt.size - previousSize) / previousSize < CONVERGED_DELTA
        ) {
          // Two attempts in a row barely moving the size means the encoder has
          // hit its quality floor for this resolution; more CRF will not help,
          // so hand over to rate control instead of burning passes.
          break
        }

        previousSize = attempt.size
        const next = nextCrf(profile, crf, attempt.size, plan.targetBytes, history)
        if (tried.has(quantize(next))) break
        tried.add(quantize(next))
        crf = next
      }

      // Still over target, so the encoder hit its quality floor here. Switch to
      // rate control: give the whole budget to the VBV ceiling and recalibrate
      // that ceiling against the size it actually produced. A rate-controlled
      // file is lower quality than a CRF one, which is why this only runs once
      // the quality search has failed.
      let correctiveAttempt = 0
      let lastCap: number | null = null
      let lastSize: number | null = null
      while (!keepers.under && correctiveAttempt < CORRECTIVE_PASSES) {
        signal?.throwIfAborted()
        passIndex = limit + correctiveAttempt
        passRatio = 0
        correctiveAttempt += 1

        // Size follows the ceiling almost linearly, so scaling the last ceiling by
        // the last miss lands on the target. The margin keeps the next attempt on
        // the safe side instead of oscillating around it.
        const bitrateCap = clampCap(
          lastCap === null || lastSize === null
            ? plan.videoBitrate
            : lastCap * ((plan.targetBytes / lastSize) * CORRECTIVE_MARGIN),
          plan.videoBitrate,
        )
        activeMessage = `Size pass ${correctiveAttempt} of ${CORRECTIVE_PASSES}…`
        emit({ phase: 'finalizing', pass: passIndex + 1, crf: null, message: activeMessage })

        const attempt = await encodeOnce('a size pass', { bitrateCap })
        history.push({ size: attempt.size, crf: profile.maxCrf })
        const fits = record(attempt)
        if (fits) break

        // The ceiling moved but the file did not: the encoder, not the budget, is
        // the limit, so another attempt would buy nothing.
        if (lastSize !== null && Math.abs(attempt.size - lastSize) / lastSize < CONVERGED_DELTA) break
        lastCap = bitrateCap
        lastSize = attempt.size
      }

      const best = keepers.under ?? keepers.over
      if (!best) throw new Error('Encoding produced no output.')

      const hitTarget = keepers.under !== null
      emit({
        phase: 'done',
        ratio: 1,
        pass: history.length,
        crf: best.crf,
        attemptBytes: best.size,
        message: hitTarget ? 'Finished' : 'Finished (over target)',
      })

      const achievedVideoBitrate = Math.max(
        0,
        Math.round((best.size * 8 * 0.996) / plan.durationSec - plan.audioBitrate),
      )

      return {
        blob: new Blob([toBlobPart(best.bytes)], {
          type: plan.container === 'mp4' ? 'video/mp4' : 'video/webm',
        }),
        fileName: outputFileName(file.name, plan.extension),
        bytes: best.size,
        targetBytes: plan.targetBytes,
        sourceBytes: file.size,
        crf: best.rateControlled ? null : best.crf,
        rateControlled: best.rateControlled,
        videoBitrate: achievedVideoBitrate,
        audioBitrate: plan.audioBitrate,
        attempts: history.length,
        hitTarget,
        durationSec: plan.durationSec,
        width: plan.outputWidth,
        height: plan.outputHeight,
        fps: plan.outputFps,
        info,
        notes: [
          ...plan.notes,
          ...(best.size < plan.targetBytes * 0.75
            ? [
                'This clip is already so compressed that maximum quality still lands well under ' +
                  'your target — there was nothing left to squeeze.',
              ]
            : []),
          ...(hitTarget
            ? []
            : [
                `This footage cannot be squeezed to ${formatBytes(plan.targetBytes)} at ` +
                  `${plan.outputWidth}×${plan.outputHeight} — the best attempt still came out ` +
                  `${formatBytes(best.size - plan.targetBytes)} over. Cap the resolution lower, ` +
                  `remove the audio, or accept a larger target.`,
              ]),
        ],
      }
    },
  )
}

function clampCap(value: number, videoBitrate: number): number {
  return Math.round(Math.max(MIN_VIDEO_BITRATE, Math.min(value, videoBitrate * 1.5)))
}

function quantize(crf: number): number {
  return Math.round(crf * 10)
}

/**
 * Blob parts must sit on a plain ArrayBuffer. readFile hands back a transferred
 * one, so the copy below is only a safety net for unexpected backing stores.
 */
function toBlobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) return bytes as Uint8Array<ArrayBuffer>
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

export function outputFileName(sourceName: string, extension: string): string {
  const base = sourceName.replace(/\.[^./\\]+$/, '').slice(0, 80).trim() || 'video'
  return `${base}-compressed${extension}`
}