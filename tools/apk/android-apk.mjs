#!/usr/bin/env node
// Shared source metadata and APK verification for Windows and GitHub runners.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export const COMMUNITY_PACKAGE = 'io.github.rdavydov.pocketpalai';
export const COMMUNITY_NAME = 'PocketPal AI Community';
const ABIS = ['arm64-v8a', 'x86_64'];

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function singleMatch(source, pattern, name) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected one literal ${name}; found ${matches.length}. Review the updated Android configuration.`,
    );
  }
  return matches[0][1];
}

function gradleValue(source, name, quoted = false) {
  const value = quoted ? '["\']([^"\']+)["\']' : '(\\d+)';
  return singleMatch(
    source,
    new RegExp(`^\\s*${name}\\s*(?:=\\s*)?${value}\\s*$`, 'gm'),
    name,
  );
}

function decodeXml(value) {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, entity) => {
      if (entity.startsWith('#')) {
        const hex = entity[1].toLowerCase() === 'x';
        return String.fromCodePoint(
          Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10),
        );
      }
      return {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"}[
        entity.toLowerCase()
      ];
    },
  );
}

export function readMetadata(root = DEFAULT_ROOT) {
  root = path.resolve(root);
  const gradle = read(path.join(root, 'android/build.gradle'));
  const app = read(path.join(root, 'android/app/build.gradle'));
  const strings = read(
    path.join(root, 'android/app/src/main/res/values/strings.xml'),
  ).replace(/<!--[\s\S]*?-->/g, '');
  const versionName = gradleValue(app, 'versionName', true);
  const versionCode = gradleValue(app, 'versionCode');
  const packageVersion = JSON.parse(
    read(path.join(root, 'package.json')),
  ).version;
  const versionFile = read(path.join(root, '.version')).trim();
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(versionName)) {
    throw new Error(`Unsupported Android versionName: ${versionName}`);
  }
  if (versionName !== packageVersion || versionName !== versionFile) {
    throw new Error(
      `Version mismatch: Android=${versionName}, package.json=${packageVersion}, .version=${versionFile}.`,
    );
  }
  if (Number(versionCode) < 1 || Number(versionCode) > 2147483647) {
    throw new Error('Android versionCode must be a positive 32-bit integer.');
  }
  const packageName = gradleValue(app, 'applicationId', true);
  const appName = decodeXml(
    singleMatch(
      strings,
      /<string\b[^>]*\bname\s*=\s*["']app_name["'][^>]*>([^<]*)<\/string>/g,
      'app_name',
    ),
  );
  if (packageName !== COMMUNITY_PACKAGE || appName !== COMMUNITY_NAME) {
    throw new Error(
      `Community identity changed: package=${packageName}, app_name=${appName}.`,
    );
  }
  const minSdk = Number(gradleValue(gradle, 'minSdkVersion'));
  const targetSdk = Number(gradleValue(gradle, 'targetSdkVersion'));
  const compileSdk = Number(gradleValue(gradle, 'compileSdkVersion'));
  if (minSdk !== 24 || targetSdk < minSdk || compileSdk < targetSdk) {
    throw new Error(
      `Unsupported SDK configuration: min=${minSdk}, target=${targetSdk}, compile=${compileSdk}; Android 7/API24 must be retained.`,
    );
  }
  const abiDeclaration = singleMatch(
    app,
    /^\s*abiFilters\s+([^\r\n]+)$/gm,
    'abiFilters',
  );
  const abis = [...abiDeclaration.matchAll(/["']([^"']+)["']/g)].map(
    match => match[1],
  );
  if (abis.length !== ABIS.length || !ABIS.every(abi => abis.includes(abi))) {
    throw new Error(
      `Expected only ${ABIS.join(', ')}; source declares ${abis.join(', ')}.`,
    );
  }
  return {
    package: packageName,
    appName,
    versionName,
    versionCode,
    minSdk,
    minimumAndroid: '7.0',
    targetSdk,
    compileSdk,
    buildToolsVersion: gradleValue(gradle, 'buildToolsVersion', true),
    ndkVersion: gradleValue(gradle, 'ndkVersion', true),
    abis,
  };
}

export function resolveSdkPackages(list, metadata) {
  const packages = new Set();
  let inTable = false;
  let foundTable = false;
  for (const line of list.split(/\r?\n/)) {
    const columns = line.split('|').map(column => column.trim());
    if (
      columns[0] === 'Path' &&
      columns[1] === 'Version' &&
      columns[2] === 'Description'
    ) {
      inTable = true;
      foundTable = true;
      continue;
    }
    if (/^[\s|-]+$/.test(line)) continue;
    if (columns.length < 3) {
      inTable = false;
      continue;
    }
    if (!inTable) continue;
    const [id, version, description] = columns;
    // --channel=0 is the caller's contract, but a previously installed
    // preview can still appear in its installed-packages table.
    if (
      /^\d+(?:\.\d+)*$/.test(version) &&
      !/\b(?:alpha|beta|preview|rc)\d*\b/i.test(description)
    ) {
      packages.add(id);
    }
  }
  if (!foundTable) {
    throw new Error(
      'Unsupported sdkmanager list format. Supply the complete output of sdkmanager --list --channel=0.',
    );
  }
  const platforms = [
    `platforms;android-${metadata.compileSdk}`,
    `platforms;android-${metadata.compileSdk}.0`,
  ];
  const platform = platforms.find(id => packages.has(id));
  if (!platform) {
    throw new Error(
      `Missing stable platform for compileSdk ${metadata.compileSdk}. Expected ${platforms.join(' or ')}; higher minor APIs and previews are not substitutes.`,
    );
  }
  const selected = {
    platform,
    buildTools: `build-tools;${metadata.buildToolsVersion}`,
    ndk: `ndk;${metadata.ndkVersion}`,
    cmake: 'cmake;3.22.1',
  };
  for (const id of Object.values(selected)) {
    if (!packages.has(id)) {
      throw new Error(
        `Missing stable SDK package '${id}' in sdkmanager --list --channel=0.`,
      );
    }
  }
  return selected;
}

export function parseBadging(text, expected) {
  const packageLine = singleMatch(
    text,
    /^package:\s*(.*)\r?$/gm,
    'APK package line',
  );
  const fields = Object.fromEntries(
    [
      ...packageLine.matchAll(
        /(?:^|\s)(name|versionCode|versionName)='([^']*)'/g,
      ),
    ].map(match => [match[1], match[2]]),
  );
  if (fields.name !== expected.package) {
    throw new Error(
      `APK package '${fields.name}' differs from expected '${expected.package}'.`,
    );
  }
  if (
    fields.versionName !== expected.versionName ||
    fields.versionCode !== String(expected.versionCode)
  ) {
    throw new Error(
      `Stale APK version ${fields.versionName} (${fields.versionCode}); expected ${expected.versionName} (${expected.versionCode}).`,
    );
  }
  const appName = singleMatch(
    text,
    /^application-label:'(.*)'\r?$/gm,
    'APK application-label',
  );
  if (appName !== expected.appName) {
    throw new Error(
      `APK application label '${appName}' differs from expected '${expected.appName}'.`,
    );
  }
  const minSdk = Number(
    singleMatch(text, /^sdkVersion:'(\d+)'\r?$/gm, 'APK minSdk'),
  );
  const targetSdk = Number(
    singleMatch(text, /^targetSdkVersion:'(\d+)'\r?$/gm, 'APK targetSdk'),
  );
  if (minSdk !== 24 || targetSdk !== expected.targetSdk) {
    throw new Error(
      `APK SDKs min=${minSdk}, target=${targetSdk}; expected min=24, target=${expected.targetSdk}.`,
    );
  }
  if (/^application-debuggable(?:\s|$)/m.test(text)) {
    throw new Error('Expected a non-debuggable standalone release APK.');
  }
  const nativeCode = singleMatch(
    text,
    /^native-code:\s*(.*)\r?$/gm,
    'APK native-code',
  );
  const abis = [...nativeCode.matchAll(/'([^']+)'/g)].map(match => match[1]);
  if (abis.length !== ABIS.length || !ABIS.every(abi => abis.includes(abi))) {
    throw new Error(
      `APK must contain only ${ABIS.join(', ')}; found ${abis.join(', ')}.`,
    );
  }
  return {
    package: fields.name,
    appName,
    versionName: fields.versionName,
    versionCode: fields.versionCode,
    minSdk,
    targetSdk,
    abis,
  };
}

export function pemCertificates(text) {
  return [
    ...text.matchAll(
      /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g,
    ),
  ].map(match => {
    const body = match[1].replace(/\s/g, '');
    if (
      !body ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(body) ||
      body.length % 4 !== 0
    ) {
      throw new Error('Malformed PEM signing certificate.');
    }
    return Buffer.from(body, 'base64');
  });
}

export function assertDebugSigner(
  apkCertificateOutput,
  keystoreCertificateOutput,
) {
  const apkCertificates = pemCertificates(apkCertificateOutput);
  const keystoreCertificates = pemCertificates(keystoreCertificateOutput);
  if (
    apkCertificates.length !== 1 ||
    keystoreCertificates.length !== 1 ||
    !apkCertificates[0].equals(keystoreCertificates[0])
  ) {
    throw new Error(
      'APK signer differs from the existing public debug.keystore; it cannot update the published Community APK.',
    );
  }
}

export function runChecked(program, args, {cwd, env, log} = {}) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  if (log) fs.writeFileSync(log, output);
  if (result.error || result.status !== 0) {
    const reason =
      result.error?.message ||
      `exit ${result.status}${result.signal ? ` (${result.signal})` : ''}`;
    throw new Error(
      `${path.basename(program)} failed: ${reason}.${log ? ` See ${log}` : ` ${output.trim().slice(-2000)}`}`,
    );
  }
  return result.stdout;
}

function requireFile(file) {
  if (!fs.statSync(file, {throwIfNoEntry: false})?.isFile())
    throw new Error(`Missing verification file: ${file}`);
  return file;
}

export function verifyApk(options) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  if (!options.reportDir) throw new Error('--report-dir is required.');
  const reportDir = path.resolve(options.reportDir);
  fs.mkdirSync(reportDir, {recursive: true});
  const verdictPath = path.join(reportDir, 'artifact-checks.json');
  fs.rmSync(verdictPath, {force: true});
  if (!options.apk) throw new Error('--apk is required.');
  const apk = requireFile(path.resolve(options.apk));
  const metadata = readMetadata(root);
  const expected = {
    ...metadata,
    package: options.expectedPackageName || metadata.package,
    appName: options.expectedAppName || metadata.appName,
    versionName: options.expectedVersionName || metadata.versionName,
    versionCode: options.expectedVersionCode || metadata.versionCode,
    targetSdk:
      options.expectedTargetSdk === undefined
        ? metadata.targetSdk
        : Number(options.expectedTargetSdk),
  };
  if (!Number.isInteger(expected.targetSdk) || expected.targetSdk < 24)
    throw new Error('Invalid --expected-target-sdk.');
  const sdkRoot =
    options.sdkRoot || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const javaHome = options.javaHome || process.env.JAVA_HOME;
  if (!sdkRoot || !javaHome)
    throw new Error('Supply --sdk-root/--java-home or ANDROID_HOME/JAVA_HOME.');
  const windows = process.platform === 'win32';
  const executable = windows ? '.exe' : '';
  const buildTools = path.join(
    path.resolve(sdkRoot),
    'build-tools',
    metadata.buildToolsVersion,
  );
  const javaBin = path.join(path.resolve(javaHome), 'bin');
  const java = requireFile(path.join(javaBin, `java${executable}`));
  const keytool = requireFile(path.join(javaBin, `keytool${executable}`));
  const aapt = requireFile(path.join(buildTools, `aapt${executable}`));
  const zipalign = requireFile(path.join(buildTools, `zipalign${executable}`));
  const apksigner = requireFile(path.join(buildTools, 'lib/apksigner.jar'));
  const keystore = requireFile(path.join(root, 'android/app/debug.keystore'));
  let bash = 'bash';
  let git = 'git';
  const extraPath = [javaBin];
  if (windows) {
    if (!options.gitRoot)
      throw new Error(
        '--git-root pointing to Git for Windows is required on Windows.',
      );
    bash = requireFile(path.join(options.gitRoot, 'bin/bash.exe'));
    git = requireFile(path.join(options.gitRoot, 'cmd/git.exe'));
    requireFile(path.join(options.gitRoot, 'usr/bin/unzip.exe'));
    extraPath.push(path.join(options.gitRoot, 'usr/bin'));
  }
  const python = options.python || (windows ? 'python' : 'python3');
  const env = {
    ...process.env,
    JAVA_HOME: path.resolve(javaHome),
    PATH: [...extraPath, process.env.PATH || ''].join(path.delimiter),
  };
  const run = (program, args, filename) =>
    runChecked(program, args, {
      cwd: root,
      env,
      log: filename && path.join(reportDir, filename),
    });
  const badging = run(aapt, ['dump', 'badging', apk], 'apk-badging.txt');
  const actual = parseBadging(badging, expected);
  const signature = run(
    java,
    [
      '-jar',
      apksigner,
      'verify',
      '--verbose',
      '--print-certs-pem',
      '--min-sdk-version',
      '24',
      apk,
    ],
    'apk-signature.txt',
  );
  // Certificate bytes, not a mutable DN or a custom fingerprint stamp, hold update compatibility.
  const expectedCertificate = run(keytool, [
    '-exportcert',
    '-rfc',
    '-keystore',
    keystore,
    '-storepass',
    'android',
    '-alias',
    'androiddebugkey',
  ]);
  assertDebugSigner(signature, expectedCertificate);
  run(zipalign, ['-c', '-P', '16', '-v', '4', apk], 'apk-zipalign.txt');
  run(
    bash,
    ['scripts/verify-plus-gate.sh', apk.replaceAll('\\', '/'), '--ungated'],
    'apk-plus-gate.txt',
  );
  run(
    process.execPath,
    [
      'scripts/verify-android-payload.js',
      '--apk',
      apk,
      '--report',
      path.join(reportDir, 'apk-native-payload.txt'),
    ],
    'apk-native-payload.log',
  );
  run(
    python,
    [
      path.join(root, 'tools/apk/check-apk-elf-layout.py'),
      apk,
      '--report',
      path.join(reportDir, 'apk-elf-layout.json'),
      '--require-16kb',
    ],
    'apk-elf-layout.log',
  );
  const sourceCommit = run(git, ['rev-parse', 'HEAD']).trim();
  const trackedChanges = run(git, [
    'status',
    '--porcelain',
    '--untracked-files=no',
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const signerCertificates = [
    ...new Set(
      [...signature.matchAll(/certificate DN:\s*([^\r\n]+)/g)].map(
        match => match[1],
      ),
    ),
  ];
  const verdict = {
    verifiedAtUtc: new Date().toISOString(),
    apk,
    bytes: fs.statSync(apk).size,
    sourceCommit,
    trackedChanges,
    ...actual,
    minimumAndroid: '7.0',
    debuggable: false,
    plusGate: 'off',
    signerCertificates,
    signerMatchesDebugKeystore: true,
    signature: 'verified for API 24+',
    zipAlignment16kb: 'passed',
    nativePayload: 'passed',
    elfLayout16kb: 'passed',
    runtime: 'not tested by this script',
  };
  fs.writeFileSync(verdictPath, JSON.stringify(verdict, null, 2) + '\n');
  return verdict;
}

const FLAGS = {
  '--root': 'root',
  '--list-file': 'listFile',
  '--apk': 'apk',
  '--report-dir': 'reportDir',
  '--sdk-root': 'sdkRoot',
  '--java-home': 'javaHome',
  '--python': 'python',
  '--git-root': 'gitRoot',
  '--expected-package-name': 'expectedPackageName',
  '--expected-app-name': 'expectedAppName',
  '--expected-version-name': 'expectedVersionName',
  '--expected-version-code': 'expectedVersionCode',
  '--expected-target-sdk': 'expectedTargetSdk',
};

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['metadata', 'verify', 'sdk-packages'].includes(command))
    throw new Error(
      'Usage: android-apk.mjs metadata [--root PATH] | sdk-packages --list-file PATH [--root PATH] | verify --apk PATH --report-dir PATH [--sdk-root PATH --java-home PATH --python PATH --git-root PATH]',
    );
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const key = FLAGS[flag];
    const value = rest[index + 1];
    if (
      !key ||
      (command === 'metadata' && key !== 'root') ||
      (command === 'sdk-packages' && !['root', 'listFile'].includes(key)) ||
      (command === 'verify' && key === 'listFile')
    )
      throw new Error(`Unsupported ${command} argument: ${flag}`);
    if (options[key] !== undefined)
      throw new Error(`Repeated argument: ${flag}`);
    if (!value || value.startsWith('--'))
      throw new Error(`${flag} requires a value.`);
    options[key] = value;
  }
  if (command === 'sdk-packages' && !options.listFile) {
    throw new Error(
      'sdk-packages requires --list-file from sdkmanager --list --channel=0.',
    );
  }
  return {command, options};
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const {command, options} = parseArgs(process.argv.slice(2));
    let result;
    if (command === 'metadata') result = readMetadata(options.root);
    else if (command === 'sdk-packages') {
      result = resolveSdkPackages(
        read(options.listFile),
        readMetadata(options.root),
      );
    } else result = verifyApk(options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
