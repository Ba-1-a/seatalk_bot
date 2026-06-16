# VASA - Virtual Assistant SOC Arjawinangun

Bot SeaTalk berbasis Cloudflare Workers dengan fitur AI, Google Sheets integration, dan screenshot tanpa freemium.

## Arsitektur

```
┌─────────────────────────────────────────────────────────────────────┐
│                      CLOUDFLARE WORKERS                             │
│                  (Event Callback Utama SeaTalk)                      │
│                                                                     │
│  index.js ──┬── /inventory  → botSheet.js                           │
│             ├── /setsheet    → botSheet.js                          │
│             ├── /readsheet   → botSheet.js                          │
│             ├── /screenshot  → botSheet.js ──→ Vercel (PDF→PNG)    │
│             └── chat umum    → botCoding.js → aiHandler.js          │
│                                                                     │
│  Infrastruktur:                                                     │
│  - KV Namespace: BOT_MEMORY (session, token cache, cron_jobs)       │
│  - AI Binding: Cloudflare Workers AI (gratis)                       │
│  - Supabase: Database cadangan                                      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         VERCEL (Helper)                              │
│                                                                     │
│  /api/pdf-to-png.js → Puppeteer render PDF → output PNG            │
│                                                                     │
│  Alur Screenshot (TANPA FREEMIUM):                                  │
│  1. Worker export spreadsheet ke PDF via Google Drive API (GRATIS)  │
│  2. Worker POST PDF base64 ke Vercel endpoint                       │
│  3. Vercel/Puppeteer render PDF → screenshot PNG                    │
│  4. Worker kirim PNG ke SeaTalk via base64                          │
└─────────────────────────────────────────────────────────────────────┘
```

## Fitur Utama

- **Chat AI** - Menggunakan Cloudflare Workers AI (gratis, tanpa daftar kartu kredit)
- **Google Sheets Integration** - Baca, export spreadsheet
- **Screenshot Spreadsheet** - Export spreadsheet ke PDF → PNG tanpa API freemium
- **Memory** - Simpan konteks percakapan per user/grup di KV
- **Cron Jobs** - Jadwalkan laporan otomatis
- **Auto-Threading** - Jawaban panjang otomatis di-thread di grup

## Command

| Command | Deskripsi | Contoh |
|---------|-----------|--------|
| `/setsheet <url>` | Simpan spreadsheet | `/setsheet https://docs.google.com/spreadsheets/d/xxx` |
| `/readsheet [tab]` | Baca data spreadsheet | `/readsheet Sheet1` |
| `/screenshot [tab] [range]` | Screenshot spreadsheet | `/screenshot Sheet1 A1:D20` |
| `/inventory` | Fitur inventory (coming soon) | `/inventory` |
| `<teks bebas>` | Chat dengan AI | Apa kabar? |

## Setup & Deploy

### 1. Install dependencies
```bash
npm install
```

### 2. Set secrets Cloudflare Workers
```bash
echo "NzE2Mjg3ODUxMjc5" | npx wrangler secret put SEATALK_APP_ID
echo "c3urIS7asdvFi0rIwbhuAKBklGWY1yQv" | npx wrangler secret put SEATALK_APP_SECRET
echo '-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDTLteN85kD+s3m
...
-----END PRIVATE KEY-----' | npx wrangler secret put GOOGLE_PRIVATE_KEY
```

### 3. Deploy
```bash
npx wrangler deploy
```

### 4. Deploy Vercel (untuk helper PDF-to-PNG)
```bash
# Di folder api/:
cd api
# Deploy ke Vercel
vercel --prod
```

## Struktur File

```
├── index.js              # Entry point Worker (Event Callback SeaTalk)
├── wrangler.toml         # Konfigurasi Cloudflare Workers
├── api/
│   └── pdf-to-png.js     # Vercel endpoint PDF→PNG (Puppeteer)
├── src/
│   ├── aiHandler.js      # AI model management (Cloudflare Workers AI)
│   ├── botCoding.js      # Chat flow & memory management
│   ├── botSheet.js       # Google Sheets, PDF export, screenshot logic
│   └── utils.js          # Utility functions (SeaTalk API, helpers)
├── secrets.json          # Backup kredensial (jangan commit ke public!)
├── package.json          # Dependencies
├── deploy.sh             # Script deploy lengkap
└── vercel.json           # Konfigurasi Vercel
```

## Catatan Penting

- **Tidak ada API freemium** - Semua screenshot menggunakan Google Drive API (gratis) + Vercel Puppeteer
- **Tidak perlu kartu kredit** - Cloudflare Workers AI gratis tanpa perlu daftar KK
- **Seatalk Challenge** - Worker sudah handle `seatalk_challenge` untuk verifikasi webhook
- **Token OAuth** Google di-cache di KV (~50 menit)
- **Memory percakapan** disimpan di KV dengan TTL 1 jam
- **Service Account** Google harus di-share ke spreadsheet yang akan diakses