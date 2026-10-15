import { useCallback, useEffect, useMemo, useState } from 'react'
import { Dropzone } from './components/Dropzone'
import { Options } from './components/Options'
import { ProgressPanel } from './components/ProgressPanel'
import { ResultPanel } from './components/ResultPanel'
import { TargetSize } from './components/TargetSize'
import { compressVideo, type CompressProgress, type CompressResult } from './lib/compress'
import type { Settings } from './lib/encode'
import { engine, type EngineMode } from './lib/engine'
import { formatBytes, formatDuration, MB } from './lib/format'
import { analyzeSource, type SourceSummary } from './lib/source'
import { useEngineState, useEngineWarmup } from './lib/useEngine'
import { useSettings } from './lib/useSettings'
import { useNow } from './lib/useNow'

type Stage = 'idle' | 'reading' | 'ready' | 'working' | 'done'

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [source, setSource] = useState<SourceSummary | null>(null)
  const [settings, setSettings] = useSettings()
  const [stage, setStage] = useState<Stage>('idle')
  const [progress, setProgress] = useState<CompressProgress | null>(null)
  const [result, setResult] = useState<CompressResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState<AbortController | null>(null)
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const engineState = useEngineState()

  useEngineWarmup()

  const handleFile = useCallback(async (next: File) => {
    setError(null)
    setResult(null)
    setProgress(null)
    setStage('reading')
    try {
      const summary = await analyzeSource(next)
      setSource((previous) => {
        if (previous) URL.revokeObjectURL(previous.objectUrl)
        return summary
      })
      setFile(next)
      setSettings((previous) => ({
        ...previous,
        targetBytes: Math.max(1 * MB, Math.round(next.size * 0.5)),
      }))
      setStage('ready')
    } catch (cause) {
      setFile(null)
      setSource(null)
      setError(cause instanceof Error ? cause.message : String(cause))
      setStage('idle')
    }
  }, [setSettings])

  useEffect(() => {
    if (!source) return
    return () => URL.revokeObjectURL(source.objectUrl)
  }, [source])

  const start = useCallback(async () => {
    if (!file) return
    const controller = new AbortController()
    setCancelled(controller)
    setStage('working')
    setStartedAt(Date.now())
    setError(null)
    setProgress(null)
    try {
      const output = await compressVideo({
        file,
        settings,
        signal: controller.signal,
        onProgress: setProgress,
      })
      setResult(output)
      setStage('done')
    } catch (cause) {
      if (controller.signal.aborted) {
        setStage('ready')
        return
      }
      setError(describe(cause))
      setStage('ready')
      // A failed encode may have left the wasm heap unusable.
      if (/memory|allocation failed|out of bounds/i.test(describe(cause))) engine.reset()
    } finally {
      setCancelled(null)
    }
  }, [file, settings])

  const cancel = useCallback(() => {
    cancelled?.abort()
    // ffmpeg.wasm cannot interrupt a running command, so drop the worker.
    engine.reset()
  }, [cancelled])

  const restart = useCallback(() => {
    setSource((previous) => {
      if (previous) URL.revokeObjectURL(previous.objectUrl)
      return null
    })
    setFile(null)
    setResult(null)
    setProgress(null)
    setError(null)
    setStage('idle')
  }, [])

  const busy = stage === 'working'
  const elapsed = (useNow(busy) - startedAt) / 1000
  const canStart = file !== null && settings.targetBytes > 0 && !busy

  const totalBudget = useMemo(() => {
    if (!source?.duration || source.duration <= 0) return null
    return (settings.targetBytes * 8) / source.duration
  }, [source, settings.targetBytes])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>squeeze</h1>
          <p>video to an exact file size, in this tab. nothing is uploaded.</p>
        </div>
        <EngineStatus
          status={engineState.status}
          progress={engineState.progress}
          threads={engineState.threads}
          mode={engineState.mode}
          cached={engineState.cached}
        />
      </header>

      <main className="main">
        {stage === 'idle' && !source && (
          <>
            <Dropzone onFile={handleFile} />
            {error && <p className="alert">{error}</p>}
            <section className="panel">
              <ul className="facts">
                <li>
                  <b>~32 MB</b> encoder core is fetched once, then the browser caches it.
                </li>
                <li>
                  each attempt is a <b>full re-encode</b>; two to four are typical.
                </li>
                <li>
                  quality is steered by crf, so busy scenes keep their detail and the file is the
                  largest one that still fits.
                </li>
              </ul>
            </section>
          </>
        )}

        {stage === 'reading' && (
          <section className="panel">
            <div className="panel__head">
              <h2>reading file…</h2>
            </div>
            <p className="hint">checking that this browser can decode it.</p>
          </section>
        )}

        {source && file && stage !== 'done' && (
          <>
            <section className="panel">
              <div className="file">
                <video
                  className="file__preview"
                  src={source.objectUrl}
                  muted
                  playsInline
                  preload="metadata"
                />
                <div className="file__meta">
                  <p className="file__name" title={source.name}>
                    {source.name}
                  </p>
                  <p className="file__facts">
                    {formatBytes(source.size)}
                    {source.width > 0 && ` · ${source.width}×${source.height}`}
                    {source.duration !== null && ` · ${formatDuration(source.duration)}`}
                  </p>
                </div>
                <Dropzone onFile={handleFile} compact />
              </div>
            </section>

            <TargetSize
              settings={settings}
              sourceBytes={source.size}
              disabled={busy}
              onChange={setSettings}
            />

            {totalBudget !== null && (
              <p className="hint">
                {formatBitrate(totalBudget)} total ·{' '}
                {formatBitrate(Math.max(0, totalBudget - audioAllowance(settings)))} for the picture
                {settings.audioMode === 'strip' ? ' · audio removed' : ''}
              </p>
            )}

            <Options
              settings={settings}
              sourceBytes={source.size}
              disabled={busy}
              onChange={setSettings}
            />

            {error && <p className="alert">{error}</p>}

            {busy && progress ? (
              <ProgressPanel
                progress={progress}
                targetBytes={settings.targetBytes}
                elapsed={elapsed}
                onCancel={cancel}
              />
            ) : (
              <div className="actions">
                <button
                  type="button"
                  className="button button--primary"
                  disabled={!canStart}
                  onClick={start}
                >
                  compress to {formatBytes(settings.targetBytes)}
                </button>
                {engineState.mode === 'single' && (
                  <p className="hint">
                    no cross-origin isolation on this host, so ffmpeg is single-threaded and about
                    three times slower.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {stage === 'done' && result && <ResultPanel result={result} onRestart={restart} />}
      </main>

      <footer className="footer">
        ffmpeg compiled to wasm, running here. no uploads, no accounts, no server.
      </footer>
    </div>
  )
}

function EngineStatus({
  status,
  progress,
  threads,
  mode,
  cached,
}: {
  status: string
  progress: number
  threads: number
  mode: EngineMode
  cached: boolean
}) {
  if (status === 'loading') {
    return (
      <span className="status">
        fetching ffmpeg core {Math.round(progress * 100)}% · 32 MB, once
      </span>
    )
  }
  if (status === 'ready') {
    return (
      <span className="status">
        ffmpeg ready · {mode === 'threads' ? `${threads} threads` : '1 thread'}
        {cached ? ' · from cache' : ''}
      </span>
    )
  }
  if (status === 'error') return <span className="status status--error">ffmpeg failed to load</span>
  return <span className="status">ffmpeg not loaded yet</span>
}

function audioAllowance(settings: Settings): number {
  return settings.audioMode === 'strip' ? 0 : settings.audioBitrate
}

function formatBitrate(bitsPerSecond: number): string {
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`
  return `${Math.round(bitsPerSecond / 1000)} kbps`
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}