// Static file server for the built site, used by `nix run .` and to check the
// production bundle locally. It sets the same cross-origin isolation headers as
// public/_headers, because multi-threaded ffmpeg.wasm refuses to start without
// them.
//
//   node scripts/serve.mjs --root dist [--port 4173]

import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

const args = parseArgs(process.argv.slice(2))
const root = resolve(args.root ?? 'dist')
const port = Number(args.port ?? process.env.PORT ?? 4173)
const host = args.host ?? process.env.HOST ?? '127.0.0.1'

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
}

const HEADERS = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

try {
  if (!statSync(root).isDirectory()) throw new Error('not a directory')
} catch {
  console.error(`No build found at ${root}. Run "npm run build" first.`)
  process.exit(1)
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const file = resolveFile(url.pathname)

  if (!file) {
    response.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }

  response.writeHead(200, {
    ...HEADERS,
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
    // Bundled files are content-hashed, so they can be cached forever.
    'Cache-Control': file.includes(`${sep}assets${sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  })
  createReadStream(file).pipe(response)
})

server.listen(port, host, () => {
  console.log(`Squeeze is serving ${root}`)
  console.log(`  http://${host}:${port}`)
})

/** Maps a URL path to a file inside the root, or null if it escapes or is gone. */
function resolveFile(pathname) {
  const decoded = decodeURIComponent(pathname)
  const candidate = resolve(join(root, normalize(decoded)))
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  try {
    const stats = statSync(candidate)
    if (stats.isDirectory()) return resolveFile(join(decoded, 'index.html'))
    return candidate
  } catch {
    // Single-page fallback.
    return resolveFile('/index.html')
  }
}

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    parsed[key] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
  }
  return parsed
}