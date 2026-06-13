<#
  scrydex-403-probe.ps1 — isolate the /v1/cards 403 (since 2026-06-07).

  Creds: reads SCRYDEX_API_KEY / SCRYDEX_TEAM_ID from the environment, falling
  back to Ingestion/.dev.vars. NEVER hardcode the key in this file.

  Run from anywhere:
    pwsh ./scripts/scrydex-403-probe.ps1        # PowerShell 7
    powershell -File .\scripts\scrydex-403-probe.ps1   # Windows PowerShell 5.1

  Each /cards call that reaches Scrydex may cost 1 credit (~7 total here —
  negligible vs the 50k cap). Do not loop it.
#>

$ErrorActionPreference = 'Stop'

# ── Load credentials ─────────────────────────────────────────────────────────
$key  = $env:SCRYDEX_API_KEY
$team = $env:SCRYDEX_TEAM_ID
if (-not $key -or -not $team) {
  $devVars = Join-Path $PSScriptRoot '..\.dev.vars'
  if (Test-Path $devVars) {
    foreach ($line in Get-Content $devVars) {
      if ($line -match '^\s*SCRYDEX_API_KEY\s*=\s*"?([^"\s]+)"?') { if (-not $key)  { $key  = $Matches[1] } }
      if ($line -match '^\s*SCRYDEX_TEAM_ID\s*=\s*"?([^"\s]+)"?')  { if (-not $team) { $team = $Matches[1] } }
    }
  }
}
if (-not $key -or -not $team) {
  Write-Host "Missing creds. Set them first, e.g.:" -ForegroundColor Red
  Write-Host '  $env:SCRYDEX_API_KEY = "..."; $env:SCRYDEX_TEAM_ID = "..."' -ForegroundColor Yellow
  Write-Host "  …or add SCRYDEX_API_KEY / SCRYDEX_TEAM_ID to Ingestion/.dev.vars (gitignored)."
  exit 1
}

$H = @{ 'X-Api-Key' = $key; 'X-Team-ID' = $team; 'Accept' = 'application/json' }

# ── Request helper: prints status + body, works on PS 5.1 and 7 ──────────────
function Invoke-SX {
  param([string]$Label, [string]$Url)
  Write-Host "`n=== $Label ===" -ForegroundColor Cyan
  Write-Host $Url -ForegroundColor DarkGray
  $body = $null; $code = $null
  try {
    $r    = Invoke-WebRequest -Uri $Url -Headers $H -Method GET -UseBasicParsing
    $code = [int]$r.StatusCode
    $body = $r.Content
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $code = [int]$resp.StatusCode
      try {
        $sr   = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $sr.ReadToEnd(); $sr.Close()
      } catch { $body = '<could not read error body>' }
    } else {
      Write-Host ("NETWORK ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
      return
    }
  }
  $color = if ($code -ge 200 -and $code -lt 300) { 'Green' } else { 'Yellow' }
  Write-Host ("HTTP {0}" -f $code) -ForegroundColor $color
  if ($body) { Write-Host $body.Substring(0, [Math]::Min(800, $body.Length)) }
}

$base = 'https://api.scrydex.com'

Invoke-SX '1. CONTROL: account usage (key valid?)'        "$base/account/v1/usage"
Invoke-SX '2. CONTROL: pokemon expansions (data scope?)'  "$base/pokemon/v1/expansions"
Invoke-SX '3. EXACT failing call (worker makes this)'     "$base/pokemon/v1/cards?expansion=me2&include=prices&limit=500"
Invoke-SX '4. cards WITHOUT include=prices'               "$base/pokemon/v1/cards?expansion=me2&limit=500"
Invoke-SX '5. cards WITHOUT expansion filter'             "$base/pokemon/v1/cards?limit=5"
Invoke-SX '6. cards on an OLDER expansion (sv10)'         "$base/pokemon/v1/cards?expansion=sv10&include=prices&limit=5"
Invoke-SX '7. different game (onepiece)'                  "$base/onepiece/v1/cards?limit=5"

Write-Host "`nDone. The body of any 403 (esp. #3) usually names the cause." -ForegroundColor Cyan
