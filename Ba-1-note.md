# Pastikan Repo sudah menggunakan arsitektur berikut dan perbaiki kelemahannya

## Begini aturan mainnya :

- Gunakan Cloudflare Workers untuk Event Callback 
- Selalu comment nama file di setiap awal kode agar aku gak salah edit
- Karena sudah mentok memanfaatkan tier gratis yang harus daftar KK, kita hindari fitur freemium 
- Proses screenshot [Export ke PDF -> PDF to PNG -> PNG kirim ke seatalk (reason : Aku mau bot screenshot apa yang user lihat di spreadsheet)]
- Buat worker lolos seatalk_challenge
- Jangan render lewat HTML, tapi benar-benar ambil screenshot
- selalu put secret
- selalu deploy pakai token untuk mencegah user input manual dan selalu push ke GitHub agar tidak ada progres terbuang
- jangan terlalu agresif saat menggunakan terminal, ada delay beberapa detik
- jangan ragu untuk menambah file baru maupun menghapus file lama / file yang sudah tidak relevan
- jangan pakai email default PC, hanya pakai email dibawah ini sesuai kebutuhan:
  - Email Kantor (bawana.pratama@spx-external.com)
  - Email Pribadi (bawanappratama@gmail.com)\
- jangan install key ataupun secret apapun di root, kita menggunakan laptop kantor


## Infrastruktur

### Email Kantor (bawana.pratama@spx-external.com) :

#### Seatalk Custom App

- App ID : NzE2Mjg3ODUxMjc5
- App Secret : c3urIS7asdvFi0rIwbhuAKBklGWY1yQv

#### Google Service Account
 
- vasa-725@studio-1196053014-a94d0.iam.gserviceaccount.com
- GOOGLE_PRIVATE_KEY :
```
{
  "type": "service_account",
  "project_id": "studio-1196053014-a94d0",
  "private_key_id": "f4c5d3ed2184cd55e436bd0dd8e28126e64e2056",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDTLteN85kD+s3m\nYej9onE2SfhiufAda+8JA7j3CoRfGx7dz/exNc3FeGgAuamy2vwywsEDLGhZRuOE\n0jf94FOhH5CDeRCmIWpYcukKWQ7MTaKvqViUamGf7wEKZTBQ+2m1Yk1UhNQiwI4k\nz5eAwhLxEfRYOjMqXGOqRbH6lvGI5zyP6qWG1/+TuEQRGwuEOEiPZtOyBIK8pxnR\n0q/bgR44VYlCtMhHt4VWKazgec3Y1CfdS7QzbgtRVyoolN/Mkbo5QKHZ1UY8x4yI\nFYlBY4OVT5ICI1Cmu4IGA31lRGd1eNOhae0ZnsuGLtjUcZn4+s6Ea4YlGz2OpYmG\nDsIf1t8VAgMBAAECggEADPMG9d+L1woIM1B22Fg5BIqXaxTA6LAkN/N9FW2uqj15\nsHSlJb4Jc33FNG4uCrD4D/P2bXrJ0NefWEo8c4CcgCyOtveAeHKW5WK+b9gzWrG6\nZqnfeNJN6pNEOnfz9Rmr5LRpAeRXNOS4kpp45sTmIz2yzVb13J4a4M3MDEEFmuhY\nDKVt8hRhAX/LRlYYdW2sals7Ba+GO2IcJP4RK2kSpV9i8WTHM+K+igbS2s86Flh2\nfLfKZxIOBPKam+LLb8p+G1DUU6M7qWqq6Zc8vvV65kPRZAEmq+Q/VlJp2d2bgMlZ\nRzN3odNrmtdKhL+HPtk9kdrQcBl/1bBmAINJU8H0bQKBgQDpRhU7ts84h3zWKj4X\nceP44VXtLd1bbHPsxJTngL61aSAxoBgLpCk3hn0V1BivIMltH5XM/JJwDN0pBI/z\n8Weuev3gUpTPLYoju6QtvpmS0pGY9axBGPWlfkIelZirbji0OFTbIe+WrXNfRs7K\n9J8ZNWMmz6aVAQ/uh/KH6UsWFwKBgQDnwc7txkESz+RVzP0PeBTSPsxOOzcsh7cP\nZcApRL2dg9hAQdaoFX/0zmCCghYFEtKuSCWK8Rx9TRM6QHTUC2e+PZvS6knMNy/I\nAa1IAUpGPfANn6MjkRp4kXrNEI5HpFP0uCrrILTPdupZwzh5hyzB4/kg6NuEyl5R\nR78Gtk4bswKBgDE8yrSM9JZA+teVmP+H2Y+puGJUoPlwHdPm9msa4KYX52SyHwEu\nCEkhCPv3hbJJYFq5JPxcf2hJPtEullfuJ21LppSXubM1MIg0TgYdyfqUmYjIqjAf\nXZIt4TTlbJEatbtMfJS4SALs34JHxtRN59sBSslhYQ7oZ314knefhWrHAoGBAJyt\np8mT6FZheYqQBN06X0kr709MNSbDsXyVW24K7O3aPo5idE46CsFj7FcOvvg7G3d7\nivX9vzburnsJLHJWK5Kvb/MNNUr8XC8pAw7U4HPQV8O+Erpu1KiCIbUU5juE2sVs\n5IcFG3fOeuyoUDvIqPeDud8HzbBeZ5knmftdsDyFAoGBALvzuBTR+kJzWfPQrM+v\nlKz0xLUqrP0mVKxVbdon4ffpLjZrpKMGuYinBNJJpROvPztI1Jps37Pn4E9r1GcR\n5yCf9v2SdxN2WYAaOkJdOFpoDcnDdtY5YDFodyt2CEhbOWaROFJwRMGcu/I8F3rD\n2HWUxMNqTkluAuqX54Nuz6mE\n-----END PRIVATE KEY-----\n",
  "client_email": "vasa-725@studio-1196053014-a94d0.iam.gserviceaccount.com",
  "client_id": "105005089149237610568",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/vasa-725%40studio-1196053014-a94d0.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
}
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
- VERCEL_TOKEN = vcp_05xEKA7JCRDCpY8uiURVvu99CxqdLtW7x4J1nrxFSJtYSMbTSD2K8wBa

#### Supabase 

- https://gsdtravhmqbzkwdujkve.supabase.co
- Publishable key : sb_publishable_hgnywAp2NTYe31BFd41fXg_YS5R6qng
- Secret keys : sb_secret_CE5G8RTNXljujP7AyBkP8Q_v3b9eNsN
- service_role : eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdzZHRyYXZobXFiemt3ZHVqa3ZlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTI2NTIyMCwiZXhwIjoyMDk2ODQxMjIwfQ.zm7mj7lb2yea5WnS9SxD22ZqtyQYw9PORMPSpDAcQR0
- anon public : eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdzZHRyYXZobXFiemt3ZHVqa3ZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNjUyMjAsImV4cCI6MjA5Njg0MTIyMH0.vIs5hE0_AAivB0ghYt777_QJZDhQgLHSkXVGXwFpKC8
- Project name : seatalk_bot
- Project ID : gsdtravhmqbzkwdujkve

### Huggung Face Spaces

- ba-1-a/B-Cube_Tech
- HF_API_KEY = "adf66d648188c72c3173b698948a128f4b8f7a13b32014bff9ee914b43a6007a"


## Kelemahan Yang Diketahui

1. Bot menolak command spam [⏳ Sedang memproses screenshot sebelumnya. Mohon tunggu hingga selesai sebelum request baru.]
2. Gagal memproses screenshot range panjang yang sebelumnya berhasil, contoh command [/screenshot https://docs.google.com/spreadsheets/d/1p3Ag8tAIBWYxOp9CAtn_He6wiOeEPfj3p_Cfm1RLaI8/edit?pli=1&gid=357702624#gid=357702624 tab_name=Kari Share range=J8:P73]


## Next Steps

- [x] Fix whitespace issue (V7)
- [x] Hugging Face Spaces Integration (Need Check)
- [x] Fix group chat messaging
- [ ] Fix screenshot range besar
- [ ] Scheduling screenshot (auto-report)
- [ ] Sheet context understanding untuk AI
- [ ] Threshold alert & notification