#!/bin/bash
# deploy.sh
# VASA - Virtual Assistant SOC Arjawinangun
# Script untuk deploy ke Cloudflare Workers dan push ke GitHub

echo "=========================================="
echo " VASA - Deploy Script"
echo "=========================================="

# 1. Set secrets (hanya perlu dijalankan sekali)
echo ""
echo "[1/4] Setting secrets..."
echo "Note: Secrets sudah seharusnya sudah di-set sebelumnya."
echo "Jika belum, jalankan perintah berikut:"
echo "  npx wrangler secret put SEATALK_APP_ID"
echo "  npx wrangler secret put SEATALK_APP_SECRET"
echo "  npx wrangler secret put GOOGLE_PRIVATE_KEY"
echo "  npx wrangler secret put GOOGLE_CLIENT_EMAIL"

# 2. Install dependencies
echo ""
echo "[2/4] Installing dependencies..."
npm install

# 3. Deploy to Cloudflare Workers
echo ""
echo "[3/4] Deploying to Cloudflare Workers..."
npx wrangler deploy

# 4. Push to GitHub
echo ""
echo "[4/4] Pushing to GitHub..."
git add -A
git commit -m "Deploy: VASA bot update - $(date '+%Y-%m-%d %H:%M:%S')"
git push origin main

echo ""
echo "=========================================="
echo " Deploy Complete!"
echo "=========================================="