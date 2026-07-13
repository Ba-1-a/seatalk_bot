# AGENTS HANDOVER

## Project
SeaTalk bot with screenshot pipeline using Google Sheets -> PDF -> PNG -> SeaTalk.

## Current status
- Vercel gateway and HF Spaces backend have been updated for lighter render behavior.
- Bot screenshot flow now uses a render option payload and better error handling for timeout cases.
- Local syntax validation passed for the updated Node files.
- Live Cloudflare Worker deployment is still blocked by the local runtime because Wrangler requires Node 22+ while this environment provides Node 20.

## Important files
- src/botSheet.js
- api/pdf-to-png.js
- hf-spaces/api/index.js
- src/renderOptions.js
- wrangler.toml

## What to do next
1. Deploy the updated Vercel app and verify the live endpoint.
2. Deploy the Cloudflare Worker from a Node 22 environment.
3. Re-test screenshot flow for both single chat and group chat.
4. Validate thread reply behavior for longer responses.

## Credentials / environment notes
- Keep secrets in the platform secret store, not in source files.
- Use the provided Vercel token and Cloudflare token when deploying.

## Known issue
- The local workstation currently runs Node 20, which blocks Wrangler deployment. Use a machine or shell with Node 22+ for the Worker deployment step.
