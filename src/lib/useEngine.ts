import { useEffect, useRef, useState } from 'react'
import { engine, type EngineState } from './engine'

export function useEngineState(): EngineState {
  const [state, setState] = useState<EngineState>(engine.state)
  useEffect(() => engine.subscribe(setState), [])
  return state
}

/**
 * Starts fetching and compiling the wasm core in the background.
 *
 * The core is ~32 MB and compiling it takes a couple of seconds, so waiting for
 * the user to pick a file makes the first encode feel broken. Warming starts on
 * idle rather than immediately so it never competes with the first paint.
 */
export function useEngineWarmup(): void {
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true

    const warm = () => void engine.load().catch(() => {
      /* surfaced through engine.state.error */
    })

    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(warm, { timeout: 1500 })
      return () => cancelIdleCallback(handle)
    }
    const timer = setTimeout(warm, 600)
    return () => clearTimeout(timer)
  }, [])
}