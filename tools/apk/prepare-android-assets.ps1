[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath $Root).ProviderPath
$taskApp = Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json
$taskPackageName = 'react-native-enriched-markdown'
$taskDependencies = @($taskApp.dependencies.PSObject.Properties.Name) + @($taskApp.devDependencies.PSObject.Properties.Name)
if ($taskDependencies -notcontains $taskPackageName) {
    Write-Output 'Android asset preparation: enriched-markdown is not a dependency; skipped.'
    return
}

# Match the package's JavaScript semantics: only the boolean false opts out.
$taskHighlightSetting = $taskApp.'enriched-markdown'.enableCodeHighlight
if ($taskHighlightSetting -is [bool] -and -not $taskHighlightSetting) {
    Write-Output 'Android asset preparation: code highlighting is disabled in package.json; skipped.'
    return
}

$taskPackageRoot = Join-Path $taskRoot ('node_modules/' + $taskPackageName)
$taskInstaller = Join-Path $taskPackageRoot 'vendor-grammars.mjs'
$taskManifestPath = Join-Path $taskPackageRoot 'cpp/highlight/grammar-versions.json'
$taskVendor = Join-Path $taskPackageRoot 'cpp/highlight/vendor'
$taskRegistry = Join-Path $taskVendor 'generated/generated_registry.cpp'
$taskWindowsSystem = Join-Path $env:SystemRoot 'System32'
$taskWindowsTar = Join-Path $taskWindowsSystem 'tar.exe'
if (-not (Test-Path -LiteralPath $taskWindowsTar -PathType Leaf)) {
    throw "Windows tar is required for Android grammar assets: $taskWindowsTar. Restore the Windows archive tool before building."
}
foreach ($taskRequired in @(
    (Join-Path $taskPackageRoot 'package.json'),
    $taskInstaller, $taskManifestPath, $taskRegistry
)) {
    if (-not (Test-Path -LiteralPath $taskRequired -PathType Leaf) -or (Get-Item -LiteralPath $taskRequired).Length -eq 0) {
        throw "Enriched-markdown package is incomplete or its native layout changed: $taskRequired. Restore locked dependencies before building."
    }
}
$taskPackage = Get-Content -LiteralPath (Join-Path $taskPackageRoot 'package.json') -Raw | ConvertFrom-Json
$taskManifest = Get-Content -LiteralPath $taskManifestPath -Raw | ConvertFrom-Json
if (-not $taskManifest.runtime -or -not @($taskManifest.grammars.PSObject.Properties).Count) {
    throw "Cannot read the native grammar manifest: $taskManifestPath. Review the updated package's Android preparation."
}

$taskRequiredAssets = @(
    (Join-Path $taskVendor 'tree-sitter/src/lib.c'),
    (Join-Path $taskVendor 'tree-sitter/include/tree_sitter/api.h'),
    (Join-Path $taskVendor 'tree-sitter/.stamp'),
    (Join-Path $taskVendor 'grammars/.stamp'),
    $taskRegistry
)
foreach ($taskGrammar in $taskManifest.grammars.PSObject.Properties) {
    if ($taskGrammar.Name -notmatch '^[A-Za-z0-9._+-]+$') {
        throw "Unexpected grammar identifier in the installed manifest: $($taskGrammar.Name)"
    }
    $taskGrammarDir = Join-Path $taskVendor ('grammars/' + $taskGrammar.Name)
    $taskRequiredAssets += Join-Path $taskGrammarDir 'parser.c'
    $taskRequiredAssets += Join-Path $taskGrammarDir 'highlights.scm'
    if ($taskGrammar.Value.scanner -eq $true) {
        $taskRequiredAssets += Join-Path $taskGrammarDir 'scanner.c'
    }
    foreach ($taskSharedSource in @($taskGrammar.Value.sharedSrc)) {
        if ($taskSharedSource) {
            $taskRequiredAssets += Join-Path $taskGrammarDir ([IO.Path]::GetFileName($taskSharedSource.Replace('/', '\')))
        }
    }
}

function Get-MissingAndroidAssets {
    foreach ($taskAsset in $taskRequiredAssets) {
        if (-not (Test-Path -LiteralPath $taskAsset -PathType Leaf)) {
            $taskAsset
        } elseif ((Get-Item -LiteralPath $taskAsset).Length -eq 0) {
            $taskAsset
        }
    }
}

function Format-MissingAndroidAssets([string[]]$Missing) {
    $taskExamples = @($Missing | Select-Object -First 6 | ForEach-Object { $_.Substring($taskVendor.Length + 1).Replace('\', '/') })
    return "$($Missing.Count) missing/empty files: " + ($taskExamples -join ', ') + $(if ($Missing.Count -gt 6) { ', ...' } else { '' })
}

$taskBefore = @(Get-MissingAndroidAssets)
if ($CheckOnly) {
    if ($taskBefore.Count) {
        throw ("Missing or empty Android grammar assets. Run the normal APK build to restore them. " + (Format-MissingAndroidAssets $taskBefore))
    }
    Write-Output "Android grammar assets are present for $taskPackageName $($taskPackage.version)."
    return
}

$taskArguments = @(
    $taskInstaller,
    '--from-npm',
    '--vendor-dir', $taskVendor,
    '--manifest', $taskManifestPath
)
if ($taskBefore.Count) {
    # The upstream installer treats an existing empty file as present. Its
    # supported force flag repairs such partial trees without custom stamps.
    $taskArguments += '--force'
    Write-Output "Restoring Android grammar assets for $taskPackageName $($taskPackage.version)..."
} else {
    Write-Output "Checking current Android grammar pins for $taskPackageName $($taskPackage.version)..."
}

# Use only the Android/shared grammar installer. The package's broad
# postinstall also downloads RaTeX for iOS when math is enabled.
$taskPreference = $ErrorActionPreference
$taskOldPath = $env:PATH
try {
    # The upstream Node installer spawns `tar` by name. Git's GNU tar treats
    # Windows drive letters in archive paths as remote-host syntax; ensure the
    # Windows bsdtar is selected without editing upstream installer sources.
    $env:PATH = "$taskWindowsSystem;$taskOldPath"
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = $null
    & $NodeExe @taskArguments
    $taskExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $taskPreference
    $env:PATH = $taskOldPath
}
if ($null -eq $taskExitCode -or $taskExitCode -ne 0) {
    throw "Android grammar preparation failed (exit $taskExitCode). Check network access to registry.npmjs.org and github.com, then rerun the APK build."
}
$taskAfter = @(Get-MissingAndroidAssets)
if ($taskAfter.Count) {
    throw ("Android grammar preparation finished without all required assets. " + (Format-MissingAndroidAssets $taskAfter))
}
Write-Output 'Android grammar preparation passed; no iOS math assets were requested.'
