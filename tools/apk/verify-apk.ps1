[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ApkPath,
    [Parameter(Mandatory = $true)][string]$ReportDir,
    [Parameter(Mandatory = $true)][string]$SdkRoot,
    [Parameter(Mandatory = $true)][string]$JavaHome,
    [Parameter(Mandatory = $true)][string]$PythonExe,
    [Parameter(Mandatory = $true)][string]$GitRoot,
    [int]$ExpectedTargetSdk = 36,
    [string]$ExpectedPackageName,
    [string]$ExpectedAppName,
    [string]$ExpectedVersionName,
    [ValidatePattern('^\d+$')][string]$ExpectedVersionCode
)

# Keep the original Windows command interface; both operating systems now use
# one verifier and one report schema. Every child process receives an argument
# array, including paths with spaces, without cmd.exe/shell string evaluation.
$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskArguments = @(
    (Join-Path $PSScriptRoot 'android-apk.mjs'), 'verify',
    '--apk', $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ApkPath),
    '--report-dir', $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ReportDir),
    '--sdk-root', $SdkRoot, '--java-home', $JavaHome, '--python', $PythonExe,
    '--git-root', $GitRoot, '--expected-target-sdk', [string]$ExpectedTargetSdk
)
foreach ($taskOverride in @(
    @('--expected-package-name', $ExpectedPackageName),
    @('--expected-app-name', $ExpectedAppName),
    @('--expected-version-name', $ExpectedVersionName),
    @('--expected-version-code', $ExpectedVersionCode)
)) {
    if ($taskOverride[1]) { $taskArguments += $taskOverride }
}
$taskPreference = $ErrorActionPreference
try {
    # Windows PowerShell 5.1 turns native stderr into ErrorRecords. A non-zero
    # exit status, rather than harmless tool warnings, decides failure.
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = $null
    $taskOutput = & $taskNode @taskArguments
    $taskExit = $LASTEXITCODE
} finally { $ErrorActionPreference = $taskPreference }
if ($null -eq $taskExit -or $taskExit -ne 0) { throw "APK verification failed (exit $taskExit)." }
$taskResult = ($taskOutput -join "`n") | ConvertFrom-Json
Write-Output "APK verification passed; $($taskResult.appName), $($taskResult.package); version $($taskResult.versionName) ($($taskResult.versionCode)); Android 7.0+, Plus ungated, existing signing certificate."
