param(
  [Parameter(Mandatory=$true)]
  [string]$PdfPath,
  [string]$VercelUrl = $env:VERCEL_PDF_TO_PNG_URL,
  [string]$HfUrl = $env:HF_SPACES_URL,
  [string]$HfKey = $env:HF_API_KEY
)

if (-not (Test-Path $PdfPath)) {
  Write-Error "PDF file not found: $PdfPath"
  exit 1
}

if (-not $VercelUrl) { Write-Error 'VERCEL_PDF_TO_PNG_URL not set in env'; exit 1 }

$bytes = [System.IO.File]::ReadAllBytes($PdfPath)
$base64 = [System.Convert]::ToBase64String($bytes)
$payload = @{ pdf_base64 = $base64 } | ConvertTo-Json -Depth 4

Write-Host "Posting to Vercel gateway: $VercelUrl"
$response = Invoke-RestMethod -Uri $VercelUrl -Method Post -Body $payload -ContentType 'application/json' -ErrorAction Stop -OutFile out_vercel.png
Write-Host "Vercel returned file saved to out_vercel.png (size: $(Get-Item out_vercel.png).Length) bytes"

if ($HfUrl -and $HfKey) {
  Write-Host "Posting directly to HF Spaces: $HfUrl/screenshot"
  $headers = @{ Authorization = "Bearer $HfKey" }
  Invoke-RestMethod -Uri "$HfUrl/screenshot" -Method Post -Body $payload -ContentType 'application/json' -Headers $headers -ErrorAction Stop -OutFile out_hf.png
  Write-Host "HF Spaces returned file saved to out_hf.png (size: $(Get-Item out_hf.png).Length) bytes"
} else {
  Write-Host "HF_SPACES_URL or HF_API_KEY not set; skipping direct HF test"
}
