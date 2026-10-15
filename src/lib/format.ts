const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

export function formatBytes(bytes: number, digits?: number): string {
  if (!Number.isFinite(bytes)) return '—'
  const abs = Math.abs(bytes)
  const d = digits ?? (abs >= GB || abs === 0 ? 2 : abs >= MB ? 1 : 0)
  if (abs >= GB) return `${(bytes / GB).toFixed(d)} GB`
  if (abs >= MB) return `${(bytes / MB).toFixed(d)} MB`
  if (abs >= KB) return `${(bytes / KB).toFixed(0)} KB`
  return `${bytes} B`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatLongDuration(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function formatBitrate(bitsPerSecond: number): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '—'
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`
  return `${Math.round(bitsPerSecond / 1000)} kbps`
}

export function formatPercent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`
}

/** Parses "12.5", "12,5", "1.2 GB", "500m" into bytes. */
export function parseSize(input: string): number | null {
  const text = input.trim().toLowerCase().replace(',', '.')
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/.exec(text)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  switch (match[2]) {
    case 'kb':
    case 'kib':
      return value * KB
    case 'mb':
    case 'mib':
      return value * MB
    case 'gb':
    case 'gib':
      return value * GB
    default:
      return value
  }
}

export { GB, KB, MB }