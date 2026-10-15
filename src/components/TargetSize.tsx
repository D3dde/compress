import { MB } from '../lib/format'
import type { Settings } from '../lib/encode'

interface TargetSizeProps {
  settings: Settings
  sourceBytes: number
  disabled: boolean
  onChange: (settings: Settings) => void
}

const PRESETS = [0.25, 0.5, 0.75]

export function TargetSize({ settings, sourceBytes, disabled, onChange }: TargetSizeProps) {
  const targetBytes = settings.targetBytes
  const min = Math.max(0.5 * MB, sourceBytes * 0.005)
  const max = Math.max(min * 2, sourceBytes)
  const ratio = targetBytes > 0 ? clamp01(Math.log(targetBytes / min) / Math.log(max / min)) : 0.5

  const update = (patch: Partial<Settings>) => onChange({ ...settings, ...patch })

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>target size</h2>
        <span className="panel__aside">stops as soon as a pass fits</span>
      </div>

      <div className="target">
        <div className="target__field">
          <input
            type="number"
            className="target__input"
            value={round(targetBytes / MB)}
            min={1}
            step={1}
            disabled={disabled}
            onChange={(event) => {
              const mb = Number(event.target.value)
              if (Number.isFinite(mb) && mb > 0) update({ targetBytes: Math.round(mb * MB) })
            }}
            aria-label="Target size in megabytes"
          />
          <span className="target__unit">MB</span>
        </div>

        <input
          type="range"
          className="target__slider"
          min={0}
          max={1}
          step={0.001}
          value={ratio}
          disabled={disabled}
          onChange={(event) => {
            const next = min * Math.pow(max / min, Number(event.target.value))
            update({ targetBytes: Math.round(next) })
          }}
          aria-label="Target size slider"
        />

        <div className="target__presets">
          {PRESETS.map((fraction) => {
            const bytes = Math.round(sourceBytes * fraction)
            const active = Math.abs(bytes - targetBytes) / bytes < 0.02
            return (
              <button
                key={fraction}
                type="button"
                className={`chip${active ? ' chip--active' : ''}`}
                disabled={disabled}
                onClick={() => update({ targetBytes: bytes })}
              >
                {fraction * 100}%
              </button>
            )
          })}
          <button
            type="button"
            className="chip"
            disabled={disabled}
            onClick={() => update({ targetBytes: Math.round(sourceBytes * 0.1) })}
          >
            10%
          </button>
          <button
            type="button"
            className="chip"
            disabled={disabled}
            onClick={() => update({ targetBytes: Math.round(sourceBytes * 0.9) })}
          >
            90%
          </button>
        </div>
      </div>

      {targetBytes >= sourceBytes && (
        <p className="hint hint--warn">
          that is bigger than the original. re-encoding cannot add detail back — pick something
          under {(sourceBytes / MB).toFixed(0)} MB.
        </p>
      )}
    </section>
  )
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}