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