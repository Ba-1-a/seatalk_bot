# Vercel 403 Error - Quick Fix Guide

**Error**: `❌ Gagal membuat screenshot: Vercel PDF-to-PNG gagal: HTTP 403`  
**Root Cause**: `HF_API_KEY` tidak ada atau invalid di Vercel environment variables  
**Date**: 22 Juni 2026

---

## Langkah Perbaikan (5 Menit)

### 1. Buka Vercel Dashboard
```
https://vercel.com
```

### 2. Pilih Project
- Cari project: **seatalkbot** 
- Atau: https://seatalkbot.vercel.app/

### 3. Buka Environment Variables
```
Settings → Environment Variables
```

### 4. Tambahkan HF_API_KEY

Klik **Add New**:

| Field | Value |
|-------|-------|
| **Name** | `HF_API_KEY` |
| **Value** | `adf66d648188c72c3173b698948a128f4b8f7a13b32014bff9ee914b43a6007a` |
| **Environment** | Production (checklist ini) |
| **Environment** | Preview (checklist ini) |
| **Environment** | Development (checklist ini) |

Klik **Save**

### 5. (Optional) Tambahkan HF_SPACES_URL

Klik **Add New** lagi:

| Field | Value |
|-------|-------|
| **Name** | `HF_SPACES_URL` |
| **Value** | `https://ba-1-a-b-cube-tech.hf.space` |
| **Environment** | Production, Preview, Development |

Klik **Save**

### 6. Redeploy Vercel

**Option A: Via Dashboard**
- Deployments → Redeploy (pilih deployment terbaru)

**Option B: Via Git Push**
```bash
# Push perubahan apapun ke trigger redeploy
git commit --allow-empty -m "trigger vercel redeploy"
git push origin main
```

---

## Verifikasi

Setelah redeploy, test Vercel endpoint:

```bash
# Test health check
curl https://seatalkbot.vercel.app/api/pdf-to-png

# Harusnya return error 405 (method not allowed) atau 400
# BUKAN 403 (forbidden)
```

### Test via SeaTalk:
1. Buka SeaTalk
2. Kirim command: `/screenshot`
3. Harusnya berhasil (tidak ada error 403)

---

## Troubleshooting

### Jika masih 403 setelah setup:

**Cek 1: Environment Variables Ter-set**
```bash
# Via Vercel CLI
vercel env ls
```

**Cek 2: HF Spaces Status**
- Buka: https://ba-1-a-b-cube-tech.hf.space
- Harusnya return JSON response (bukan error)

**Cek 3: HF_API_KEY Valid**
- Login ke Hugging Face: https://huggingface.co/settings/tokens
- Cek apakah token `adf66d648188c72c3173b698948a128f4b8f7a13b32014bff9ee914b43a6007a` masih aktif

**Cek 4: Vercel Logs**
- Vercel Dashboard → seatalkbot → Logs
- Cari error detail tentang HF_API_KEY

---

## Alternative: Skip Vercel, Direct to HF Spaces

Jika Vercel continue bermasalah, kita bisa ubah arsitektur:

**Current**: Cloudflare → Vercel → HF Spaces  
**Alternative**: Cloudflare → HF Spaces (direct)

Perubahan yang dibutuhkan:
1. Update `src/botSheet.js` - `convertPdfToPng()` langsung call HF Spaces
2. Update `wrangler.toml` - tambahkan HF_API_KEY sebagai secret
3. Remove dependency ke Vercel

Mau saya prepare alternative ini juga?

---

## Quick Checklist

- [ ] HF_API_KEY sudah di-set di Vercel
- [ ] HF_SPACES_URL sudah di-set di Vercel (optional)
- [ ] Vercel sudah di-redeploy
- [ ] Test `/screenshot` di SeaTalk
- [ ] Verify tidak ada error 403

---

**Last Updated**: 22 Juni 2026, 14:28 WIB  
**Status**: ⏳ Menunggu user set environment variables di Vercel