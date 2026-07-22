---
title: B-Cube Tech Screenshot Bot
emoji: 📸
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# B-Cube Tech Screenshot Bot
Space ini digunakan untuk menjalankan service screenshot bot.

# HF Spaces - Puppeteer Screenshot API

Hugging Face Space untuk render PDF-to-PNG menggunakan Puppeteer/Chromium.

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check |
| `/screenshot` | POST | Bearer | Convert PDF to PNG |
| `/stats` | GET | Bearer | Usage statistics |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HF_API_KEY` | Yes | API key untuk proteksi endpoint |
| `CHROME_PATH` | No | Path ke Chromium binary |
| `NODE_ENV` | No | Environment (default: production) |

## Deploy

Push ke GitHub repo `ba-1-a/B-Cube_Tech`, HF Spaces auto-deploy via Docker.

## Arsitektur

Vercel (lightweight) → HF Spaces (heavy lifting)
- Vercel API Gateway menerima request dari Cloudflare Workers
- Meneruskan PDF ke HF Spaces untuk di-render via Puppeteer
- HF Spaces return PNG ke Vercel, diteruskan ke client

## Testing

```bash
curl -H "Authorization: Bearer $HF_API_KEY" \
  -X POST https://ba-1-a-b-cube-tech.hf.space/screenshot \
  -H "Content-Type: application/json" \
  -d '{"pdf_base64": "..."}'