# VASA - Virtual Assistant SOC Arjawinangun

Bot SeaTalk berbasis Cloudflare Workers dengan fitur AI, Google Sheets integration, dan screenshot spreadsheet asli via PDF.

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
│  /api/pdf-to-png.js → Puppeteer + pdfjs-dist inline render PDF     │
│                                                                     │
│  ALUR SCREENSHOT:                                                   │
│                                                                     │
│  1. Export spreadsheet ke PDF via Google Drive API (GRATIS!)        │
│     ↓ Google Drive export mempertahankan FORMAT ASLI spreadsheet    │
│     (warna, border, merged cells, font, background, dll)            │
│                                                                     │
│  2. Kirim PDF (base64) ke Vercel endpoint /api/pdf-to-png           │
│                                                                     │
│  3. Vercel render PDF via pdfjs-dist inline (dari node_modules)     │
│     ↓ Render PDF asli ke HTML5 Canvas (bukan HTML rekonstruksi!)    │
│                                                                     │
│  4. Vercel screenshot halaman canvas → PNG → kirim balik ke Worker  │
│                                                                     │
│  5. Worker kirim PNG ke SeaTalk via base64 inline                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Fitur Utama

- **Chat AI** - Menggunakan Cloudflare Workers AI (gratis, tanpa daftar kartu kredit)
- **Google Sheets Integration** - Baca data spreadsheet (text) & screenshot (PDF→PNG)
- **Screenshot Spreadsheet ASLI** - Export ke PDF (Google Drive API) → PNG (pdfjs-dist render canvas) - BUKAN HTML rekonstruksi
- **Memory** - Simpan konteks percakapan per user/grup di KV
- **Cron Jobs** - Jadwalkan laporan otomatis
- **Auto-Threading** - Jawaban panjang otomatis di-thread di grup

## Command

| Command | Deskripsi | Contoh |
|---------|-----------|--------|
| `/setsheet <url>` | Simpan spreadsheet | `/setsheet https://docs.google.com/spreadsheets/d/xxx` |
| `/readsheet [tab]` | Baca data spreadsheet (text mode) | `/readsheet Sheet1` |
| `/screenshot [tab]` | Screenshot spreadsheet via PDF | `/screenshot Sheet1` |
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
│   └── pdf-to-png.js     # Vercel endpoint PDF→PNG (Puppeteer + pdfjs-dist inline)
├── src/
│   ├── aiHandler.js      # AI model management (Cloudflare Workers AI)
│   ├── botCoding.js      # Chat flow & memory management
│   ├── botSheet.js       # Google Sheets, PDF export (Drive API), screenshot logic
│   ├── logger.js         # Structured logging untuk semua service
│   └── utils.js          # Utility functions (SeaTalk API, helpers)
├── secrets.json          # Backup kredensial (jangan commit ke public!)
├── package.json          # Dependencies
├── deploy.sh             # Script deploy lengkap
├── vercel.json           # Konfigurasi Vercel (maxDuration: 60s)
└── README.md             # Dokumentasi ini
```

## Catatan Penting

- **Tidak ada API freemium** - Semua screenshot via Google Drive API export PDF (GRATIS)
- **Tidak render HTML** - pdfjs-dist render PDF asli ke canvas, bukan HTML table rekonstruksi
- **Tidak perlu kartu kredit** - Cloudflare Workers AI gratis tanpa perlu daftar KK
- **Seatalk Challenge** - Worker sudah handle `seatalk_challenge` untuk verifikasi webhook
- **Token OAuth** Google di-cache di KV (~50 menit)
- **Memory percakapan** disimpan di KV dengan TTL 1 jam
- **Service Account** Google harus di-share ke spreadsheet yang akan diakses
- **Vercel timeout** diset ke 60 detik (cukup untuk pdfjs-dist render canvas)
- **pdfjs-dist v3.11.174** digunakan karena versi UMD bisa di-inject via `<script>` tag tanpa dynamic import

## Kelemahan yang Diketahui

1. **Screenshot seluruh halaman (ignore custom range)** - Parameter range seperti `A1:D20` tidak mempengaruhi output PDF karena Google Drive API export selalu menghasilkan PDF dari seluruh sheet. Untuk screenshot sebagian, perlu dipotong manual nantinya.

2. **Duplikasi screenshot (5 kali kirim)** - Jika user mengirim perintah `/screenshot` dan Worker sedang memproses, request kedua dari SeaTalk (retry mechanism) akan memicu proses screenshot lagi. Hal ini menyebabkan beberapa screenshot terkirim. Solusi: implementasi deduplication/rate limiting di Worker.

3. **Waktu proses lama (~50 detik)** - Karena pdfjs-dist harus render setiap halaman PDF ke canvas satu per satu di Puppeteer. Spreadsheet dengan banyak baris membutuhkan waktu lebih lama.

4. **Worker timeout 100 detik** - Cloudflare Worker gratis memiliki batas CPU time 10-30 detik untuk request. Screenshot besar mungkin timeout sebelum selesai.

5. **Whitespace border masih ada di range kecil** - Crop whitespace terkadang tidak menghapus whitespace sepenuhnya di range nilai kecil (threshold terlalu ketat atau bounding box tidak optimal). Perlu penyesuaian threshold atau penambahan crop ulang setelah bounding box.

6. **Sharp binary compatibility di Vercel** - Library sharp menggunakan native binary yang mungkin tidak kompatibel dengan runtime Vercel (Node.js 24). Saat ini menggunakan fallback JS crop jika sharp gagal di-load.

7. **Vercel cold start timeout** - Endpoint `/api/pdf-to-png` di Vercel free tier bisa timeout pada request pertama (cold start). Puppeteer + pdfjs-dist perlu waktu inisialisasi ~30-60 detik pada first call.
