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
│     ↓ JS 4-directional edge scan crop whitespace di browser        │
│     ↓ Resize body/html/container ke ukuran konten                   │
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
- **Custom Range** - Support screenshot range tertentu (A1:D15, 5-30, dll)
- **Adaptive Paper Size** - Otomatis pilih ukuran kertas berdasarkan rasio konten
- **Whitespace Removal** - JS browser-side 4-directional edge scan crop
- **Memory** - Simpan konteks percakapan per user/grup di KV
- **Cron Jobs** - Jadwalkan laporan otomatis
- **Auto-Threading** - Jawaban panjang otomatis di-thread di grup

## Command

| Command | Deskripsi | Contoh |
|---------|-----------|--------|
| `/setsheet <url>` | Simpan spreadsheet | `/setsheet https://docs.google.com/spreadsheets/d/xxx` |
| `/readsheet [tab]` | Baca data spreadsheet (text mode) | `/readsheet Sheet1` |
| `/screenshot [tab] [range]` | Screenshot spreadsheet via PDF | `/screenshot Sheet1 A1:D15` |
| `/inventory` | Fitur inventory (coming soon) | `/inventory` |
| `<teks bebas>` | Chat dengan AI | Apa kabar? |

### Range Format untuk Screenshot
- `A1:D15` - Range spesifik
- `5-30` - Baris 5 sampai 30, semua kolom
- `D15` - Kolom D dari baris 15 sampai akhir
- `A:D` - Semua kolom A sampai D

## Setup & Deploy

### 1. Install dependencies
```bash
npm install
```

### 2. Setup Secrets
Lihat dokumentasi lengkap di [docs/SECRETS_SETUP.md](docs/SECRETS_SETUP.md)

Quick setup:
```bash
# Seatalk App
npx wrangler secret put SEATALK_APP_ID
npx wrangler secret put SEATALK_APP_SECRET

# Google Service Account
npx wrangler secret put GOOGLE_CLIENT_EMAIL
npx wrangler secret put GOOGLE_PRIVATE_KEY

# Supabase (opsional)
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# Vercel (opsional, untuk custom domain)
npx wrangler secret put VERCEL_PDF_TO_PNG_URL
```

### 3. Create KV Namespace
```bash
npx wrangler kv namespace create BOT_MEMORY
# Copy ID dari output, lalu update di wrangler.toml
```

### 4. Deploy Cloudflare Worker
```bash
npx wrangler deploy
```

### 5. Deploy Vercel (untuk helper PDF-to-PNG)
```bash
# Dari root project:
vercel --prod
```

Atau connect GitHub repo ke Vercel untuk auto-deploy.

## Struktur File

```
├── index.js              # Entry point Worker (Event Callback SeaTalk)
├── wrangler.toml         # Konfigurasi Cloudflare Workers
├── api/
│   └── pdf-to-png.js     # Vercel endpoint PDF→PNG (Puppeteer + pdfjs-dist)
├── src/
│   ├── aiHandler.js      # AI model management (Cloudflare Workers AI)
│   ├── botCoding.js      # Chat flow & memory management
│   ├── botSheet.js       # Google Sheets, PDF export (Drive API), screenshot logic
│   ├── logger.js         # Structured logging untuk semua service
│   └── utils.js          # Utility functions (SeaTalk API, helpers)
├── docs/
│   ├── SECRETS_SETUP.md  # Panduan setup secrets
│   └── DEBUG_PLAN_WHITESPACE.md  # Debug log whitespace issue
├── secrets.json          # Backup kredensial (jangan commit ke public!)
├── package.json          # Dependencies
├── deploy.sh             # Script deploy lengkap
├── vercel.json           # Konfigurasi Vercel (maxDuration: 60s)
└── README.md             # Dokumentasi ini
```

## Troubleshooting

### Screenshot tidak muncul / error
1. Cek Vercel deployment status di https://vercel.com
2. Cek logs Vercel untuk error details
3. Pastikan Google Service Account memiliki akses ke spreadsheet
4. Pastikan Vercel endpoint merespon HTTP 200

### Whitespace masih ada
- Crop dilakukan di browser (JS), bukan di server
- Threshold default: 8 (pixel dengan RGB > 247 dianggap putih)
- Anti false positive: minimal 3 pixel non-white per baris/kolom

### Bot tidak respond di grup
- Pastikan bot di-invite ke grup
- Cek SeaTalk App permissions
- Bot hanya respond jika di-mention atau reply ke pesan bot

### Google OAuth error
- Pastikan GOOGLE_PRIVATE_KEY format benar (ada header/footer PEM)
- Pastikan GOOGLE_CLIENT_EMAIL sesuai dengan private key
- Service Account harus di-share ke spreadsheet

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
- **Crop di browser** - Karena sharp tidak compatible dengan Vercel serverless, crop whitespace dilakukan di dalam Chromium menggunakan JavaScript sebelum screenshot

## Known Issues

1. **Vercel cold start** - First request bisa memakan waktu 30-60 detik untuk inisialisasi Puppeteer + Chromium
2. **Multi-page spreadsheet** - PDF dengan banyak halaman akan membutuhkan waktu lebih lama untuk render
3. **Large range** - Range sangat besar (100+ kolom) mungkin timeout di Vercel

## Roadmap

- [x] Fix whitespace issue (V7 - JS browser-side crop + viewport resize)
- [ ] Fix group chat messaging
- [ ] Scheduling screenshot (auto-report)
- [ ] Sheet context understanding untuk AI
- [ ] Threshold alert & notification
- [ ] Update sheet via chat
- [ ] Multi-sheet support

## License

Private - VASA SOC Arjawinangun

## Author

Built with ❤️ for VASA SOC Arjawinangun