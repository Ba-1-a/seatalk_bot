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
echo "Jika belum, jalankan perintah berikut SATU PER SATU:"
echo ""
echo "  echo \"NzE2Mjg3ODUxMjc5\" | npx wrangler secret put SEATALK_APP_ID"
echo "  echo \"c3urIS7asdvFi0rIwbhuAKBklGWY1yQv\" | npx wrangler secret put SEATALK_APP_SECRET"
echo "  echo '-----BEGIN PRIVATE KEY-----' > /tmp/gkey.pem"
echo "  echo '(isi private_key dari service account)' >> /tmp/gkey.pem"
echo "  echo '-----END PRIVATE KEY-----' >> /tmp/gkey.pem"
echo "  npx wrangler secret put GOOGLE_PRIVATE_KEY < /tmp/gkey.pem"
echo "  echo \"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...\" | npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY"
echo ""
echo "CATATAN: Jangan commit .pem files ke GitHub!"

# 2. Install dependencies
echo ""
echo "[2/4] Installing dependencies..."
npm install

# 3. Deploy to Cloudflare Workers
echo ""
echo "[3/4] Deploying to Cloudflare Workers..."
export CLOUDFLARE_API_TOKEN="cfut_bc8SlAhJhsr7zpQhovoztYVaUbHkM1vG3deMQzL856825c05"
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