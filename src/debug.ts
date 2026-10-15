import { FFmpeg } from '@ffmpeg/ffmpeg'
import mtCore from '@ffmpeg/core-mt?url'
import mtWasm from '@ffmpeg/core-mt/wasm?url'
import mtWorker from '@ffmpeg/core-mt/worker?url&no-inline'
import stCore from '@ffmpeg/core?url'
import stWasm from '@ffmpeg/core/wasm?url'

declare global {
  interface Window {
    __out: unknown
    __err: string | null
    runVariant: (name: string, single: boolean) => void
  }
}
window.__out = null
window.__err = null

const BASE = [
  '-i', '/input/test.mp4', '-map', '0:v:0', '-map_metadata', '-1', '-an',
  '-c:v', 'libx264', '-preset', 'veryfast',
]

const VARIANTS: Record<string, string[]> = {
  bare: ['-crf', '32'],
  maxrate: ['-crf', '32', '-maxrate', '500000', '-bufsize', '1000000'],
  threads: ['-crf', '32', '-x264-params', 'threads=0'],
  sliced: ['-crf', '32', '-x264-params', 'threads=0:sliced-threads=1'],
  gop: ['-crf', '32', '-x264-params', 'threads=0:sliced-threads=1:keyint=50:min-keyint=50:scenecut=0'],
  profile: [
    '-crf', '32', '-maxrate', '500000', '-bufsize', '1000000',
    '-x264-params', 'threads=0:sliced-threads=1:keyint=50:min-keyint=50:scenecut=0',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
  ],
  presetFast: ['-crf', '32', '-preset', 'ultrafast'],
  threads2: ['-crf', '32', '-preset', 'ultrafast', '-threads', '2'],
  threads4: ['-crf', '32', '-preset', 'ultrafast', '-threads', '4'],
}

window.runVariant = (name: string, single: boolean) => {
  void (async () => {
    const logs: string[] = []
    const result: Record<string, unknown> = { variant: name, single }
    try {
      const ff = new FFmpeg()
      ff.on('log', ({ message }) => logs.push(message))
      await ff.load(
        single
          ? { coreURL: stCore, wasmURL: stWasm }
          : { coreURL: mtCore, wasmURL: mtWasm, workerURL: mtWorker },
      )
      await ff.createDir('/input')
      await ff.createDir('/work')
      const blob = await (await fetch('/test.mp4')).blob()
      const { FFFSType } = await import('@ffmpeg/ffmpeg')
      await ff.mount(FFFSType.WORKERFS, { files: [new File([blob], 'test.mp4')] }, '/input')
      const out = '/work/out.mp4'
      const args = [...BASE, ...VARIANTS[name], '-y', out]
      result.args = args.join(' ')
      const code = await ff.exec(args).catch((error: Error) => `threw ${error}`)
      result.code = code
      try {
        const data = await ff.readFile(out)
        result.size = typeof data === 'string' ? data.length : data.byteLength
      } catch {
        result.size = 'no output'
      }
    } catch (error) {
      result.error = `${(error as Error).message ?? String(error)} :: ${(error as Error).stack?.slice(0, 300) ?? ''}`
    }
    result.tail = logs.slice(-6).join(' | ').slice(0, 400)
    window.__out = result
  })().catch((error) => {
    window.__err = String(error)
  })
}
