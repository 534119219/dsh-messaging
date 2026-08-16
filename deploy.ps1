# Deploy messaging plugin packages into the web profile's installed copy
# (the profile installs file: deps as copies, so source edits need a sync).
# After running this, RESTART dsh web manually for host-side changes.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileNodeModules = Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules'

$packages = Get-ChildItem (Join-Path $root 'packages') -Directory
foreach ($pkg in $packages) {
    $src = $pkg.FullName
    $dst = Join-Path $profileNodeModules $pkg.Name
    if (-not (Test-Path $dst)) {
        Write-Host "SKIP $($pkg.Name) (not installed yet - run pnpm install in the profile first)"
        continue
    }
    Copy-Item -Path (Join-Path $src 'lib') -Destination $dst -Recurse -Force
    Copy-Item -Path (Join-Path $src 'cordis.patch.yml') -Destination $dst -Force
    Copy-Item -Path (Join-Path $src 'package.json') -Destination $dst -Force
    Write-Host "deployed $($pkg.Name) -> $dst"
}
Write-Host 'Done. Restart dsh web manually to load changes.'
