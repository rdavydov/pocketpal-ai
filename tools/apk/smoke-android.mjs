#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const packageName = 'io.github.rdavydov.pocketpalai';
const activityName = 'com.pocketpal.MainActivity';
const sleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));
const decodeXml = value =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

export function parseUiNodes(xml) {
  return [...xml.matchAll(/<node\b([^>]*?)\/?\s*>/g)].map(match =>
    Object.fromEntries(
      [...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(attribute => [
        attribute[1],
        decodeXml(attribute[2]),
      ]),
    ),
  );
}

export function boundsCenter(bounds) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(bounds ?? '');
  if (!match) throw new Error('Malformed UI element bounds');
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (right <= left || bottom <= top || right > 20000 || bottom > 20000)
    throw new Error('Empty or unreasonable UI element bounds');
  return [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)];
}

export function packageVersion(dump) {
  const code = /\bversionCode=(\d+)\b/.exec(dump)?.[1];
  const version = /\bversionName=([^\s]+)/.exec(dump)?.[1];
  if (!code || !version)
    throw new Error('Cannot read the installed package version');
  return {versionName: version, versionCode: code};
}

export function hasFatalCrash(log) {
  return /\bFATAL EXCEPTION\b|\bFatal signal \d+\b|\bAndroidRuntime\b[^\n]*\bFATAL\b/.test(
    log,
  );
}

export function pngDimensions(buffer) {
  if (
    buffer.length < 45 ||
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.subarray(12, 16).toString('ascii') !== 'IHDR' ||
    buffer.subarray(-8, -4).toString('ascii') !== 'IEND'
  )
    throw new Error('Native screenshot is not a complete PNG');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width > 20000 || height > 20000)
    throw new Error('Invalid native screenshot dimensions');
  return {width, height};
}

export function selectDevice(output, requested) {
  const devices = output
    .split(/\r?\n/)
    .map(line => /^(\S+)\s+device(?:\s|$)/.exec(line))
    .filter(Boolean)
    .map(match => match[1]);
  if (requested) {
    if (!devices.includes(requested))
      throw new Error(`Requested Android device ${requested} is not ready`);
    return requested;
  }
  if (devices.length !== 1)
    throw new Error(
      `Smoke test needs exactly one ready Android device; found ${devices.length}. Use --serial to select it.`,
    );
  return devices[0];
}

export function parseArguments(args) {
  const options = {};
  const names = new Set(['apk', 'report-dir', 'build-info', 'serial', 'adb']);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '');
    const value = args[index + 1];
    if (
      !args[index]?.startsWith('--') ||
      !names.has(name) ||
      !value ||
      value.startsWith('--') ||
      options[name]
    ) {
      throw new Error(
        'Usage: smoke-android.mjs --apk APK --report-dir DIR [--build-info JSON] [--serial DEVICE] [--adb PATH]',
      );
    }
    options[name] = value;
  }
  if (!options.apk || !options['report-dir'])
    throw new Error('--apk and --report-dir are required');
  return options;
}

export async function smokeAndroid(
  options,
  {run = spawnSync, delay = sleep} = {},
) {
  const apk = path.resolve(options.apk);
  const reports = path.resolve(options['report-dir']);
  const buildInfoFile = path.resolve(
    options['build-info'] ?? path.join(path.dirname(apk), 'build-info.json'),
  );
  mkdirSync(reports, {recursive: true});
  if (!existsSync(apk) || !existsSync(buildInfoFile))
    throw new Error('APK and its verified build-info.json are required');
  const info = JSON.parse(
    readFileSync(buildInfoFile, 'utf8').replace(/^\uFEFF/, ''),
  );
  if (
    info.package !== packageName ||
    !/^[0-9a-f]{40}$/.test(info.sourceCommit ?? '') ||
    !info.versionName ||
    !info.versionCode
  ) {
    throw new Error('Unexpected or incomplete Community build metadata');
  }
  const adbPath =
    options.adb ?? (process.platform === 'win32' ? 'adb.exe' : 'adb');
  let serial;
  let appPid;
  let lastXml = '';
  const check = {
    sourceCommit: info.sourceCommit,
    package: packageName,
    versionName: info.versionName,
    versionCode: String(info.versionCode),
    passed: false,
    install: false,
    launch: false,
    ui: false,
    microphoneTested: false,
    modelInferenceTested: false,
    hardwareAccelerationTested: false,
  };
  function adb(
    args,
    {binary = false, allowFailure = false, timeout = 60000} = {},
  ) {
    const result = run(adbPath, [...(serial ? ['-s', serial] : []), ...args], {
      encoding: binary ? null : 'utf8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!allowFailure && (result.error || result.status !== 0)) {
      throw new Error(
        `adb ${args.slice(0, 3).join(' ')} failed: ${result.error?.message ?? String(result.stderr).trim()}`,
      );
    }
    return binary
      ? (result.stdout ?? Buffer.alloc(0))
      : String(result.stdout ?? '').trim();
  }
  function dumpUi() {
    const filename = '/sdcard/pocketpal-community-smoke.xml';
    adb(['shell', 'uiautomator', 'dump', filename], {
      allowFailure: true,
      timeout: 20000,
    });
    const xml = adb(['shell', 'cat', filename], {allowFailure: true});
    if (!xml.includes('<hierarchy')) return [];
    lastXml = xml;
    return parseUiNodes(xml).filter(node => node.package === packageName);
  }
  function collectLog() {
    return appPid
      ? adb(['logcat', '-d', `--pid=${appPid}`, '-v', 'threadtime'], {
          allowFailure: true,
        })
      : '';
  }
  try {
    serial = selectDevice(adb(['devices']), options.serial);
    const api = Number(adb(['shell', 'getprop', 'ro.build.version.sdk']));
    const abi = adb(['shell', 'getprop', 'ro.product.cpu.abi']);
    check.device = {serial, api, abi};
    if (api !== 35 || abi !== 'x86_64')
      throw new Error(
        `Expected the CI API35 x86_64 emulator, received API${api} ${abi}`,
      );
    // No global logcat clear or app-data reset: scope all diagnostics to this APK.
    adb(['install', '--no-incremental', '-r', apk], {timeout: 180000});
    const installed = packageVersion(
      adb(['shell', 'dumpsys', 'package', packageName]),
    );
    if (
      installed.versionName !== info.versionName ||
      installed.versionCode !== String(info.versionCode)
    )
      throw new Error('Installed version differs from the verified APK');
    check.install = true;
    const launch = adb([
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      `${packageName}/${activityName}`,
    ]);
    writeFileSync(path.join(reports, 'launch.txt'), launch + '\n');
    if (/\bError\b|Exception/.test(launch) || !/Status:\s*ok/.test(launch))
      throw new Error('Android did not confirm successful Activity startup');
    check.launch = true;
    const deadline = Date.now() + 120000;
    let skipped = false;
    while (Date.now() < deadline) {
      appPid = adb(['shell', 'pidof', packageName], {allowFailure: true}).split(
        /\s+/,
      )[0];
      const nodes = dumpUi();
      if (nodes.some(node => node['resource-id'] === 'chat-input')) {
        check.ui = true;
        break;
      }
      const skip = nodes.find(
        node =>
          node['resource-id'] === 'onboarding-skip' && node.enabled !== 'false',
      );
      if (skip && !skipped) {
        adb([
          'shell',
          'input',
          'tap',
          ...boundsCenter(skip.bounds).map(String),
        ]);
        skipped = true;
      }
      if (appPid && hasFatalCrash(collectLog()))
        throw new Error(
          'Application crashed while loading the React Native UI',
        );
      await delay(1500);
    }
    if (!check.ui)
      throw new Error(
        'The standalone React Native chat UI did not become ready within 120 seconds',
      );
    await delay(10000);
    const currentPid = adb(['shell', 'pidof', packageName], {
      allowFailure: true,
    }).split(/\s+/)[0];
    if (!appPid || currentPid !== appPid)
      throw new Error(
        'Application exited or restarted after reaching the chat UI',
      );
    const activities = adb(['shell', 'dumpsys', 'activity', 'activities']);
    const resumed = activities
      .split(/\r?\n/)
      .filter(line =>
        /(?:mResumedActivity|topResumedActivity|ResumedActivity:)/.test(line),
      );
    if (!resumed.some(line => line.includes(`${packageName}/`)))
      throw new Error('Community is no longer the foreground Activity');
    dumpUi();
    if (
      !parseUiNodes(lastXml).some(
        node =>
          node.package === packageName && node['resource-id'] === 'chat-input',
      )
    )
      throw new Error('Chat UI disappeared after startup');
    const log = collectLog();
    if (hasFatalCrash(log))
      throw new Error('A fatal crash was recorded for the Community process');
    check.passed = true;
    check.crashMarkers = 0;
  } catch (error) {
    check.error = error.message;
    throw error;
  } finally {
    check.checkedAtUtc = new Date().toISOString();
    if (serial) {
      try {
        writeFileSync(path.join(reports, 'app.log'), collectLog() + '\n');
      } catch {}
      try {
        if (lastXml)
          writeFileSync(path.join(reports, 'ui.xml'), lastXml + '\n');
      } catch {}
      try {
        const screenshot = adb(['exec-out', 'screencap', '-p'], {
          binary: true,
          allowFailure: true,
        });
        check.screenshot = pngDimensions(screenshot);
        writeFileSync(path.join(reports, 'smoke.png'), screenshot);
      } catch (error) {
        check.passed = false;
        check.error ??= error.message;
      }
      try {
        adb(['shell', 'rm', '-f', '/sdcard/pocketpal-community-smoke.xml'], {
          allowFailure: true,
        });
      } catch {}
    }
    writeFileSync(
      path.join(reports, 'checks.json'),
      JSON.stringify(check, null, 2) + '\n',
    );
  }
  if (!check.passed) throw new Error(check.error ?? 'Smoke test did not pass');
  console.log(
    `Android smoke passed: ${packageName} ${info.versionName}, API35 x86_64.`,
  );
  return check;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await smokeAndroid(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
