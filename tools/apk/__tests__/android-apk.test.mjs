import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  readMetadata,
  resolveSdkPackages,
  parseBadging,
  assertDebugSigner,
  pemCertificates,
  parseArgs,
  verifyApk,
  runChecked,
} from '../android-apk.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'community-apk-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('community-apk-test-'));
    fs.rmSync(root, {recursive: true, force: true});
  });
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content);
  };
  write('package.json', JSON.stringify({version: '1.24.0'}));
  write('.version', '1.24.0\n');
  write(
    'android/build.gradle',
    `buildToolsVersion = "37.0.0"\nminSdkVersion = 24\ncompileSdkVersion = 37\ntargetSdkVersion = 36\nndkVersion = "27.3.13750724"\n`,
  );
  write(
    'android/app/build.gradle',
    `applicationId "io.github.rdavydov.pocketpalai"\nversionName "1.24.0"\nversionCode 161\nabiFilters "arm64-v8a", "x86_64"\n`,
  );
  write(
    'android/app/src/main/res/values/strings.xml',
    '<resources><string name="app_name">PocketPal AI Community</string></resources>',
  );
  return {root, write};
}

const expected = {
  package: 'io.github.rdavydov.pocketpalai',
  appName: 'PocketPal AI Community',
  versionName: '1.24.0',
  versionCode: '161',
  targetSdk: 36,
};
const badging = `package: name='io.github.rdavydov.pocketpalai' versionCode='161' versionName='1.24.0' platformBuildVersionName='17' compileSdkVersionCodename='17'\nsdkVersion:'24'\ntargetSdkVersion:'36'\napplication-label:'PocketPal AI Community'\nnative-code: 'arm64-v8a' 'x86_64'\n`;

test('metadata derives current Android/toolchain versions and Community identity', t => {
  const {root} = fixture(t);
  assert.deepEqual(readMetadata(root), {
    ...expected,
    minSdk: 24,
    minimumAndroid: '7.0',
    compileSdk: 37,
    buildToolsVersion: '37.0.0',
    ndkVersion: '27.3.13750724',
    abis: ['arm64-v8a', 'x86_64'],
  });
});

test('metadata rejects a stale .version even when Android and package.json agree', t => {
  const {root, write} = fixture(t);
  write('.version', '1.23.0\n');
  assert.throws(() => readMetadata(root), /Version mismatch/);
});

test('metadata rejects a stale package version', t => {
  const {root, write} = fixture(t);
  write('package.json', JSON.stringify({version: '1.23.0'}));
  assert.throws(() => readMetadata(root), /Version mismatch/);
});

test('metadata rejects the original application ID', t => {
  const {root} = fixture(t);
  const file = path.join(root, 'android/app/build.gradle');
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace('io.github.rdavydov.pocketpalai', 'com.pocketpalai'),
  );
  assert.throws(() => readMetadata(root), /Community identity changed/);
});

test('metadata fails when upstream changes the minimum Android version', t => {
  const {root} = fixture(t);
  const file = path.join(root, 'android/build.gradle');
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace('minSdkVersion = 24', 'minSdkVersion = 26'),
  );
  assert.throws(() => readMetadata(root), /Android 7\/API24 must be retained/);
});

test('metadata rejects ambiguous duplicate version declarations', t => {
  const {root} = fixture(t);
  fs.appendFileSync(
    path.join(root, 'android/app/build.gradle'),
    'versionCode 162\n',
  );
  assert.throws(() => readMetadata(root), /Expected one literal versionCode/);
});

const sdkMetadata = {
  compileSdk: 37,
  buildToolsVersion: '37.0.0',
  ndkVersion: '27.3.13750724',
};
const sdkTools = [
  ['build-tools;37.0.0', '37.0.0', 'Android SDK Build-Tools 37'],
  ['ndk;27.3.13750724', '27.3.13750724', 'NDK (Side by side)'],
  ['cmake;3.22.1', '3.22.1', 'CMake 3.22.1'],
];
const sdkList = rows =>
  [
    'Loading local repository...',
    'Available Packages:',
    '  Path | Version | Description',
    '  ------- | ------- | -------',
    ...rows.map(row => `  ${row.join(' | ')}`),
  ].join('\n');

test('SDK resolver supports an integer API package from the stable table', () => {
  const result = resolveSdkPackages(
    sdkList([
      ['platforms;android-36', '2', 'Android SDK Platform 36'],
      ...sdkTools,
    ]),
    {...sdkMetadata, compileSdk: 36},
  );
  assert.deepEqual(result, {
    platform: 'platforms;android-36',
    buildTools: 'build-tools;37.0.0',
    ndk: 'ndk;27.3.13750724',
    cmake: 'cmake;3.22.1',
  });
});

test('SDK resolver chooses exact API 37.0 rather than a higher minor API', () => {
  const result = resolveSdkPackages(
    sdkList([
      ['platforms;android-37.2', '1', 'Android SDK Platform 37.2'],
      ['platforms;android-37.1', '1', 'Android SDK Platform 37.1'],
      ['platforms;android-37.0', '1', 'Android SDK Platform 37'],
      ...sdkTools,
    ]),
    sdkMetadata,
  );
  assert.equal(result.platform, 'platforms;android-37.0');
});

test('SDK resolver prefers the exact integer API ID when both forms exist', () => {
  const result = resolveSdkPackages(
    sdkList([
      ['platforms;android-37.0', '1', 'Android SDK Platform 37'],
      ['platforms;android-37', '2', 'Android SDK Platform 37'],
      ...sdkTools,
    ]),
    sdkMetadata,
  );
  assert.equal(result.platform, 'platforms;android-37');
});

test('SDK resolver accepts installed tool packages and an available platform', () => {
  const installed = [
    'Installed packages:',
    'Path | Version | Description | Location',
    '---- | ------- | ----------- | --------',
    ...sdkTools.map(row => [...row, `installed/${row[0]}`].join(' | ')),
  ].join('\r\n');
  const result = resolveSdkPackages(
    installed +
      '\r\n\r\n' +
      sdkList([['platforms;android-37.0', '1', 'Android SDK Platform 37']]),
    sdkMetadata,
  );
  assert.equal(result.platform, 'platforms;android-37.0');
  assert.equal(result.ndk, 'ndk;27.3.13750724');
});

test('SDK resolver rejects preview-only API packages and higher minor substitutes', () => {
  const list = sdkList([
    ['platforms;android-37', '1 rc1', 'Android SDK Platform 37'],
    ['platforms;android-37.0', '1', 'Android SDK Platform 37 (Beta)'],
    ['platforms;android-37.2', '1', 'Android SDK Platform 37.2'],
    ...sdkTools,
  ]);
  assert.throws(
    () => resolveSdkPackages(list, sdkMetadata),
    /Missing stable platform for compileSdk 37/,
  );
});

for (const id of sdkTools.map(row => row[0])) {
  test(`SDK resolver rejects missing pinned package ${id}`, () => {
    const list = sdkList([
      ['platforms;android-37.0', '1', 'Android SDK Platform 37'],
      ...sdkTools.filter(row => row[0] !== id),
    ]);
    assert.throws(
      () => resolveSdkPackages(list, sdkMetadata),
      error => {
        assert.match(error.message, /Missing stable SDK package/);
        assert.ok(error.message.includes(id));
        return true;
      },
    );
  });
}

test('SDK resolver reports unsupported output instead of guessing package IDs', () => {
  assert.throws(
    () =>
      resolveSdkPackages('Error: repository could not be loaded', sdkMetadata),
    /Unsupported sdkmanager list format/,
  );
});

test('SDK package CLI reads the current project and returns installable IDs as JSON', t => {
  const {root, write} = fixture(t);
  write(
    'sdk-list.txt',
    sdkList([
      ['platforms;android-37.0', '1', 'Android SDK Platform 37'],
      ...sdkTools,
    ]),
  );
  const cli = new URL('../android-apk.mjs', import.meta.url);
  const output = runChecked(process.execPath, [
    fileURLToPath(cli),
    'sdk-packages',
    '--root',
    root,
    '--list-file',
    path.join(root, 'sdk-list.txt'),
  ]);
  assert.deepEqual(JSON.parse(output), {
    platform: 'platforms;android-37.0',
    buildTools: 'build-tools;37.0.0',
    ndk: 'ndk;27.3.13750724',
    cmake: 'cmake;3.22.1',
  });
  assert.equal(readMetadata(root).compileSdk, 37);
  assert.equal(readMetadata(root).minSdk, 24);
});

test('badging parses the actual manifest, including extra aapt fields and CRLF', () => {
  assert.deepEqual(parseBadging(badging.replaceAll('\n', '\r\n'), expected), {
    ...expected,
    minSdk: 24,
    abis: ['arm64-v8a', 'x86_64'],
  });
});

for (const [name, from, to, pattern] of [
  [
    'package',
    'io.github.rdavydov.pocketpalai',
    'com.pocketpalai',
    /APK package/,
  ],
  [
    'name',
    "application-label:'PocketPal AI Community'",
    "application-label:'PocketPal'",
    /application label/,
  ],
  [
    'version',
    "versionName='1.24.0'",
    "versionName='1.23.0'",
    /Stale APK version/,
  ],
  ['code', "versionCode='161'", "versionCode='160'", /Stale APK version/],
  ['minimum Android', "sdkVersion:'24'", "sdkVersion:'26'", /APK SDKs/],
  ['ABI', "'arm64-v8a' 'x86_64'", "'arm64-v8a'", /APK must contain only/],
]) {
  test(`badging rejects mismatching ${name}`, () => {
    assert.throws(
      () => parseBadging(badging.replace(from, to), expected),
      pattern,
    );
  });
}

test('badging rejects debuggable APKs', () => {
  assert.throws(
    () => parseBadging(badging + 'application-debuggable\n', expected),
    /non-debuggable/,
  );
});

test('certificate comparison uses DER bytes and requires exactly one signer', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----';
  assert.deepEqual(pemCertificates(pem), [Buffer.from([1, 2, 3])]);
  assert.doesNotThrow(() =>
    assertDebugSigner(
      'Signer certificate DN: name\n' + pem,
      pem.replace('AQID', 'AQ\nID'),
    ),
  );
  assert.throws(
    () => assertDebugSigner(pem.replace('AQID', 'AQIE'), pem),
    /APK signer differs/,
  );
  assert.throws(
    () => assertDebugSigner(pem + '\n' + pem, pem),
    /APK signer differs/,
  );
  assert.throws(
    () => assertDebugSigner('Signer certificate DN: name', pem),
    /APK signer differs/,
  );
});

test('CLI rejects repeated flags, missing values and verify flags in metadata', () => {
  assert.deepEqual(parseArgs(['metadata', '--root', 'folder with spaces']), {
    command: 'metadata',
    options: {root: 'folder with spaces'},
  });
  assert.throws(
    () => parseArgs(['metadata', '--root', 'one', '--root', 'two']),
    /Repeated argument/,
  );
  assert.throws(
    () => parseArgs(['verify', '--apk', '--report-dir', 'out']),
    /requires a value/,
  );
  assert.throws(
    () => parseArgs(['metadata', '--apk', 'app.apk']),
    /Unsupported metadata argument/,
  );
  assert.deepEqual(parseArgs(['sdk-packages', '--list-file', 'SDK list.txt']), {
    command: 'sdk-packages',
    options: {listFile: 'SDK list.txt'},
  });
  assert.throws(() => parseArgs(['sdk-packages']), /requires --list-file/);
  assert.throws(
    () => parseArgs(['sdk-packages', '--apk', 'app.apk']),
    /Unsupported sdk-packages argument/,
  );
});

test('failed verification removes a previous success verdict before preflight', t => {
  const {root, write} = fixture(t);
  write('reports/artifact-checks.json', '{"signature":"passed"}');
  assert.throws(
    () =>
      verifyApk({
        root,
        apk: path.join(root, 'missing.apk'),
        reportDir: path.join(root, 'reports'),
      }),
    /Missing verification file/,
  );
  assert.equal(
    fs.existsSync(path.join(root, 'reports/artifact-checks.json')),
    false,
  );
});

test('a failed subprocess is an error and its diagnostic output is retained', t => {
  const {root} = fixture(t);
  const log = path.join(root, 'tool.log');
  assert.throws(
    () =>
      runChecked(
        process.execPath,
        ['-e', 'console.error("native check failed"); process.exit(9)'],
        {log},
      ),
    /exit 9/,
  );
  assert.match(fs.readFileSync(log, 'utf8'), /native check failed/);
});
