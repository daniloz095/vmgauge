<#
.SYNOPSIS
  Collect VMGauge's own log (with the raw UDS/DID replies) from the head unit.

.DESCRIPTION
  Runs the exact same `cat` the manual command uses, so it always works:
  it pulls /var/opt/public/oap/oap_*/data/vmgauge.log over SSH and saves it.

.PARAMETER HostName
  Head unit IP (e.g. 169.254.102.111).

.PARAMETER KeyPath
  Root SSH private key path.

.PARAMETER OutFile
  Where to save the log. Default: vmgauge-log.txt

.PARAMETER Csv
  Also copy the CSV logging file (vmgauge_log.csv) when the REC logger was used.

.EXAMPLE
  .\deploy\collect-logs.ps1 -HostName 169.254.102.111 -KeyPath "$env:USERPROFILE\Downloads\MGU-SSH\data\enrollments\<VIN>\id_rsa"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][string]$KeyPath,
    [string]$OutFile = 'vmgauge-log.txt',
    [switch]$Csv
)

$ErrorActionPreference = 'Continue'
if (-not (Test-Path -LiteralPath $KeyPath)) { throw "SSH key not found: $KeyPath" }

$opts = @('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL', '-o', 'GlobalKnownHostsFile=NUL',
    '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', '-i', $KeyPath)
$target = "root@$HostName"

# The one command that is known to work: cat the app log (the glob is expanded on the unit).
$remote = 'cat /var/opt/public/oap/oap_*/data/vmgauge.log 2>/dev/null'

Write-Host "Collecting vmgauge.log from $target ..."
$out = & ssh @opts $target $remote 2>$null
if (-not $out -or @($out).Count -eq 0) {
    Write-Host "ERROR: no output from $target - SSH failed or no log yet (check ignition, IP, key)." -ForegroundColor Red
    exit 1
}
$out | Set-Content -LiteralPath $OutFile -Encoding UTF8
Write-Host "Saved $((Get-Item -LiteralPath $OutFile).Length) bytes to $OutFile"

if ($Csv) {
    $csvRemote = 'cat /var/opt/public/oap/oap_*/data/vmgauge_log.csv 2>/dev/null'
    $csv = & ssh @opts $target $csvRemote 2>$null
    if ($csv -and @($csv).Count -gt 0) {
        $csvOut = [IO.Path]::ChangeExtension($OutFile, '.csv')
        $csv | Set-Content -LiteralPath $csvOut -Encoding UTF8
        Write-Host "Saved CSV log to $csvOut"
    } else {
        Write-Host '(no vmgauge_log.csv on the unit - REC logger was not used)'
    }
}

Write-Host '--- preview (last 60 lines) ---'
$out | Select-Object -Last 60
