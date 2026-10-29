$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    $repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
    $repoPrefix = $repoRoot + '\'

    # Every installation/download path is owned by this repository. Refuse
    # junctions and symlinks before writing or replacing managed directories.
    function Assert-RepositoryPath([string] $Candidate) {
        $fullPath = [System.IO.Path]::GetFullPath($Candidate)
        if (!$fullPath.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Managed path leaves the repository: $fullPath"
        }
        $relativePath = $fullPath.Substring($repoPrefix.Length)
        $currentPath = $repoRoot
        foreach ($segment in $relativePath.Split('\')) {
            $currentPath = Join-Path $currentPath $segment
            $item = Get-Item -LiteralPath $currentPath -Force -ErrorAction SilentlyContinue
            if ($null -ne $item) {
                if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Managed paths cannot be junctions or symbolic links: $currentPath"
                }
            }
        }
        return $fullPath
    }

    $version = (Get-Content -LiteralPath (Join-Path $repoRoot '.node-version') -Raw).Trim()
    if ($version -notmatch '^24\.\d+\.\d+$') {
        throw '.node-version must contain a pinned Node.js 24 version such as 24.19.0.'
    }
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    if ($architecture -notin @('x64', 'arm64')) {
        throw "Unsupported Windows architecture: $architecture. Use Windows x64 or ARM64."
    }

    $toolsRoot = Assert-RepositoryPath (Join-Path $repoRoot '.tools')
    $target = Assert-RepositoryPath (Join-Path $toolsRoot 'node')
    $setupRoot = Assert-RepositoryPath (Join-Path $repoRoot '.cache\setup')
    New-Item -ItemType Directory -Path $toolsRoot, $setupRoot -Force | Out-Null
    $targetNode = Join-Path $target 'node.exe'
    $targetNpm = Join-Path $target 'node_modules\npm\bin\npm-cli.js'
    if ((Test-Path -LiteralPath $targetNode) -and (Test-Path -LiteralPath $targetNpm)) {
        $existingVersion = & $targetNode --version
        if ($LASTEXITCODE -eq 0 -and $existingVersion -eq "v$version") {
            Write-Output "Project-local Node.js $version is ready."
            exit 0
        }
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $archiveName = "node-v$version-win-$architecture.zip"
    $downloadBase = "https://nodejs.org/dist/v$version"
    $checksumPath = Assert-RepositoryPath (Join-Path $setupRoot "SHASUMS256-v$version.txt")
    $archivePath = Assert-RepositoryPath (Join-Path $setupRoot $archiveName)
    Write-Output "Preparing project-local Node.js $version ($architecture)..."
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 180 -Uri "$downloadBase/SHASUMS256.txt" -OutFile $checksumPath
    $escapedName = [regex]::Escape($archiveName)
    $checksumLine = @(Get-Content -LiteralPath $checksumPath | Where-Object { $_ -match "^[a-fA-F0-9]{64}\s+\*?$escapedName$" })
    if ($checksumLine.Count -ne 1) { throw "Official checksum not found for $archiveName" }
    $expectedHash = ($checksumLine[0] -split '\s+')[0].ToLowerInvariant()

    $cachedArchiveIsValid = (Test-Path -LiteralPath $archivePath) -and
        ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expectedHash)
    if (!$cachedArchiveIsValid) {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri "$downloadBase/$archiveName" -OutFile $archivePath
    }
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw 'Node.js archive checksum mismatch. No runtime was installed.' }

    $extractRoot = Assert-RepositoryPath (Join-Path $setupRoot ('extract-' + [guid]::NewGuid().ToString('N')))
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
    $unpackedRoot = Assert-RepositoryPath (Join-Path $extractRoot "node-v$version-win-$architecture")
    $unpackedNode = Join-Path $unpackedRoot 'node.exe'
    $unpackedNpm = Join-Path $unpackedRoot 'node_modules\npm\bin\npm-cli.js'
    if (!(Test-Path -LiteralPath $unpackedNode) -or !(Test-Path -LiteralPath $unpackedNpm)) {
        throw 'The Node.js archive is missing node.exe or the npm CLI.'
    }
    $installedVersion = & $unpackedNode --version
    if ($LASTEXITCODE -ne 0 -or $installedVersion -ne "v$version") {
        throw 'The downloaded Node.js runtime did not pass its version check.'
    }

    # This exact validated directory is managed only by this installer.
    $target = Assert-RepositoryPath $target
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    Move-Item -LiteralPath $unpackedRoot -Destination $target
    if (!(Test-Path -LiteralPath $targetNpm) -or (& $targetNode --version) -ne "v$version") {
        throw 'The installed Node.js runtime could not be verified.'
    }
    Write-Output "Project-local Node.js $version is ready in .tools/node."
    exit 0
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
