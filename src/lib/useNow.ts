import { useEffect, useState } from 'react'

/**
 * Current wall-clock time, refreshed once a second while `active` is true and
 * frozen otherwise. Used for elapsed/ETA readouts.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}