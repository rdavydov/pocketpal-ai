#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ownRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const json = filename =>
  JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));

export function dummyGoogleServices(packageName) {
  return {
    project_info: {
      project_number: '000000000000',
      project_id: 'dummy-project-for-ci',
      storage_bucket: 'dummy-project-for-ci.appspot.com',
    },
    client: [
      {
        client_info: {
          mobilesdk_app_id: '1:000000000000:android:0000000000000000',
          android_client_info: {package_name: packageName},
        },
        api_key: [{current_key: 'dummy-api-key-for-ci-builds'}],
      },
    ],
  };
}

export function configForPackage(current, packageName) {
  const clients = current.client ?? [];
  if (
    clients.some(
      client =>
        client.client_info?.android_client_info?.package_name === packageName,
    )
  ) {
    return current;
  }
  if (
    current.project_info?.project_id !== 'dummy-project-for-ci' ||
    !clients.length
  ) {
    throw new Error(
      `google-services.json has no client for ${packageName}; refusing to rewrite a real Firebase configuration.`,
    );
  }
  return dummyGoogleServices(packageName);
}

export function requiredGrammarAssets(packageRoot, manifest) {
  if (!manifest.runtime || !Object.keys(manifest.grammars ?? {}).length) {
    throw new Error(
      'The enriched-markdown Android grammar manifest is incomplete.',
    );
  }
  const vendor = path.join(packageRoot, 'cpp/highlight/vendor');
  const required = [
    'tree-sitter/src/lib.c',
    'tree-sitter/include/tree_sitter/api.h',
    'tree-sitter/.stamp',
    'grammars/.stamp',
    'generated/generated_registry.cpp',
  ].map(relative => path.join(vendor, relative));
  for (const [name, grammar] of Object.entries(manifest.grammars)) {
    if (!/^[A-Za-z0-9._+-]+$/.test(name) || name === '.' || name === '..') {
      throw new Error(`Unexpected grammar name: ${name}`);
    }
    const directory = path.join(vendor, 'grammars', name);
    required.push(
      path.join(directory, 'parser.c'),
      path.join(directory, 'highlights.scm'),
    );
    if (grammar.scanner === true)
      required.push(path.join(directory, 'scanner.c'));
    for (const shared of grammar.sharedSrc ?? []) {
      if (typeof shared !== 'string' || !shared || shared.includes('\0')) {
        throw new Error(`Invalid shared grammar source for ${name}`);
      }
      const filename = path.posix.basename(shared.replaceAll('\\', '/'));
      if (filename === '.' || filename === '..')
        throw new Error(`Invalid shared grammar filename for ${name}`);
      required.push(path.join(directory, filename));
    }
  }
  return required;
}

function missingFiles(files) {
  return files.filter(
    filename =>
      !existsSync(filename) ||
      !statSync(filename).isFile() ||
      statSync(filename).size === 0,
  );
}

export function prepareCi(root, {checkOnly = false} = {}) {
  root = path.resolve(root);
  const metadataResult = spawnSync(
    process.execPath,
    [path.join(root, 'tools/apk/android-apk.mjs'), 'metadata', '--root', root],
    {encoding: 'utf8'},
  );
  if (metadataResult.error || metadataResult.status !== 0) {
    throw new Error(
      `Cannot read Android metadata: ${metadataResult.stderr || metadataResult.error?.message}`,
    );
  }
  const metadata = JSON.parse(metadataResult.stdout);
  const app = json(path.join(root, 'package.json'));
  const envFile = path.join(root, '.env');
  const googleFile = path.join(root, 'android/app/google-services.json');
  const google = existsSync(googleFile)
    ? configForPackage(json(googleFile), metadata.package)
    : dummyGoogleServices(metadata.package);
  if (!checkOnly) {
    if (!existsSync(envFile)) {
      writeFileSync(
        envFile,
        'PALSHUB_API_BASE_URL=https://palshub.ai\nAPP_URL=pocketpal://app\nENABLE_PALSHUB_INTEGRATION=true\nENABLE_AUTHENTICATION=true\nENABLE_OFFLINE_MODE=true\n',
      );
    }
    mkdirSync(path.dirname(googleFile), {recursive: true});
    writeFileSync(googleFile, JSON.stringify(google, null, 2) + '\n');
  }
  if (
    app.dependencies?.['react-native-enriched-markdown'] &&
    app['enriched-markdown']?.enableCodeHighlight !== false
  ) {
    const packageRoot = path.join(
      root,
      'node_modules/react-native-enriched-markdown',
    );
    const installer = path.join(packageRoot, 'vendor-grammars.mjs');
    const manifestFile = path.join(
      packageRoot,
      'cpp/highlight/grammar-versions.json',
    );
    if (!existsSync(installer) || !existsSync(manifestFile)) {
      throw new Error(
        'The locked enriched-markdown package is missing its Android grammar installer.',
      );
    }
    const required = requiredGrammarAssets(packageRoot, json(manifestFile));
    const missing = missingFiles(required);
    if (!checkOnly) {
      const args = [
        installer,
        '--from-npm',
        '--vendor-dir',
        path.join(packageRoot, 'cpp/highlight/vendor'),
        '--manifest',
        manifestFile,
      ];
      if (missing.length) args.push('--force');
      const result = spawnSync(process.execPath, args, {
        cwd: root,
        stdio: 'inherit',
        env: {...process.env, INIT_CWD: root},
      });
      if (result.error || result.status !== 0)
        throw new Error(
          `Android grammar preparation failed: ${result.error?.message ?? result.status}`,
        );
    }
    const after = missingFiles(required);
    if (after.length)
      throw new Error(
        `Missing/empty Android grammar assets: ${after.slice(0, 6).join(', ')}`,
      );
  }
  const nativeFiles = [
    '@react-native/gradle-plugin/gradle/libs.versions.toml',
    'llama.rn/vendor/OpenCL-Headers/CL/cl.h',
    'llama.rn/vendor/llama.cpp/ggml/src/ggml-hexagon/htp/v73/htp_iface_stub.c',
    'llama.rn/vendor/llama.cpp/ggml/src/ggml-hexagon/htp/v73/htp_iface.h',
    'llama.rn/bin/arm64-v8a/libOpenCL.so',
    ...['v73', 'v75', 'v79', 'v81', 'v85'].map(
      variant => `llama.rn/bin/arm64-v8a/libggml-htp-${variant}.so`,
    ),
  ].map(relative => path.join(root, 'node_modules', relative));
  const missingNative = missingFiles(nativeFiles);
  if (missingNative.length)
    throw new Error(
      `Locked native dependency payload is incomplete: ${missingNative.join(', ')}`,
    );
  console.log(
    `CI Android preparation passed for ${metadata.appName} ${metadata.versionName}.`,
  );
  return metadata;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    let root = ownRoot;
    let checkOnly = false;
    let rootSeen = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--check-only' && !checkOnly) checkOnly = true;
      else if (
        args[index] === '--root' &&
        !rootSeen &&
        args[index + 1] &&
        !args[index + 1].startsWith('--')
      ) {
        root = args[++index];
        rootSeen = true;
      } else {
        throw new Error('Usage: prepare-ci.mjs [--root ROOT] [--check-only]');
      }
    }
    prepareCi(root, {checkOnly});
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
