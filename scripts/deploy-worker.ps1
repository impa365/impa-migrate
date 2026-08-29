# Deploy do Worker IMPA Migrator (Cloudflare)
# Uso (PowerShell):  .\scripts\deploy-worker.ps1
# Requer token com: Workers Scripts Edit + Workers Routes Edit + DNS Edit + Single Redirect Edit

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$tokenPath = Join-Path $Root "senhacloud.txt"
if (-not (Test-Path $tokenPath)) { throw "Missing senhacloud.txt" }

$env:CF_API_TOKEN = (Get-Content -Raw $tokenPath).Trim()
$headersJson = @{
  Authorization = "Bearer $($env:CF_API_TOKEN)"
  "Content-Type" = "application/json"
}

Write-Host "Verifying token..."
$verify = Invoke-RestMethod -Method GET -Uri "https://api.cloudflare.com/client/v4/user/tokens/verify" -Headers $headersJson
if (-not $verify.success) { throw "Token verify failed" }

$zoneResp = Invoke-RestMethod -Method GET -Uri "https://api.cloudflare.com/client/v4/zones?name=impa365.com" -Headers $headersJson
$zoneId = $zoneResp.result[0].id
$accountId = $zoneResp.result[0].account.id
Write-Host "Zone/account OK"

# 1) Remove old dynamic redirect to GitHub (conflicts with Worker)
$phaseUri = "https://api.cloudflare.com/client/v4/zones/$zoneId/rulesets/phases/http_request_dynamic_redirect/entrypoint"
try {
  $existing = Invoke-RestMethod -Method GET -Uri $phaseUri -Headers $headersJson
  $kept = @($existing.result.rules | Where-Object {
    $_.description -ne "IMPA Migrator -> GitHub raw script" -and
    ($_.expression -notlike "*migrator.impa365.com*")
  })
  $body = @{ rules = @($kept) } | ConvertTo-Json -Depth 12
  Invoke-RestMethod -Method PUT -Uri $phaseUri -Headers $headersJson -Body $body | Out-Null
  Write-Host "Redirect rules cleaned (migrator rule removed if present)"
} catch {
  Write-Host "No redirect entrypoint or cleanup skipped"
}

# 2) Ensure DNS migrator exists (proxied)
$dnsList = Invoke-RestMethod -Method GET -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?name=migrator.impa365.com" -Headers $headersJson
$dnsBody = @{
  type = "A"
  name = "migrator"
  content = "192.0.2.1"
  proxied = $true
  ttl = 1
  comment = "IMPA Migrator Worker"
} | ConvertTo-Json
if (@($dnsList.result).Count -gt 0) {
  $recId = $dnsList.result[0].id
  Invoke-RestMethod -Method PUT -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/$recId" -Headers $headersJson -Body $dnsBody | Out-Null
  Write-Host "DNS updated"
} else {
  Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records" -Headers $headersJson -Body $dnsBody | Out-Null
  Write-Host "DNS created"
}

# 3) Upload Worker module
$scriptName = "impa-migrator"
$workerPath = Join-Path $Root "workers\migrator.js"
$workerBytes = [System.IO.File]::ReadAllBytes($workerPath)

$boundary = [guid]::NewGuid().ToString("N")
$utf8 = New-Object System.Text.UTF8Encoding $false
$meta = @{
  main_module = "migrator.js"
  compatibility_date = "2024-11-01"
} | ConvertTo-Json -Compress

$sb = New-Object System.IO.MemoryStream
function Add-TextPart($name, $filename, $contentType, $text) {
  $header = "--$boundary`r`nContent-Disposition: form-data; name=`"$name`""
  if ($filename) { $header += "; filename=`"$filename`"" }
  $header += "`r`nContent-Type: $contentType`r`n`r`n"
  $bytes = $utf8.GetBytes($header + $text + "`r`n")
  $sb.Write($bytes, 0, $bytes.Length)
}
function Add-BinPart($name, $filename, $contentType, [byte[]]$data) {
  $header = "--$boundary`r`nContent-Disposition: form-data; name=`"$name`"; filename=`"$filename`"`r`nContent-Type: $contentType`r`n`r`n"
  $h = $utf8.GetBytes($header)
  $sb.Write($h, 0, $h.Length)
  $sb.Write($data, 0, $data.Length)
  $nl = $utf8.GetBytes("`r`n")
  $sb.Write($nl, 0, $nl.Length)
}

Add-TextPart "metadata" $null "application/json" $meta
Add-BinPart "migrator.js" "migrator.js" "application/javascript+module" $workerBytes
$end = $utf8.GetBytes("--$boundary--`r`n")
$sb.Write($end, 0, $end.Length)
$form = $sb.ToArray()

$uploadHeaders = @{
  Authorization = "Bearer $($env:CF_API_TOKEN)"
  "Content-Type" = "multipart/form-data; boundary=$boundary"
}
$uploadUri = "https://api.cloudflare.com/client/v4/accounts/$accountId/workers/scripts/$scriptName"
Write-Host "Uploading worker..."
try {
  $resp = Invoke-RestMethod -Method PUT -Uri $uploadUri -Headers $uploadHeaders -Body $form
  Write-Host "WORKER_UPLOAD success=$($resp.success)"
} catch {
  Write-Host "WORKER_UPLOAD_FAIL"
  $_.ErrorDetails.Message
  throw
}

# 4) Route migrator.impa365.com/* → worker
$routes = Invoke-RestMethod -Method GET -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/workers/routes" -Headers $headersJson
$pattern = "migrator.impa365.com/*"
$existingRoute = @($routes.result | Where-Object { $_.pattern -eq $pattern })
$routeBody = @{ pattern = $pattern; script = $scriptName } | ConvertTo-Json
if ($existingRoute.Count -gt 0) {
  $rid = $existingRoute[0].id
  Invoke-RestMethod -Method PUT -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/workers/routes/$rid" -Headers $headersJson -Body $routeBody | Out-Null
  Write-Host "ROUTE updated"
} else {
  Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/workers/routes" -Headers $headersJson -Body $routeBody | Out-Null
  Write-Host "ROUTE created"
}

Write-Host "DONE"
Write-Host "Browser: https://migrator.impa365.com"
Write-Host "Script:  curl -sSL https://migrator.impa365.com | head"
Write-Host "Install: curl -sSL https://migrator.impa365.com/install | head"

$env:CF_API_TOKEN = $null
