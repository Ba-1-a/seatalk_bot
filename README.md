# VASA - Virtual Assistant SOC Arjawinangun

Bot SeaTalk berbasis Cloudflare Workers dengan fitur AI, Google Sheets integration, dan screenshot spreadsheet asli (bukan HTML rekonstruksi).

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
│  - AI Binding: Cloudflare Workers AI (gratis, tanpa daftar KK)      │
│  - Supabase: Database cadangan                                      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         VERCEL (Helper PDF→PNG)                      │
│                                                                     │
│  /api/pdf-to-png.js → Puppeteer render PDF native di Chrome → PNG  │
│                                                                     │
│  ALUR SCREENSHOT YANG BENAR (TANPA FREEMIUM):                       │
│                                                                     │
│  1. Export spreadsheet ke PDF via Google Drive API (GRATIS!)        │
│     ↓ Google Drive export mempertahankan FORMAT ASLI spreadsheet    │
│     (warna, border, merged cells, font, background, dll)            │
│                                                                     │
│  2. Kirim PDF (base64) ke Vercel endpoint /api/pdf-to-png           │
│                                                                     │
│  3. Vercel render PDF native di Chrome                              │
│     ↓ BUKAN HTML rekonstruksi! Chrome native PDF viewer             │
│     ↓ Mempertahankan 100% fidelity dokumen asli                     │
│                                                                     │
│  4. Vercel screenshot → PNG → kirim balik ke Worker                │
│                                                                     │
│  5. Worker kirim PNG ke SeaTalk via base64 inline                   │
│                                                                     │
│  KENAPA INI BENAR:                                                  │
│  - "Jangan render lewat HTML, tapi benar-benar ambil screenshot"    │
│  - Google Drive API export PDF GRATIS, tanpa freemium               │
│  - Chrome native PDF viewer != HTML buatan                          │
└─────────────────────────────────────────────────────────────────────┘
```

## Fitur Utama

- **Chat AI** - Menggunakan Cloudflare Workers AI (gratis, tanpa daftar kartu kredit)
- **Google Sheets Integration** - Baca, export spreadsheet
- **Screenshot Spreadsheet ASLI** - Export spreadsheet ke PDF (Google Drive API) → PNG (Chrome native render) - BUKAN HTML rekonstruksi
- **Memory** - Simpan konteks percakapan per user/grup di KV
- **Cron Jobs** - Jadwalkan laporan otomatis
- **Auto-Threading** - Jawaban panjang otomatis di-thread di grup

## Command

| Command | Deskripsi | Contoh |
|---------|-----------|--------|
| `/setsheet <url>` | Simpan spreadsheet | `/setsheet https://docs.google.com/spreadsheets/d/xxx` |
| `/readsheet [tab]` | Baca data spreadsheet (text mode) | `/readsheet Sheet1` |
| `/screenshot [tab]` | Screenshot spreadsheet ASLI via PDF | `/screenshot Sheet1` |
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

### 3. Deploy Cloudflare Worker
```bash
npx wrangler deploy
```

### 4. Deploy Vercel (untuk helper PDF-to-PNG)
```bash
# Dari root project:
vercel --prod
```

## Struktur File

```
├── index.js              # Entry point Worker (Event Callback SeaTalk)
├── wrangler.toml         # Konfigurasi Cloudflare Workers
├── api/
│   └── pdf-to-png.js     # Vercel endpoint PDF→PNG (Puppeteer, render native Chrome)
├── src/
│   ├── aiHandler.js      # AI model management (Cloudflare Workers AI)
│   ├── botCoding.js      # Chat flow & memory management
│   ├── botSheet.js       # Google Sheets, PDF export (Drive API), screenshot logic
│   ├── logger.js         # Structured logging untuk semua service
│   └── utils.js          # Utility functions (SeaTalk API, helpers)
├── secrets.json          # Backup kredensial (jangan commit ke public!)
├── package.json          # Dependencies
├── deploy.sh             # Script deploy lengkap
├── vercel.json           # Konfigurasi Vercel (maxDuration: 60s untuk Puppeteer)
└── README.md             # Dokumentasi ini
```

## Catatan Penting

- **Tidak ada API freemium** - Semua screenshot via Google Drive API export PDF (GRATIS)
- **Tidak render HTML** - Chrome native PDF viewer, bukan HTML table rekonstruksi
- **Tidak perlu kartu kredit** - Cloudflare Workers AI gratis tanpa perlu daftar KK
- **Seatlak Challenge** - Worker sudah handle `seatalk_challenge` untuk verifikasi webhook (`index.js` baris 42-47)
- **Token OAuth** Google di-cache di KV (~50 menit)
- **Memory percakapan** disimpan di KV dengan TTL 1 jam
- **Service Account** Google harus di-share ke spreadsheet yang akan diakses
- **Vercel timeout** diset ke 60 detik (cukup untuk Puppeteer render PDF)