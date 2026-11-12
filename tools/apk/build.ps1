[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$VerifyApk,
    [switch]$RestoreDependencies,
    [string]$SdkRoot,
    [string]$JavaHome,
    [string]$PythonExe
)

$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskCache = Join-Path $taskRoot '.build-tools'
$taskOutput = Join-Path $taskRoot 'build\apk'
$taskLogDir = Join-Path $taskCache 'logs\latest'
$taskOldLocation = Get-Location
foreach ($taskParameter in @('VerifyApk','SdkRoot','JavaHome','PythonExe')) {
    $taskValue = Get-Variable -Name $taskParameter -ValueOnly
    if ($taskValue) { Set-Variable -Name $taskParameter -Value $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($taskValue) }
}
$taskLock = $null
$taskTemporaryApk = $null
$taskYarnCache = $null
$taskTranscriptActive = $false
$taskEnvNames = @('JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_USER_HOME',
    'GRADLE_USER_HOME','HEXAGON_SDK_ROOT','HEXAGON_TOOLS_ROOT','PATH','NODE_ENV',
    'BABEL_ENV','PLUS_STORE_GATE','E2E_BUILD','ORG_GRADLE_PROJECT_rnllamaBuildFromSource',
    'CMAKE_BUILD_PARALLEL_LEVEL','POCKETPAL_LOCAL_NINJA','POCKETPAL_REPO_ROOT')
$taskOldEnv = @{}
foreach ($taskName in $taskEnvNames) { $taskOldEnv[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process') }

function Require-File([string]$Path, [string]$Hint) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing: $Path. $Hint" }
}
function Run-Checked([string]$Program, [string[]]$Arguments) {
    $taskPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 turns native stderr into ErrorRecords.
        # Exit status, rather than harmless compiler warnings, decides success.
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = $null
        & $Program @Arguments
        $taskExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $taskPreference }
    if ($null -eq $taskExitCode -or $taskExitCode -ne 0) { throw "$Program failed (exit $taskExitCode)." }
}
try {
    Set-Location -LiteralPath $taskRoot
    New-Item -ItemType Directory -Path $taskCache -Force | Out-Null
    try { $taskLock = [IO.File]::Open((Join-Path $taskCache 'build.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Another local APK build is running. Wait for it to finish.' }
    New-Item -ItemType Directory -Path $taskLogDir -Force | Out-Null
    if (-not $CheckOnly -and -not $VerifyApk) {
        Start-Transcript -LiteralPath (Join-Path $taskLogDir 'build.log') -Force | Out-Null
        $taskTranscriptActive = $true
        [IO.File]::WriteAllText((Join-Path $taskLogDir 'gradle.log'), "Current build started $([DateTime]::UtcNow.ToString('o')). Gradle has not started yet; preparation output is in build.log.`n", (New-Object Text.UTF8Encoding($false)))
        $taskOldVerdict = Join-Path $taskLogDir 'artifact-checks.json'
        if (Test-Path -LiteralPath $taskOldVerdict) { Remove-Item -LiteralPath $taskOldVerdict -Force }
    }
    Require-File (Join-Path $taskRoot 'android\gradlew.bat') 'The upstream Gradle wrapper is required.'
    $taskNode = (Get-Command node.exe -ErrorAction Stop).Source
    $taskYarn = (Get-Command yarn.cmd -ErrorAction Stop).Source
    $taskGit = (Get-Command git.exe -ErrorAction Stop).Source
    $taskGitRoot = Split-Path -Parent (Split-Path -Parent $taskGit)
    Require-File (Join-Path $taskGitRoot 'bin\bash.exe') 'Install Git for Windows with Git Bash.'
    Require-File (Join-Path $taskGitRoot 'usr\bin\unzip.exe') 'Git for Windows must include unzip.'
    Require-File (Join-Path $env:SystemRoot 'System32\tar.exe') 'Windows tar.exe is required to extract native grammar archives.'
    $taskNodeVersion = (& $taskNode -p 'process.versions.node').Trim()
    if ([version]$taskNodeVersion -lt [version]'22.21.0') { throw 'Node.js 22.21.0 or newer is required.' }
    $taskYarnVersion = (& $taskYarn --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $taskYarnVersion -ne '1.22.22') { throw 'Install Yarn Classic 1.22.22 (npm install --global yarn@1.22.22).' }
    if (-not $SdkRoot) {
        if ($env:ANDROID_HOME) { $SdkRoot = $env:ANDROID_HOME }
        else { $SdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
    }
    if (-not $JavaHome) { $JavaHome = Join-Path $taskCache 'jdk17\jdk-17.0.20.1+1' }
    if (-not $PythonExe) { $PythonExe = Join-Path $env:LOCALAPPDATA 'Python\pythoncore-3.15-64\python.exe' }
    Require-File (Join-Path $JavaHome 'bin\java.exe') 'Supply -JavaHome pointing to JDK 17.'
    Require-File $PythonExe 'Supply -PythonExe pointing to Python 3.9+.'
    $taskJavaVersion = (& (Join-Path $JavaHome 'bin\java.exe') --version | Out-String)
    if ($LASTEXITCODE -ne 0 -or $taskJavaVersion -notmatch '(openjdk|java) 17\.') { throw 'This workflow requires JDK 17. Android Studio JBR 25 is not a replacement.' }
    Run-Checked $PythonExe @('-c', 'import sys; assert sys.version_info >= (3,9), "Python 3.9+ required"')
    $taskGradleSource = Get-Content (Join-Path $taskRoot 'android\build.gradle') -Raw
    $taskSdkValues = @{}
    foreach ($taskSetting in @('buildToolsVersion','minSdkVersion','compileSdkVersion','targetSdkVersion','ndkVersion')) {
        $taskMatch = [regex]::Match($taskGradleSource, '(?m)^\s*' + $taskSetting + '\s*=\s*["'']?([\d.]+)')
        if (-not $taskMatch.Success) { throw "Cannot read $taskSetting from android/build.gradle. Review this wrapper after upstream changes." }
        $taskSdkValues[$taskSetting] = $taskMatch.Groups[1].Value
    }
    if ($taskSdkValues.minSdkVersion -ne '24') { throw 'Upstream changed minSdk. This Android 7 workflow requires API 24; review compatibility before building.' }
    $taskBuildTools = Join-Path $SdkRoot ('build-tools\' + $taskSdkValues.buildToolsVersion)
    Require-File (Join-Path $taskBuildTools 'aapt.exe') 'Install the build-tools version from android/build.gradle in Android Studio SDK Manager.'
    Require-File (Join-Path $SdkRoot ('ndk\' + $taskSdkValues.ndkVersion + '\toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe')) 'Install the pinned NDK in Android Studio SDK Manager.'
    Require-File (Join-Path $SdkRoot 'cmake\3.22.1\bin\cmake.exe') 'Install CMake 3.22.1 in Android Studio SDK Manager.'
    $taskPlatforms = @(Get-ChildItem (Join-Path $SdkRoot 'platforms') -Directory | Where-Object { $_.Name -match ('^android-' + [regex]::Escape($taskSdkValues.compileSdkVersion) + '(\.0)?$') })
    if (-not $taskPlatforms.Count) { throw ('Install Android SDK Platform ' + $taskSdkValues.compileSdkVersion + ' in Android Studio.') }
    Require-File (Join-Path $taskPlatforms[0].FullName 'android.jar') 'SDK Platform installation is incomplete.'
    $taskNinja = Join-Path $taskCache 'ninja\v1.13.2\ninja.exe'
    Require-File $taskNinja 'Restore the retained .build-tools/ninja folder.'
    $taskNinjaVersion = (& $taskNinja --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [version]$taskNinjaVersion -lt [version]'1.12.0') { throw 'Ninja 1.12+ is required for Windows long paths.' }
    $taskSdkAction = Get-Content (Join-Path $taskRoot '.github\actions\setup-hexagon-sdk\action.yml') -Raw
    $taskHexVersion = [regex]::Match($taskSdkAction, 'sdk-version:[\s\S]*?default:\s*([\d.]+)').Groups[1].Value
    if (-not $taskHexVersion) { throw 'Cannot read the upstream Hexagon version. Review the updated action.' }
    $taskHexRoot = Join-Path $taskCache ('hexagon-sdk\' + $taskHexVersion)
    $taskConsumed = @('incs','ipc/fastrpc/rpcmem/inc','ipc/fastrpc/remote/ship/android_aarch64/libcdsprpc.so')
    foreach ($taskRelative in $taskConsumed) {
        $taskPath = Join-Path $taskHexRoot $taskRelative
        if (-not (Test-Path -LiteralPath $taskPath)) { throw "Missing retained Hexagon SDK $taskHexVersion at $taskPath. Restore it; do not bypass the NPU check." }
        $taskEntries = @(Get-Item -LiteralPath $taskPath -Force)
        if (Test-Path -LiteralPath $taskPath -PathType Container) { $taskEntries += @(Get-ChildItem -LiteralPath $taskPath -Recurse -Force) }
        if (@($taskEntries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Unexpected reparse point in the consumed Hexagon subset.' }
    }

    $env:JAVA_HOME = $JavaHome
    $env:ANDROID_HOME = $SdkRoot
    $env:ANDROID_SDK_ROOT = $SdkRoot
    $env:ANDROID_USER_HOME = Join-Path $taskCache 'android-user'
    $env:GRADLE_USER_HOME = Join-Path $taskCache 'gradle-home'
    $env:HEXAGON_SDK_ROOT = $taskHexRoot
    $env:HEXAGON_TOOLS_ROOT = $taskHexRoot
    $env:POCKETPAL_LOCAL_NINJA = $taskNinja
    $env:POCKETPAL_REPO_ROOT = $taskRoot
    $env:PATH = "$JavaHome\bin;$(Split-Path -Parent $PythonExe);$env:SystemRoot\System32;$taskGitRoot\usr\bin;$env:PATH"
    $env:NODE_ENV = 'production'
    $env:BABEL_ENV = 'production'
    $env:PLUS_STORE_GATE = 'false'
    $env:E2E_BUILD = 'false'
    $env:ORG_GRADLE_PROJECT_rnllamaBuildFromSource = 'true'
    $env:CMAKE_BUILD_PARALLEL_LEVEL = '4'
    $taskAppGradle = Get-Content (Join-Path $taskRoot 'android\app\build.gradle') -Raw
    $taskPackageMatch = [regex]::Match($taskAppGradle, '(?m)^\s*applicationId\s*(?:=\s*)?["'']([^"'']+)["'']')
    if (-not $taskPackageMatch.Success) { throw 'Cannot read the current Android applicationId.' }
    $taskExpectedPackage = $taskPackageMatch.Groups[1].Value
    [xml]$taskAndroidStrings = Get-Content (Join-Path $taskRoot 'android\app\src\main\res\values\strings.xml') -Raw
    $taskAppLabel = $taskAndroidStrings.SelectSingleNode('/resources/string[@name="app_name"]')
    if (-not $taskAppLabel -or -not $taskAppLabel.InnerText.Trim()) { throw 'Cannot read the current Android app_name resource.' }
    $taskExpectedAppName = $taskAppLabel.InnerText
    $taskVerifyParams = @{ReportDir=$taskLogDir; SdkRoot=$SdkRoot; JavaHome=$JavaHome; PythonExe=$PythonExe; GitRoot=$taskGitRoot; ExpectedTargetSdk=[int]$taskSdkValues.targetSdkVersion; ExpectedPackageName=$taskExpectedPackage; ExpectedAppName=$taskExpectedAppName}
    if ($VerifyApk) {
        & (Join-Path $PSScriptRoot 'verify-apk.ps1') -ApkPath ([IO.Path]::GetFullPath($VerifyApk)) @taskVerifyParams
        if (-not $?) { throw 'APK verification failed.' }
        Write-Host "Verification passed. Reports: $taskLogDir"
        return
    }

    $taskVersionMatch = [regex]::Match($taskAppGradle, '(?m)^\s*versionName\s*(?:=\s*)?["'']([^"'']+)["'']')
    $taskCodeMatch = [regex]::Match($taskAppGradle, '(?m)^\s*versionCode\s*(?:=\s*)?(\d+)')
    if (-not $taskVersionMatch.Success -or -not $taskCodeMatch.Success) { throw 'Cannot read the current Android versionName/versionCode. Review the updated app Gradle configuration.' }
    $taskExpectedVersion = $taskVersionMatch.Groups[1].Value
    $taskExpectedCode = $taskCodeMatch.Groups[1].Value
    $taskPackageJson = Get-Content (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json
    if ($taskPackageJson.version -ne $taskExpectedVersion) { throw "Version mismatch: package.json=$($taskPackageJson.version), Android=$taskExpectedVersion. Update the repository version files consistently." }
    $taskVerifyParams.ExpectedVersionName = $taskExpectedVersion
    $taskVerifyParams.ExpectedVersionCode = $taskExpectedCode
    if (-not $CheckOnly) {
        # Active packages always live in the root node_modules. Only the download
        # cache is temporary; even failed builds remove it in finally.
        $taskYarnCache = Join-Path $taskCache ('tmp\yarn-cache-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $taskYarnCache -Force | Out-Null
        Write-Host "Checking locked dependencies for $taskExpectedAppName $taskExpectedVersion; temporary Yarn cache: $taskYarnCache"
        $taskInstallArgs = @('install','--frozen-lockfile','--ignore-scripts','--production=false','--check-files','--cache-folder',$taskYarnCache)
        if ($RestoreDependencies) { $taskInstallArgs += '--force' }
        Run-Checked $taskYarn $taskInstallArgs
        Run-Checked $taskNode @('node_modules/patch-package/index.js','--error-on-fail')
    }
    & (Join-Path $PSScriptRoot 'prepare-android-assets.ps1') -Root $taskRoot -NodeExe $taskNode -CheckOnly:$CheckOnly
    if (-not $?) { throw 'Android dependency asset preparation failed.' }
    foreach ($taskRequired in @('node_modules/@react-native/gradle-plugin/gradle/libs.versions.toml',
        'node_modules/llama.rn/vendor/OpenCL-Headers/CL/cl.h',
        'node_modules/llama.rn/vendor/llama.cpp/ggml/src/ggml-hexagon/htp/v73/htp_iface_stub.c',
        'node_modules/llama.rn/vendor/llama.cpp/ggml/src/ggml-hexagon/htp/v73/htp_iface.h',
        'node_modules/llama.rn/bin/arm64-v8a/libOpenCL.so')) { Require-File (Join-Path $taskRoot $taskRequired) 'Run build-apk.cmd -RestoreDependencies; review upstream native layout if this still fails.' }
    foreach ($taskDsp in @('v73','v75','v79','v81','v85')) { Require-File (Join-Path $taskRoot "node_modules/llama.rn/bin/arm64-v8a/libggml-htp-$taskDsp.so") 'The locked llama.rn tarball must include the DSP assets.' }
    if ($CheckOnly) {
        Write-Host "Preflight passed for $taskExpectedAppName $taskExpectedVersion ($taskExpectedCode), package $taskExpectedPackage. Node $taskNodeVersion; Yarn $taskYarnVersion; JDK 17; SDK $($taskSdkValues.compileSdkVersion); minSdk 24; native assets present."
        return
    }
    if (-not (Test-Path '.env')) {
        [IO.File]::WriteAllText((Join-Path $taskRoot '.env'), "PALSHUB_API_BASE_URL=https://palshub.ai`nAPP_URL=pocketpal://app`nENABLE_PALSHUB_INTEGRATION=true`nENABLE_AUTHENTICATION=true`nENABLE_OFFLINE_MODE=true`n", (New-Object Text.UTF8Encoding($false)))
    }
    $taskGooglePath = Join-Path $taskRoot 'android\app\google-services.json'
    if (-not (Test-Path -LiteralPath $taskGooglePath)) {
        $taskGoogle = '{"project_info":{"project_number":"000000000000","project_id":"dummy-project-for-ci","storage_bucket":"dummy-project-for-ci.appspot.com"},"client":[{"client_info":{"mobilesdk_app_id":"1:000000000000:android:0000000000000000","android_client_info":{"package_name":""}},"api_key":[{"current_key":"dummy-api-key-for-ci-builds"}]}]}' | ConvertFrom-Json
        $taskGoogle.client[0].client_info.android_client_info.package_name = $taskExpectedPackage
        [IO.File]::WriteAllText($taskGooglePath, ($taskGoogle | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
    } else {
        $taskGoogle = Get-Content -LiteralPath $taskGooglePath -Raw | ConvertFrom-Json
        $taskGooglePackageNames = @($taskGoogle.client | ForEach-Object { $_.client_info.android_client_info.package_name })
        if ($taskGooglePackageNames -cnotcontains $taskExpectedPackage) {
            if ($taskGoogle.project_info.project_id -ne 'dummy-project-for-ci' -or -not @($taskGoogle.client).Count) {
                throw "google-services.json has no client for '$taskExpectedPackage'. Supply Firebase configuration for this fork; a real configuration will not be rewritten."
            }
            foreach ($taskGoogleClient in $taskGoogle.client) { $taskGoogleClient.client_info.android_client_info.package_name = $taskExpectedPackage }
            [IO.File]::WriteAllText($taskGooglePath, ($taskGoogle | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
            Write-Host "Updated the local CI dummy Firebase client to $taskExpectedPackage."
        }
    }
    $taskVariants = (& $taskNode 'scripts/verify-android-payload.js' --print-variants | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $taskVariants) { throw 'Cannot read native variants from the upstream payload manifest.' }
    $taskLog = Join-Path $taskLogDir 'gradle.log'
    $taskArguments = @('-p',(Join-Path $taskRoot 'android'),'assembleProdRelease','--init-script',(Join-Path $PSScriptRoot 'windows.init.gradle'),
        '--no-daemon','--max-workers=4','--console=plain','--info',
        '-Dorg.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m','-Pkotlin.compiler.execution.strategy=in-process',
        '-PrnllamaBuildFromSource=true',"-PrnllamaVariants=$taskVariants",'-PRNSpeech_phononAbis=arm64-v8a,x86_64','-PreactNativeArchitectures=arm64-v8a,x86_64')
    Write-Host "Building $taskExpectedAppName standalone prodRelease with Plus gate OFF. Log: $taskLog"
    $taskPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = $null
        & (Join-Path $taskRoot 'android\gradlew.bat') @taskArguments 2>&1 |
            ForEach-Object { $_.ToString() } | Out-File -LiteralPath $taskLog -Encoding UTF8
        $taskGradleExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $taskPreference }
    if ($null -eq $taskGradleExit -or $taskGradleExit -ne 0) { Get-Content $taskLog -Tail 45 | Write-Host; throw "Gradle failed. Previous delivered APK is unchanged. Full log: $taskLog" }
    $taskSourceApk = Join-Path $taskRoot 'android\app\build\outputs\apk\prod\release\app-prod-release.apk'
    Require-File $taskSourceApk 'Gradle finished without the expected APK.'
    & (Join-Path $PSScriptRoot 'verify-apk.ps1') -ApkPath $taskSourceApk @taskVerifyParams
    if (-not $?) { throw 'APK verification failed; previous delivered APK is unchanged.' }
    $taskMetadata = Get-Content (Join-Path $taskLogDir 'artifact-checks.json') -Raw | ConvertFrom-Json
    $taskVersion = $taskMetadata.versionName
    if (-not $taskVersion -or $taskVersion -notmatch '^[A-Za-z0-9._+-]+$') { throw 'Unsafe or missing versionName in APK metadata.' }
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    $taskDestination = Join-Path $taskOutput "pocketpal-ai-community-$taskVersion-android7.apk"
    $taskTemporaryApk = $taskDestination + '.' + $PID + '.partial'
    Copy-Item -LiteralPath $taskSourceApk -Destination $taskTemporaryApk
    if ((Get-Item -LiteralPath $taskTemporaryApk).Length -ne $taskMetadata.bytes) { throw 'Copied APK size differs; refusing to publish.' }
    if (Test-Path $taskDestination) { [IO.File]::Replace($taskTemporaryApk, $taskDestination, [NullString]::Value) }
    else { [IO.File]::Move($taskTemporaryApk, $taskDestination) }
    $taskTemporaryApk = $null
    $taskMetadata.apk = $taskDestination
    $taskMetadata | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $taskOutput 'build-info.json') -Encoding UTF8
    @(
        'POCKETPAL AI COMMUNITY - VERIFIED FORK APK BUILD',
        "Application: $($taskMetadata.appName)",
        "Version: $($taskMetadata.versionName) ($($taskMetadata.versionCode))",
        "File: $taskDestination",
        "Bytes: $($taskMetadata.bytes)",
        "Source commit: $($taskMetadata.sourceCommit)",
        "Package: $($taskMetadata.package)",
        "Minimum Android: $($taskMetadata.minimumAndroid) / API $($taskMetadata.minSdk); target API $($taskMetadata.targetSdk)",
        "ABIs: $($taskMetadata.abis -join ', ')",
        "Signer: $($taskMetadata.signerCertificates -join '; ')",
        'Passed: source/manifest version match, release flags, APK signature, Plus gate OFF, native payload, ZIP/ELF alignment.',
        'Runtime/device tests are separate and are not performed by this command.',
        'Details: build-info.json and verification-build/.',
        'Instructions: ../../tools/apk/README-RU.md'
    ) | Set-Content (Join-Path $taskOutput 'BUILD-REPORT.txt') -Encoding UTF8
    Copy-Item -LiteralPath (Join-Path $taskRoot 'LICENSE') -Destination (Join-Path $taskOutput 'LICENSE.txt') -Force
    $taskFinalReports = Join-Path $taskOutput 'verification-build'
    New-Item -ItemType Directory -Path $taskFinalReports -Force | Out-Null
    foreach ($taskReportName in @('artifact-checks.json','apk-badging.txt','apk-signature.txt',
        'apk-zipalign.txt','apk-plus-gate.txt','apk-native-payload.txt','apk-native-payload.log','apk-elf-layout.json')) {
        Copy-Item -LiteralPath (Join-Path $taskLogDir $taskReportName) -Destination $taskFinalReports -Force
    }
    Write-Host "SUCCESS: $taskDestination"
    Write-Host 'Artifact checks passed. Device/model/microphone tests are separate and are not run by this script.'
}
finally {
    try {
        if ($taskTemporaryApk -and (Test-Path -LiteralPath $taskTemporaryApk)) { Remove-Item -LiteralPath $taskTemporaryApk -Force }
        if ($taskYarnCache -and (Test-Path -LiteralPath $taskYarnCache)) {
            $taskCacheTarget = [IO.Path]::GetFullPath($taskYarnCache)
            $taskAllowedPrefix = [IO.Path]::GetFullPath((Join-Path $taskCache 'tmp')) + '\'
            if (-not $taskCacheTarget.StartsWith($taskAllowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Temporary Yarn cache cleanup escaped the project cache root.' }
            if ((Get-Item -LiteralPath $taskCacheTarget -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing recursive deletion of a reparse-point cache root.' }
            Remove-Item -LiteralPath $taskCacheTarget -Recurse -Force
            Write-Host 'Temporary Yarn download cache removed.'
        }
    } finally {
        try {
            if ($taskLock) { $taskLock.Dispose() }
            foreach ($taskName in $taskEnvNames) { [Environment]::SetEnvironmentVariable($taskName, $taskOldEnv[$taskName], 'Process') }
            Set-Location -LiteralPath $taskOldLocation
        } finally {
            if ($taskTranscriptActive) { Stop-Transcript | Out-Null }
        }
    }
}
