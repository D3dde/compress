import { FFmpeg } from '@ffmpeg/ffmpeg'
import { FFFSType } from '@ffmpeg/ffmpeg'

// The cores are imported as URLs rather than copied into public/: the ffmpeg
// worker loads the core with a dynamic import, and Vite refuses to serve files
// out of public/ as modules. Bundling them this way also means the core is
// hashed, cached correctly and works under any deploy base (GitHub Pages, a
// subpath, a CDN) without any URL rewriting.
import mtCoreUrl from '@ffmpeg/core-mt?url'
import mtWasmUrl from '@ffmpeg/core-mt/wasm?url'
import mtWorkerUrl from '@ffmpeg/core-mt/worker?url&no-inline'
import stCoreUrl from '@ffmpeg/core?url'
import stWasmUrl from '@ffmpeg/core/wasm?url'

export const INPUT_DIR = '/input'
export const WORK_DIR = '/work'

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'error'
/** Multi-threaded cores need SharedArrayBuffer; without it we fall back. */
export type EngineMode = 'threads' | 'single'

export interface EngineState {
  status: EngineStatus
  /** 0..1 boot progress while the wasm core is downloaded and compiled. */
  progress: number
  error: string | null
  threads: number
  mode: EngineMode
  /** True once the core was served from the browser cache rather than network. */
  cached: boolean
}

export interface JobHooks {
  /** 0..1 progress of the currently running ffmpeg invocation. */
  onProgress?: (ratio: number) => void
  onLog?: (line: string) => void
}

type Listener = (state: EngineState) => void

interface CoreUrls {
  coreURL: string
  wasmURL: string
  workerURL: string | undefined
  mode: EngineMode
  threads: number
}

export function preferredMode(): EngineMode {
  return typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated ? 'threads' : 'single'
}

function pickCore(): CoreUrls {
  if (preferredMode() === 'threads') {
    return {
      coreURL: mtCoreUrl,
      wasmURL: mtWasmUrl,
      workerURL: mtWorkerUrl,
      mode: 'threads',
      threads: threadCount(),
    }
  }
  // Single-threaded: no SharedArrayBuffer needed, so this works on hosts that
  // cannot send COOP/COEP headers (GitHub Pages, for one) at roughly a third of
  // the speed.
  return { coreURL: stCoreUrl, wasmURL: stWasmUrl, workerURL: undefined, mode: 'single', threads: 1 }
}

export function threadCount(): number {
  const cores = navigator.hardwareConcurrency ?? 4
  return Math.max(1, Math.min(8, cores - 1))
}

/**
 * Single long-lived ffmpeg.wasm instance shared by the app.
 *
 * Booting the core costs a ~32 MB download plus a WASM compile, so it is created
 * lazily on first use and kept warm afterwards; the scratch filesystem is wiped
 * between jobs.
 */
class Engine {
  #ffmpeg: FFmpeg | null = null
  #loading: Promise<FFmpeg> | null = null
  #listeners = new Set<Listener>()
  #state: EngineState = {
    status: 'idle',
    progress: 0,
    error: null,
    threads: 1,
    mode: 'single',
    cached: false,
  }
  #hooks: JobHooks | null = null

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  get state(): EngineState {
    return this.#state
  }

  #emit(patch: Partial<EngineState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener(this.#state)
  }

  /** Multi-threading needs SharedArrayBuffer, which needs cross-origin isolation. */
  get supported(): boolean {
    return typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated
  }

  /** Exposed so the core prefetcher can report download progress. */
  emitBootProgress(ratio: number): void {
    if (this.#state.status === 'loading') this.#emit({ progress: ratio })
  }

  async load(): Promise<FFmpeg> {
    if (this.#ffmpeg) return this.#ffmpeg
    if (this.#loading) return this.#loading

    const core = pickCore()
    this.#emit({
      status: 'loading',
      progress: 0,
      error: null,
      threads: core.threads,
      mode: core.mode,
      cached: false,
    })
    this.#loading = (async () => {
      const ffmpeg = new FFmpeg()
      ffmpeg.on('progress', ({ progress }) => {
        if (Number.isFinite(progress)) this.#hooks?.onProgress?.(progress)
      })
      ffmpeg.on('log', ({ message }) => {
        this.#hooks?.onLog?.(message)
      })

      const wasmURL = await prefetchCore(core.wasmURL)
      await ffmpeg.load({
        coreURL: core.coreURL,
        wasmURL,
        ...(core.workerURL ? { workerURL: core.workerURL } : {}),
      })

      this.#ffmpeg = ffmpeg
      this.#emit({
        status: 'ready',
        progress: 1,
        error: null,
        threads: core.threads,
        mode: core.mode,
        cached: servedFromCache(core.wasmURL),
      })
      return ffmpeg
    })()

    try {
      return await this.#loading
    } catch (error) {
      this.#emit({ status: 'error', error: describe(error) })
      this.#loading = null
      throw error
    }
  }

  /**
   * Runs `fn` against an ffmpeg whose scratch filesystem is empty, with `file`
   * mounted read-only at /input. WORKERFS serves bytes straight from the Blob
   * instead of copying them into the wasm heap, so source size is not bounded
   * by the browser heap.
   */
  async withJob<T>(
    file: File,
    hooks: JobHooks,
    fn: (ffmpeg: FFmpeg, inputPath: string) => Promise<T>,
  ): Promise<T> {
    const ffmpeg = await this.load()
    this.#hooks = hooks
    await ffmpeg.createDir(INPUT_DIR).catch(() => {})
    await ffmpeg.createDir(WORK_DIR).catch(() => {})
    await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, INPUT_DIR)
    try {
      return await fn(ffmpeg, `${INPUT_DIR}/${file.name}`)
    } finally {
      this.#hooks = null
      await ffmpeg.unmount(INPUT_DIR).catch(() => {})
      await this.cleanup(ffmpeg)
    }
  }

  async cleanup(ffmpeg: FFmpeg): Promise<void> {
    for (const dir of [WORK_DIR, INPUT_DIR]) {
      try {
        const entries = await ffmpeg.listDir(dir)
        for (const entry of entries) {
          if (entry.isDir) await ffmpeg.deleteDir(`${dir}/${entry.name}`).catch(() => {})
          else await ffmpeg.deleteFile(`${dir}/${entry.name}`).catch(() => {})
        }
      } catch {
        /* directory may not exist */
      }
    }
  }

  /** Frees the wasm heap, e.g. after an out-of-memory failure. */
  reset(): void {
    this.#ffmpeg?.terminate()
    this.#ffmpeg = null
    this.#loading = null
    this.#emit({
      status: 'idle',
      progress: 0,
      error: null,
      threads: preferredMode() === 'threads' ? threadCount() : 1,
      mode: preferredMode(),
    })
  }
}

export const engine = new Engine()

/**
 * Streams the core wasm so the UI can show a real download bar instead of a
 * spinner frozen on a 32 MB transfer.
 *
 * The chunks are handed to a Blob as they arrive rather than merged into one
 * buffer first: the wasm core reads it back in a worker, so holding a second
 * 32 MB copy in the main thread only costs memory and a copy.
 */
async function prefetchCore(wasmURL: string): Promise<string> {
  const response = await fetch(wasmURL, { cache: 'force-cache' })
  if (!response.ok) throw new Error(`Could not download the ffmpeg core (HTTP ${response.status}).`)
  const total = Number(response.headers.get('content-length') ?? 0)
  if (!response.body) return wasmURL

  const reader = response.body.getReader()
  const chunks: BlobPart[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(toBlobPart(value))
    received += value.byteLength
    engine.emitBootProgress(total > 0 ? Math.min(received / total, 0.95) : 0)
  }

  const url = URL.createObjectURL(new Blob(chunks, { type: 'application/wasm' }))
  // The core worker only reads the URL during load(); revoking later is safe and
  // keeps the buffer from being retained for the rest of the session.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return url
}

/** A zero transfer size means the browser served it from its own cache. */
function servedFromCache(url: string): boolean {
  const entry = performance
    .getEntriesByName(url, 'resource')
    .at(-1) as PerformanceResourceTiming | undefined
  return entry !== undefined && entry.transferSize === 0 && entry.decodedBodySize > 0
}

function toBlobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) return bytes as Uint8Array<ArrayBuffer>
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}