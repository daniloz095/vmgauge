<#
.SYNOPSIS
  One-command install of VMGauge on a BMW MGU (iDrive 7) head unit.

.DESCRIPTION
  Downloads the repo from GitHub, extracts the BMW oap-sdk from the head unit
  (donor app x_call — it is BMW code, so it never comes from GitHub), builds the
  app and installs it over SSH.

.PARAMETER HostName
  Head unit IP (the "MGU IP" that ssh_enable reports, e.g. 169.254.102.111).

.PARAMETER KeyPath
  Root SSH private key path. Default: <profile>\.ssh\mgu_root_key

.PARAMETER User
  SSH user. Default: root

.PARAMETER Branch
  Repo branch to build. Default: main

.EXAMPLE
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/daniloz095/vmgauge/main/deploy/install.ps1))) -HostName 169.254.102.111 -KeyPath "$env:USERPROFILE\Downloads\MGU-SSH\data\enrollments\<VIN>\id_rsa"

.NOTES
  Requires on the laptop: Python 3, Node.js, the OpenSSH client and tar (Windows 10+).
#>
[CmdletBinding()]
param(
    [string]$HostName,
    [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\mgu_root_key'),
    [string]$User    = 'root',
    [string]$Branch  = 'main',
    [string]$Repo    = 'daniloz095/vmgauge'
)

$ErrorActionPreference = 'Continue'
# GitHub requires TLS 1.2+; older PowerShell may negotiate TLS 1.0/1.1.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
# allow running the deploy scripts (push-to-car.ps1) from this process
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch { }

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Fail($m)       { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

if (-not $HostName) { Fail 'HostName is required (the head unit IP). Usage: install.ps1 -HostName <ip> [-KeyPath <key>]' }

# --- tool checks -------------------------------------------------------------
foreach ($bin in 'python', 'node', 'ssh', 'scp', 'tar') {
    if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
        Fail "$bin not found on PATH. Install it first (Python 3, Node.js, OpenSSH client)."
    }
}
if (-not (Test-Path -LiteralPath $KeyPath)) { Fail "SSH key not found: $KeyPath" }

# --- ssh options ---------------------------------------------------------------
$SshOpts = @(
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'GlobalKnownHostsFile=NUL',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-i', $KeyPath
)
$Target = "$User@$HostName"

# scp on OpenSSH >= 9.0 defaults to SFTP, which the HU's sshd may lack: force the
# legacy protocol when the client supports -O (version from ssh, which ships with scp).
$ScpLegacy = @()
$sshVer = (& ssh -V 2>&1 | Out-String)
if ($sshVer -match 'OpenSSH[^\d]*(\d+)\.(\d+)' -and [int]$Matches[1] -ge 9) { $ScpLegacy = @('-O') }

# --- work dir -----------------------------------------------------------------
$Work = Join-Path ([IO.Path]::GetTempPath()) ("vmgauge-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Work | Out-Null
try {
    # 1) download the repo from GitHub
    Write-Step "Downloading $Repo ($Branch) ..."
    $tarball = Join-Path $Work 'repo.tar.gz'
    try {
        Invoke-WebRequest -Uri "https://github.com/$Repo/archive/refs/heads/$Branch.tar.gz" -OutFile $tarball -ErrorAction Stop
    } catch {
        Fail "Cannot download $Repo from GitHub. Check the internet connection. ($($_.Exception.Message))"
    }
    tar -xzf $tarball -C $Work
    $RepoRoot = Join-Path $Work 'vmgauge-main'
    if (-not (Test-Path (Join-Path $RepoRoot 'kit\tools\build.py'))) { Fail 'repo layout unexpected (build.py not found)' }

    # 2) connectivity check
    Write-Step "Connecting to $Target ..."
    ssh @SshOpts -n $Target 'echo ok' 2>$null
    if ($LASTEXITCODE -ne 0) { Fail "Cannot SSH to $Target. Check ignition, IP ($HostName) and key ($KeyPath)." }

    # 3) extract the BMW oap-sdk from the head unit (not on GitHub)
    if (-not (Test-Path (Join-Path $RepoRoot 'oap-sdk\index.js'))) {
        Write-Step 'Extracting oap-sdk from the head unit (donor app x_call) ...'
        scp @SshOpts @ScpLegacy -q "${Target}:/usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz" (Join-Path $RepoRoot 'x_call.tgz')
        if ($LASTEXITCODE -ne 0) { Fail 'could not fetch the donor app x_call.tgz from the head unit' }
        Push-Location $RepoRoot
        tar -xzf 'x_call.tgz'
        node kit/tools/extract_sdk.js javascript/app.js
        Pop-Location
        if (-not (Test-Path (Join-Path $RepoRoot 'oap-sdk\index.js'))) { Fail 'oap-sdk extraction failed' }
    }

    # 4) build + pack the car kit
    Write-Step 'Building vmgauge ...'
    Push-Location $RepoRoot
    "y" | python kit/tools/make_kit.py vmgauge
    if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'make_kit.py failed' }
    Pop-Location

    # 5) install on the head unit
    Write-Step 'Installing on the head unit ...'
    & (Join-Path $RepoRoot 'deploy\push-to-car.ps1') install -Key $KeyPath -Ip $HostName
    if ($LASTEXITCODE -ne 0) { Fail 'install failed' }

    Write-Host ''
    Write-Step "DONE: vmgauge installed on ${Target}."
    Write-Host 'Open it from the apps menu. If the screen is blank, reboot the head unit once.' -ForegroundColor Green
}
finally {
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
