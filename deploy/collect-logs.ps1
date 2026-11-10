<#
.SYNOPSIS
  Collect VMGauge diagnostic logs from the head unit and save them to a file.

.DESCRIPTION
  Pulls the app's own log (with the raw UDS/DID replies) and the head unit's
  system log (logread), filtered, and writes them to OutFile.

.EXAMPLE
  .\deploy\collect-logs.ps1 -HostName 169.254.102.111 -KeyPath "$env:USERPROFILE\Downloads\MGU-SSH\data\enrollments\<VIN>\id_rsa"
#>
[CmdletBinding()]
param(
    [string]$HostName,
    [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\mgu_root_key'),
    [string]$OutFile = 'vmgauge-logs.txt'
)

$ErrorActionPreference = 'Continue'
if (-not $HostName) { throw 'Usage: collect-logs.ps1 -HostName <ip> [-KeyPath <key>] [-OutFile <file>]' }
if (-not (Test-Path -LiteralPath $KeyPath)) { throw "SSH key not found: $KeyPath" }

$opts = @('-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=NUL','-o','BatchMode=yes','-o','ConnectTimeout=15','-i',$KeyPath)
$target = "root@$HostName"

$remote = @(
    'echo ===== VMGAUGE-APP-LOG =====',
    'cat /var/opt/public/oap/oap_*/data/vmgauge.log 2>/dev/null',
    'echo ===== INSTALLED-APPS =====',
    'cd /var/opt/mgu-custom-apps 2>/dev/null && sh mgu-app-install.sh list 2>/dev/null',
    'echo ===== SYSTEM-LOG =====',
    'logread 2>/dev/null | grep -i vmgauge | tail -200'
) -join '; '

Write-Host "Collecting logs from $target ..."
$out = & ssh @opts $target $remote 2>$null
if (-not $out -or @($out).Count -eq 0) {
    Write-Host "ERROR: no output from $target - SSH failed (check ignition, IP, key)." -ForegroundColor Red
    exit 1
}
$out | Set-Content -LiteralPath $OutFile -Encoding UTF8
Write-Host "Saved to $OutFile ($((Get-Item -LiteralPath $OutFile).Length) bytes)"
Write-Host '--- preview (first 100 lines) ---'
$out | Select-Object -First 100
