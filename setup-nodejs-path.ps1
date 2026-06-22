# setup-nodejs-path.ps1
# Script untuk setup Node.js PATH di PowerShell profile (tanpa admin rights)

$nodePath = "C:\Users\SPXID3657\Documents\Bawan\Kode\lib\node-v24.17.0-win-x64\node-v24.17.0-win-x64"

Write-Host "=== Setting up Node.js PATH ===" -ForegroundColor Cyan
Write-Host "Node.js path: $nodePath" -ForegroundColor Yellow

# 1. Cek apakah Node.js sudah ada di PATH
$currentPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -like "*$nodePath*") {
    Write-Host "OK: Node.js path sudah ada di user PATH" -ForegroundColor Green
} else {
    Write-Host "Menambahkan Node.js ke user PATH..." -ForegroundColor Yellow
    $newPath = $currentPath + ";" + $nodePath
    [System.Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "OK: Node.js path berhasil ditambahkan ke user PATH" -ForegroundColor Green
}

# 2. Setup PowerShell profile
Write-Host ""
Write-Host "=== Setting up PowerShell Profile ===" -ForegroundColor Cyan

$profilePath = $PROFILE
$profileDir = Split-Path -Parent $profilePath

# Buat directory profile jika belum ada
if (-not (Test-Path $profileDir)) {
    New-Item -Path $profileDir -Type Directory -Force | Out-Null
    Write-Host "OK: Profile directory created" -ForegroundColor Green
}

# Buat profile file jika belum ada
if (-not (Test-Path $profilePath)) {
    New-Item -Path $profilePath -Type File -Force | Out-Null
    Write-Host "OK: Profile file created" -ForegroundColor Green
}

# Baca profile yang ada
$profileContent = Get-Content $profilePath -Raw -ErrorAction SilentlyContinue

# Cek apakah Node.js path sudah ada di profile
if ($profileContent -like "*$nodePath*") {
    Write-Host "OK: Node.js path sudah ada di PowerShell profile" -ForegroundColor Green
} else {
    Write-Host "Menambahkan Node.js ke PowerShell profile..." -ForegroundColor Yellow
    
    # Tambahkan ke profile
    $line1 = ""
    $line1 += "# Node.js untuk VASA Seatalk Bot deployment"
    Add-Content -Path $profilePath -Value $line1
    
    $line2 = '$env:Path += "'
    $line2 += $nodePath
    $line2 += '"'
    Add-Content -Path $profilePath -Value $line2
    
    Write-Host "OK: Node.js path berhasil ditambahkan ke PowerShell profile" -ForegroundColor Green
}

# 3. Test Node.js
Write-Host ""
Write-Host "=== Testing Node.js ===" -ForegroundColor Cyan

# Reload PATH untuk session saat ini
$env:Path += ";" + $nodePath

try {
    $nodeVersion = & "$nodePath\node.exe" --version
    $npmVersion = & "$nodePath\npm.cmd" --version
    
    Write-Host "OK: Node.js version: $nodeVersion" -ForegroundColor Green
    Write-Host "OK: npm version: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Setup Complete! ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. RESTART PowerShell (close dan buka lagi)" -ForegroundColor White
Write-Host "2. Test: node --version" -ForegroundColor White
Write-Host "3. Test: npm --version" -ForegroundColor White
Write-Host "4. Deploy: cd 'C:\Users\SPXID3657\Documents\Bawan\Kode\Seatalk Bot\seatalk_bot'" -ForegroundColor White
Write-Host "5. Deploy: npm run deploy" -ForegroundColor White
Write-Host ""
Write-Host "Note: Node.js akan otomatis tersedia di semua PowerShell session baru" -ForegroundColor Gray

Write-Host ""
Write-Host "Press any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")