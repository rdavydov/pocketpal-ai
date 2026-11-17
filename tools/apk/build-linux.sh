#!/usr/bin/env bash
# Same source-built standalone Community APK as build-apk.cmd, on a Linux runner.
set -euo pipefail

task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_root"
task_output="${1:-$task_root/build/apk/ci}"
mkdir -p "$task_output"
task_output="$(cd -- "$task_output" && pwd)"
mkdir -p "$task_output/logs" "$task_output/verification-build"
exec > >(tee "$task_output/logs/build.log") 2>&1

export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
: "${ANDROID_HOME:?Set ANDROID_HOME to the installed Android SDK}"
: "${JAVA_HOME:?Set JAVA_HOME to JDK 17}"
: "${HEXAGON_SDK_ROOT:?Run the repository setup-hexagon-sdk action first}"
: "${HEXAGON_TOOLS_ROOT:?Run the repository setup-hexagon-sdk action first}"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<21))throw Error("Node 22.21+ required")'
test "$(yarn --version)" = '1.22.22'
"$JAVA_HOME/bin/java" -version 2>&1 | grep -Eq 'version "17\.'
python3 -c 'import sys; assert sys.version_info >= (3, 9)'
command -v ninja >/dev/null

export RNLLAMA_SKIP_POSTINSTALL=1
export PLUS_STORE_GATE=false
export E2E_BUILD=false
export NODE_ENV=production
export BABEL_ENV=production
export ORG_GRADLE_PROJECT_rnllamaBuildFromSource=true
export CMAKE_BUILD_PARALLEL_LEVEL=4
# Never permit the upstream Gradle fallback to silently change the release identity.
unset APP_RELEASE_STORE_PASSWORD APP_RELEASE_KEY_PASSWORD

node tools/apk/android-apk.mjs metadata --root "$task_root" > "$task_output/source-info.json"
yarn install --frozen-lockfile --ignore-scripts --production=false --check-files
node node_modules/patch-package/index.js --error-on-fail
node tools/apk/prepare-ci.mjs --root "$task_root"
task_variants="$(node scripts/verify-android-payload.js --print-variants)"
test -n "$task_variants"
export ORG_GRADLE_PROJECT_rnllamaVariants="$task_variants"

# A transient init script bounds every native module and aligns plugin versions
# with the installed React Native plugin, without editing application sources.
export POCKETPAL_REPO_ROOT="$task_root"
export POCKETPAL_CI_NINJA="$(command -v ninja)"
cat > "$task_output/ci.init.gradle" <<'GRADLE'
gradle.beforeProject { project ->
    def root = System.getenv('POCKETPAL_REPO_ROOT')
    def pins = new File(root, 'node_modules/@react-native/gradle-plugin/gradle/libs.versions.toml').getText('UTF-8')
    def agp = pins =~ /(?m)^agp\s*=\s*"([^"]+)"\s*$/
    def kotlin = pins =~ /(?m)^kotlin\s*=\s*"([^"]+)"\s*$/
    if (!agp.find() || !kotlin.find()) throw new GradleException('Cannot read installed React Native plugin versions')
    project.buildscript.configurations.configureEach {
        resolutionStrategy.force('com.android.tools.build:gradle:' + agp.group(1), 'org.jetbrains.kotlin:kotlin-gradle-plugin:' + kotlin.group(1))
    }
    def configure = {
        def android = project.extensions.getByName('android')
        android.ndkVersion = project.rootProject.ext.ndkVersion
        if (project.name == 'react-native-image-picker') {
            project.extensions.getByName('androidComponents').finalizeDsl { dsl -> dsl.compileSdk = project.rootProject.ext.compileSdkVersion }
        }
        android.defaultConfig.externalNativeBuild.cmake.arguments.addAll([
            '-DCMAKE_MAKE_PROGRAM=' + System.getenv('POCKETPAL_CI_NINJA'),
            '-DCMAKE_JOB_POOLS=compile=4;link=1',
            '-DCMAKE_JOB_POOL_COMPILE=compile', '-DCMAKE_JOB_POOL_LINK=link',
        ])
    }
    project.pluginManager.withPlugin('com.android.application') { configure() }
    project.pluginManager.withPlugin('com.android.library') { configure() }
    project.pluginManager.withPlugin('com.facebook.react') {
        if (project.path == ':app') project.extensions.getByName('react').extraPackagerArgs.addAll(['--max-workers', '1'])
    }
}
GRADLE

task_gradle_args=(
  --init-script "$task_output/ci.init.gradle" --no-daemon --max-workers=4 --console=plain --info --stacktrace
  '-Dorg.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=1536m'
  -Pkotlin.compiler.execution.strategy=in-process
  -PrnllamaBuildFromSource=true "-PrnllamaVariants=$task_variants"
  -PRNSpeech_phononAbis=arm64-v8a,x86_64 -PreactNativeArchitectures=arm64-v8a,x86_64
)
# A cold multi-module Kotlin build needs more class metadata than the incremental
# Windows build. Compile it first so compiler failures precede the expensive C++
# build; assemble then reuses these outputs with exactly the same configuration.
bash android/gradlew -p "$task_root/android" :app:compileProdReleaseKotlin \
  "${task_gradle_args[@]}" 2>&1 | tee "$task_output/logs/kotlin-preflight.log"

bash android/gradlew -p "$task_root/android" assembleProdRelease "${task_gradle_args[@]}" \
  2>&1 | tee "$task_output/logs/gradle.log"
grep -qF "Building rnllama variants: $task_variants" "$task_output/logs/gradle.log"
task_source_apk="$task_root/android/app/build/outputs/apk/prod/release/app-prod-release.apk"
node tools/apk/android-apk.mjs verify --apk "$task_source_apk" \
  --report-dir "$task_output/verification-build" --sdk-root "$ANDROID_HOME" \
  --java-home "$JAVA_HOME" --python "$(command -v python3)"

node --input-type=module - "$task_output" "$task_source_apk" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [output, sourceApk] = process.argv.slice(2);
const info = JSON.parse(fs.readFileSync(path.join(output, 'verification-build/artifact-checks.json'), 'utf8').replace(/^\uFEFF/, ''));
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(info.versionName)) throw Error('Unsafe/non-stable APK version');
const destination = path.join(output, `pocketpal-ai-community-${info.versionName}-android7.apk`);
const partial = destination + '.partial';
fs.copyFileSync(sourceApk, partial);
if (fs.statSync(partial).size !== info.bytes) throw Error('Copied APK size mismatch');
fs.renameSync(partial, destination);
info.apk = destination;
fs.writeFileSync(path.join(output, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
fs.copyFileSync('LICENSE', path.join(output, 'LICENSE.txt'));
fs.writeFileSync(path.join(output, 'BUILD-REPORT.txt'), [
  `${info.appName} ${info.versionName} (${info.versionCode})`,
  `Package: ${info.package}`, `Source: ${info.sourceCommit}`, `File: ${path.basename(destination)}`,
  `Bytes: ${info.bytes}`, `Android minimum: ${info.minSdk}; target: ${info.targetSdk}`,
  `ABIs: ${info.abis.join(', ')}`, 'Signature: public upstream Android Debug test key',
  'Passed: release identity/version, API24+ signature, Plus OFF, native payload and ZIP/ELF 16 KB.',
  'Device smoke test is a separate job; no full voice or physical GPU/NPU claim.', '',
].join('\n'));
console.log(`SUCCESS: ${destination}`);
NODE
