# AGENTS HANDOVER

## Project
SeaTalk bot with screenshot pipeline using Google Sheets -> PDF -> PNG -> SeaTalk.

## Current status
- Vercel gateway and HF Spaces backend have been updated for lighter render behavior.
- Bot screenshot flow now uses a render option payload and better error handling for timeout cases.
- The Cloudflare Worker has been deployed successfully.
- Live Worker endpoint:
  - https://seatalk-bot.bawanappratama.workers.dev
- Smoke test against the live Worker returned HTTP 200.

## Important files
- src/botSheet.js
- api/pdf-to-png.js
- hf-spaces/api/index.js
- src/renderOptions.js
- wrangler.toml

## What to do next
1. Verify the Vercel gateway endpoint and HF Spaces backend from the deployed service.
2. Run the screenshot flow end-to-end for private chat and group chat scenarios.
3. Confirm the Worker handles timeouts and render options correctly.
4. Validate thread reply behavior for longer responses.

## Credentials / environment notes
- Keep secrets in the platform secret store, not in source files.
- Use `wrangler secret put` for Cloudflare secrets:
  - SEATALK_APP_ID
  - SEATALK_APP_SECRET
  - GOOGLE_PRIVATE_KEY
  - SUPABASE_SERVICE_ROLE_KEY
- Cloudflare deployment was performed using a portable Node 22 runtime because the local shell defaults to Node 20.

## Known issue
- The local workstation default Node runtime is Node 20, which is incompatible with Wrangler for this project.
- Use a shell with Node 22+ or a portable Node 22 executable when deploying the Worker.
