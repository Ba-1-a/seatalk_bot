# AGENTS HANDOVER

## Project
SeaTalk bot with screenshot pipeline using Google Sheets -> PDF -> PNG -> SeaTalk.

## Current status
- ✅ Cloudflare Worker deployed: https://seatalk-bot.bawanappratama.workers.dev
- ✅ Private chat screenshot: **BERHASIL** (HF Spaces aktif kembali)
- ✅ Group chat screenshot: **BERHASIL** (setelah fix argument parsing + thread handling)
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
1. **Command spam handling**: ✅ DIPERBAIKI - strip @mention + deduplicate consecutive commands
2. **Group chat screenshot**: ✅ DIPERBAIKI - argument parsing + thread handling diperbaiki
3. **Auto-thread reply**: ✅ DIPERBAIKI - auto-threading untuk respons panjang di grup

## Next steps
- [x] Fix group chat screenshot execution
- [x] Implement spam-resistant rate limiting  
- [x] Fix auto-thread reply for long responses
- [ ] Scheduling screenshot (auto-report)
- [ ] Sheet context understanding untuk AI

## Cara Deploy yang Benar

### Prasyarat
- Node 22 terinstal di `bin/node-22.23.1/`
- Wrangler sudah terautentikasi (OAuth atau API token)

### Langkah-langkah deploy:

1. **Commit & push semua perubahan ke GitHub**
   ```powershell
   cd projects/ba-1-a/seatalk_bot
   git add .
   git commit -m "fix: ..."
   git push origin main
   ```

2. **Deploy Cloudflare Worker menggunakan Node 22**
   ```powershell
   cd projects/ba-1-a/seatalk_bot
   $env:CLOUDFLARE_API_TOKEN = 'cfut_bc8SlAhJhsr7zpQhovoztYVaUbHkM1vG3deMQzL856825c05'
   C:\Users\SPXID3657\Documents\Bawan\Kode\bin\node-22.23.1\node.exe node_modules\wrangler\bin\wrangler.js deploy
   ```
   atau menggunakan PowerShell script:
   ```powershell
   .\deploy-fix.ps1 -SkipGit
   ```

3. **Deploy Vercel function** (jika ada perubahan di `api/pdf-to-png.js`)
   ```powershell
   cd projects/ba-1-a/seatalk_bot
   vercel --prod --yes
   ```

### Catatan penting:
- Jangan gunakan `npx.cmd` langsung karena akan menggunakan Node versi sistem (v20), yang tidak didukung wrangler
- Wrangler v4.x membutuhkan Node.js v22.0.0 atau lebih tinggi
- Sebelum deploy, pastikan semua secrets sudah di-set via `wrangler secret put`

## Credentials reference
- See `Ba-1-note.md` for complete infrastructure credentials
- Use `wrangler secret put` for sensitive values
