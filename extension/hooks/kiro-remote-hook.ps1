param(
  [Parameter(Mandatory = $true)][string]$Endpoint,
  [switch]$Blocking
)

$RelayUrl = 'http://localhost:3737'
$RequestTimeoutSec = 70
$TokenFile = Join-Path $env:USERPROFILE '.kiro-remote\token'

# Hooks deliberately fail open when the relay is unavailable.
if (-not (Test-Path $TokenFile)) { exit 0 }
$Token = (Get-Content -Raw $TokenFile).Trim()
if (-not $Token) { exit 0 }

$Payload = [Console]::In.ReadToEnd()
$Headers = @{ Authorization = "Bearer $Token" }

try {
  $Response = Invoke-RestMethod `
    -Uri "$RelayUrl/hook/$Endpoint" `
    -Method Post `
    -Headers $Headers `
    -ContentType 'application/json' `
    -Body $Payload `
    -TimeoutSec $RequestTimeoutSec
} catch {
  exit 0
}

if ($Blocking -and $Response.action -eq 'deny') {
  [Console]::Error.WriteLine("Denied by Kiro Remote: $($Response.reason)")
  exit 1
}

exit 0
