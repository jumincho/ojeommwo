param(
  [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = "Stop"
$Common = Join-Path $ProjectRoot "scripts\local-failover-common.ps1"
if (-not (Test-Path -LiteralPath $Common -PathType Leaf)) {
  throw "Emergency common module not found: $Common"
}
. $Common
Disable-OjeommwoLocalEmergency -ProjectRoot $ProjectRoot

$remaining = @(Get-ScheduledTask -TaskName "ojeommwo-v2*" -ErrorAction SilentlyContinue)
if ($remaining.Count -gt 0) {
  $remaining | Select-Object TaskName, State | Format-Table -AutoSize
  exit 1
}

Write-Output "No local ojeommwo-v2 scheduled tasks remain."
