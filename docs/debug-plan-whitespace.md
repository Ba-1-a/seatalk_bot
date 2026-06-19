# Debug Plan: Whitespace Border Issue

**Tanggal**: 19 Juni 2026  
**Masalah**: Whitespace border masih ada di range kecil setelah crop

---

## Hypotheses

1. **Threshold terlalu ketat untuk gridline abu-abu** — Threshold 12 dari 255 mungkin masih menganggap gridline abu-abu sangat muda sebagai putih, sehingga bounding box terlalu besar dan tidak crop whitespace yang sebenarnya.
2. **Bounding box awal terlalu besar** — Padding 2px di bounding box bisa menambah whitespace jika konten ada di tepi.
3. **Right/bottom trim threshold sama dengan content detection** — Threshold untuk right/bottom trim menggunakan nilai yang sama (TH=12), bisa jadi terlalu permisif.
4. **Google Drive PDF export margins** — PDF dari Google Drive mungkin punya margin default yang tidak terdeteksi sebagai putih karena ada watermark/header Google Drive.
5. **Screenshot fullPage padding** — Puppeteer `fullPage: true` bisa menambah whitespace di bawah halaman.

---

## Plan Debugging

### Step 1: Inspect current output
- Screenshot spreadsheet via `/screenshot`
- Buka PNG, ukur whitespace di: top, right, bottom, left
- Catat ukuran pixel whitespace untuk masing-masing sisi

### Step 2: Cek nilai pixel di area whitespace
- Tambahkan console log di JS crop untuk menampilkan nilai RGB di area yang dianggap whitespace
- Cek apakah nilai RGB di whitespace benar-benar (255,255,255) atau ada variasi

### Step 3: Adjust threshold
- **Opsi A**: Turunkan threshold dari 12 ke 8 atau 6 (lebih ketat)
- **Opsi B**: Tambah tolerance untuk right/bottom trim terpisah dari content detection
- **Opsi C**: Percaya 100% pada sharp.trim() dan hapus JS crop fallback entirely

### Step 4: Cek Google Drive PDF margin
- Download PDF hasil export dari Google Drive API
- Cek apakah ada margin/header Google Drive di dalam PDF
- Jika ada, pertimbangkan crop di level PDF sebelum render

### Step 5: Test dengan spreadsheet yang berbeda
- Test dengan spreadsheet yang data cuma 1 cell (range kecil)
- Test dengan spreadsheet yang data sampai row terakhir (tanpa whitespace bawah)
- Bandingkan hasil crop

### Step 6: Iterasi
- Setiap perubahan, test ulang
- Catat threshold mana yang paling baik untuk spreadsheet current

---

## Action Items

- [ ] Screenshot spreadsheet aktual, ukur whitespace
- [ ] Tambah debug logging di JS crop
- [ ] Adjust threshold TH dari 12 → 8 → 6
- [ ] Test sharp.trim() dengan threshold berbeda (8, 5)
- [ ] Cek apakah masalahnya di PDF export atau di crop
- [ ] Jika perlu, tambah crop 1px extra sebagai safety margin

---

## Rollback Plan

- Jika perubahan menyebabkan crop terlalu agresif (potong konten), revert ke commit terakhir yang working (`7bbd12e`)
- Sharp binary akan tetap di-package, tapi di-handle oleh current fallback mechanism

---

## Metric Success

- Tanpa whitespace di 4 sisi (top, right, bottom, left) untuk spreadsheet 1 cell
- Tidak ada konten yang terpotong
- PNG size minimal (tidak ada padding putih yang tidak perlu)