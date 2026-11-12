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
    [ValidatePattern('^\d+$')]
    [string]$ExpectedVersionCode
)

$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskApk = (Resolve-Path -LiteralPath $ApkPath).Path
$taskReports = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ReportDir)
New-Item -ItemType Directory -Path $taskReports -Force | Out-Null
# A failed retry must never leave an earlier success verdict in the same folder.
$taskVerdict = Join-Path $taskReports 'artifact-checks.json'
if (Test-Path -LiteralPath $taskVerdict -PathType Leaf) {
    Remove-Item -LiteralPath $taskVerdict -Force
}
$taskGradle = Get-Content -LiteralPath (Join-Path $taskRoot 'android/build.gradle') -Raw
$taskAppGradle = Get-Content -LiteralPath (Join-Path $taskRoot 'android/app/build.gradle') -Raw
if (-not $ExpectedPackageName) {
    $taskExpectedPackageMatch = [regex]::Match($taskAppGradle, '(?m)^\s*applicationId\s*(?:=\s*)?["'']([^"'']+)["'']')
    if (-not $taskExpectedPackageMatch.Success) { throw 'Cannot read the current applicationId from android/app/build.gradle.' }
    $ExpectedPackageName = $taskExpectedPackageMatch.Groups[1].Value
}
if (-not $ExpectedAppName) {
    [xml]$taskStrings = Get-Content -LiteralPath (Join-Path $taskRoot 'android/app/src/main/res/values/strings.xml') -Raw
    $taskExpectedLabel = $taskStrings.SelectSingleNode('/resources/string[@name="app_name"]')
    if (-not $taskExpectedLabel -or -not $taskExpectedLabel.InnerText.Trim()) { throw 'Cannot read the current Android app_name resource.' }
    $ExpectedAppName = $taskExpectedLabel.InnerText
}
$taskBuildToolsMatch = [regex]::Match($taskGradle, 'buildToolsVersion\s*=\s*["'']([^"'']+)["'']')
if (-not $taskBuildToolsMatch.Success) { throw 'Cannot read buildToolsVersion from android/build.gradle.' }
$taskBuildTools = Join-Path $SdkRoot ('build-tools/' + $taskBuildToolsMatch.Groups[1].Value)
$taskBash = Join-Path $GitRoot 'bin/bash.exe'
$taskGit = Join-Path $GitRoot 'cmd/git.exe'
foreach ($taskRequiredFile in @(
    (Join-Path $taskBuildTools 'aapt.exe'),
    (Join-Path $taskBuildTools 'apksigner.bat'),
    (Join-Path $taskBuildTools 'zipalign.exe'),
    (Join-Path $JavaHome 'bin/java.exe'),
    (Join-Path $GitRoot 'usr/bin/unzip.exe'),
    $taskBash, $taskGit, $PythonExe
)) {
    if (-not (Test-Path -LiteralPath $taskRequiredFile -PathType Leaf)) {
        throw "Missing verification tool: $taskRequiredFile"
    }
}

$taskOldJavaHome = $env:JAVA_HOME
$taskOldPath = $env:PATH
Push-Location $taskRoot
try {
    $env:JAVA_HOME = $JavaHome
    $env:PATH = "$(Join-Path $GitRoot 'usr/bin');$(Join-Path $JavaHome 'bin');$taskOldPath"
    $taskBadging = & (Join-Path $taskBuildTools 'aapt.exe') dump badging $taskApk
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect compiled APK manifest.' }
    $taskBadging | Set-Content -LiteralPath (Join-Path $taskReports 'apk-badging.txt') -Encoding UTF8
    if (-not ($taskBadging -match "^sdkVersion:'24'$")) { throw 'APK must retain Android 7.0 / API 24 minimum.' }
    if (-not ($taskBadging -match "^targetSdkVersion:'$ExpectedTargetSdk'$")) { throw "APK target SDK differs from expected API $ExpectedTargetSdk." }
    if ($taskBadging -match '^application-debuggable') { throw 'Expected a non-debuggable standalone release APK.' }
    $taskPackage = [regex]::Match(($taskBadging -join "`n"), "(?m)^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'")
    if (-not $taskPackage.Success -or $taskPackage.Groups[1].Value -cne $ExpectedPackageName) { throw "APK package identity differs from expected '$ExpectedPackageName'. Refusing an APK of another application." }
    $taskAppLabel = [regex]::Match(($taskBadging -join "`n"), "(?m)^application-label:'(.*)'\r?$")
    if (-not $taskAppLabel.Success -or $taskAppLabel.Groups[1].Value -cne $ExpectedAppName) { throw "APK application label differs from expected '$ExpectedAppName'. Refusing stale or incorrectly branded output." }
    if ($ExpectedVersionName -and $taskPackage.Groups[3].Value -cne $ExpectedVersionName) {
        throw "APK versionName '$($taskPackage.Groups[3].Value)' differs from current source version '$ExpectedVersionName'. Refusing a stale APK."
    }
    if ($ExpectedVersionCode -and $taskPackage.Groups[2].Value -cne $ExpectedVersionCode) {
        throw "APK versionCode '$($taskPackage.Groups[2].Value)' differs from current source version '$ExpectedVersionCode'. Refusing a stale APK."
    }
    $taskNativeCode = @($taskBadging | Where-Object { $_ -match '^native-code:' })
    if ($taskNativeCode.Count -ne 1) { throw 'Cannot determine the native APK architectures.' }
    $taskAbis = @([regex]::Matches($taskNativeCode[0], "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    if ($taskAbis.Count -ne 2 -or $taskAbis -notcontains 'arm64-v8a' -or $taskAbis -notcontains 'x86_64') {
        throw "Expected only arm64-v8a and x86_64; APK contains: $($taskAbis -join ', ')."
    }

    & (Join-Path $taskBuildTools 'apksigner.bat') verify --verbose --print-certs --min-sdk-version 24 $taskApk *> (Join-Path $taskReports 'apk-signature.txt')
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    $taskSignature = Get-Content -LiteralPath (Join-Path $taskReports 'apk-signature.txt') -Raw
    $taskSignerNames = @([regex]::Matches($taskSignature, 'certificate DN:\s*([^\r\n]+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    & (Join-Path $taskBuildTools 'zipalign.exe') -c -P 16 -v 4 $taskApk *> (Join-Path $taskReports 'apk-zipalign.txt')
    if ($LASTEXITCODE -ne 0) { throw 'APK ZIP alignment verification failed.' }

    & $taskBash scripts/verify-plus-gate.sh ($taskApk.Replace('\', '/')) --ungated *> (Join-Path $taskReports 'apk-plus-gate.txt')
    if ($LASTEXITCODE -ne 0) { throw 'APK Plus-gate verification failed; the final bundled JavaScript must be ungated.' }
    & node scripts/verify-android-payload.js --apk $taskApk --report (Join-Path $taskReports 'apk-native-payload.txt') *> (Join-Path $taskReports 'apk-native-payload.log')
    if ($LASTEXITCODE -ne 0) { throw 'Native patch/backend payload verification failed.' }
    & $PythonExe (Join-Path $PSScriptRoot 'check-apk-elf-layout.py') $taskApk --report (Join-Path $taskReports 'apk-elf-layout.json') --require-16kb
    if ($LASTEXITCODE -ne 0) { throw 'Native ELF alignment verification failed.' }

    $taskCommit = (& $taskGit rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot record the source Git commit.' }
    $taskTrackedChanges = @(& $taskGit status --porcelain --untracked-files=no)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot record tracked source changes.' }
    [ordered]@{
        verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
        apk = $taskApk
        bytes = (Get-Item -LiteralPath $taskApk).Length
        sourceCommit = $taskCommit
        trackedChanges = $taskTrackedChanges
        package = $taskPackage.Groups[1].Value
        appName = $taskAppLabel.Groups[1].Value
        versionCode = $taskPackage.Groups[2].Value
        versionName = $taskPackage.Groups[3].Value
        minSdk = 24
        minimumAndroid = '7.0'
        targetSdk = $ExpectedTargetSdk
        abis = $taskAbis
        debuggable = $false
        plusGate = 'off'
        signerCertificates = $taskSignerNames
        signature = 'verified for API 24+'
        zipAlignment16kb = 'passed'
        nativePayload = 'passed'
        elfLayout16kb = 'passed'
        runtime = 'not tested by this script'
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskVerdict -Encoding UTF8
    Write-Output "APK verification passed; $($taskAppLabel.Groups[1].Value), $($taskPackage.Groups[1].Value); version $($taskPackage.Groups[3].Value) ($($taskPackage.Groups[2].Value)); Android 7.0+, Plus ungated."
} finally {
    Pop-Location
    $env:JAVA_HOME = $taskOldJavaHome
    $env:PATH = $taskOldPath
}
