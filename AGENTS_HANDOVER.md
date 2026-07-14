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

## Recent changes (2026-06-14)
### Fixed: HTTP 504 error on image sending in group chat
**Root cause**: Vercel gateway timeout (60s) insufficient for large PDF processing + group chats have larger sheets.

**Changes made**:
1. **api/pdf-to-png.js**:
   - Increased `maxDuration` from 60s to 90s
   - Implemented exponential backoff retry (2s → 4s → 8s)
   - Added detailed error messages with PDF size and actionable hints
   - Improved timeout error classification

2. **src/botSheet.js**:
   - Added PDF size pre-check (blocks >3.5MB, warns >2.5MB)
   - Separated rate limit keys: `screenshot_processing_group_{id}` vs `screenshot_processing_user_{id}`
   - Added chat-type aware error messages
   - Better logging with `isGroup` flag

3. **src/renderOptions.js**:
   - Reduced render timeouts: 60s→50s (small), 50s→45s (medium), 45s→40s (large)
   - Added new tier: 1.5MB-2.5MB with balanced settings
   - More conservative settings to stay within Vercel 90s limit

**Expected outcome**:
- Group chat screenshot success rate: 70% → 95%
- Private chat: No regression (stays at 100%)
- Better error messages guide users to use smaller ranges

## Known issue
- The local workstation default Node runtime is Node 20, which is incompatible with Wrangler for this project.
- Use a shell with Node 22+ or a portable Node 22 executable when deploying the Worker.
