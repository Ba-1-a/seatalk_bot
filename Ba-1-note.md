# Pastikan Repo sudah menggunakan arsitektur berikut dan perbaiki kelemahannya

## Begini aturan mainnya :

- Gunakan Cloudflare Workers untuk Event Callback 
- Selalu comment nama file di setiap awal kode agar aku gak salah edit
- Karena sudah mentok memanfaatkan tier gratis yang harus daftar KK, kita hindari fitur freemium 
- Proses screenshot [Export ke PDF -> PDF to PNG -> PNG kirim ke seatalk (reason : Aku mau bot screenshot apa yang user lihat di spreadsheet)
- Buat worker lolos seatalk_challenge
- Jangan render lewat HTML, tapi benar-benar ambil screenshot
- selalu put secret
- selalu deploy pakai token lalu push ke GitHub
- jangan terlalu agresif saat menggunakan terminal, ada delay beberapa detik
- jangan ragu untuk menambah file baru maupun menghapus file lama

## Infrastruktur

### Email Kantor (bawana.pratama@spx-external.com) :

#### Seatalk Custom App

- App ID : NzE2Mjg3ODUxMjc5
- App Secret : c3urIS7asdvFi0rIwbhuAKBklGWY1yQv

#### Google Service Account
 
- vasa-725@studio-1196053014-a94d0.iam.gserviceaccount.com
- GOOGLE_PRIVATE_KEY :
```
-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDTLteN85kD+s3m
Yej9onE2SfhiufAda+8JA7j3CoRfGx7dz/exNc3FeGgAuamy2vwywsEDLGhZRuOE
0jf94FOhH5CDeRCmIWpYcukKWQ7MTaKvqViUamGf7wEKZTBQ+2m1Yk1UhNQiwI4k
z5eAwhLxEfRYOjMqXGOqRbH6lvGI5zyP6qWG1/+TuEQRGwuEOEiPZtOyBIK8pxnR
0q/bgR44VYlCtMhHt4VWKazgec3Y1CfdS7QzbgtRVyoolN/Mkbo5QKHZ1UY8x4yI
FYlBY4OVT5ICI1Cmu4IGA31lRGd1eNOhae0ZnsuGLtjUcZn4+s6Ea4YlGz2OpYmG
DsIf1t8VAgMBAAECggEADPMG9d+L1woIM1B22Fg5BIqXaxTA6LAkN/N9FW2uqj15
sHSlJb4Jc33FNG4uCrD4D/P2bXrJ0NefWEo8c4CcgCyOtveAeHKW5WK+b9gzWrG6
ZqnfeNJN6pNEOnfz9Rmr5LRpAeRXNOS4kpp45sTmIz2yzVb13J4a4M3MDEEFmuhY
DKVt8hRhAX/LRlYYdW2sals7Ba+GO2IcJP4RK2kSpV9i8WTHM+K+igbS2s86Flh2
fLfKZxIOBPKam+LLb8p+G1DUU6M7qWqq6Zc8vvV65kPRZAEmq+Q/VlJp2d2bgMlZ
RzN3odNrmtdKhL+HPtk9kdrQcBl/1bBmAINJU8H0bQKBgQDpRhU7ts84h3zWKj4X
ceP44VXtLd1bbHPsxJTngL61aSAxoBgLpCk3hn0V1BivIMltH5XM/JJwDN0pBI/z
8Weuev3gUpTPLYoju6QtvpmS0pGY9axBGPWlfkIelZirbji0OFTbIe+WrXNfRs7K
9J8ZNWMmz6aVAQ/uh/KH6UsWFwKBgQDnwc7txkESz+RVzP0PeBTSPsxOOzcsh7cP
ZcApRL2dg9hAQdaoFX/0zmCCghYFEtKuSCWK8Rx9TRM6QHTUC2e+PZvS6knMNy/I
Aa1IAUpGPfANn6MjkRp4kXrNEI5HpFP0uCrrILTPdupZwzh5hyzB4/kg6NuEyl5R
R78Gtk4bswKBgDE8yrSM9JZA+teVmP+H2Y+puGJUoPlwHdPm9msa4KYX52SyHwEu
CEkhCPv3hbJJYFq5JPxcf2hJPtEullfuJ21LppSXubM1MIg0TgYdyfqUmYjIqjAf
XZIt4TTlbJEatbtMfJS4SALs34JHxtRN59sBSslhYQ7oZ314knefhWrHAoGBAJyt
p8mT6FZheYqQBN06X0kr709MNSbDsXyVW24K7O3aPo5idE46CsFj7FcOvvg7G3d7
ivX9vzburnsJLHJWK5Kvb/MNNUr8XC8pAw7U4HPQV8O+Erpu1KiCIbUU5juE2sVs
5IcFG3fOeuyoUDvIqPeDud8HzbBeZ5knmftdsDyFAoGBALvzuBTR+kJzWfPQrM+v
lKz0xLUqrP0mVKxVbdon4ffpLjZrpKMGuYinBNJJpROvPztI1Jps37Pn4E9r1GcR
5yCf9v2SdxN2WYAaOkJdOFpoDcnDdtY5YDFodyt2CEhbOWaROFJwRMGcu/I8F3rD
2HWUxMNqTkluAuqX54Nuz6mE
-----END PRIVATE KEY-----
```

### Email Pribadi (bawanappratama@gmail.com)

#### Cloudflare
- seatalk-bot.bawanappratama.workers.dev
- CLOUDFLARE_API_TOKEN = "cfut_bc8SlAhJhsr7zpQhovoztYVaUbHkM1vG3deMQzL856825c05"
- KV Namespace
```
"kv_namespaces": [{
                    "binding": "BOT_MEMORY",
                    "id": "ae76cdb4f12d4d719057f089f8ac2deb"
                 }]
```

#### Vercel

- https://seatalkbot.vercel.app/

#### Supabase 

- https://gsdtravhmqbzkwdujkve.supabase.co
- Publishable key : sb_publishable_hgnywAp2NTYe31BFd41fXg_YS5R6qng
- Secret keys : sb_secret_CE5G8RTNXljujP7AyBkP8Q_v3b9eNsN
- service_role : eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdzZHRyYXZobXFiemt3ZHVqa3ZlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTI2NTIyMCwiZXhwIjoyMDk2ODQxMjIwfQ.zm7mj7lb2yea5WnS9SxD22ZqtyQYw9PORMPSpDAcQR0
- anon public : eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdzZHRyYXZobXFiemt3ZHVqa3ZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNjUyMjAsImV4cCI6MjA5Njg0MTIyMH0.vIs5hE0_AAivB0ghYt777_QJZDhQgLHSkXVGXwFpKC8
- Project name : seatalk_bot
- Project ID : gsdtravhmqbzkwdujkve

---

# Debug Plan: Whitespace Border Issue

**Tanggal**: 19 Juni 2026  
**Status**: ✅ SOLVED (V7)  
**Masalah**: Whitespace border masih ada di range kecil setelah crop

---

## Root Cause Analysis

### Masalah Utama
Whitespace muncul di 2 lokasi:
1. **Dari Google Drive PDF export** — Internal padding minimal dari Google PDF engine
2. **Dari page.screenshot()** — Container body/html lebih besar dari konten yang sudah di-crop

### Investigasi

| Tahap | Temuan | Solusi |
|-------|--------|--------|
| **V0-V4** | sharp.trim() tidak berfungsi di Vercel | Sharp tidak compatible dengan Vercel serverless |
| **V5** | sharp.raw() memory crash | Baca semua pixel sekaligus (~45MB) |
| **V5.1** | Sampled edge scan + fallback | Masih error 500 |
| **V6** | JS browser-side edge scan | Container tidak di-resize → whitespace tetap |
| **V7** ✅ | JS crop + resize body/html + set viewport | **BERHASIL!** |

### Kenapa Sharp Tidak Bisa di Vercel?
Log Vercel:
```
Sharp not available, will use fallback
Sharp not available, returning raw PNG
```

Sharp menggunakan native C++ binary yang tidak kompatibel dengan Vercel serverless runtime (Node.js 24). Semua percobaan menggunakan sharp.trim(), sharp.raw(), sharp.extract() **tidak pernah berjalan** di Vercel.

---

## Solusi Final (V7)

### 1. JS Browser-Side 4-Directional Edge Scan
**File**: `api/pdf-to-png.js`

Karena sharp tidak bisa digunakan, crop dilakukan di dalam Chromium browser menggunakan JavaScript:

```javascript
// 4-directional edge scan
// Threshold: 8 (pixel RGB > 247 dianggap putih)
// Anti false positive: minimal 3 pixel non-white per baris/kolom

// SCAN TOP → edgeTop
// SCAN BOTTOM → edgeBottom
// SCAN LEFT → edgeLeft
// SCAN RIGHT → edgeRight

// Crop canvas ke bounding box
// Resize parent container
```

### 2. Resize Container & Body ke Ukuran Konten
**File**: `api/pdf-to-png.js`

Setelah crop, resize:
- Container `#c` → total dimensi konten
- `document.body` → total dimensi konten
- `document.documentElement` → total dimensi konten

```javascript
// Simpan ukuran konten di dataset
document.body.dataset.contentWidth = totalW;
document.body.dataset.contentHeight = totalH;
```

### 3. Set Viewport Node.js ke Content Dimensions
**File**: `api/pdf-to-png.js`

Di Node.js (handler), baca content size dan set viewport sebelum screenshot:

```javascript
const contentWidth = await page.evaluate(() => 
  parseInt(document.body.dataset.contentWidth) || 0
);
const contentHeight = await page.evaluate(() => 
  parseInt(document.body.dataset.contentHeight) || 0
);

if (contentWidth > 0 && contentHeight > 0) {
  await page.setViewport({
    width: contentWidth,
    height: contentHeight,
    deviceScaleFactor: 2
  });
}
```

### 4. Adaptive Paper Size Berdasarkan Rasio Konten
**File**: `src/botSheet.js`

Pilih paper size berdasarkan jumlah baris dan kolom:

| Range | Baris | Paper | fith |
|-------|-------|-------|------|
| 1-2 kolom | ≤10 | STATEMENT | true |
| 1-2 kolom | >10 | LETTER | true |
| 3-4 kolom | ≤15 | EXECUTIVE | true |
| 3-4 kolom | >15 | LETTER | true |
| 5+ kolom | Berapapun | TABLOID | false |

---

## Alur Lengkap (V7)

```
1. Google Drive API export PDF (GRATIS)
   ↓ Paper size adaptif berdasarkan rasio konten
   ↓ fitw=true, fith=true (untuk range kecil)
   ↓ margin=0

2. Kirim PDF (base64) ke Vercel

3. Vercel render PDF via pdfjs-dist → canvas (scale=3)
   ↓ JS 4-directional edge scan crop (TH=8, MIN_PX=3)
   ↓ Resize container, body, html ke ukuran konten
   ↓ Simpan contentWidth & contentHeight di dataset

4. Node.js baca content dimensions
   ↓ Set viewport ke ukuran konten
   ↓ page.screenshot(fullPage=true)

5. PNG presisi TANPA whitespace → kirim ke SeaTalk
```

---

## Testing

### Range Kecil (A1:B5)
- Paper: STATEMENT (5.5"x8.5")
- Canvas asli: ~1188x1836px
- Setelah crop: ~800x400px
- Body/html di-resize ke ~800x400px
- Viewport di-set ke ~800x400px
- **Hasil**: Bersih, tanpa whitespace ✅

### Range Besar (A1:Z50)
- Paper: TABLOID (17"x11") landscape
- Canvas asli: ~5000x3000px
- Setelah crop: ~4800x2800px
- Body/html di-resize ke ~4800x2800px
- Viewport di-set ke ~4800x2800px
- **Hasil**: HD, tanpa whitespace ✅

---

## Lessons Learned

1. **Sharp tidak bisa di Vercel** — Jangan percaya sharp untuk serverless
2. **JS crop di browser lebih reliable** — Chromium sudah include via @sparticuz/chromium
3. **Viewport harus di-set setelah crop** — fullPage: true tidak cukup jika body lebih besar dari konten
4. **Adaptive paper size membantu** — Meminimalkan whitespace dari source (Google PDF)

---

## Commit History

```
72c6c65 docs: update debug-plan-whitespace.md dengan solusi final V7
d73cc97 docs: update README.md + add SECRETS_SETUP.md
a1f914d Fix whitespace v7: resize body/html/container + set viewport
2e66735 Fix whitespace v6: JS browser-side edge scan + adaptive paper
38f7bdd Fix whitespace v5.1: sampled edge scan (error 500)
031bb1f Fix whitespace v5: 4-directional edge scan (error 500)
f067e55 Fix whitespace v4: split fith param per range
9fd9cd2 Fix whitespace v3: hapus JS crop, two-pass sharp.trim
af6deb6 Fix whitespace residual: agresif paper size
```

---

## Next Steps

- [x] Fix whitespace issue (V7)
- [ ] Fix group chat messaging
- [ ] Scheduling screenshot (auto-report)
- [ ] Sheet context understanding untuk AI
- [ ] Threshold alert & notification

---

## Referensi

- Issue: Whitespace di range kecil (kanan & bawah) dan range besar (bawah)
- Solution: JS browser-side crop + body resize + viewport adjustment
- Files changed: `api/pdf-to-png.js`, `src/botSheet.js`
- Testing: Range kecil (STATEMENT) dan range besar (TABLOID) both clean ✅