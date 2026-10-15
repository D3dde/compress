import type {
  AudioCodec,
  MaxFps,
  MaxHeight,
  QualityMode,
  Settings,
  SpeedPreset,
  VideoCodec,
} from '../lib/encode'
import { MB } from '../lib/format'

interface OptionsProps {
  settings: Settings
  sourceBytes: number
  disabled: boolean
  onChange: (settings: Settings) => void
}

const VIDEO_CODECS: { value: VideoCodec; label: string; note: string }[] = [
  { value: 'h264', label: 'H.264', note: 'plays everywhere' },
  { value: 'h265', label: 'H.265 / HEVC', note: 'smaller, newer players' },
  { value: 'vp9', label: 'VP9', note: 'open codec, WebM' },
]

const SPEEDS: { value: SpeedPreset; label: string }[] = [
  { value: 'fast', label: 'Fastest' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'quality', label: 'Best quality' },
]

const QUALITY: { value: QualityMode; label: string; passes: string }[] = [
  { value: 'fast', label: 'Quick', passes: 'up to 2 passes' },
  { value: 'balanced', label: 'Accurate', passes: 'up to 3 passes' },
  { value: 'best', label: 'Exhaustive', passes: 'up to 4 passes' },
]

const HEIGHTS: MaxHeight[] = [0, 2160, 1440, 1080, 720, 480, 360]
const FPS: MaxFps[] = [0, 60, 30, 24, 15]
const AUDIO_CODECS: { value: AudioCodec; label: string }[] = [
  { value: 'aac', label: 'AAC' },
  { value: 'opus', label: 'Opus' },
  { value: 'mp3', label: 'MP3' },
]

export function Options({ settings, sourceBytes, disabled, onChange }: OptionsProps) {
  const update = (patch: Partial<Settings>) => onChange({ ...settings, ...patch })

  return (
    <section className="panel">
      <details>
        <summary className="panel__head panel__summary">
          <h2>Fine tuning</h2>
          <span className="panel__aside">codec, resolution, audio, effort</span>
        </summary>

        <div className="options">
          <Field label="video codec">
            <Select
              value={settings.videoCodec}
              disabled={disabled}
              onChange={(value) => update({ videoCodec: value as VideoCodec })}
              options={VIDEO_CODECS.map((c) => ({
                value: c.value,
                label: `${c.label} · ${c.note}`,
              }))}
            />
          </Field>

          <Field label="speed">
            <Segmented
              value={settings.speed}
              disabled={disabled}
              options={SPEEDS}
              onChange={(value) => update({ speed: value as SpeedPreset })}
            />
          </Field>

          <Field label="accuracy" hint="more passes, more time">
            <Segmented
              value={settings.qualityMode}
              disabled={disabled}
              options={QUALITY}
              onChange={(value) => update({ qualityMode: value as QualityMode })}
            />
          </Field>

          <Field label="max resolution">
            <Segmented
              value={String(settings.maxHeight)}
              disabled={disabled}
              options={HEIGHTS.map((h) => ({ value: String(h), label: h === 0 ? 'Original' : `${h}p` }))}
              onChange={(value) => update({ maxHeight: Number(value) as MaxHeight })}
            />
          </Field>

          <Field label="max frame rate">
            <Segmented
              value={String(settings.maxFps)}
              disabled={disabled}
              options={FPS.map((f) => ({ value: String(f), label: f === 0 ? 'Original' : `${f}` }))}
              onChange={(value) => update({ maxFps: Number(value) as MaxFps })}
            />
          </Field>

          <Field label="audio" hint="remove drops the sound track">
            <Segmented
              value={settings.audioMode}
              disabled={disabled}
              options={[
                { value: 'encode', label: 'Keep' },
                { value: 'strip', label: 'Remove' },
              ]}
              onChange={(value) => update({ audioMode: value as Settings['audioMode'] })}
            />
          </Field>

          {settings.audioMode === 'encode' && (
            <>
              <Field label="audio codec">
                <Select
                  value={settings.audioCodec}
                  disabled={disabled}
                  onChange={(value) => update({ audioCodec: value as AudioCodec })}
                  options={AUDIO_CODECS}
                />
              </Field>

              <Field label="audio bitrate" hint="kbps">
                <Segmented
                  value={String(settings.audioBitrate)}
                  disabled={disabled}
                  options={[64_000, 96_000, 128_000, 192_000, 256_000].map((b) => ({
                    value: String(b),
                    label: `${b / 1000}`,
                  }))}
                  onChange={(value) => update({ audioBitrate: Number(value) })}
                />
              </Field>
            </>
          )}

          <Field label="auto resolution" hint="shrink when the target is very small">
            <Segmented
              value={settings.autoDownscale ? 'on' : 'off'}
              disabled={disabled}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' },
              ]}
              onChange={(value) => update({ autoDownscale: value === 'on' })}
            />
          </Field>

          {sourceBytes > 700 * MB && (
            <p className="hint hint--warn">
              Large sources run in browser memory. If the tab runs out, use a shorter clip.
            </p>
          )}
        </div>
      </details>
    </section>
  )
}

interface FieldProps {
  label: string
  hint?: string
  children: React.ReactNode
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="field">
      <div className="field__label">
        {label}
        {hint && <span className="field__hint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

interface SegmentedProps {
  value: string
  options: { value: string; label: string }[]
  disabled?: boolean
  onChange: (value: string) => void
}

function Segmented({ value, options, disabled, onChange }: SegmentedProps) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented__item${option.value === value ? ' segmented__item--active' : ''}`}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

interface SelectProps {
  value: string
  options: { value: string; label: string }[]
  disabled?: boolean
  onChange: (value: string) => void
}

function Select({ value, options, disabled, onChange }: SelectProps) {
  return (
    <div className="select">
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  )
}