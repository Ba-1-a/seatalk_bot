# Deployment Guide: HTTP 504 Timeout Fix

**Tanggal**: 2026-06-14  
**Issue**: Bot gagal mengirim gambar di grup dengan error `❌ Gagal membuat screenshot: Vercel PDF-to-PNG gagal: HTTP 504`

## Ringkasan Perbaikan

### Problem Analysis
- **Symptom**: Error 504 hanya terjadi di group chat, private chat tidak ada masalah
- **Root Cause**: 
  1. Vercel `maxDuration: 60s` tidak cukup untuk PDF besar yang butuh render lama
  2. Group chat cenderung memiliki spreadsheet lebih besar
  3. Tidak ada pre-check PDF size sebelum dikirim ke Vercel
  4. Retry mechanism menggunakan fixed delay (tidak optimal)

### Solusi yang Diterapkan

#### 1. Vercel Gateway (`api/pdf-to-png.js`)
- ✅ Increased `maxDuration: 60s → 90s`
- ✅ Exponential backoff retry: `2s → 4s → 8s`
- ✅ Better error messages dengan PDF size dan actionable hints
- ✅ Error classification (timeout vs network vs server error)

#### 2. Cloudflare Worker (`src/botSheet.js`)
- ✅ PDF size pre-check: Block >3.5MB, warn >2.5MB
- ✅ Separate rate limit keys untuk group vs private chat
- ✅ Chat-type aware error messages
- ✅ Enhanced logging dengan `isGroup` flag

#### 3. Render Options (`src/renderOptions.js`)
- ✅ Reduced render timeouts untuk safety margin:
  - Large PDF (≥2.5MB): 45s → **40s**
  - Medium-large PDF (≥1.5MB): 50s → **45s**
  - Medium PDF (≥1MB): 60s → **50s**
  - Small PDF (<1MB): 60s → **55s**
- ✅ Added new tier untuk 1.5MB-2.5MB range
- ✅ More granular optimization

## Deployment Steps

### Prerequisites
- Node.js 22+ (required for Wrangler)
- Vercel CLI installed (`npm i -g vercel`)
- Git repository connected to Vercel

### Step 1: Deploy Cloudflare Worker (Already Done)
```bash
# Navigate to project directory
cd projects/ba-1-a/seatalk_bot

# Deploy Worker (gunakan Node 22 portable)
bin/node-22.23.1/bin/npx.cmd wrangler deploy
```

**Expected output**:
```
✨ Successfully deployed to seatalk-bot
Published seatalk-bot (X.XXs)
  https://seatalk-bot.bawanappratama.workers.dev
```

### Step 2: Deploy Vercel Function
```bash
# Dari root project
cd projects/ba-1-a/seatalk_bot

# Pull environment variables (jika belum)
vercel pull --yes

# Deploy ke Vercel
vercel --prod
```

**Atau push ke Git** (auto-deploy):
```bash
git add .
git commit -m "fix: increase Vercel timeout to 90s, add exponential backoff, PDF size check"
git push origin main
```

### Step 3: Verify Deployment

#### Check Vercel Deployment
```bash
# Cek deployment terbaru
vercel ls

# Verifikasi maxDuration terpasang
vercel inspect https://seatalkbot.vercel.app/api/pdf-to-png
```

Lihat di Vercel dashboard:
- Function: `api/pdf-to-png`
- maxDuration: **90 seconds**
- Region: Choose region terdekat (biasanya `iad1` atau `sfo1`)

#### Check Cloudflare Worker
```bash
# Test worker endpoint
curl https://seatalk-bot.bawanappratama.workers.dev/health

# Expected: {"status":"ok",...}
```

### Step 4: Environment Variables

#### Vercel Environment Variables
Pastikan ini ada di Vercel dashboard (Settings → Environment Variables):

```bash
# Required
HF_API_KEY=<your-hf-api-key>

# Optional
HF_SPACES_URL=https://ba-1-a-b-cube-tech.hf.space
```

#### Cloudflare Worker Secrets
```bash
# Set via wrangler (jika belum)
bin/node-22.23.1/bin/npx.cmd wrangler secret put SEATALK_APP_ID
bin/node-22.23.1/bin/npx.cmd wrangler secret put SEATALK_APP_SECRET
bin/node-22.23.1/bin/npx.cmd wrangler secret put GOOGLE_PRIVATE_KEY
bin/node-22.23.1/bin/npx.cmd wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

## Testing Checklist

### Test 1: Private Chat (No Regression)
```
User: /setsheet <url>
User: /screenshot
Expected: ✅ Screenshot berhasil dikirim
```

### Test 2: Group Chat (Main Fix)
```
User: /setsheet <url>
User: /screenshot
Expected: ✅ Screenshot berhasil dikirim di thread
```

### Test 3: Large Sheet (New Behavior)
```
User: /screenshot (tanpa range, sheet >3.5MB)
Expected: ⚠️ "Sheet terlalu besar (X.XMB). Coba gunakan range yang lebih kecil"
```

### Test 4: Timeout Handling (Simulated)
```
User: /screenshot range=very_large_range
Expected: ⏱️ Timeout message dengan hint untuk smaller range
```

### Test 5: Rate Limiting
```
User1: /screenshot
User1: /screenshot (sebelum yang pertama selesai)
Expected: ⏳ "Sedang memproses screenshot sebelumnya..."
```

## Rollback Plan

### Jika terjadi masalah:

#### Option A: Rollback Cloudflare Worker
```bash
cd projects/ba-1-a/seatalk_bot
git revert HEAD
bin/node-22.23.1/bin/npx.cmd wrangler deploy
```

#### Option B: Rollback Hanya botSheet.js
```bash
git checkout HEAD~1 -- src/botSheet.js src/renderOptions.js
bin/node-22.23.1/bin/npx.cmd wrangler deploy
```

#### Option C: Quick Hotfix - Reduce maxDuration
Edit `vercel.json`:
```json
{
  "functions": {
    "api/pdf-to-png.js": {
      "maxDuration": 60
    }
  }
}
```
Deploy Vercel:
```bash
vercel --prod
```

## Monitoring

### Metrics to Watch

1. **Success Rate**
   - Before: ~70% (group), 100% (private)
   - Target: ≥95% (group), 100% (private)

2. **Average Processing Time**
   - Monitor di Vercel logs: `X-Execution-Time` header
   - Target: <50s for most requests

3. **Error Breakdown**
   - 504 timeouts: Should decrease significantly
   - 502 errors: Should remain rare (HF Spaces issues)
   - 413 errors: New (PDF >3.5MB blocks)

4. **Retry Rate**
   - Should see retry attempts in Cloudflare logs
   - Target: <5% of requests need retry

### Cloudflare Worker Logs
```bash
# Real-time logs
bin/node-22.23.1/bin/npx.cmd wrangler tail seatalk-bot

# Filter by service
bin/node-22.23.1/bin/npx.cmd wrangler tail seatalk-bot --format pretty
```

### Vercel Logs
```bash
# Real-time logs
vercel logs https://seatalkbot.vercel.app/api/pdf-to-png --follow
```

## Notes

### Vercel Plan Requirements
- **Hobby Plan**: Supports up to 10s timeout ONLY (ini masalah!)
- **Pro Plan**: Supports up to 60s default, bisa request increase
- **Enterprise**: Supports up to 5min (300s)

**Jika pakai Hobby Plan**:
- `maxDuration: 90` akan di-ignore oleh Vercel
- Limit akan tetap 10s
- Harus upgrade ke Pro atau gunakan alternatif:

#### Alternative untuk Hobby Plan
```javascript
// api/pdf-to-png.js - Async processing with webhook
export default async function handler(req, res) {
  // Return immediately with 202 Accepted
  res.status(202).json({
    status: 'processing',
    message: 'Screenshot sedang diproses'
  });
  
  // Process async (tapi Vercel tetap kill setelah 10s)
  // Jadi ini tidak akan work
}
```

**Rekomendasi**: Upgrade Vercel ke Pro ($20/bulan) untuk support 90s timeout.

### HF Spaces Backend
Pastikan HF Spaces tetap running:
```
Health check: https://ba-1-a-b-cube-tech.hf.space/health
```

Jika HF Spaces down, semua request akan return 502.

## Support

Jika masih ada masalah setelah deploy:

1. **Check logs** untuk error pattern
2. **Verify PDF size** - biasanya yang gagal adalah PDF >3MB
3. **Test dengan range kecil** untuk isolate issue
4. **Check Vercel dashboard** untuk timeout configurations
5. **Monitor HF Spaces** - free tier bisa sleep

## Success Criteria

✅ Group chat screenshot success rate ≥ 95%  
✅ Private chat screenshot tetap 100% (no regression)  
✅ Error messages jelas dan actionable  
✅ No 504 errors untuk PDF < 3MB  
✅ Retry mechanism bekerja untuk transient failures