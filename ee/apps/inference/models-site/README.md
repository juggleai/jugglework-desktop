# JuggleWork Model Catalog

This directory is the static publish root for the generated JuggleWork model catalog.

Cloudflare Pages can deploy this directory directly:

- Build command: `pnpm --dir ee/apps/inference models:build`
- Build output directory: `ee/apps/inference/models-site`
- Catalog URL: `/models/api.json`

The generated `models/api.json` file is ignored by git. It is rebuilt from `src/models/base.json` and the active JuggleWork overlay by `scripts/build-models.mjs`.

JuggleWork-specific models live in `src/models/openwork-models.json`. `scripts/build-models.mjs` turns that list into the JuggleWork provider overlay at build time and switches the provider API URL based on `OPENWORK_DEV_MODE`.

Local development still serves the generated catalog from the inference Hono app at `/models/api.json` so one local service can provide both the proxy API and model catalog during dev.
