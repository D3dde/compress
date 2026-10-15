import { useEffect, useMemo } from 'react'
import type { CompressResult } from '../lib/compress'
import { formatBitrate, formatBytes, formatDuration, formatPercent } from '../lib/format'

interface ResultPanelProps {
  result: CompressResult
  onRestart: () => void
}

export function ResultPanel({ result, onRestart }: ResultPanelProps) {
  const url = useMemo(() => URL.createObjectURL(result.blob), [result.blob])

  useEffect(() => () => URL.revokeObjectURL(url), [url])

  const saved = result.sourceBytes - result.bytes
  const savedRatio = saved / result.sourceBytes

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>{result.hitTarget ? 'target reached' : 'finished over target'}</h2>
        <span className="panel__aside">
          {result.attempts} pass{result.attempts > 1 ? 'es' : ''}
        </span>
      </div>

      <div className="result__headline">
        <span className="result__number">{formatBytes(result.bytes)}</span>
        <span className={saved >= 0 ? 'good' : 'bad'}>
          {saved >= 0 ? '-' : '+'}
          {formatBytes(Math.abs(saved))} ({formatPercent(Math.abs(savedRatio))})
        </span>
        <span className="result__label">of {formatBytes(result.sourceBytes)}</span>
      </div>

      <div className="result__bar" aria-hidden="true">
        <div className="result__bar-source" style={{ width: '100%' }} />
        <div className="result__bar-target" style={{ width: `${barWidth(result)}%` }} />
        <div className="result__bar-output" style={{ width: `${barWidth(result)}%` }} />
      </div>
      <div className="result__scale">
        <span>0</span>
        <span className="result__scale-target">
          target {formatBytes(result.targetBytes)}
        </span>
        <span>{formatBytes(result.sourceBytes)} original</span>
      </div>

      <dl className="stats">
        <Stat label="target" value={formatBytes(result.targetBytes)} />
        <Stat label="video" value={formatBitrate(result.videoBitrate)} />
        <Stat label="audio" value={result.audioBitrate ? formatBitrate(result.audioBitrate) : 'none'} />
        <Stat label="quality" value={result.crf === null ? 'rate controlled' : `crf ${result.crf.toFixed(1)}`} />
        <Stat label="resolution" value={`${result.width}×${result.height}`} />
        <Stat label="frame rate" value={`${Math.round(result.fps)} fps`} />
        <Stat label="length" value={formatDuration(result.durationSec)} />
        <Stat label="source" value={result.info.video?.codec ?? '—'} />
      </dl>

      <video className="result__player" src={url} controls playsInline preload="metadata" />

      {result.notes.length > 0 && (
        <ul className="notes">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        <a className="button button--primary" href={url} download={result.fileName}>
          download {result.fileName}
        </a>
        <button type="button" className="button" onClick={onRestart}>
          another
        </button>
      </div>
    </section>
  )
}

function barWidth(result: CompressResult): number {
  return Math.min(100, (result.bytes / Math.max(result.sourceBytes, 1)) * 100)
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stats__item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}