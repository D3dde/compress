import type { MediaInfo } from './probe'

export type VideoCodec = 'h264' | 'h265' | 'vp9'
export type AudioCodec = 'aac' | 'opus' | 'mp3'
export type AudioMode = 'encode' | 'strip'
export type SpeedPreset = 'fast' | 'balanced' | 'quality'
export type QualityMode = 'fast' | 'balanced' | 'best'
/** 0 keeps the source value. */
export type MaxHeight = 0 | 2160 | 1440 | 1080 | 720 | 480 | 360
export type MaxFps = 0 | 60 | 30 | 24 | 15

export interface Settings {
  targetBytes: number
  videoCodec: VideoCodec
  audioMode: AudioMode
  audioCodec: AudioCodec
  /** Audio bitrate in bits/s; ignored when audioMode is "strip". */
  audioBitrate: number
  speed: SpeedPreset
  qualityMode: QualityMode
  maxHeight: MaxHeight
  maxFps: MaxFps
  /** Drop resolution automatically when the target is too small to hold it. */
  autoDownscale: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  targetBytes: 0,
  videoCodec: 'h264',
  audioMode: 'encode',
  audioCodec: 'aac',
  audioBitrate: 128_000,
  speed: 'balanced',
  qualityMode: 'balanced',
  maxHeight: 0,
  maxFps: 0,
  autoDownscale: false,
}

interface CodecProfile {
  encoder: string
  /** CRF value that yields roughly the same visual quality as x264 CRF 23. */
  referenceCrf: number
  minCrf: number
  maxCrf: number
  /** CRF points to add when the bitrate budget is halved. */
  crfPerHalving: number
  /** Bits per pixel per frame that referenceCrf produces on ordinary footage. */
  referenceBpp: number
  presets: Record<SpeedPreset, string>
}

export const CODECS: Record<VideoCodec, CodecProfile> = {
  h264: {
    encoder: 'libx264',
    referenceCrf: 23,
    minCrf: 12,
    maxCrf: 45,
    crfPerHalving: 6,
    referenceBpp: 0.055,
    presets: { fast: 'ultrafast', balanced: 'veryfast', quality: 'medium' },
  },
  h265: {
    encoder: 'libx265',
    referenceCrf: 28,
    minCrf: 14,
    maxCrf: 42,
    crfPerHalving: 5,
    referenceBpp: 0.055,
    presets: { fast: 'ultrafast', balanced: 'veryfast', quality: 'medium' },
  },
  vp9: {
    encoder: 'libvpx-vp9',
    referenceCrf: 32,
    minCrf: 15,
    maxCrf: 60,
    crfPerHalving: 9,
    referenceBpp: 0.075,
    presets: { fast: '4', balanced: '2', quality: '0' },
  },
}

const SPEED_THREAD_HINT: Record<SpeedPreset, string> = {
  fast: 'threads=0:sliced-threads=0',
  balanced: 'threads=0:sliced-threads=1',
  quality: 'threads=0:sliced-threads=1',
}

/** Max CRF search iterations; each one is a full encode. */
const PASSES: Record<QualityMode, number> = { fast: 2, balanced: 3, best: 4 }

const CONTAINER_OVERHEAD_BPS = 4000
const MIN_AUDIO_BITRATE = 16_000
/** Audio never takes more than this share of the budget unless it must. */
const AUDIO_SHARE = 0.15
/** How far above the average bitrate a single moment may spike. */
const VBV_HEADROOM = 3
/** Rate-driven ceiling and buffer sizes, as multiples of the bitrate cap. */
const VBV_CEILING = 1.1
const VBV_BUFFER = 0.55
const MAX_AUDIO_BITRATE = 256_000
/**
 * Bits per pixel per frame. Around 0.10 is comfortably watchable, 0.03 is
 * rough but still usable, and much below that every encoder turns to mush — so
 * auto-downscale aims for 0.03 and we refuse anything under 0.008.
 */
const BITS_PER_PIXEL_FLOOR = 0.03
const BITS_PER_PIXEL_TERRIBLE = 0.012
/** Below this the picture is not worth encoding at any resolution. */
const MIN_VIDEO_BITRATE = 25_000

export interface Plan {
  durationSec: number
  targetBytes: number
  videoBitrate: number
  audioBitrate: number
  /** Effective audio codec: WebM output can only carry Opus. */
  audioCodec: AudioCodec
  crf: number
  maxrate: number
  bufsize: number
  outputWidth: number
  outputHeight: number
  outputFps: number
  container: 'mp4' | 'webm'
  extension: string
  gop: number
  filter: string | null
  hasAudio: boolean
  notes: string[]
  /** Set when even the lowest sensible quality cannot fit the target. */
  infeasible?: string
}

export interface PlanInput {
  info: MediaInfo
  settings: Settings
}

export function maxPasses(qualityMode: QualityMode): number {
  return PASSES[qualityMode]
}

/** Chooses the audio bitrate: never above the source, never a large share of the budget. */
export function chooseAudioBitrate(info: MediaInfo, settings: Settings, budgetBps: number): number {
  if (settings.audioMode === 'strip' || !info.audio) return 0
  // MP3 falls apart below ~64 kbps; AAC and Opus stay usable far lower, which
  // matters when the whole budget is only a few hundred kbps.
  const floor = settings.audioCodec === 'mp3' ? 64_000 : MIN_AUDIO_BITRATE
  const source = info.audio.bitrate ?? 128_000
  const channels = Math.max(1, info.audio.channels)
  const byChannels = channels >= 6 ? 1.6 : channels >= 2 ? 1 : 0.7
  return Math.max(
    floor,
    Math.min(
      settings.audioBitrate * byChannels,
      Math.max(floor, budgetBps * AUDIO_SHARE),
      // No point re-encoding to a higher rate than the track already has.
      Math.max(floor, source),
      MAX_AUDIO_BITRATE,
    ),
  )
}

export function planCompression({ info, settings }: PlanInput): Plan {
  const notes: string[] = []
  const duration = info.duration
  const targetBytes = settings.targetBytes
  const hasAudio = info.audio !== null && settings.audioMode === 'encode'

  // 0.4% headroom for the container, then a flat muxing overhead.
  const container: 'mp4' | 'webm' = settings.videoCodec === 'vp9' ? 'webm' : 'mp4'
  const audioCodec: AudioCodec =
    container === 'webm' && settings.audioMode === 'encode' ? 'opus' : settings.audioCodec
  const budgetBps = Math.max(0, (targetBytes * 8 * 0.996) / duration - CONTAINER_OVERHEAD_BPS)
  const audioBitrate = chooseAudioBitrate(info, { ...settings, audioCodec }, budgetBps)
  if (audioCodec !== settings.audioCodec) {
    notes.push('WebM output only carries Opus audio, so the audio track is encoded as Opus.')
  }

  const { width: srcWidth, height: srcHeight, fps: srcFps } = sourceGeometry(info)
  const pixelBudget =
    (budgetBps - audioBitrate) / Math.max(1, srcWidth * srcHeight * Math.max(1, srcFps))
  let { width, height, fps } = sourceGeometry(info)

  if (settings.autoDownscale && pixelBudget < BITS_PER_PIXEL_FLOOR && width * height > 0) {
    // Scale so the budget buys the same bits per pixel the floor asks for.
    const shortEdge = Math.round(
      Math.min(width, height) * Math.sqrt(pixelBudget / BITS_PER_PIXEL_FLOOR),
    )
    const scaled = fitShortEdge({ width, height }, shortEdge)
    if (scaled.width < width || scaled.height < height) {
      notes.push(
        `Resolution dropped to ${scaled.width}×${scaled.height} — the target is too small for ` +
          `${width}×${height} at this length.`,
      )
      width = scaled.width
      height = scaled.height
    }
  }
  if (settings.maxHeight > 0 && height > settings.maxHeight) {
    const scaled = fitHeight({ width, height }, settings.maxHeight)
    notes.push(`Resolution capped at ${scaled.width}×${scaled.height}.`)
    width = scaled.width
    height = scaled.height
  }
  if (settings.maxFps > 0 && fps > settings.maxFps) {
    notes.push(`Frame rate capped at ${settings.maxFps} fps (from ${round(fps)} fps).`)
    fps = settings.maxFps
  }

  const videoBitrate = Math.max(0, budgetBps - audioBitrate)
  const profile = CODECS[settings.videoCodec]
  const crf = startingCrf(profile, pixelBudget)

  if (videoBitrate < MIN_VIDEO_BITRATE) {
    return {
      durationSec: duration,
      targetBytes,
      videoBitrate,
      audioBitrate,
      audioCodec,
      crf: profile.maxCrf,
      maxrate: videoBitrate,
      bufsize: videoBitrate * 2,
      outputWidth: width,
      outputHeight: height,
      outputFps: fps,
      container,
      extension: container === 'mp4' ? '.mp4' : '.webm',
      gop: Math.round(fps * 2),
      filter: buildFilter({ width, height, fps, srcWidth, srcHeight, srcFps }),
      hasAudio,
      notes,
      infeasible:
        `A ${formatSeconds(duration)} video cannot be stored in ${formatBytes(targetBytes)} — ` +
        `that is ${round(videoBitrate / 1000)} kbps for the picture.`,
    }
  }

  if (pixelBudget < BITS_PER_PIXEL_TERRIBLE && !settings.autoDownscale) {
    notes.push(
      `That is only ${round((pixelBudget * 1000) / 100) / 10} bits per pixel per frame at ` +
        `${width}×${height}, which will look heavily smeared. Turn on auto resolution, or cap ` +
        `the resolution lower.`,
    )
  }

  if (settings.videoCodec === 'h265') {
    notes.push('H.265 gives smaller files at equal quality, but needs a modern player to view.')
  }
  if (settings.videoCodec === 'vp9') {
    notes.push('VP9 is slower to encode than H.264 and is kept at 8-bit.')
  }
  if (info.video?.pixFmt && /(10|12)le$/.test(info.video.pixFmt)) {
    notes.push('Source is high-bit-depth; output is 8-bit, so HDR gradations may band.')
  }

  return {
    durationSec: duration,
    targetBytes,
    videoBitrate,
    audioBitrate,
    audioCodec,
    crf,
    // The ceiling only trims pathological peaks; keeping it loose leaves CRF in
    // charge of the average bitrate so the search can actually steer.
    maxrate: Math.round(videoBitrate * VBV_HEADROOM),
    bufsize: Math.round(videoBitrate * VBV_HEADROOM * 2),
    outputWidth: width,
    outputHeight: height,
    outputFps: fps,
    container,
    extension: container === 'mp4' ? '.mp4' : '.webm',
    gop: Math.max(2, Math.round(fps * 2)),
    filter: buildFilter({ width, height, fps, srcWidth, srcHeight, srcFps }),
    hasAudio,
    notes,
  }
}

export interface EncodeOptions {
  /**
   * Forces rate-controlled mode at this average video bitrate. Used when the
   * quality-driven search cannot reach the target at this resolution.
   */
  bitrateCap?: number
  crf?: number
  threads: number
}

/** Builds the ffmpeg argument list for one encoding attempt. */
export function buildEncodeArgs(
  plan: Plan,
  settings: Settings,
  inputPath: string,
  outputPath: string,
  options: EncodeOptions,
): string[] {
  const profile = CODECS[settings.videoCodec]
  const args = ['-i', inputPath, '-map', '0:v:0', '-map_metadata', '-1']

  if (plan.hasAudio) args.push('-map', '0:a:0?')
  if (plan.filter) args.push('-vf', plan.filter)

  args.push('-c:v', profile.encoder, '-preset', profile.presets[settings.speed])

  const cap = options.bitrateCap
  const crf = cap ? profile.referenceCrf : (options.crf ?? plan.crf)
  // In rate-driven mode the encoder stays quality-greedy (reference CRF) and the
  // VBV ceiling decides the size, which keeps far more detail than letting a huge
  // CRF flatten the picture. Note that with a CRF set, ffmpeg's x264/x265
  // wrappers read -b:v as another ceiling rather than an average, so the ceiling
  // is passed through -maxrate instead; it lands ~10% below the number, which the
  // caller corrects on the next attempt.
  const maxrate = Math.round(cap ? cap * VBV_CEILING : plan.maxrate)
  const bufsize = Math.round(cap ? cap * VBV_BUFFER : maxrate * 2)

  if (settings.videoCodec === 'vp9') {
    args.push(
      '-row-mt',
      '1',
      '-tile-columns',
      settings.speed === 'fast' ? '6' : '2',
      '-auto-alt-ref',
      '1',
      '-deadline',
      settings.speed === 'fast' ? 'realtime' : settings.speed === 'balanced' ? 'good' : 'best',
    )
    if (cap) {
      args.push('-b:v', String(cap), '-maxrate', String(maxrate), '-bufsize', String(bufsize))
    } else {
      args.push('-b:v', '0', '-crf', String(Math.round(crf)))
    }
  } else {
    args.push('-crf', crf.toFixed(1), '-maxrate', String(maxrate), '-bufsize', String(bufsize))
  }

  if (settings.videoCodec === 'h264') {
    args.push(
      '-x264-params',
      `${SPEED_THREAD_HINT[settings.speed]}:keyint=${plan.gop}:min-keyint=${plan.gop}:scenecut=0`,
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'high',
    )
  } else if (settings.videoCodec === 'h265') {
    args.push(
      '-x265-params',
      `pools=${Math.max(1, options.threads)}:keyint=${plan.gop}:min-keyint=${plan.gop}:scenecut=0:log-level=error`,
      '-pix_fmt',
      'yuv420p',
      '-tag:v',
      'hvc1',
    )
  } else {
    args.push('-pix_fmt', 'yuv420p')
  }

  if (plan.hasAudio) {
    args.push('-c:a', plan.audioCodec, '-b:a', String(Math.round(plan.audioBitrate)))
    if (plan.audioCodec === 'aac') {
      args.push('-profile:a', 'aac_low')
    } else if (plan.audioCodec === 'opus') {
      // libopus still sits behind the experimental gate in ffmpeg, so it needs
      // both the explicit encoder name and the strictness override.
      args.push('-c:a', 'libopus', '-strict', '-2', '-ar', '48000', '-vbr', 'on')
    } else {
      args.push('-ar', '44100')
    }
  } else {
    args.push('-an')
  }

  args.push('-max_muxing_queue_size', '2048')
  if (plan.container === 'mp4') {
    args.push('-movflags', '+faststart')
  }
  args.push(outputPath)
  return args
}

/**
 * CRF update for the next attempt.
 *
 * Encoder size is exponential in CRF, but how steeply depends on the codec, the
 * preset and the footage — the "CRF points per halving" figure is only a rough
 * prior. Once two attempts have been measured, a secant step through the actual
 * points converges regardless of the true slope; the prior is used until then
 * and as the fallback when the two sizes were nearly identical.
 */
export function nextCrf(
  profile: CodecProfile,
  crf: number,
  sizeBytes: number,
  targetBytes: number,
  history: readonly CrfSample[] = [],
): number {
  const ratio = Math.max(sizeBytes, 1) / Math.max(targetBytes, 1)
  const prior = profile.crfPerHalving * Math.log2(ratio)
  const latest = history[history.length - 1]
  const previous = history[history.length - 2]

  let delta = prior
  if (latest && previous && latest.crf !== previous.crf) {
    const slope =
      (Math.log(Math.max(latest.size, 1)) - Math.log(Math.max(previous.size, 1))) /
      (latest.crf - previous.crf)
    if (Number.isFinite(slope) && Math.abs(slope) > 1e-6) {
      delta = (Math.log(Math.max(targetBytes, 1)) - Math.log(Math.max(sizeBytes, 1))) / slope
    }
  }

  const step = clamp(delta, -profile.crfPerHalving, profile.crfPerHalving)
  return clamp(crf + step, profile.minCrf, profile.maxCrf)
}

/** One measured encode, used to steer the next one. */
export interface CrfSample {
  size: number
  crf: number
}

/**
 * First CRF guess from the bit budget expressed per pixel per frame.
 *
 * Encoder output size is exponential in CRF, so inverting that curve turns a
 * bits-per-pixel budget straight into a starting CRF.
 */
export function startingCrf(profile: CodecProfile, bitsPerPixel: number): number {
  const slope = Math.LN2 / profile.crfPerHalving
  const crf = profile.referenceCrf - Math.log(Math.max(bitsPerPixel, 1e-6) / profile.referenceBpp) / slope
  return clamp(crf, profile.minCrf, profile.maxCrf)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function round(value: number): number {
  return Math.round(value)
}

/** Source video bitrate, falling back to (file size - audio) / duration. */
export function estimateSourceVideoBitrate(info: MediaInfo, fileBytes: number): number {
  if (info.video?.bitrate && info.video.bitrate > 0) return info.video.bitrate
  const total = info.bitrate ?? (fileBytes * 8) / Math.max(info.duration, 0.001)
  const audio = info.audio?.bitrate ?? 0
  const estimate = total - audio
  if (estimate > 10_000) return estimate
  // Last resort: assume a middling bitrate for the resolution and frame rate.
  const { width, height, fps } = sourceGeometry(info)
  return Math.max(500_000, width * height * fps * 0.09)
}

function sourceGeometry(info: MediaInfo): { width: number; height: number; fps: number } {
  const width = info.video?.width ?? 1280
  const height = info.video?.height ?? 720
  const fps = info.video?.fps && info.video.fps > 0 && Number.isFinite(info.video.fps) ? info.video.fps : 30
  return { width, height, fps }
}

function fitHeight({ width, height }: { width: number; height: number }, maxHeight: number) {
  const scale = maxHeight / height
  return { width: even(width * scale), height: even(maxHeight) }
}

/** Scales down proportionally until the shorter side is at most `shortEdge`. */
function fitShortEdge({ width, height }: { width: number; height: number }, shortEdge: number) {
  const scale = Math.min(1, shortEdge / Math.min(width, height))
  return { width: even(width * scale), height: even(height * scale) }
}

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

function buildFilter(geometry: {
  width: number
  height: number
  fps: number
  srcWidth: number
  srcHeight: number
  srcFps: number
}): string | null {
  const parts: string[] = []
  if (geometry.height !== geometry.srcHeight || geometry.width !== geometry.srcWidth) {
    parts.push(`scale=${geometry.width}:${geometry.height}:flags=lanczos`)
  }
  if (Math.abs(geometry.fps - geometry.srcFps) > 0.01) {
    parts.push(`fps=${geometry.fps.toFixed(3)}`)
  }
  return parts.length > 0 ? parts.join(',') : null
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} kB`
}

function formatSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}