# Debug & Logs Guide - VASA Seatalk Bot

**Tanggal**: 22 Juni 2026  
**Purpose**: Panduan lengkap untuk debug dan monitoring bot

---

## Quick Links

| Service | Dashboard | Logs |
|---------|-----------|------|
| **Cloudflare Worker** | https://dash.cloudflare.com | Workers → seatalk-bot → Logs |
| **Vercel** | https://vercel.com/ba1a-s-projects/seatalk_bot | Deployments → [Latest] → Logs |
| **HF Spaces** | https://ba-1-a-b-cube-tech.hf.space | HF Dashboard → Spaces → B-Cube_Tech → Logs |
| **GitHub** | https://github.com/Ba-1-a/seatalk_bot | Actions → Workflows |

---

## 1. Cloudflare Worker Logs

### Access:
```
https://dash.cloudflare.com → Workers & Pages → seatalk-bot → Logs
```

### Yang Dicari:

**✅ Success Indicators**:
```
[reqId] Incoming message { senderId, groupId, isGroup }
[reqId] Routing → /screenshot
[reqId] Background: Starting screenshot processing
```

**❌ Error Indicators**:
```
[reqId] Missing required secrets { missing: [...] }
[reqId] Worker error { error: ... }
[reqId] Duplicate message detected via dedup key
```

### Common Issues:

| Error | Meaning | Solution |
|-------|---------|----------|
| `Missing required secrets` | Secret tidak di-set | Set via `wrangler secret put` atau Dashboard |
| `Duplicate message detected` | Bot sudah proses message ini | Normal (deduplication bekerja) |
| `Google OAuth gagal` | Service account issue | Cek GOOGLE_PRIVATE_KEY dan GOOGLE_CLIENT_EMAIL |
| `Export PDF gagal` | Spreadsheet tidak bisa di-export | Cek akses Service Account ke spreadsheet |

---

## 2. Vercel Logs

### Access:
```
https://vercel.com/ba1a-s-projects/seatalk_bot → Deployments → [Latest] → Logs
```

### Yang Dicari:

**✅ Success Indicators**:
```
Forwarding PDF (42219 bytes) to HF Spaces
Attempt 1: Sending PDF to HF Spaces...
PNG received from HF Spaces (attempt 1): 262407 bytes
```

**❌ Error Indicators**:
```
HF_API_KEY not configured → 500
HF Spaces error: 403 → Invalid API key
HF Spaces error: 502 → Bad gateway
HF Spaces proxy error: ReferenceError → Bug di code
```

### Common Issues:

| Error | Meaning | Solution |
|-------|---------|----------|
| `HF_API_KEY not configured` | Env var tidak ada | Set di Vercel Dashboard → Environment Variables |
| `Invalid API key` (403) | HF_API_KEY salah/expired | Cek token di https://huggingface.co/settings/tokens |
| `ReferenceError: response is not defined` | Bug di code | Sudah di-fix di commit d9b5119 |
| `Timeout (>45s)` | HF Spaces lambat | Normal untuk PDF besar, tunggu atau retry |

---

## 3. HF Spaces Logs

### Access:
```
https://huggingface.co/spaces/ba-1-a/B-Cube_Tech → Logs
```

### Yang Dicari:

**✅ Success Indicators**:
```
[timestamp] Processing PDF: 42224 bytes
[timestamp] Screenshot done: 262997 bytes in 6186ms
```

**❌ Error Indicators**:
```
Error: Invalid API key
Error: PDF too large
Error: Puppeteer timeout
```

### Common Issues:

| Error | Meaning | Solution |
|-------|---------|----------|
| `Invalid API key` | HF_API_KEY salah | Cek Vercel env var |
| `PDF too large` | PDF > 10MB | Reduce range atau optimize spreadsheet |
| `Puppeteer timeout` | Chromium lambat | Normal untuk PDF kompleks, retry akan jalan |

---

## 4. Debug Checklist

### Screenshot Gagal? Cek Berurutan:

**Step 1: Cloudflare Worker**
```
https://dash.cloudflare.com → Workers → seatalk-bot → Logs
```
- [ ] Bot menerima command `/screenshot`?
- [ ] Google OAuth token berhasil?
- [ ] PDF export dari Google Drive berhasil?
- [ ] Request ke Vercel terkirim?

**Step 2: Vercel**
```
https://vercel.com/ba1a-s-projects/seatalk_bot → Logs
```
- [ ] Vercel menerima PDF?
- [ ] HF_API_KEY ter-set?
- [ ] Request ke HF Spaces terkirim?
- [ ] Response dari HF Spaces diterima?

**Step 3: HF Spaces**
```
https://huggingface.co/spaces/ba-1-a/B-Cube_Tech → Logs
```
- [ ] HF Spaces menerima PDF?
- [ ] Processing berhasil?
- [ ] PNG di-return?

**Step 4: SeaTalk**
- [ ] Bot mengirim pesan "processing"?
- [ ] Bot mengirim error message?
- [ ] PNG terkirim ke chat?

---

## 5. Log Patterns untuk Debug

### Pattern 1: Screenshot Success Flow
```
Cloudflare: [reqId] Routing → /screenshot
Cloudflare: [reqId] Background: Starting screenshot processing
Cloudflare: [reqId] PDF exported { sizeBytes: 42224 }
Cloudflare: [reqId] PNG received from Vercel { sizeBytes: 262407 }
Vercel: Forwarding PDF (42219 bytes) to HF Spaces
Vercel: Attempt 1: Sending PDF to HF Spaces...
Vercel: PNG received from HF Spaces (attempt 1): 262407 bytes
HF Spaces: Processing PDF: 42224 bytes
HF Spaces: Screenshot done: 262997 bytes in 6186ms
```

### Pattern 2: 403 Error (HF_API_KEY Missing)
```
Vercel: Forwarding PDF (42219 bytes) to HF Spaces
Vercel: Attempt 1: Sending PDF to HF Spaces...
Vercel: HF Spaces error (attempt 1): 403 {"error":"Invalid API key"}
Cloudflare: ❌ Gagal membuat screenshot: Vercel PDF-to-PNG gagal: HTTP 403
```

### Pattern 3: 502 Error (Bug di Code)
```
Vercel: Forwarding PDF (42219 bytes) to HF Spaces
Vercel: Attempt 1: Sending PDF to HF Spaces...
Vercel: PNG received from HF Spaces (attempt 1): 262407 bytes
Vercel: HF Spaces proxy error: ReferenceError: response is not defined
Cloudflare: ❌ Gagal membuat screenshot: Vercel PDF-to-PNG gagal: HTTP 502
```

---

## 6. Monitoring Commands

### Cloudflare (via Wrangler):
```bash
# Tail logs real-time
wrangler tail

# Filter by service
wrangler tail --service botSheet
wrangler tail --service core
```

### Vercel (via CLI):
```bash
# View logs
vercel logs seatalkbot.vercel.app

# Follow logs real-time
vercel logs seatalkbot.vercel.app --follow
```

### GitHub Actions:
```bash
# View workflow runs
gh run list

# View specific run logs
gh run view <run-id> --log-failed
```

---

## 7. Quick Debug Commands

### Test Cloudflare Worker:
```bash
# Health check
curl https://seatalk-bot.bawanappratama.workers.dev

# Expected: "Bot Active"
```

### Test Vercel:
```bash
# Health check (should return 405)
curl https://seatalkbot.vercel.app/api/pdf-to-png

# Test with sample PDF (should return 400 or 405)
curl -X POST https://seatalkbot.vercel.app/api/pdf-to-png \
  -H "Content-Type: application/json" \
  -d '{"pdf_base64": "test"}'
```

### Test HF Spaces:
```bash
# Health check
curl https://ba-1-a-b-cube-tech.hf.space/health

# Expected: JSON with status "ok"
```

### Test Google Drive Export:
```bash
# Manual test (butuh token)
curl -H "Authorization: Bearer <token>" \
  "https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/export?format=pdf"
```

---

## 8. Log Retention

| Service | Retention | Notes |
|---------|-----------|-------|
| Cloudflare Workers | 7 days (free tier) | Upgrade untuk longer retention |
| Vercel | 30 days (pro) / 1 day (free) | Check Vercel plan |
| HF Spaces | Real-time only | Logs hilang setelah restart |
| GitHub Actions | 90 days | Unlimited untuk private repos |

---

## 9. Alerting (Future Enhancement)

Untuk production, pertimbangkan:
- **Cloudflare Analytics**: https://dash.cloudflare.com → Analytics → Workers
- **Vercel Monitoring**: https://vercel.com/dashboard → Monitoring
- **Uptime Robot**: Monitor endpoint health
- **Sentry**: Error tracking (jika perlu)

---

## 10. Troubleshooting Decision Tree

```
Screenshot gagal?
├─ Cloudflare log ada error?
│  ├─ Missing secrets → Set secrets
│  ├─ Google OAuth error → Cek service account
│  └─ PDF export error → Cek spreadsheet access
│
├─ Vercel log ada error?
│  ├─ 403 → Set HF_API_KEY
│  ├─ 502 → Check HF Spaces status
│  └─ Timeout → Normal untuk PDF besar
│
├─ HF Spaces log ada error?
│  ├─ Invalid API key → Cek Vercel env var
│  ├─ PDF too large → Reduce range
│  └─ Puppeteer error → HF Spaces issue
│
└─ Bot tidak respond?
   ├─ Cek SeaTalk webhook URL
   ├─ Cek Cloudflare Worker URL
   └─ Cek KV namespace binding
```

---

## Quick Reference Card

**Cloudflare Worker URL**: https://seatalk-bot.bawanappratama.workers.dev  
**Vercel URL**: https://seatalkbot.vercel.app  
**HF Spaces**: https://ba-1-a-b-cube-tech.hf.space  
**GitHub**: https://github.com/Ba-1-a/seatalk_bot  

**Common Commands**:
```bash
# Deploy Cloudflare
$env:CLOUDFLARE_API_TOKEN="<token>"; wrangler deploy

# Deploy Vercel
$env:VERCEL_TOKEN="<token>"; vercel --prod

# Tail Cloudflare logs
wrangler tail

# View Vercel logs
vercel logs seatalkbot.vercel.app
```

---

**Last Updated**: 22 Juni 2026, 15:00 WIB  
**Maintained By**: Bawan Pratama  
**Status**: Active