import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { DEFAULT_SETTINGS, type Settings } from './encode'

const STORAGE_KEY = 'squeeze.settings.v1'

/**
 * Keeps the tuning panel between videos. Only the choices people actually make
 * are stored; the target is always recomputed from the file that was picked.
 */
export function useSettings(): [Settings, Dispatch<SetStateAction<Settings>>] {
  const [settings, setSettings] = useState<Settings>(load)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      /* private mode, quota, whatever — not worth interrupting the user */
    }
  }, [settings])

  return [settings, setSettings]
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const stored = JSON.parse(raw) as Partial<Settings>
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      // Never restore a target: it is meaningless for a different video.
      targetBytes: 0,
      maxHeight: isOneOf(stored.maxHeight, [0, 2160, 1440, 1080, 720, 480, 360])
        ? stored.maxHeight!
        : DEFAULT_SETTINGS.maxHeight,
      maxFps: isOneOf(stored.maxFps, [0, 60, 30, 24, 15])
        ? stored.maxFps!
        : DEFAULT_SETTINGS.maxFps,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function isOneOf<T>(value: T | undefined, allowed: T[]): boolean {
  return value !== undefined && allowed.includes(value)
}