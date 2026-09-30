param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$trackerUrl = 'http://127.0.0.1:5173/'

try {
    $trackerResponse = Invoke-WebRequest -Uri $trackerUrl -UseBasicParsing -TimeoutSec 2
    if ($trackerResponse.Content -match 'Prop Desk') {
        if (!$NoBrowser) { Start-Process $trackerUrl }
        Write-Host "Prop Desk is running at $trackerUrl"
        exit 0
    }
} catch {
    # No existing preview: start one below.
}

$trackerNode = (Get-Command node -ErrorAction SilentlyContinue).Source
$trackerBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (!$trackerNode -or [int]([regex]::Match((& $trackerNode --version), '\d+').Value) -lt 18) {
    if (Test-Path -LiteralPath $trackerBundledNode) {
        $trackerNode = $trackerBundledNode
    } else {
        throw 'Install Node.js 20 or newer, then run npm install in this folder.'
    }
}
if (!(Test-Path -LiteralPath 'node_modules/vite/bin/vite.js')) {
    throw 'Dependencies are missing. Run npm install with Node.js 20 or newer.'
}
New-Item -ItemType Directory -Path 'artifacts' -Force | Out-Null
$trackerServer = Start-Process -FilePath $trackerNode -ArgumentList 'node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5173','--strictPort' -WorkingDirectory $PSScriptRoot -RedirectStandardOutput (Join-Path $PSScriptRoot 'artifacts\vite.log') -RedirectStandardError (Join-Path $PSScriptRoot 'artifacts\vite-error.log') -WindowStyle Hidden -PassThru
for ($trackerAttempt = 0; $trackerAttempt -lt 30; $trackerAttempt++) {
    if ($trackerServer.HasExited) { throw 'The preview could not start. Check artifacts/vite-error.log. Port 5173 may already be in use.' }
    try {
        $trackerResponse = Invoke-WebRequest -Uri $trackerUrl -UseBasicParsing -TimeoutSec 2
        if ($trackerResponse.Content -match 'Prop Desk') {
            if (!$NoBrowser) { Start-Process $trackerUrl }
            Write-Host "Prop Desk is running at $trackerUrl"
            exit 0
        }
    } catch { }
    Start-Sleep -Milliseconds 300
}
throw 'The preview did not become ready. Check artifacts/vite-error.log.'
