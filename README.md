# seatalk_bot

## PERINGATAN PRIVASI

Repositori ini sekarang menggunakan mekanisme pengambilan tangkapan layar self-hosted yang menyimpan hasil gambar ke dalam direktori `screenshots/` di repositori.

- WAJIB: Repositori harus dikonfigurasi sebagai **Private Repository** di GitHub. Jika repositori diubah menjadi publik, semua screenshot yang dihasilkan dapat terekspos ke publik.
- Jangan menyimpan kredensial atau data sensitif secara langsung di dalam tangkapan layar yang di-commit.

## Setup Screenshot Otomatis

1. Tambahkan secret GitHub repository:
   - `TARGET_URL` → URL target yang akan di-capture oleh workflow.
   - `SEATALK_APP_ID` → SeaTalk app_id yang akan digunakan oleh workflow untuk mengirim screenshot.
   - `SEATALK_APP_SECRET` → SeaTalk app_secret yang akan digunakan oleh workflow.

2. Tambahkan secret Cloudflare Worker (atau wrangler secret):
   - `GITHUB_TRIGGER_TOKEN` → Personal Access Token GitHub.
   - Disarankan menggunakan **Fine-grained Personal Access Token** yang valid untuk repo ini.
   - Untuk fine-grained PAT, berikan akses ke repository `bp-pratama/seatalk_bot` dan permission `Actions` dengan `Read & write`.
   - Untuk classic PAT, berikan scope `repo` dan/atau `workflow`.
   - Pastikan token sebenarnya bisa mengakses `https://api.github.com/repos/bp-pratama/seatalk_bot/actions/workflows/screenshot.yml/dispatches`.
   - Contoh format:
     - `GITHUB_TRIGGER_TOKEN="github_pat_xxxxxxxx..."`
   - Token ini digunakan oleh bot untuk memicu workflow `screenshot.yml` melalui API GitHub.

3. Pastikan Worker memiliki variable/secret `GITHUB_TRIGGER_TOKEN` di environment.
   - Jika tidak tersedia, perintah `/screenshot` akan mengembalikan error.

4. `workflow_dispatch` juga menerima input `target_url`, `target_id`, `is_group`, `thread_id`, dan `original_message_id`.

## Cara Kerja

- Bot Seatalk menggunakan perintah `/screenshot` untuk memicu workflow GitHub Actions.
- Workflow menjalankan `node screenshot.js` di runner Ubuntu dan mengambil screenshot.
- Jika `SEATALK_APP_ID`, `SEATALK_APP_SECRET`, dan target Seatalk dikirim dari bot, screenshot langsung dikirim ke Seatalk.
- Hasil screenshot tidak lagi dipush ke repositori.

## Catatan

- `screenshots/` hanya digunakan sebagai penyimpanan lokal sementara di Action runner.
- `GITHUB_TRIGGER_TOKEN`, `SEATALK_APP_ID`, dan `SEATALK_APP_SECRET` harus disimpan sebagai secret.
- Jangan masukkan token atau kredensial ke dalam kode sumber.
