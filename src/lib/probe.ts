import type { FFmpeg } from '@ffmpeg/ffmpeg'

export interface VideoStreamInfo {
  codec: string
  width: number
  height: number
  /** Frames per second. */
  fps: number
  bitrate: number | null
  pixFmt: string | null
  /** Display rotation in degrees, as ffmpeg will apply it. */
  rotation: number
}

export interface AudioStreamInfo {
  codec: string
  channels: number
  sampleRate: number
  bitrate: number | null
}

export interface MediaInfo {
  duration: number
  /** Overall file bitrate in bits/s. */
  bitrate: number | null
  video: VideoStreamInfo | null
  audio: AudioStreamInfo | null
}

const DURATION = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/
const BITRATE = /bitrate:\s*(\d+(?:\.\d+)?)\s*kb\/s/
const STREAM = /^Stream #\d+:\d+.*?:\s*(Video|Audio):\s*(.+)$/
const VIDEO_SIZE = /(?:^|[\s,])(\d{2,5})x(\d{2,5})(?:[\s,[]|$)/
const VIDEO_FPS = /([\d.]+)\s*fps/
const PIX_FMT = /(yuv\d+p\d*|yuv\d+p\w+|nv\d+|rgb\w+|bgr\w+|gbr\w+|p010|yuv420p10le|yuva\d+p\d+)/i
const ROTATION = /rotation of (-?[\d.]+) degrees/
const CODEC = /^([a-z0-9_]+)/
const SAMPLE_RATE = /(\d+)\s*Hz/
const CHANNELS = /\b(mono|stereo|quad|5\.1|7\.1|9\.1)(\b|,)/

/**
 * Reads container and stream metadata using ffmpeg -i.
 * Uses a dedicated log buffer to avoid clobbering the main job log.
 */
export async function probe(ffmpeg: FFmpeg, inputPath: string): Promise<MediaInfo> {
  const probeLog: string[] = []

  const handler = ({ message }: { message: string }) => {
    probeLog.push(message)
  }
  ffmpeg.on('log', handler)

  try {
    await ffmpeg.exec(['-hide_banner', '-i', inputPath, '-f', 'null', '-'])
  } catch {
    // ffmpeg exits non-zero for "no output specified"; the log is the result.
  } finally {
    ffmpeg.off('log', handler)
  }

  const info = parse(probeLog)
  if (!info) throw new Error(`Could not read the metadata of this file. ${tail(probeLog)}`)
  return info
}

export function parse(lines: string[]): MediaInfo | null {
  const duration = DURATION.exec(lines.find((line) => line.includes('Duration:')) ?? '')
  if (!duration) return null
  const seconds =
    Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])

  let video: VideoStreamInfo | null = null
  let audio: AudioStreamInfo | null = null
  let pending: 'video' | 'audio' | null = null

  for (const line of lines) {
    const stream = STREAM.exec(line.trim())
    if (stream) {
      const [, kind, rest] = stream
      if (kind === 'Video' && !video) {
        const size = VIDEO_SIZE.exec(rest)
        video = {
          codec: CODEC.exec(rest)?.[1] ?? 'unknown',
          width: size ? Number(size[1]) : 0,
          height: size ? Number(size[2]) : 0,
          fps: Number(VIDEO_FPS.exec(rest)?.[1] ?? 0) || 0,
          bitrate: null,
          pixFmt: PIX_FMT.exec(rest)?.[1] ?? null,
          rotation: 0,
        }
        pending = 'video'
      } else if (kind === 'Audio' && !audio) {
        const channels = CHANNELS.exec(rest)?.[1]
        audio = {
          codec: CODEC.exec(rest)?.[1] ?? 'unknown',
          channels: channels === 'mono' ? 1 : channels ? 2 : 2,
          sampleRate: Number(SAMPLE_RATE.exec(rest)?.[1] ?? 48_000),
          bitrate: null,
        }
        pending = 'audio'
      }
      continue
    }

    // Display rotation is reported on a side-data line under the video stream.
    const rotation = ROTATION.exec(line)
    if (rotation && pending === 'video' && video) {
      video.rotation = normalizeRotation(Number(rotation[1]))
      continue
    }

    const bitrate = BITRATE.exec(line)
    if (bitrate) {
      const value = Math.round(Number(bitrate[1]) * 1000)
      if (pending === 'video' && video) video.bitrate = value
      else if (pending === 'audio' && audio) audio.bitrate = value
    }
  }

  const container = BITRATE.exec(lines.find((line) => line.includes('Duration:')) ?? '')
  return {
    duration: seconds,
    bitrate: container ? Math.round(Number(container[1]) * 1000) : null,
    video,
    audio,
  }
}

function normalizeRotation(degrees: number): number {
  const value = Math.abs(Math.round(degrees / 90) * 90) % 360
  return value === 180 ? 0 : value
}

/** Last few lines of ffmpeg output, for error messages. */
export function tail(lines: string[], count = 16): string {
  return lines.slice(-count).join(' | ')
}