# Secrets Setup Guide

Panduan lengkap untuk setup semua secrets yang dibutuhkan oleh VASA Bot.

## Daftar Secrets

| Secret | Wajib | Deskripsi |
|--------|-------|-----------|
| `SEATALK_APP_ID` | ✅ Ya | ID aplikasi SeaTalk Custom App |
| `SEATALK_APP_SECRET` | ✅ Ya | Secret aplikasi SeaTalk Custom App |
| `GOOGLE_CLIENT_EMAIL` | ✅ Ya | Email Service Account Google |
| `GOOGLE_PRIVATE_KEY` | ✅ Ya | Private key Service Account Google (format PEM) |
| `HF_API_KEY` | ✅ Ya | API key untuk akses HF Spaces + Vercel API Gateway |
| `HF_SPACES_URL` | ✅ Ya | URL HF Spaces deployment (default: `https://ba-1-a-b-cube-tech.hf.space`) |
| `VERCEL_PDF_TO_PNG_URL` | ❌ Opsional | URL Vercel API Gateway (default: `https://seatalkbot.vercel.app/api/pdf-to-png`) |
| `SUPABASE_URL` | ❌ Opsional | URL project Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | ❌ Opsional | Service role key Supabase |

---

## Cara Mendapatkan Masing-Masing Secret

### 1. SEATALK_APP_ID & SEATALK_APP_SECRET

**Langkah:**
1. Buka https://open.seatalk.com
2. Login dengan akun SeaTalk admin
3. Buat Custom App baru (atau pilih yang sudah ada)
4. Di halaman app, cari **App ID** dan **App Secret**
5. Copy kedua nilai tersebut

**Contoh:**
```
SEATALK_APP_ID = "712687851279"
SEATALK_APP_SECRET = "c3urIS7asdvFi0rIwbhuAKBklGWY1yQv"
```

---

### 2. GOOGLE_CLIENT_EMAIL & GOOGLE_PRIVATE_KEY

**Langkah:**
1. Buka https://console.cloud.google.com/iam-admin/service-accounts
2. Pilih project Google Cloud Anda
3. Klik **"Create Service Account"** (atau pilih yang sudah ada)
4. Beri nama (misal: `vasa-bot-service-account`)
5. Klik **"Create and Continue"**
6. Role: pilih **"Editor"** atau **"Service Account User"**
7. Klik **"Done"**
8. Klik pada service account yang baru dibuat
9. Tab **"Keys"** → **"Add Key"** → **"Create new key"**
10. Pilih **JSON** → **"Create"**
11. File JSON akan terdownload. Buka file tersebut:
    - `client_email` → `GOOGLE_CLIENT_EMAIL`
    - `private_key` → `GOOGLE_PRIVATE_KEY`

**Contoh:**
```
GOOGLE_CLIENT_EMAIL = "vasa-725@studio-1196053014-a94d0.iam.gserviceaccount.com"
GOOGLE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDTLteN85kD+s3m\n...\n-----END PRIVATE KEY-----\n"
```

**⚠️ PENTING:**
- Private key HARUS menyertakan header `-----BEGIN PRIVATE KEY-----` dan footer `-----END PRIVATE KEY-----`
- Newline (`\n`) harus di-preserve. Jika menggunakan `wrangler secret put`, newline akan otomatis di-handle.

---

### 3. SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY (Opsional)

**Langkah:**
1. Buka https://supabase.com
2. Login ke project Anda
3. Di halaman project, cari **"Project URL"** dan **"service_role key"** (bukan anon/public key)
4. Copy kedua nilai tersebut

**Contoh:**
```
SUPABASE_URL = "https://gsdtravhmqbzkwdujkve.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

---

### 4. HF_API_KEY & HF_SPACES_URL (Wajib untuk migrasi HF Spaces)

**HF_API_KEY:**
- Nilai sama dipakai di: Cloudflare Workers, Vercel, dan HF Spaces
- Contoh: `adf66d648188c72c3173b698948a128f4b8f7a13b32014bff9ee914b43a6007a`

**HF_SPACES_URL:**
- URL deployment HF Spaces (setelah deploy HF Spaces)
- Contoh: `https://ba-1-a-b-cube-tech.hf.space`
- Port HF Spaces standard: `7860`

Setup di HF Spaces:
1. Buka HF Spaces → Settings → Variables and secrets
2. Add `HF_API_KEY` dengan value yang sama
3. Save

### 5. VERCEL_PDF_TO_PNG_URL (Opsional)

Default URL sudah di-set di kode:
```
https://seatalkbot.vercel.app/api/pdf-to-png
```

Sekarang URL ini menuju ke Vercel API Gateway yang meneruskan request ke HF Spaces.
Hanya perlu diubah jika Anda deploy Vercel dengan custom domain.

---

## Setup Secrets di Cloudflare Workers

### Metode 1: Via Wrangler CLI (Recommended)

```bash
# Seatalk App
echo "712687851279" | npx wrangler secret put SEATALK_APP_ID
echo "c3urIS7asdvFi0rIwbhuAKBklGWY1yQv" | npx wrangler secret put SEATALK_APP_SECRET

# Google Service Account
echo "vasa-725@studio-1196053014-a94d0.iam.gserviceaccount.com" | npx wrangler secret put GOOGLE_CLIENT_EMAIL

# Google Private Key (paste seluruh key, termasuk header/footer)
npx wrangler secret put GOOGLE_PRIVATE_KEY
# Setelah command dijalankan, paste private key Anda, lalu tekan Ctrl+D (Linux/Mac) atau Ctrl+Z (Windows)

# Supabase (opsional)
echo "https://gsdtravhmqbzkwdujkve.supabase.co" | npx wrangler secret put SUPABASE_URL
echo "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." | npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# HF Spaces (wajib)
echo "adf66d648188c72c3173b698948a128f4b8f7a13b32014bff9ee914b43a6007a" | npx wrangler secret put HF_API_KEY
echo "https://ba-1-a-b-cube-tech.hf.space" | npx wrangler secret put HF_SPACES_URL

# Vercel (opsional, default sudah di-set)
echo "https://seatalkbot.vercel.app/api/pdf-to-png" | npx wrangler secret put VERCEL_PDF_TO_PNG_URL
```

### Metode 2: Via File (untuk automation)

Buat file `.env` di root project:
```env
SEATALK_APP_ID=712687851279
SEATALK_APP_SECRET=c3urIS7asdvFi0rIwbhuAKBklGWY1yQv
GOOGLE_CLIENT_EMAIL=vasa-725@studio-1196053014-a94d0.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDTLteN85kD+s3m\n...\n-----END PRIVATE KEY-----\n"
SUPABASE_URL=https://gsdtravhmqbzkwdujkve.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
HF_API_KEY=adf66d648188c72c3173b698948a128f4b8f7a13b32014bff9ee914b43a6007a
HF_SPACES_URL=https://ba-1-a-b-cube-tech.hf.space
VERCEL_PDF_TO_PNG_URL=https://seatalkbot.vercel.app/api/pdf-to-png
```

Kemudian jalankan:
```bash
npx wrangler secret bulk .env
```

---

## Verifikasi Secrets

Untuk memastikan secrets sudah ter-set dengan benar:

```bash
# List semua secrets (hanya nama, bukan value)
npx wrangler secret list
```

Output yang diharapkan:
```
SEATALK_APP_ID
SEATALK_APP_SECRET
GOOGLE_CLIENT_EMAIL
GOOGLE_PRIVATE_KEY
HF_API_KEY
HF_SPACES_URL
SUPABASE_URL (jika di-set)
SUPABASE_SERVICE_ROLE_KEY (jika di-set)
VERCEL_PDF_TO_PNG_URL (jika di-set)
```

---

## Troubleshooting

### "GOOGLE_PRIVATE_KEY tidak valid: tidak ditemukan header BEGIN PRIVATE KEY"
- Pastikan private key dimulai dengan `-----BEGIN PRIVATE KEY-----`
- Jangan hapus baris apapun dari private key
- Jika copy dari file JSON, pastikan tidak ada karakter yang terpotong

### "Google OAuth gagal: unauthorized_client"
- Pastikan `GOOGLE_CLIENT_EMAIL` sesuai dengan private key
- Pastikan Service Account aktif di Google Cloud Console

### "Service Account tidak memiliki akses ke spreadsheet"
- Buka spreadsheet di Google Sheets
- Klik **"Share"** → masukkan email Service Account (`GOOGLE_CLIENT_EMAIL`)
- Beri permission **"Editor"**

### "Sharp not available" di Vercel
- Ini normal! Sharp tidak compatible dengan Vercel serverless
- Bot menggunakan JS browser-side crop sebagai fallback

---

## Backup Secrets

Simpan semua secrets di file `secrets.json` (JANGAN commit ke Git!):

```json
{
  "SEATALK_APP_ID": "712687851279",
  "SEATALK_APP_SECRET": "c3urIS7asdvFi0rIwbhuAKBklGWY1yQv",
  "GOOGLE_CLIENT_EMAIL": "vasa-725@studio-1196053014-a94d0.iam.gserviceaccount.com",
  "GOOGLE_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "SUPABASE_URL": "https://gsdtravhmqbzkwdujkve.supabase.co",
  "SUPABASE_SERVICE_ROLE_KEY": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "VERCEL_PDF_TO_PNG_URL": "https://seatalkbot.vercel.app/api/pdf-to-png"
}
```

File `secrets.json` sudah ada di `.gitignore`, jadi aman untuk disimpan di local.

---

## Quick Setup Script

Untuk setup cepat semua secrets sekaligus, jalankan:

```bash
#!/bin/bash
# setup-secrets.sh

echo "Setting up VASA Bot secrets..."

echo "712687851279" | npx wrangler secret put SEATALK_APP_ID
echo "c3urIS7asdvFi0rIwbhuAKBklGWY1yQv" | npx wrangler secret put SEATALK_APP_SECRET
echo "vasa-725@studio-1196053014-a94d0.iam.gserviceaccount.com" | npx wrangler secret put GOOGLE_CLIENT_EMAIL

echo "Paste GOOGLE_PRIVATE_KEY (tekan Ctrl+D setelah selesai):"
npx wrangler secret put GOOGLE_PRIVATE_KEY

echo "https://gsdtravhmqbzkwdujkve.supabase.co" | npx wrangler secret put SUPABASE_URL
echo "PASTE_SUPABASE_SERVICE_ROLE_KEY" | npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY

echo "https://ba-1-a-b-cube-tech.hf.space" | npx wrangler secret put HF_SPACES_URL
echo "adf66d648188c72c3173b698948a128f4b8f7a13b32014bff9ee914b43a6007a" | npx wrangler secret put HF_API_KEY
echo "https://seatalkbot.vercel.app/api/pdf-to-png" | npx wrangler secret put VERCEL_PDF_TO_PNG_URL

echo "Setup complete! Verify with: npx wrangler secret list"
```

Simpan sebagai `setup-secrets.sh`, lalu jalankan:
```bash
chmod +x setup-secrets.sh
./setup-secrets.sh
```

---

## Catatan Penting

1. **Jangan commit secrets ke Git** - File `secrets.json` sudah di-ignore di `.gitignore`
2. **Rotate secrets secara berkala** - Ganti `SEATALK_APP_SECRET` dan `GOOGLE_PRIVATE_KEY` setiap 3-6 bulan
3. **Jangan share private key** - Private key hanya untuk server, jangan dibagikan ke siapapun
4. **Service Account harus di-share** - Setiap spreadsheet yang ingin diakses harus di-share ke email Service Account
5. **KV Namespace** - Jangan lupa buat KV namespace `BOT_MEMORY` dan update ID di `wrangler.toml`

---

## Next Steps

Setelah secrets di-set:
1. Deploy Cloudflare Worker: `npx wrangler deploy`
2. Deploy Vercel: `vercel --prod`
3. Test bot dengan mengirim pesan di SeaTalk