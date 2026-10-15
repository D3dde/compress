# Squeeze

Compress a video to an exact target file size, entirely in the browser. No uploads, no server.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

Deploy `dist/` to any static host.

## How it works

ffmpeg compiled to WebAssembly runs locally. The encoder is downloaded once (~32 MB), then the browser caches it.

To hit the target size, the app doesn't guess a CRF — it measures. Each attempt is encoded, its size checked, and the next CRF is chosen by a secant step through the measured points. Converges in 2–4 passes. If the footage hits a quality floor, it switches to rate control with a recalibrated VBV ceiling.

Overrides for resolution, frame rate, codec, audio, and speed are in "Fine tuning".

## GitHub Pages

Push to `main` — the workflow builds with `BASE_PATH=/compress/` and deploys automatically. Enable **Settings → Pages → Source: GitHub Actions**.

## Nix

```bash
nix develop      # node 24, ffmpeg, git
nix build        # builds site to store
nix run .        # serves on http://127.0.0.1:4173
nix flake check  # builds + typechecks
```

Dependencies are fetched once in a fixed-output derivation; the build is offline.

## Limits

Each attempt is a full re-encode (2–4 typical). Output lives in memory during encoding — very large targets on long clips may OOM.