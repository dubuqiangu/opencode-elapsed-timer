# verify-install.ps1 — opencode-usage-meter one-click install self-verification.
# Run from anywhere after git push:  pwsh <repo>/scripts/verify-install.ps1
#
# Chain: local HEAD pushed -> plugin update -> plugin list commit match ->
#        on-disk installed version match -> installed file tree mirrors the
#        repo (src/test/docs counts) -> host opencode.json registration.
# Prints a PASS/FAIL line per check; exits 0 only when every check passes.
# This verifies the DISK state only — the running TUI still needs a full
# restart to pick the new code up (see docs/guides/install.md).
param(
  [string]$PluginId = "github:dubuqiangu/opencode-usage-meter"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path $PSScriptRoot -Parent
$script:failures = 0

function Assert-Check {
  param([string]$Label, [bool]$Condition, [string]$Detail = "")
  $suffix = if ($Detail) { "  ($Detail)" } else { "" }
  if ($Condition) {
    Write-Output ("PASS  " + $Label + $suffix)
  } else {
    Write-Output ("FAIL  " + $Label + $suffix)
    $script:failures++
  }
}

function Count-Files {
  param([string]$Directory)
  if (-not (Test-Path $Directory)) { return 0 }
  return @(Get-ChildItem $Directory -Recurse -File).Count
}

# --- expected state, derived from the local repo ----------------------------------
$packageJson = Get-Content (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedVersion = $packageJson.version
$localHead = (git -C $repoRoot rev-parse --short HEAD).Trim()
$originHead = (git -C $repoRoot rev-parse --short origin/main).Trim()
Assert-Check "local HEAD is pushed (HEAD == origin/main)" ($localHead -eq $originHead) "HEAD=$localHead origin=$originHead"

$expectedSrcCount = Count-Files (Join-Path $repoRoot "src")
$expectedTestCount = Count-Files (Join-Path $repoRoot "test")
$expectedDocsCount = Count-Files (Join-Path $repoRoot "docs")

# --- one-click update ---------------------------------------------------------------
Set-Location $env:USERPROFILE
$null = opencode plugin update $PluginId

# --- plugin list shows the pushed commit --------------------------------------------
$listLine = (opencode plugin list | Select-String -Pattern "usage-meter" | Select-Object -First 1).Line
$installedCommit = $null
if ($listLine) {
  $plainLine = $listLine -replace "$([char]27)\[[0-9;]*m", ""
  foreach ($token in ($plainLine -split "\s+")) {
    if ($token -match "^[0-9a-f]{7,}$") { $installedCommit = $token; break }
  }
}
Assert-Check "plugin list shows the pushed commit" ($installedCommit -eq $localHead) "installed=$installedCommit expected=$localHead"

# --- on-disk installed package -------------------------------------------------------
$cacheRoot = Join-Path $env:USERPROFILE ".cache\opencode\npm"
$packageRoot = Get-ChildItem $cacheRoot -Directory -Filter "git-opencode-usage-meter-*" |
  Sort-Object Name -Descending | Select-Object -First 1
$installedPkg = if ($packageRoot) { Join-Path $packageRoot.FullName "node_modules\opencode-usage-meter" } else { $null }
$installedVersion = if ($installedPkg -and (Test-Path (Join-Path $installedPkg "package.json"))) {
  (Get-Content (Join-Path $installedPkg "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
} else { $null }
Assert-Check "on-disk installed version matches package.json" ($installedVersion -eq $expectedVersion) "installed=$installedVersion expected=$expectedVersion"

$installedSrcCount = if ($installedPkg) { Count-Files (Join-Path $installedPkg "src") } else { -1 }
$installedTestCount = if ($installedPkg) { Count-Files (Join-Path $installedPkg "test") } else { -1 }
$installedDocsCount = if ($installedPkg) { Count-Files (Join-Path $installedPkg "docs") } else { -1 }
Assert-Check "installed src tree mirrors the repo" ($installedSrcCount -eq $expectedSrcCount) "installed=$installedSrcCount repo=$expectedSrcCount"
Assert-Check "installed test tree mirrors the repo" ($installedTestCount -eq $expectedTestCount) "installed=$installedTestCount repo=$expectedTestCount"
Assert-Check "installed docs tree mirrors the repo" ($installedDocsCount -eq $expectedDocsCount) "installed=$installedDocsCount repo=$expectedDocsCount"

# --- host registration -----------------------------------------------------------------
$hostConfigPath = Join-Path $env:USERPROFILE ".config\opencode\opencode.json"
$hostConfig = if (Test-Path $hostConfigPath) {
  Get-Content $hostConfigPath -Raw -Encoding UTF8
} else { "" }
Assert-Check "plugin registered in opencode.json" ($hostConfig.Contains($PluginId))

Write-Output "----"
if ($script:failures -eq 0) {
  Write-Output ("VERIFY OK — v$expectedVersion @ $localHead fully installed")
  exit 0
}
Write-Output ("VERIFY FAILED — $script:failures check(s) failed")
exit 1
