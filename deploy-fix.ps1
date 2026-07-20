# Deployment Script for Seatalk Bot
# Run this script from: projects/ba-1-a/seatalk_bot/
# Date: 2026-07-20
# Updated: Deployment method using Node 22 directly (wrangler requires v22+)

param(
    [string]$NodePath = "",
    [switch]$SkipWorker = $false,
    [switch]$SkipVercel = $false,
    [switch]$SkipGit = $false
)

# Find Node 22 executable
if (-not $NodePath -or -not (Test-Path $NodePath)) {
    $possiblePaths = @(
        "..\bin\node-22.23.1",
        "..\lib\node-v22.17.0-win-x64",
        "C:\Program Files\nodejs\node.exe"
    )
    foreach ($path in $possiblePaths) {
        $fullPath = Join-Path $PWD.Path $path
        if (Test-Path $fullPath) {
            $NodePath = $fullPath
            break
        }
    }
}
if (-not $NodePath) {
    $NodePath = "C:\Users\SPXID3657\Documents\Bawan\Kode\bin\node-22.23.1"
}

$nodeExe = Join-Path $NodePath "node.exe"
$ErrorActionPreference = "Stop"
$projectRoot = $PWD.Path

Write-Host "=== Seatalk Bot - Deployment Script ===" -ForegroundColor Cyan
Write-Host "Project root: $projectRoot`n"

# ============================================================
# STEP 1: Deploy Cloudflare Worker
# ============================================================
if (-not $SkipWorker) {
    Write-Host "`n[1/4] Deploying Cloudflare Worker..." -ForegroundColor Yellow
    
    # Use Node 22 directly to run wrangler (wrangler v4 requires Node 22+)
    # Do NOT use npx.cmd because it will use system Node (v20) which is incompatible
    $wranglerScript = Join-Path $projectRoot "node_modules\wrangler\bin\wrangler.js"
    
    if (-not (Test-Path $wranglerScript)) {
        Write-Host "ERROR: Wrangler not found at $wranglerScript" -ForegroundColor Red
        Write-Host "Please run 'npm install' first" -ForegroundColor Yellow
        exit 1
    }
    
    try {
        Push-Location $projectRoot
        
        # Set Cloudflare API token for non-interactive deploy
        $env:CLOUDFLARE_API_TOKEN = 'cfut_bc8SlAhJhsr7zpQhovoztYVaUbHkM1vG3deMQzL856825c05'
        
        # Deploy using Node 22 directly
        & $nodeExe $wranglerScript deploy --force
        
        Write-Host "`n✓ Cloudflare Worker deployed successfully" -ForegroundColor Green
    }
    catch {
        Write-Host "`n✗ Worker deployment failed: $_" -ForegroundColor Red
        Write-Host "Check your Cloudflare authentication and try again" -ForegroundColor Yellow
    }
    finally {
        Pop-Location
    }
}
else {
    Write-Host "`n[1/4] Skipping Cloudflare Worker deployment" -ForegroundColor Gray
}

# ============================================================
# STEP 2: Deploy Vercel Function
# ============================================================
if (-not $SkipVercel) {
    Write-Host "`n[2/4] Deploying Vercel function..." -ForegroundColor Yellow
    
    # Check if vercel CLI is available
    $vercelCmd = Get-Command vercel -ErrorAction SilentlyContinue
    if (-not $vercelCmd) {
        Write-Host "WARNING: Vercel CLI not found. Installing..." -ForegroundColor Yellow
        npm install -g vercel
    }
    
    try {
        Push-Location $projectRoot
        
        # Pull environment if needed
        Write-Host "  - Pulling environment variables..." -ForegroundColor Gray
        vercel pull --yes --yes 2>$null
        
        # Deploy to production
        Write-Host "  - Deploying to production..." -ForegroundColor Gray
        vercel --prod --yes
        
        Write-Host "`n✓ Vercel function deployed successfully" -ForegroundColor Green
        Write-Host "  Verify at: https://vercel.com/dashboard" -ForegroundColor Cyan
    }
    catch {
        Write-Host "`n✗ Vercel deployment failed: $_" -ForegroundColor Red
        Write-Host "You can deploy manually later with: vercel --prod" -ForegroundColor Yellow
    }
    finally {
        Pop-Location
    }
}
else {
    Write-Host "`n[2/4] Skipping Vercel deployment" -ForegroundColor Gray
}

# ============================================================
# STEP 3: Commit and Push to GitHub
# ============================================================
if (-not $SkipGit) {
    Write-Host "`n[3/4] Committing and pushing to GitHub..." -ForegroundColor Yellow
    
    try {
        Push-Location $projectRoot
        
        # Configure git if needed
        $gitUser = git config user.name
        $gitEmail = git config user.email
        
        if (-not $gitUser) {
            git config user.name "Seatalk Bot Deploy"
            git config user.email "deploy@bawanappratama.com"
        }
        
        # Add all changes
        git add .
        
        # Commit with current changes
        $commitMessage = @"
fix: resolve spam handling, group chat screenshot, and thread issues

- Add stripMentions() and deduplicateConsecutiveCommands()
- Improve argument parsing for screenshot commands in group chat
- Fix thread handling for long responses in group chat
- Increase HF Spaces timeout from 30s to 60s for large PDFs
- Update AGENTS_HANDOVER.md with deployment instructions

Fixes:
- Bot not handling spam commands correctly
- Group chat screenshot failures due to @mention and argument parsing
- Large PDF timeouts in HF Spaces (2.6MB PDF)
- Thread reply inconsistencies in group chat
"@
        
        git commit -m $commitMessage
        
        # Push
        git push origin main
        
        Write-Host "`n✓ Changes committed and pushed to GitHub" -ForegroundColor Green
        Write-Host "  Repository: https://github.com/Ba-1-a/seatalk_bot" -ForegroundColor Cyan
    }
    catch {
        Write-Host "`n✗ Git operations failed: $_" -ForegroundColor Red
        Write-Host "You can commit manually later with:" -ForegroundColor Yellow
        Write-Host "  git add ." -ForegroundColor White
        Write-Host "  git commit -m 'fix: resolve spam handling and group chat issues'" -ForegroundColor White
        Write-Host "  git push origin main" -ForegroundColor White
    }
    finally {
        Pop-Location
    }
}
else {
    Write-Host "`n[3/4] Skipping Git commit/push" -ForegroundColor Gray
}

# ============================================================
# STEP 4: Verification
# ============================================================
Write-Host "`n[4/4] Verification Checklist" -ForegroundColor Yellow
Write-Host @"
Please verify the following:

Cloudflare Worker:
  ✓ Endpoint: https://seatalk-bot.bawanappratama.workers.dev
  ✓ Test: curl https://seatalk-bot.bawanappratama.workers.dev/health

Vercel Function:
  ✓ Endpoint: https://seatalkbot.vercel.app/api/pdf-to-png
  ✓ maxDuration: 90 seconds (check Vercel dashboard)
  ✓ Environment: HF_API_KEY configured

GitHub:
  ✓ Latest commit includes fix changes
  ✓ Repository: https://github.com/Ba-1-a/seatalk_bot

Testing:
  [ ] Private chat: /screenshot (should work as before)
  [ ] Group chat: /screenshot (should now succeed)
  [ ] Large sheet: /screenshot range=A1:D50 (should work better)
"@ -ForegroundColor Cyan

Write-Host "`n=== Deployment Complete ===" -ForegroundColor Green
Write-Host "Monitor logs for any issues:" -ForegroundColor Yellow
Write-Host "  Cloudflare: .\bin\node-22.23.1\node.exe node_modules\wrangler\bin\wrangler.js tail seatalk-bot" -ForegroundColor Gray
Write-Host "  Vercel: vercel logs https://seatalkbot.vercel.app/api/pdf-to-png --follow`n" -ForegroundColor Gray

# ============================================================
# Quick Deployment Reference
# ============================================================
Write-Host "`n=== QUICK REFERENCE ===" -ForegroundColor Cyan
Write-Host "Worker URL: https://seatalk-bot.bawanappratama.workers.dev" -ForegroundColor White
Write-Host "GitHub: https://github.com/Ba-1-a/seatalk_bot" -ForegroundColor White
Write-Host "`nManual deploy commands:" -ForegroundColor Yellow
Write-Host "  Worker: `$env:CLOUDFLARE_API_TOKEN='cfut_bc8SlAhJhsr7zpQhovoztYVaUbHkM1vG3deMQzL856825c05'; C:\Users\SPXID3657\Documents\Bawan\Kode\bin\node-22.23.1\node.exe node_modules\wrangler\bin\wrangler.js deploy" -ForegroundColor Gray
Write-Host "  Vercel: vercel --prod --yes" -ForegroundColor Gray
