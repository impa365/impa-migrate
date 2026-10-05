# Deploy do Worker SetupImpa (Cloudflare)
# Uso (PowerShell):  .\scripts\deploy-setupimpa-worker.ps1
# Requer token em senhacloud.txt com: Workers Scripts Edit + Workers Routes Edit + DNS Edit

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

# 1) Build the worker first to guarantee fresh install.sh and tarball
Write-Host "Building workers/setupimpa.js..."
$pythonExe = if (Test-Path "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe") { "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" } elseif (Get-Command python -ErrorAction SilentlyContinue) { "python" } else { "py" }
& $pythonExe (Join-Path $Root "scripts\build-setupimpa-worker.py")

$tokenPath = Join-Path $Root "senhacloud.txt"
if (-not (Test-Path $tokenPath)) { throw "Missing senhacloud.txt" }

$env:CF_API_TOKEN = (Get-Content -Raw $tokenPath).Trim()
$headersJson = @{
  Authorization = "Bearer $($env:CF_API_TOKEN)"
  "Content-Type" = "application/json"
}

Write-Host "Verifying Cloudflare token..."
$verify = Invoke-RestMethod -Method GET -Uri "https://api.cloudflare.com/client/v4/user/tokens/verify" -Headers $headersJson
if (-not $verify.success) { throw "Token verify failed" }

$zoneResp = Invoke-RestMethod -Method GET -Uri "https://api.cloudflare.com/client/v4/zones?name=impa365.com" -Headers $headersJson
$zoneId = $zoneResp.result[0].id
$accountId = $zoneResp.result[0].account.id
Write-Host "Zone/Account OK: zone=$zoneId account=$accountId"

# 2) Ensure DNS records exist (proxied)
foreach ($sub in @("setup", "setupimpa")) {
  $fullName = "$sub.impa365.com"
  $dnsList = Invoke-RestMethod -Method GET -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?name=$fullName" -Headers $headersJson
  $dnsBody = @{
    type = "A"
    name = $sub
    content = "192.0.2.1"
    proxied = $true
    ttl = 1
    comment = "SetupImpa Worker"
  } | ConvertTo-Json

  if (@($dnsList.result).Count -gt 0) {
    $recId = $dnsList.result[0].id
    Invoke-RestMethod -Method PUT -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/$recId" -Headers $headersJson -Body $dnsBody | Out-Null
    Write-Host "DNS updated: $fullName -> 192.0.2.1"
  } else {
    Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records" -Headers $headersJson -Body $dnsBody | Out-Null
    Write-Host "DNS created: $fullName -> 192.0.2.1"
  }
}

# 3) Upload Worker module
$scriptName = "setupimpa"
$workerPath = Join-Path $Root "workers\setupimpa.js"
$workerBytes = [System.IO.File]::ReadAllBytes($workerPath)

$metaObj = @{
  main_module = "setupimpa.js"
  compatibility_date = "2024-11-01"
  bindings = @(
    @{ type = "durable_object_namespace"; name = "TELEMETRY_DO"; class_name = "TelemetryStore" }
  )
  migrations = @{
    new_tag = "v1-setupimpa-telemetry-do"
    new_sqlite_classes = @("TelemetryStore")
  }
}
$meta = $metaObj | ConvertTo-Json -Compress -Depth 8

$boundary = [guid]::NewGuid().ToString("N")
$utf8 = New-Object System.Text.UTF8Encoding $false
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
Add-BinPart "setupimpa.js" "setupimpa.js" "application/javascript+module" $workerBytes
$end = $utf8.GetBytes("--$boundary--`r`n")
$sb.Write($end, 0, $end.Length)
$form = $sb.ToArray()

$uploadHeaders = @{
  Authorization = "Bearer $($env:CF_API_TOKEN)"
  "Content-Type" = "multipart/form-data; boundary=$boundary"
}
$uploadUri = "https://api.cloudflare.com/client/v4/accounts/$accountId/workers/scripts/$scriptName"
Write-Host "Uploading setupimpa worker ($($workerBytes.Length) bytes)..."

try {
  $resp = Invoke-RestMethod -Method PUT -Uri $uploadUri -Headers $uploadHeaders -Body $form
  Write-Host "WORKER_UPLOAD success=$($resp.success)"
} catch {
  Write-Host "WORKER_UPLOAD with migration failed, retrying without migrations..."
  $metaObj.Remove("migrations")
  $meta = $metaObj | ConvertTo-Json -Compress -Depth 8
  $sb = New-Object System.IO.MemoryStream
  Add-TextPart "metadata" $null "application/json" $meta
  Add-BinPart "setupimpa.js" "setupimpa.js" "application/javascript+module" $workerBytes
  $end = $utf8.GetBytes("--$boundary--`r`n")
  $sb.Write($end, 0, $end.Length)
  $form = $sb.ToArray()
  try {
    $resp = Invoke-RestMethod -Method PUT -Uri $uploadUri -Headers $uploadHeaders -Body $form
    Write-Host "WORKER_UPLOAD success=$($resp.success)"
  } catch {
    Write-Host "WORKER_UPLOAD_FAIL"
    $_.ErrorDetails.Message
    throw
  }
}

# 4) Routes setup.impa365.com/* and setupimpa.impa365.com/* -> worker
$routes = Invoke-RestMethod -Method GET -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/workers/routes" -Headers $headersJson
foreach ($pat in @("setup.impa365.com/*", "setupimpa.impa365.com/*")) {
  $existingRoute = @($routes.result | Where-Object { $_.pattern -eq $pat })
  $routeBody = @{ pattern = $pat; script = $scriptName } | ConvertTo-Json
  if ($existingRoute.Count -gt 0) {
    $rid = $existingRoute[0].id
    Invoke-RestMethod -Method PUT -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/workers/routes/$rid" -Headers $headersJson -Body $routeBody | Out-Null
    Write-Host "ROUTE updated: $pat -> $scriptName"
  } else {
    Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/workers/routes" -Headers $headersJson -Body $routeBody | Out-Null
    Write-Host "ROUTE created: $pat -> $scriptName"
  }
}

# 5) Admin password secret for /painel
$painelPassPath = Join-Path $Root "painel-senha.txt"
if (-not (Test-Path $painelPassPath)) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 18
  $rng.GetBytes($bytes)
  $generated = ([Convert]::ToBase64String($bytes) -replace '[+/=]', 'x').Substring(0, 22)
  Set-Content -Path $painelPassPath -Value $generated -NoNewline -Encoding ascii
  Write-Host "Generated painel-senha.txt"
}
$adminPassword = (Get-Content -Raw $painelPassPath).Trim()
$secretBody = @{ name = "ADMIN_PASSWORD"; text = $adminPassword; type = "secret_text" } | ConvertTo-Json
$secretUri = "https://api.cloudflare.com/client/v4/accounts/$accountId/workers/scripts/$scriptName/secrets"
try {
  Invoke-RestMethod -Method PUT -Uri $secretUri -Headers $headersJson -Body $secretBody | Out-Null
  Write-Host "ADMIN_PASSWORD secret configured"
} catch {
  Write-Host "SECRET_FAIL"
  $_.ErrorDetails.Message
  throw
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  SETUPIMPA DEPLOY CONCLUIDO COM SUCESSO NO CLOUDFLARE!" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Landing Page: https://setup.impa365.com"
Write-Host "Alias:        https://setupimpa.impa365.com"
Write-Host "Painel:       https://setup.impa365.com/painel"
Write-Host "Install cmd:  bash <(curl -sSL https://setup.impa365.com)"
Write-Host "Pacote tar:   https://setup.impa365.com/setupimpa.tar.gz"
Write-Host "Senha Painel: $adminPassword (salva em painel-senha.txt)"
Write-Host "==========================================================" -ForegroundColor Green

$env:CF_API_TOKEN = $null
