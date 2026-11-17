import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  boundsCenter,
  hasFatalCrash,
  packageVersion,
  parseArguments,
  parseUiNodes,
  pngDimensions,
  selectDevice,
  smokeAndroid,
} from '../smoke-android.mjs';
import {
  configForPackage,
  dummyGoogleServices,
  requiredGrammarAssets,
} from '../prepare-ci.mjs';

const pngFixture = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a43sAAAAASUVORK5CYII=',
  'base64',
);

test('selects exactly one ready emulator and refuses accidental multi-device operations', () => {
  assert.equal(
    selectDevice(
      'List of devices attached\nemulator-5554\tdevice\nusb-serial\toffline\n',
    ),
    'emulator-5554',
  );
  assert.throws(
    () => selectDevice('List of devices attached\n'),
    /exactly one/,
  );
  assert.throws(() => selectDevice('a\tdevice\nb\tdevice\n'), /exactly one/);
  assert.equal(selectDevice('a\tdevice\nb\tdevice\n', 'b'), 'b');
  assert.throws(
    () => selectDevice('a\tdevice\nb\toffline\n', 'b'),
    /not ready/,
  );
});

test('finds Android test IDs without depending on translated UI text', () => {
  const nodes = parseUiNodes(
    '<?xml version="1.0"?><hierarchy><node package="io.github.rdavydov.pocketpalai" resource-id="onboarding-skip" text="Skip &amp; start" bounds="[880,90][1050,190]" /></hierarchy>',
  );
  assert.equal(nodes[0]['resource-id'], 'onboarding-skip');
  assert.equal(nodes[0].text, 'Skip & start');
  assert.deepEqual(boundsCenter(nodes[0].bounds), [965, 140]);
  for (const malformed of [
    '[1,2][1,3]',
    '[5,5][2,2]',
    '[0,0][100000,2]',
    'tap 50 50',
    undefined,
  ]) {
    assert.throws(() => boundsCenter(malformed));
  }
});

test('reads Android package versions and rejects absent version metadata', () => {
  assert.deepEqual(
    packageVersion(
      'versionCode=160 minSdk=24 targetSdk=36\n versionName=1.23.0\n',
    ),
    {versionName: '1.23.0', versionCode: '160'},
  );
  assert.throws(() => packageVersion('Unknown package'), /Cannot read/);
});

test('does not call unavailable billing or ordinary React Native warnings a fatal crash', () => {
  assert.equal(
    hasFatalCrash(
      'E ReactNativeJS: Play Store service is not connected\nW ReactNative: memory warning',
    ),
    false,
  );
  assert.equal(
    hasFatalCrash('E AndroidRuntime: FATAL EXCEPTION: mqt_native_modules'),
    true,
  );
  assert.equal(
    hasFatalCrash('F libc: Fatal signal 11 (SIGSEGV), code 1'),
    true,
  );
});

test('requires a complete PNG rather than only accepting a PNG file header', () => {
  assert.deepEqual(pngDimensions(pngFixture), {width: 1, height: 1});
  assert.throws(
    () => pngDimensions(pngFixture.subarray(0, 32)),
    /complete PNG/,
  );
  assert.throws(
    () => pngDimensions(Buffer.from('not a screenshot')),
    /complete PNG/,
  );
});

test('CLI refuses ambiguous, unknown or missing options', () => {
  assert.equal(
    parseArguments(['--apk', 'app.apk', '--report-dir', 'out']).apk,
    'app.apk',
  );
  for (const args of [
    [],
    ['--apk'],
    ['--apk', '--report-dir', 'out'],
    ['--apk', 'a', '--report-dir', 'out', '--unknown', 'x'],
    ['--apk', 'a', '--apk', 'b', '--report-dir', 'out'],
  ]) {
    assert.throws(() => parseArguments(args));
  }
});

test('Firebase preparation repairs only recognized CI metadata', () => {
  const expected = 'io.github.rdavydov.pocketpalai';
  const dummy = configForPackage(
    dummyGoogleServices('com.pocketpalai'),
    expected,
  );
  assert.equal(
    dummy.client[0].client_info.android_client_info.package_name,
    expected,
  );
  const real = {
    project_info: {project_id: 'real-production'},
    client: [
      {client_info: {android_client_info: {package_name: 'com.pocketpalai'}}},
    ],
  };
  assert.throws(() => configForPackage(real, expected), /real Firebase/);
  const matching = {
    ...real,
    client: [{client_info: {android_client_info: {package_name: expected}}}],
  };
  assert.equal(configForPackage(matching, expected), matching);
});

test('Android grammar requirements include scanner/shared sources and reject path traversal', () => {
  const files = requiredGrammarAssets('/pkg', {
    runtime: {version: 'x'},
    grammars: {cpp: {scanner: true, sharedSrc: ['src/common.h']}},
  });
  assert(files.some(file => file.endsWith('scanner.c')));
  assert(files.some(file => file.endsWith('common.h')));
  assert.throws(
    () =>
      requiredGrammarAssets('/pkg', {
        runtime: {},
        grammars: {'../outside': {}},
      }),
    /Unexpected grammar/,
  );
  assert.throws(
    () => requiredGrammarAssets('/pkg', {runtime: {}, grammars: {}}),
    /incomplete/,
  );
});

function fakeDevice({
  crash = false,
  screenshotFailure = false,
  wrongVersion = false,
} = {}) {
  const calls = [];
  let skipped = false;
  const ui = id =>
    `<hierarchy><node package="io.github.rdavydov.pocketpalai" resource-id="${id}" bounds="[900,90][1050,190]" enabled="true" /></hierarchy>`;
  return {
    calls,
    run(_command, allArgs) {
      const args = allArgs[0] === '-s' ? allArgs.slice(2) : allArgs;
      calls.push(args);
      const key = args.join(' ');
      let stdout = '';
      if (key === 'devices')
        stdout = 'List of devices attached\nemulator-5554\tdevice\n';
      else if (key === 'shell getprop ro.build.version.sdk') stdout = '35';
      else if (key === 'shell getprop ro.product.cpu.abi') stdout = 'x86_64';
      else if (args[0] === 'install') stdout = 'Success';
      else if (key.startsWith('shell dumpsys package'))
        stdout = `versionCode=160 minSdk=24\nversionName=${wrongVersion ? '0.0.0' : '1.23.0'}`;
      else if (key.startsWith('shell am start'))
        stdout = 'Status: ok\nLaunchState: COLD\nTotalTime: 500';
      else if (key.startsWith('shell pidof')) stdout = '12345';
      else if (key.startsWith('shell uiautomator dump'))
        stdout = 'UI hierarchy dumped';
      else if (key.startsWith('shell cat '))
        stdout = ui(skipped ? 'chat-input' : 'onboarding-skip');
      else if (key.startsWith('shell input tap')) skipped = true;
      else if (args[0] === 'logcat')
        stdout = crash
          ? 'E AndroidRuntime: FATAL EXCEPTION: main'
          : 'E ReactNativeJS: Play Store service is not connected';
      else if (key === 'shell dumpsys activity activities')
        stdout =
          'mResumedActivity: ActivityRecord{123 u0 io.github.rdavydov.pocketpalai/com.pocketpal.MainActivity t4}';
      else if (key === 'exec-out screencap -p')
        stdout = screenshotFailure ? Buffer.from('failed') : pngFixture;
      else if (!key.startsWith('shell rm -f '))
        throw new Error(`Unexpected adb command: ${key}`);
      return {status: 0, stdout, stderr: ''};
    },
  };
}

async function withSmokeFiles(callback) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'pocketpal-smoke-test-'),
  );
  try {
    const apk = path.join(directory, 'app.apk');
    const reports = path.join(directory, 'smoke');
    writeFileSync(apk, 'test-apk');
    writeFileSync(
      path.join(directory, 'build-info.json'),
      JSON.stringify({
        sourceCommit: 'a'.repeat(40),
        package: 'io.github.rdavydov.pocketpalai',
        versionName: '1.23.0',
        versionCode: '160',
      }),
    );
    await callback({apk, reports});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

test('device smoke installs the same APK, skips onboarding by bounds, and emits publisher evidence', async () => {
  await withSmokeFiles(async ({apk, reports}) => {
    const device = fakeDevice();
    const checks = await smokeAndroid(
      {apk, 'report-dir': reports},
      {run: device.run, delay: async () => {}},
    );
    assert.equal(checks.passed, true);
    assert.equal(checks.device.api, 35);
    assert.equal(checks.sourceCommit, 'a'.repeat(40));
    assert(
      device.calls.some(args => args[0] === 'install' && args.at(-1) === apk),
    );
    assert(
      device.calls.some(args => args.join(' ') === 'shell input tap 975 140'),
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(reports, 'checks.json'))).ui,
      true,
    );
    assert(
      readFileSync(path.join(reports, 'smoke.png'))
        .subarray(0, 4)
        .equals(Buffer.from([137, 80, 78, 71])),
    );
  });
});

test('device smoke blocks release on crashes, wrong versions, or failed native screenshot capture', async () => {
  for (const failure of [
    {crash: true},
    {wrongVersion: true},
    {screenshotFailure: true},
  ]) {
    await withSmokeFiles(async ({apk, reports}) => {
      const device = fakeDevice(failure);
      await assert.rejects(
        smokeAndroid(
          {apk, 'report-dir': reports},
          {run: device.run, delay: async () => {}},
        ),
      );
      const evidence = JSON.parse(
        readFileSync(path.join(reports, 'checks.json')),
      );
      assert.equal(evidence.passed, false);
      assert(evidence.error);
    });
  }
});
