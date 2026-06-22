# Deployment Guide - VASA Seatalk Bot

## Status: ✅ Code Ready, ⚠️ Deployment Pending

**Tanggal**: 22 Juni 2026  
**Commit**: `5af51b9` - fix: group chat messaging  
**Branch**: main  
**Repository**: https://github.com/Ba-1-a/seatalk_bot

---

## Yang Sudah Dilakukan

✅ **Code Changes** - Semua perbaikan sudah di-commit dan push ke GitHub:
- Thread handling fix
- Rate limiting untuk screenshot
- Group chat screenshot threading
- HF Spaces integration hardening

✅ **Documentation** - `docs/group-chat-fixes-v1.md` sudah dibuat

⚠️ **Deployment** - Menunggu deploy ke Cloudflare Workers

---

## Deployment Options

### Option 1: Install Node.js/npm (Recommended)

1. **Download Node.js** dari https://nodejs.org/ (versi LTS)
2. **Install** dengan default settings
3. **Restart terminal** dan verify:
   ```bash
   node --version
   npm --version
   ```
4. **Deploy**:
   ```bash
   npm run deploy
   ```

### Option 2: Cloudflare Dashboard (Tanpa npm)

1. **Login** ke Cloudflare Dashboard: https://dash.cloudflare.com
2. **Pilih Workers & Pages** dari sidebar
3. **Cari worker** "seatalk-bot" (atau buat baru jika belum ada)
4. **Quick Edit** atau **Settings** → **Deployments**
5. **Connect to Git** → Pilih GitHub repo `Ba-1-a/seatalk_bot`
6. **Branch**: `main`
7. **Root directory**: `/` (root project)
8. **Build command**: (kosongkan, karena ini Worker)
9. **Deploy**

### Option 3: Manual Upload via Wrangler CLI

Jika Wrangler sudah terinstall secara global:

```bash
# Login ke Cloudflare
wrangler login

# Deploy
wrangler deploy
```

---

## Environment Variables yang Harus Di-set

### Di Cloudflare Workers Dashboard:

**Secrets** (via `wrangler secret put` atau Dashboard):
- `SEATALK_APP_ID` = `NzE2Mjg3ODUxMjc5`
- `SEATALK_APP_SECRET` = `c3urIS7asdvFi0rIwbhuAKBklGWY1yQv`
- `GOOGLE_PRIVATE_KEY` = (full JSON key dari Ba-1-note.md)
- `GOOGLE_CLIENT_EMAIL` = `vasa-725@studio-1196053014-a94d0.iam.gserviceaccount.com`

**Variables** (via `wrangler.toml` atau Dashboard):
- `GOOGLE_CLIENT_EMAIL` = `vasa-725@studio-1196053014-a94d0.iam.gserviceaccount.com`
- `SUPABASE_URL` = `https://gsdtravhmqbzkwdujkve.supabase.co`
- `VERCEL_PDF_TO_PNG_URL` = `https://seatalkbot.vercel.app/api/pdf-to-png`

### Di Vercel Dashboard:

**Environment Variables** untuk `api/pdf-to-png.js`:
- `HF_API_KEY` = `adf66d648188c72c3173b698948a128f4b8f7a13b32014bff9ee914b43a6007a`
- `HF_SPACES_URL` = `https://ba-1-a-b-cube-tech.hf.space` (optional, ini default)

**Settings** → **General** → **Build & Development Settings**:
- Framework Preset: Other
- Build Command: (kosongkan)
- Output Directory: (kosongkan)
- Install Command: `npm install` (atau biarkan default Vercel)

---

## Post-Deployment Checklist

### Cloudflare Worker:
- [ ] Worker URL aktif: `https://seatalk-bot.bawanappratama.workers.dev`
- [ ] Test endpoint: `curl https://seatalk-bot.bawanappratama.workers.dev` (harus return "Bot Active")
- [ ] Verify KV namespace binding: `BOT_MEMORY`
- [ ] Verify AI binding aktif
- [ ] Check logs di Cloudflare Dashboard → Workers → seatalk-bot → Logs

### Vercel:
- [ ] Vercel deployment success: https://seatalkbot.vercel.app/
- [ ] Test health check: `curl https://seatalkbot.vercel.app/api/pdf-to-png` (harus return method error)
- [ ] Verify environment variables ter-set
- [ ] Check Vercel logs untuk error

### SeaTalk Integration:
- [ ] Webhook URL di SeaTalk App settings: `https://seatalk-bot.bawanappratama.workers.dev`
- [ ] Test webhook verification (seatalk_challenge)
- [ ] Test di group chat: `/screenshot`
- [ ] Test di single chat: `/screenshot`
- [ ] Test auto-threading untuk jawaban panjang

---

## Troubleshooting

### npm tidak ditemukan:
- Install Node.js dari https://nodejs.org/
- Atau gunakan Option 2 (Cloudflare Dashboard)

### Worker tidak deploy:
- Cek `wrangler.toml` syntax
- Cek Cloudflare API token validity
- Cek account_id di `wrangler.toml`

### Vercel error 502:
- Cek HF Spaces status: https://ba-1-a-b-cube-tech.hf.space
- Cek HF_API_KEY di Vercel environment variables
- Cek Vercel logs untuk detail error

### Bot tidak respond di SeaTalk:
- Cek SeaTalk App permissions
- Cek webhook URL benar
- Cek Cloudflare Worker logs
- Cek KV namespace binding

---

## Rollback

Jika ada masalah setelah deploy:

```bash
# Rollback ke commit sebelumnya
git revert HEAD
git push origin main

# Atau rollback ke commit spesifik
git reset --hard <commit-hash>
git push origin main --force
```

---

## Contact & Support

- **Repository**: https://github.com/Ba-1-a/seatalk_bot
- **Documentation**: `docs/group-chat-fixes-v1.md`
- **Issues**: Buat issue di GitHub repo

---

## Next Steps Setelah Deploy

1. **Monitor logs** selama 24 jam pertama
2. **Test semua command** di SeaTalk (single chat & group chat)
3. **Verify thread handling** bekerja dengan benar
4. **Check rate limiting** - pastikan tidak ada false positive
5. **Monitor HF Spaces** - pastikan tidak ada timeout/error
6. **Collect feedback** dari user

---

**Last Updated**: 22 Juni 2026, 13:24 WIB  
**Deployed By**: Bawan Pratama  
**Status**: ⏳ Menunggu deployment manual