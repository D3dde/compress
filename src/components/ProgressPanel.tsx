import type { CompressProgress } from '../lib/compress'
import { formatBytes, formatLongDuration } from '../lib/format'

interface ProgressPanelProps {
  progress: CompressProgress
  targetBytes: number
  /** Milliseconds spent encoding, supplied by the caller so it survives re-renders. */
  elapsed: number
  onCancel: () => void
}

export function ProgressPanel({ progress, targetBytes, elapsed, onCancel }: ProgressPanelProps) {
  const eta = estimateRemaining(progress, elapsed)
  const percent = Math.round(progress.ratio * 100)
  const overBy = progress.attemptBytes ? progress.attemptBytes - targetBytes : 0

  return (
    <section className="panel panel--active">
      <div className="panel__head">
        <h2>{progress.message}</h2>
        <span className="panel__aside">
          {progress.pass > 0 ? `pass ${progress.pass}/${progress.totalPasses}` : 'starting'}
        </span>
      </div>

      <div className="progress">
        <div className="progress__track">
          <div className="progress__fill" style={{ width: `${Math.max(2, percent)}%` }} />
        </div>
        <div className="progress__meta">
          <span>{percent}%</span>
          {progress.crf !== null && <span>crf {progress.crf.toFixed(1)}</span>}
          {elapsed > 0 && <span>{formatLongDuration(elapsed)} elapsed</span>}
          {eta !== null && <span>~{formatLongDuration(eta)} left</span>}
          <span>one pass = one full encode</span>
        </div>
      </div>

      {progress.attemptBytes !== null && progress.pass > 1 && (
        <p className={`hint ${overBy > 0 ? 'hint--warn' : 'hint--ok'}`}>
          Last attempt: {formatBytes(progress.attemptBytes)}
          {overBy > 0
            ? ` · ${formatBytes(overBy)} over target, raising CRF`
            : ` · ${formatBytes(-overBy)} under target`}
        </p>
      )}

      <div className="actions">
        <button type="button" className="button" onClick={onCancel}>
          cancel
        </button>
      </div>
    </section>
  )
}

function estimateRemaining(progress: CompressProgress, elapsed: number): number | null {
  if (progress.phase !== 'encoding' && progress.phase !== 'finalizing') return null
  if (progress.ratio <= 0.02 || elapsed <= 2) return null
  const remaining = elapsed / progress.ratio - elapsed
  return remaining > 0 && Number.isFinite(remaining) ? remaining : null
}