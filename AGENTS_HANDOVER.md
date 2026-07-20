# AGENTS HANDOVER

## Project
SeaTalk bot with screenshot pipeline using Google Sheets -> PDF -> PNG -> SeaTalk.

## Current status
- ✅ Cloudflare Worker deployed: https://seatalk-bot.bawanappratama.workers.dev
- ✅ Private chat screenshot: **BERHASIL** (HF Spaces aktif kembali)
- ⚠️ Group chat screenshot: Perlu perbaikan
- ✅ Vercel gateway: maxDuration 90s, exponential backoff retry

## Important files
- src/botSheet.js - Spreadsheet engine & screenshot pipeline
- src/botCoding.js - Natural language intent detection
- src/aiHandler.js - Cloudflare Workers AI integration
- src/utils.js - SeaTalk API helpers
- api/pdf-to-png.js - Vercel PDF-to-PNG endpoint (90s timeout)
- hf-spaces/api/index.js - Puppeteer PDF-to-PNG di Hugging Face
- src/renderOptions.js - Adaptive render options based on PDF size

## Known issues (from Ba-1-note.md)
1. **Command spam handling**: Bot tidak tahan spam, muncul error HTTP 403
2. **Group chat screenshot**: Bot hanya kirim pesan info, tidak eksekusi `/screenshot`
3. **Auto-thread reply**: Bot tidak membalas di thread untuk jawaban panjang

## Next steps
- [ ] Fix group chat screenshot execution
- [ ] Implement spam-resistant rate limiting  
- [ ] Fix auto-thread reply for long responses
- [ ] Scheduling screenshot (auto-report)
- [ ] Sheet context understanding untuk AI

## Credentials reference
- See `Ba-1-note.md` for complete infrastructure credentials
- Use `wrangler secret put` for sensitive values