export interface SourceSummary {
  name: string
  size: number
  /** Seconds, or null when the browser cannot decode the container. */
  duration: number | null
  width: number
  height: number
  objectUrl: string
}

/**
 * Reads duration and dimensions straight from a <video> element.
 *
 * This is instant and needs no wasm, so the UI can show real numbers while the
 * ffmpeg core is still downloading. ffprobe stays the authority during encoding.
 */
export function analyzeSource(file: File): Promise<SourceSummary> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true

    const finish = (summary: Omit<SourceSummary, 'objectUrl' | 'size' | 'name'>) => {
      video.removeAttribute('src')
      video.load()
      resolve({ ...summary, objectUrl, size: file.size, name: file.name })
    }

    video.onloadedmetadata = () => {
      finish({
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth,
        height: video.videoHeight,
      })
    }
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error(`This browser cannot play "${file.name}". Try an MP4 (H.264) or WebM file.`))
    }
    video.src = objectUrl
  })
}

export const VIDEO_EXTENSIONS = [
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'm4v',
  'mpg',
  'mpeg',
  'ts',
  'wmv',
  'flv',
  'ogv',
  '3gp',
]

export function isProbablyVideo(file: File): boolean {
  if (file.type.startsWith('video/')) return true
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTENSIONS.includes(extension)
}