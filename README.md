# Squeeze

Compress a video to an exact target file size. Everything runs in the visitor's
browser — ffmpeg is compiled to WebAssembly and driven locally, so the file is
never uploaded and there is no backend to pay for.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

Deploy `dist/` to any static host.

## Why it is client-only

The encoder is ffmpeg compiled to WebAssembly, loaded from the bundle itself.
There is no upload endpoint, no temporary storage and no server-side job queue:
the bytes are read from the local disk with a streaming mount, encoded in the tab
and handed back as a download. The trade-off is speed — roughly 0.2–0.5×
realtime for 720p with multiple threads.

Multi-threading needs `SharedArrayBuffer`, which browsers only hand to
cross-origin isolated pages. Any host that can send two headers gets the fast
path:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`public/_headers` (Netlify, Cloudflare Pages) and `vercel.json` already do that,
and so do `vite dev` and `npm run preview`. **GitHub Pages cannot set response
headers**, so there the app detects the missing isolation and transparently falls
back to the single-threaded core — about three times slower, same output, still
entirely client-side. Both cores are bundled, hashed and lazily fetched, so only
the one the browser needs is downloaded.

## How it hits the target

A single CRF value cannot be computed up front: how many bits a frame deserves
depends on the footage, and how the file size responds to CRF depends on the
codec, the preset and the resolution. So the size is measured instead of
predicted.

1. **Budget.** The target bytes are turned into a bitrate, split into a video and
   an audio allowance, and expressed as bits per pixel per frame. Audio is never
   given more than ~15% of the budget, and never more than the source track
   already uses.
2. **First guess.** Encoder output is roughly exponential in CRF, so inverting
   that curve turns the bit budget into a starting CRF. Resolution-aware, and
   within a few points of the answer on ordinary footage.
3. **Search.** Each attempt is encoded, measured, and the next CRF is chosen by a
   secant step through the points measured so far — which converges in two or
   three attempts whatever the true size/CRF curve turns out to be. The search
   stops on the largest file that still fits the target, since that is the best
   quality available underneath it.
4. **Rate-control fallback.** Some footage bottoms out before it fits: at a low
   bitrate, no CRF setting can hit the budget at that resolution. When that
   happens — detected by two attempts landing within a few percent of each other
   — the encoder switches to a quality-greedy CRF with a VBV ceiling, and the
   ceiling is recalibrated against the size it actually produced until the file
   fits.

Overrides for resolution, frame rate, codec, audio and encoding effort are in
the "Fine tuning" panel. If nothing can reach the target, the app says so and
suggests a fix rather than silently handing back something that does not fit.

## Hosting on GitHub Pages

Push to `main` and the included workflow builds and deploys. Project sites are
served from `/<repo>/`, so the build needs to know its base:

```bash
BASE_PATH=/my-repo/ npm run build    # or: npm run build -- --base=/my-repo/
```

The workflow sets that automatically and handles the `/<user>.github.io/` case.
To check a production build locally, including the headers:

```bash
npm run build && npm run serve   # http://127.0.0.1:4173
```

## Nix

```bash
nix develop      # node 24, ffmpeg and git
nix build        # builds the site into the store
nix run .        # serves the built site on http://127.0.0.1:4173
nix flake check  # builds the site, typechecking along the way
```

The npm dependency tree is fetched once in a fixed-output derivation, so the
build itself never touches the network. The site is served by
`scripts/serve.mjs`, a dependency-free static server that sets the same
cross-origin isolation headers as the deploy configs.

## Limits

Each attempt is a full encode, so expect two to four of them depending on
"size accuracy". Video is read from disk through a streaming mount, so source
size is not bound by the wasm heap, but the encoded output lives in memory while
it is written — very large targets on long clips are the main way to run out.