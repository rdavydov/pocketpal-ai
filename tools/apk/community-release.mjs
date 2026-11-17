#!/usr/bin/env node
/** Trusted controller: merge/build elsewhere; only this file receives APP_TOKEN. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const REPOSITORY = 'rdavydov/pocketpal-ai';
export const UPSTREAM = 'a-ghorbani/pocketpal-ai';
export const PACKAGE = 'io.github.rdavydov.pocketpalai';
export const APP_NAME = 'PocketPal AI Community';
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CANDIDATE_REF = 'refs/heads/community-candidate';
const OWNED_PREFIXES = ['.github/workflows/', 'tools/apk/'];
const OWNED_FILES = [
  'COMMUNITY.md',
  'build-apk.cmd',
  'android/app/debug.keystore',
  // The store release contract is different from this fork's APK workflow.
  'scripts/__tests__/release-plus-mode.test.js',
];
const GRADLE = 'android/app/build.gradle';
const STRINGS = 'android/app/src/main/res/values/strings.xml';

export function stableVersion(value, prefix = '') {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return null;
  const result = value.slice(prefix.length);
  return VERSION.test(result) ? result : null;
}

export function compareVersions(left, right) {
  if (!VERSION.test(left) || !VERSION.test(right))
    throw new Error('Expected stable X.Y.Z versions.');
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function noSecrets(extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (
      /^(APP_TOKEN|GITHUB_TOKEN|GH_TOKEN|COMMUNITY_APP_PRIVATE_KEY)$/.test(
        key,
      ) ||
      /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)
    )
      delete env[key];
  }
  return {...env, GIT_TERMINAL_PROMPT: '0', ...extra};
}

function redact(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets.filter(Boolean))
    result = result.split(secret).join('***');
  return result;
}

function git(root, args, {allowFailure = false, env = {}, secrets = []} = {}) {
  const result = spawnSync(
    'git',
    [
      '-c',
      `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      '-c',
      'user.name=PocketPal Community',
      '-c',
      'user.email=pocketpal-community[bot]@users.noreply.github.com',
      ...args,
    ],
    {
      cwd: root,
      env: noSecrets(env),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    },
  );
  if (result.error || (result.status !== 0 && !allowFailure)) {
    throw new Error(
      redact(
        `git ${args[0]} failed: ${result.error?.message || result.stderr || result.stdout}`,
        secrets,
      ),
    );
  }
  return {
    status: result.status,
    text: result.stdout?.trim() || '',
    raw: result.stdout || '',
    error: result.stderr || '',
  };
}

function requireSha(value) {
  if (!SHA.test(value || ''))
    throw new Error('Invalid source commit identifier.');
  return value;
}

function requireVersion(value) {
  if (!VERSION.test(value || ''))
    throw new Error('Expected a stable X.Y.Z version.');
  return value;
}

function field(source, expression, label) {
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1)
    throw new Error(`Cannot read one unambiguous ${label}.`);
  return matches[0][1];
}

function gradleId(source) {
  return field(
    source,
    /^\s*applicationId\s*(?:=\s*)?["']([^"']+)["']/gm,
    'applicationId',
  );
}

function stringName(source) {
  return field(
    source,
    /<string\s+name=["']app_name["']\s*>([^<]+)<\/string>/g,
    'app_name',
  );
}

function readSource(root, ref) {
  requireSha(ref);
  const get = name => git(root, ['show', `${ref}:${name}`]).raw;
  const gradle = get(GRADLE);
  const version = requireVersion(
    field(
      gradle,
      /^\s*versionName\s*(?:=\s*)?["']([^"']+)["']/gm,
      'versionName',
    ),
  );
  const versionCode = field(
    gradle,
    /^\s*versionCode\s*(?:=\s*)?(\d+)\s*$/gm,
    'versionCode',
  );
  if (
    version !== JSON.parse(get('package.json')).version ||
    version !== get('.version').trim()
  ) {
    throw new Error(
      'Source versions differ between .version, package.json and Android.',
    );
  }
  return {
    version,
    versionCode,
    package: gradleId(gradle),
    appName: stringName(get(STRINGS)),
  };
}

function assertCommunity(source) {
  if (source.package !== PACKAGE || source.appName !== APP_NAME)
    throw new Error('Candidate lost the Community identity.');
}

function authEnvironment(token) {
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
    },
    secrets: [token, encoded],
  };
}

export class GitHub {
  constructor(token = '', fetchImpl = fetch) {
    this.token = token;
    this.fetch = fetchImpl;
  }
  async request(method, endpoint, body, {allow404 = false, upload} = {}) {
    const url = upload
      ? `https://uploads.github.com/repos/${REPOSITORY}/releases/${upload.id}/assets?name=${encodeURIComponent(upload.name)}&label=${encodeURIComponent(upload.label)}`
      : `https://api.github.com/${endpoint}`;
    const headers = {
      'User-Agent': 'PocketPal-Community-CI',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let payload = body === undefined ? undefined : JSON.stringify(body);
    if (upload) {
      headers['Content-Type'] = upload.type;
      headers['Content-Length'] = String(upload.size);
      payload = createReadStream(upload.file);
    }
    const response = await this.fetch(url, {
      method,
      headers,
      body: payload,
      ...(upload ? {duplex: 'half'} : {}),
      signal: AbortSignal.timeout(upload ? 20 * 60 * 1000 : 60 * 1000),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const message =
        (await response.json().catch(() => ({}))).message ||
        response.statusText;
      throw new Error(
        redact(
          `GitHub ${method} ${endpoint}: HTTP ${response.status} ${message}`,
          [this.token],
        ),
      );
    }
    if (response.status === 204) return null;
    return response.json();
  }
  async releases(repo = REPOSITORY) {
    const releases = [];
    for (let page = 1; ; page++) {
      const batch = await this.request(
        'GET',
        `repos/${repo}/releases?per_page=100&page=${page}`,
      );
      releases.push(...batch);
      if (batch.length < 100) return releases;
    }
  }
}

function publishedCommunity(releases) {
  return releases
    .filter(
      item =>
        !item.draft &&
        !item.prerelease &&
        stableVersion(item.tag_name, 'community-v'),
    )
    .sort((a, b) =>
      compareVersions(
        stableVersion(b.tag_name, 'community-v'),
        stableVersion(a.tag_name, 'community-v'),
      ),
    );
}

async function emitCandidate(output, state, root) {
  await fs.mkdir(output, {recursive: true});
  if (state.mode !== 'no-update') {
    git(root, ['update-ref', CANDIDATE_REF, requireSha(state.candidateSha)]);
    git(root, [
      'bundle',
      'create',
      path.resolve(output, 'candidate.bundle'),
      CANDIDATE_REF,
    ]);
  }
  await fs.writeFile(
    path.join(output, 'candidate.json'),
    JSON.stringify(state, null, 2) + '\n',
  );
  if (process.env.GITHUB_OUTPUT) {
    const values = {
      mode: state.mode,
      version: state.version || '',
      candidate_sha: state.candidateSha || '',
      base_sha: state.baseSha || '',
      tag: state.tag || '',
    };
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
  return state;
}

function fetchRef(root, remote, ref) {
  git(root, ['fetch', '--no-tags', '--no-recurse-submodules', remote, ref]);
  return requireSha(git(root, ['rev-parse', 'FETCH_HEAD^{commit}']).text);
}

function owned(name) {
  return (
    OWNED_FILES.includes(name) ||
    OWNED_PREFIXES.some(prefix => name.startsWith(prefix))
  );
}

function restoreOwned(root, baseSha) {
  const source = new Set(
    git(root, ['ls-tree', '-r', '-z', '--name-only', baseSha])
      .raw.split('\0')
      .filter(Boolean),
  );
  const indexed = git(root, ['ls-files', '-z']).raw.split('\0').filter(Boolean);
  for (const name of new Set([...source, ...indexed].filter(owned))) {
    if (source.has(name))
      git(root, [
        'restore',
        `--source=${baseSha}`,
        '--staged',
        '--worktree',
        '--',
        name,
      ]);
    else git(root, ['rm', '-f', '--ignore-unmatch', '--', name]);
  }
}

/** Remove only the known fork identity before a normal three-way merge. */
export function normalizeIdentity(ours, base, name) {
  if (name === GRADLE) {
    if (gradleId(ours) !== PACKAGE)
      throw new Error('Unexpected fork applicationId.');
    const originalId = gradleId(base);
    return ours
      .replace(
        /(^\s*applicationId\s*(?:=\s*)?["'])[^"']+(["'])/m,
        `$1${originalId}$2`,
      )
      .replace(
        `// applicationId stays as defaultConfig: ${PACKAGE}`,
        `// applicationId stays as defaultConfig: ${originalId}`,
      )
      .replace(
        `// Effective applicationId: ${PACKAGE}.e2e`,
        `// Effective applicationId: ${originalId}.e2e`,
      );
  }
  if (name === STRINGS) {
    if (stringName(ours) !== APP_NAME)
      throw new Error('Unexpected fork app_name.');
    return ours.replace(
      /(<string\s+name=["']app_name["']\s*>)[^<]+(<\/string>)/,
      `$1${stringName(base)}$2`,
    );
  }
  throw new Error(`No automatic conflict policy for ${name}.`);
}

export function applyIdentity(source, name) {
  if (name === GRADLE) {
    const original = gradleId(source);
    return source
      .replace(
        /(^\s*applicationId\s*(?:=\s*)?["'])[^"']+(["'])/m,
        `$1${PACKAGE}$2`,
      )
      .replace(
        `// applicationId stays as defaultConfig: ${original}`,
        `// applicationId stays as defaultConfig: ${PACKAGE}`,
      )
      .replace(
        `// Effective applicationId: ${original}.e2e`,
        `// Effective applicationId: ${PACKAGE}.e2e`,
      );
  }
  stringName(source);
  return source.replace(
    /(<string\s+name=["']app_name["']\s*>)[^<]+(<\/string>)/,
    `$1${APP_NAME}$2`,
  );
}

async function resolveIdentityConflict(root, name) {
  const base = git(root, ['show', `:1:${name}`]).raw;
  const ours = normalizeIdentity(
    git(root, ['show', `:2:${name}`]).raw,
    base,
    name,
  );
  const theirs = git(root, ['show', `:3:${name}`]).raw;
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pocketpal-merge-'),
  );
  try {
    const files = ['ours', 'base', 'theirs'].map(value =>
      path.join(temporary, value),
    );
    await Promise.all(
      [ours, base, theirs].map((value, index) =>
        fs.writeFile(files[index], value),
      ),
    );
    const result = git(root, ['merge-file', '--stdout', ...files], {
      allowFailure: true,
    });
    if (result.status !== 0)
      throw new Error(
        `Upstream conflicts with changes beyond Community branding in ${name}.`,
      );
    await fs.writeFile(path.join(root, name), applyIdentity(result.raw, name));
    git(root, ['add', '--', name]);
  } finally {
    if (
      path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) ||
      !path.basename(temporary).startsWith('pocketpal-merge-')
    )
      throw new Error('Unexpected merge scratch path.');
    await fs.rm(temporary, {recursive: true, force: true});
  }
}

export async function mergeCandidate(
  root,
  baseSha,
  upstreamSha,
  upstreamTag,
  version,
) {
  requireSha(baseSha);
  requireSha(upstreamSha);
  requireVersion(version);
  const result = git(root, ['merge', '--no-commit', '--no-ff', upstreamSha], {
    allowFailure: true,
  });
  if (
    result.status !== 0 &&
    !git(root, ['diff', '--name-only', '--diff-filter=U']).text
  )
    throw new Error(`Cannot merge upstream: ${result.error}`);
  restoreOwned(root, baseSha);
  const conflicts = git(root, ['diff', '--name-only', '--diff-filter=U', '-z'])
    .raw.split('\0')
    .filter(Boolean);
  for (const name of conflicts) {
    if (name !== GRADLE && name !== STRINGS)
      throw new Error(
        `Automatic update stopped at an unknown merge conflict: ${name}.`,
      );
    await resolveIdentityConflict(root, name);
  }
  for (const name of [GRADLE, STRINGS]) {
    const source = await fs.readFile(path.join(root, name), 'utf8');
    await fs.writeFile(path.join(root, name), applyIdentity(source, name));
    git(root, ['add', '--', name]);
  }
  const hasMerge =
    git(root, ['rev-parse', '--verify', 'MERGE_HEAD'], {allowFailure: true})
      .status === 0;
  if (hasMerge) {
    const message = `chore(community): update PocketPal to ${version} [skip ci]\n\nUpstream-Release: ${upstreamTag}\nUpstream-Commit: ${upstreamSha}`;
    git(root, [
      '-c',
      'user.name=PocketPal Community',
      '-c',
      'user.email=pocketpal-community[bot]@users.noreply.github.com',
      'commit',
      '--no-verify',
      '-m',
      message,
    ]);
  }
  const candidateSha = requireSha(git(root, ['rev-parse', 'HEAD']).text);
  const source = readSource(root, candidateSha);
  assertCommunity(source);
  if (source.version !== version)
    throw new Error(
      'Merged source version differs from the stable upstream release.',
    );
  const keyBefore = git(root, [
    'rev-parse',
    `${baseSha}:android/app/debug.keystore`,
  ]).text;
  if (
    keyBefore !==
    git(root, ['rev-parse', `${candidateSha}:android/app/debug.keystore`]).text
  )
    throw new Error('Candidate changed the published signing key.');
  if (git(root, ['status', '--porcelain', '--untracked-files=no']).text)
    throw new Error('Candidate contains uncommitted tracked changes.');
  return {...source, candidateSha};
}

export async function prepareRelease({
  root,
  output,
  github = new GitHub(process.env.GITHUB_TOKEN),
  originUrl = `https://github.com/${REPOSITORY}.git`,
  upstreamUrl = `https://github.com/${UPSTREAM}.git`,
}) {
  if (process.env.APP_TOKEN)
    throw new Error('APP_TOKEN must not be exposed to candidate preparation.');
  root = path.resolve(root);
  output = path.resolve(output);
  if (git(root, ['status', '--porcelain', '--untracked-files=no']).text)
    throw new Error('Candidate preparation requires a clean checkout.');
  const baseSha = requireSha(git(root, ['rev-parse', 'HEAD']).text);
  const current = readSource(root, baseSha);
  assertCommunity(current);
  const releases = await github.releases();
  const published = publishedCommunity(releases);
  const highest = published[0]
    ? stableVersion(published[0].tag_name, 'community-v')
    : null;
  const refs = await github.request(
    'GET',
    `repos/${REPOSITORY}/git/matching-refs/tags/community-v`,
  );
  const pending = new Map();
  for (const ref of refs || []) {
    const tag = ref.ref?.replace(/^refs\/tags\//, '');
    const version = stableVersion(tag, 'community-v');
    if (
      version &&
      !published.some(item => item.tag_name === tag) &&
      !releases.some(item => item.tag_name === tag && item.prerelease)
    )
      pending.set(tag, {tag, version});
  }
  for (const release of releases.filter(
    item =>
      item.draft &&
      !item.prerelease &&
      stableVersion(item.tag_name, 'community-v'),
  )) {
    pending.set(release.tag_name, {
      tag: release.tag_name,
      version: stableVersion(release.tag_name, 'community-v'),
      release,
    });
  }
  if (pending.size) {
    const item = [...pending.values()].sort((a, b) =>
      compareVersions(a.version, b.version),
    )[0];
    if (highest && compareVersions(item.version, highest) <= 0)
      throw new Error(
        'An older unpublished Community release requires cleanup before automatic updates can continue.',
      );
    const candidateSha = fetchRef(root, originUrl, `refs/tags/${item.tag}`);
    if (
      git(root, ['merge-base', '--is-ancestor', candidateSha, baseSha], {
        allowFailure: true,
      }).status !== 0
    )
      throw new Error(
        'Pending Community tag is not present in main; refusing to publish an unrelated tag.',
      );
    const source = readSource(root, candidateSha);
    assertCommunity(source);
    if (source.version !== item.version)
      throw new Error('Pending release tag and source version disagree.');
    const message = git(root, ['show', '-s', '--format=%B', candidateSha]).raw;
    const upstreamTag = field(
      message,
      /^Upstream-Release: (v?\d+\.\d+\.\d+)$/gm,
      'upstream release trailer',
    );
    const upstreamSha = requireSha(
      field(
        message,
        /^Upstream-Commit: ([a-f0-9]{40})$/gm,
        'upstream commit trailer',
      ),
    );
    if (
      git(root, ['merge-base', '--is-ancestor', upstreamSha, candidateSha], {
        allowFailure: true,
      }).status !== 0
    )
      throw new Error(
        'Pending tag does not contain its declared upstream source.',
      );
    const upstream = (await github.request(
      'GET',
      `repos/${UPSTREAM}/releases/tags/${encodeURIComponent(upstreamTag)}`,
      undefined,
      {allow404: true},
    )) || {
      tag_name: upstreamTag,
      body: '',
      html_url: `https://github.com/${UPSTREAM}/releases/tag/${upstreamTag}`,
    };
    return emitCandidate(
      output,
      {
        schemaVersion: 1,
        repository: REPOSITORY,
        mode: 'recover',
        baseSha,
        candidateSha,
        version: source.version,
        versionCode: source.versionCode,
        tag: item.tag,
        upstreamSha,
        upstreamTag,
        upstreamUrl: upstream.html_url,
        upstreamBody: upstream.body || '',
      },
      root,
    );
  }
  const latest = await github.request(
    'GET',
    `repos/${UPSTREAM}/releases/latest`,
    undefined,
    {allow404: true},
  );
  const version =
    latest &&
    (stableVersion(latest.tag_name, 'v') || stableVersion(latest.tag_name));
  if (!version || latest.draft || latest.prerelease)
    throw new Error('Upstream has no supported stable X.Y.Z release.');
  if (
    (highest && compareVersions(version, highest) <= 0) ||
    compareVersions(version, current.version) < 0
  ) {
    return emitCandidate(
      output,
      {
        schemaVersion: 1,
        repository: REPOSITORY,
        mode: 'no-update',
        baseSha,
        reason: 'No newer stable upstream version.',
        version: current.version,
      },
      root,
    );
  }
  const upstreamSha = fetchRef(
    root,
    upstreamUrl,
    `refs/tags/${latest.tag_name}`,
  );
  let previousCode = null;
  if (published[0])
    previousCode = readSource(
      root,
      fetchRef(root, originUrl, `refs/tags/${published[0].tag_name}`),
    ).versionCode;
  const candidate = await mergeCandidate(
    root,
    baseSha,
    upstreamSha,
    latest.tag_name,
    version,
  );
  if (previousCode && BigInt(candidate.versionCode) <= BigInt(previousCode))
    throw new Error(
      'Android versionCode must increase over the last published APK.',
    );
  return emitCandidate(
    output,
    {
      schemaVersion: 1,
      repository: REPOSITORY,
      mode: 'candidate',
      baseSha,
      candidateSha: candidate.candidateSha,
      version,
      versionCode: candidate.versionCode,
      tag: `community-v${version}`,
      upstreamSha,
      upstreamTag: latest.tag_name,
      upstreamUrl: latest.html_url,
      upstreamBody: latest.body || '',
    },
    root,
  );
}

function validateState(state) {
  if (
    state.schemaVersion !== 1 ||
    state.repository !== REPOSITORY ||
    !['candidate', 'recover'].includes(state.mode)
  )
    throw new Error('Unsupported candidate metadata.');
  requireSha(state.baseSha);
  requireSha(state.candidateSha);
  requireSha(state.upstreamSha);
  requireVersion(state.version);
  if (
    state.tag !== `community-v${state.version}` ||
    !/^\d+$/.test(state.versionCode) ||
    (stableVersion(state.upstreamTag, 'v') ||
      stableVersion(state.upstreamTag)) !== state.version
  )
    throw new Error('Candidate version and tag metadata disagree.');
  if (
    state.upstreamUrl !==
    `https://github.com/${UPSTREAM}/releases/tag/${state.upstreamTag}`
  )
    throw new Error('Unexpected upstream release URL.');
  return state;
}

async function importCandidate(root, input) {
  const state = validateState(
    JSON.parse(await fs.readFile(path.join(input, 'candidate.json'), 'utf8')),
  );
  const bundle = path.resolve(input, 'candidate.bundle');
  git(root, ['bundle', 'verify', bundle]);
  const heads = git(root, ['bundle', 'list-heads', bundle]).text;
  if (heads !== `${state.candidateSha} ${CANDIDATE_REF}`)
    throw new Error('Candidate bundle ref differs from metadata.');
  git(root, [
    'fetch',
    '--no-tags',
    '--no-recurse-submodules',
    bundle,
    `${CANDIDATE_REF}:refs/remotes/community/candidate`,
  ]);
  const source = readSource(root, state.candidateSha);
  assertCommunity(source);
  if (
    source.version !== state.version ||
    source.versionCode !== state.versionCode
  )
    throw new Error('Bundled source and candidate metadata disagree.');
  if (
    git(
      root,
      ['merge-base', '--is-ancestor', state.upstreamSha, state.candidateSha],
      {allowFailure: true},
    ).status !== 0 ||
    (git(
      root,
      ['merge-base', '--is-ancestor', state.baseSha, state.candidateSha],
      {allowFailure: true},
    ).status !== 0 &&
      state.mode !== 'recover')
  )
    throw new Error('Candidate ancestry differs from the prepared update.');
  return state;
}

export async function restoreCandidate({root, input}) {
  if (process.env.APP_TOKEN)
    throw new Error('APP_TOKEN must not be exposed to candidate checkout.');
  const state = await importCandidate(path.resolve(root), path.resolve(input));
  git(root, ['checkout', '--detach', state.candidateSha]);
  return state;
}

export async function validateArtifactSet(state, artifacts, smoke) {
  const info = JSON.parse(
    await fs.readFile(path.join(artifacts, 'build-info.json'), 'utf8'),
  );
  const runtime = JSON.parse(
    await fs.readFile(path.join(smoke, 'checks.json'), 'utf8'),
  );
  if (
    info.sourceCommit !== state.candidateSha ||
    info.versionName !== state.version ||
    String(info.versionCode) !== state.versionCode ||
    info.package !== PACKAGE ||
    info.appName !== APP_NAME
  )
    throw new Error(
      'APK metadata does not describe the prepared Community candidate.',
    );
  if (
    !Array.isArray(info.trackedChanges) ||
    info.trackedChanges.length ||
    info.minSdk !== 24 ||
    info.debuggable !== false ||
    info.plusGate !== 'off' ||
    info.signature !== 'verified for API 24+' ||
    info.signerMatchesDebugKeystore !== true ||
    info.nativePayload !== 'passed' ||
    info.zipAlignment16kb !== 'passed' ||
    info.elfLayout16kb !== 'passed' ||
    [...info.abis].sort().join(',') !== 'arm64-v8a,x86_64'
  )
    throw new Error('APK verification did not pass all release requirements.');
  if (
    runtime.passed !== true ||
    runtime.install !== true ||
    runtime.launch !== true ||
    runtime.ui !== true ||
    runtime.sourceCommit !== state.candidateSha ||
    runtime.package !== PACKAGE ||
    runtime.versionName !== state.version ||
    String(runtime.versionCode) !== state.versionCode ||
    runtime.device?.api !== 35 ||
    runtime.device?.abi !== 'x86_64'
  )
    throw new Error(
      'The exact release APK did not pass the emulator smoke test.',
    );
  const apk = path.join(
    artifacts,
    `pocketpal-ai-community-${state.version}-android7.apk`,
  );
  if ((await fs.stat(apk)).size !== info.bytes || info.bytes <= 0)
    throw new Error('Ready APK size differs from the verified build report.');
  const image = path.join(smoke, 'smoke.png');
  const handle = await fs.open(image);
  const header = Buffer.alloc(24);
  try {
    await handle.read(header, 0, 24, 0);
  } finally {
    await handle.close();
  }
  if (
    !header
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    header.toString('ascii', 12, 16) !== 'IHDR' ||
    header.readUInt32BE(16) < 1 ||
    header.readUInt32BE(20) < 1
  )
    throw new Error('Missing native PNG screenshot from the smoke test.');
  return {info, runtime, apk, image};
}

export function releaseNotes(state, info, runtime) {
  const base = `https://github.com/${REPOSITORY}/releases/download/${state.tag}`;
  const upstreamBody = String(state.upstreamBody || '').slice(0, 10000);
  return `# PocketPal AI Community ${state.version}\n\nНеофициальный форк [PocketPal AI](https://github.com/${UPSTREAM}) — Roman Davydov (rdavydov). Лицензия MIT, авторство оригинала сохранено.\n\n**[Скачать APK](${base}/pocketpal-ai-community-${state.version}-android7.apk)** — ${info.bytes} байт.\n\n## Изменения\n\nОбновлена основа до [PocketPal ${state.version}](${state.upstreamUrl}). Сохранены имя **${APP_NAME}**, отдельный пакет \`${PACKAGE}\`, Windows-сборка одной командой и автоматическая сборка на GitHub. Локальные Plus-функции включены штатной source-build конфигурацией \`PLUS_STORE_GATE=false\`; платные серверные материалы PalsHub не разблокируются.\n\n${upstreamBody ? `<details>\n<summary>Изменения оригинального проекта</summary>\n\n${upstreamBody}\n\n</details>\n\n` : ''}## Установка и подпись\n\nAndroid 7.0/API24+, только 64-битные arm64-v8a и x86_64. Один самостоятельный release APK, Metro не нужен. Модели LLM и речи не включены; загрузите или импортируйте их после установки. Форк устанавливается рядом с оригиналом; автоматического переноса данных между пакетами нет.\n\n**Подпись тестовая:** сохранён публичный \`android/app/debug.keystore\`, alias \`androiddebugkey\`, CN=Android Debug, RSA 2048. Сертификат совпадает с предыдущими Community APK; для обновления должны совпадать пакет и сертификат.\n\n## Проверки\n\nПройдены lint, typecheck, Jest, проверки версии/имени/пакета, сертификата, native payload, Plus и ZIP/ELF 16 KB. Этот же APK установлен и запущен на эмуляторе Android ${runtime.device.api === 35 ? '15/API35' : `API${runtime.device.api}`} x86_64; подтверждена загрузка интерфейса чата. Полный разговор через микрофон, локальная генерация LLM, физический Android 7 и GPU/NPU в этом CI-запуске не проверялись.\n\n[Точные исходники](https://github.com/${REPOSITORY}/tree/${state.candidateSha}) · [Windows README](https://github.com/${REPOSITORY}/blob/${state.candidateSha}/tools/apk/README-RU.md).\n\n<details>\n<summary>Скриншот запуска этой сборки</summary>\n\n![PocketPal AI Community](${base}/smoke.png)\n\n</details>\n\n<!-- pocketpal-community-source:${state.candidateSha} -->\n`;
}

async function tagCommit(github, tag) {
  let ref = await github.request(
    'GET',
    `repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
    undefined,
    {allow404: true},
  );
  if (!ref) return null;
  let object = ref.object;
  for (let index = 0; object.type === 'tag' && index < 5; index++)
    object = (
      await github.request('GET', `repos/${REPOSITORY}/git/tags/${object.sha}`)
    ).object;
  if (object.type !== 'commit')
    throw new Error('Release tag does not resolve to a commit.');
  return requireSha(object.sha);
}

async function releaseForTag(github, tag) {
  // The by-tag endpoint documents published releases only. Authenticated listing
  // is needed to find an unfinished draft and resume it instead of creating one.
  const matching = (await github.releases()).filter(
    release => release.tag_name === tag,
  );
  if (matching.length > 1)
    throw new Error(
      `More than one GitHub release uses ${tag}; refusing an ambiguous release.`,
    );
  return matching[0] || null;
}

export async function publishRelease({
  root,
  candidate,
  artifacts,
  smoke,
  appToken = process.env.APP_TOKEN,
  github = new GitHub(appToken),
  remoteUrl = `https://github.com/${REPOSITORY}.git`,
}) {
  if (!appToken)
    throw new Error('APP_TOKEN is required only in the final publisher job.');
  root = path.resolve(root);
  const state = await importCandidate(root, path.resolve(candidate));
  if (
    git(root, ['rev-parse', 'HEAD']).text !== state.baseSha ||
    git(root, ['status', '--porcelain', '--untracked-files=no']).text
  )
    throw new Error(
      'Publisher must run from the unchanged trusted controller checkout.',
    );
  const verified = await validateArtifactSet(
    state,
    path.resolve(artifacts),
    path.resolve(smoke),
  );
  let existing = await releaseForTag(github, state.tag);
  const oldTag = await tagCommit(github, state.tag);
  if (oldTag && oldTag !== state.candidateSha)
    throw new Error(
      'Existing Community tag points to a different source commit.',
    );
  if (existing && !existing.draft) {
    if (existing.prerelease || !oldTag)
      throw new Error(
        'Existing published release does not match a stable prepared tag.',
      );
    return {
      status: 'already-published',
      url: existing.html_url,
      tag: state.tag,
    };
  }
  const mainRef = await github.request(
    'GET',
    `repos/${REPOSITORY}/git/ref/heads/main`,
  );
  const mainSha = requireSha(mainRef.object.sha);
  if (
    state.mode === 'candidate' &&
    mainSha !== state.baseSha &&
    mainSha !== state.candidateSha
  )
    throw new Error(
      'main changed while the candidate was building; prepare and test a new candidate.',
    );
  if (state.mode === 'recover' && mainSha !== state.baseSha)
    throw new Error(
      'main changed while recovering the pending release; retry from current main.',
    );
  if (!oldTag) {
    git(root, ['update-ref', `refs/tags/${state.tag}`, state.candidateSha]);
    const mainSpec =
      mainSha === state.candidateSha
        ? []
        : [`${state.candidateSha}:refs/heads/main`];
    git(
      root,
      [
        'push',
        '--atomic',
        remoteUrl,
        ...mainSpec,
        `refs/tags/${state.tag}:refs/tags/${state.tag}`,
      ],
      authEnvironment(appToken),
    );
  } else if (
    state.mode === 'candidate' &&
    mainSha === state.baseSha &&
    mainSha !== state.candidateSha
  ) {
    // A tag created manually before promotion is not permission to replace main.
    throw new Error(
      'Community tag exists before main promotion; refusing an ambiguous partial release.',
    );
  }
  const notes = releaseNotes(state, verified.info, verified.runtime);
  const title = `PocketPal AI Community ${state.version}`;
  if (!existing)
    existing = await github.request('POST', `repos/${REPOSITORY}/releases`, {
      tag_name: state.tag,
      target_commitish: state.candidateSha,
      name: title,
      body: notes,
      draft: true,
      prerelease: false,
    });
  else {
    if (
      existing.prerelease ||
      !String(existing.body || '').includes(
        `<!-- pocketpal-community-source:${state.candidateSha} -->`,
      )
    )
      throw new Error(
        'Pending draft is not owned by this prepared automatic release.',
      );
    existing = await github.request(
      'PATCH',
      `repos/${REPOSITORY}/releases/${existing.id}`,
      {name: title, body: notes},
    );
  }
  const files = [
    {
      file: verified.apk,
      name: path.basename(verified.apk),
      type: 'application/vnd.android.package-archive',
    },
    {
      file: path.join(artifacts, 'build-info.json'),
      name: 'build-info.json',
      type: 'application/json',
    },
    {
      file: path.join(smoke, 'checks.json'),
      name: 'runtime-checks.json',
      type: 'application/json',
    },
    {file: verified.image, name: 'smoke.png', type: 'image/png'},
  ];
  const label = `Community ${state.version}; source ${state.candidateSha}`;
  for (const file of files) {
    existing = await github.request(
      'GET',
      `repos/${REPOSITORY}/releases/${existing.id}`,
    );
    if (!existing.draft)
      throw new Error(
        'Draft was published while assets were uploading; no published asset will be changed.',
      );
    const size = (await fs.stat(file.file)).size;
    let asset = existing.assets?.find(item => item.name === file.name);
    if (
      asset &&
      (asset.state !== 'uploaded' ||
        asset.size !== size ||
        asset.label !== label)
    ) {
      // Replacing an incomplete/different build is allowed only while unpublished.
      await github.request(
        'DELETE',
        `repos/${REPOSITORY}/releases/assets/${asset.id}`,
      );
      asset = null;
    }
    if (!asset)
      asset = await github.request('POST', '', undefined, {
        upload: {...file, size, id: existing.id, label},
      });
    if (
      asset.state !== 'uploaded' ||
      asset.size !== size ||
      asset.name !== file.name
    )
      throw new Error(`Release upload failed for ${file.name}.`);
  }
  existing = await github.request(
    'GET',
    `repos/${REPOSITORY}/releases/${existing.id}`,
  );
  if (!existing.draft)
    throw new Error(
      'Draft was published before final asset verification; refusing to modify it.',
    );
  for (const file of files) {
    const asset = existing.assets?.find(item => item.name === file.name);
    if (
      !asset ||
      asset.state !== 'uploaded' ||
      asset.size !== (await fs.stat(file.file)).size ||
      asset.label !== label
    )
      throw new Error('Final draft asset verification failed.');
  }
  const published = await github.request(
    'PATCH',
    `repos/${REPOSITORY}/releases/${existing.id}`,
    {draft: false, prerelease: false, make_latest: 'true'},
  );
  if (
    published.draft ||
    published.prerelease ||
    published.tag_name !== state.tag
  )
    throw new Error('GitHub did not publish the stable Community release.');
  return {
    status: 'published',
    url: published.html_url,
    tag: state.tag,
    sourceCommit: state.candidateSha,
  };
}

/** Exercise publisher capabilities using only an unpublished, run-scoped draft. */
export async function verifyAccess({
  root,
  output,
  appToken = process.env.APP_TOKEN,
  runId = process.env.GITHUB_RUN_ID,
  runAttempt = process.env.GITHUB_RUN_ATTEMPT,
  github = new GitHub(appToken),
}) {
  if (!appToken)
    throw new Error('APP_TOKEN is required for the publisher access check.');
  runId = String(runId ?? '');
  runAttempt = String(runAttempt ?? '');
  if (!/^[1-9]\d{0,19}$/.test(runId) || !/^[1-9]\d{0,19}$/.test(runAttempt))
    throw new Error(
      'Publisher access check requires numeric GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT.',
    );
  root = path.resolve(root);
  output = path.resolve(output);
  if (git(root, ['status', '--porcelain', '--untracked-files=no']).text)
    throw new Error(
      'Publisher access check requires an unchanged trusted checkout.',
    );
  const sourceCommit = requireSha(git(root, ['rev-parse', 'HEAD']).text);
  const temporaryTag = `community-ci-check-${runId}-${runAttempt}`;
  const marker = `<!-- pocketpal-community-ci-check:${runId}:${runAttempt}:${sourceCommit} -->`;
  const probeFile = path.join(output, 'access-probe.json');
  const reportFile = path.join(output, 'access-check.json');
  const report = {
    schemaVersion: 1,
    repository: REPOSITORY,
    sourceCommit,
    temporaryTag,
    passed: false,
    verifiedContentsWrite: false,
    workflowsPermissionExercised: false,
    workflowFilesDifferFromMain: false,
    draftCreated: false,
    assetVerified: false,
    cleanup: {
      draftDeleted: false,
      tagDeleted: false,
      tagAbsent: false,
      probeFileRemoved: false,
      complete: false,
    },
  };
  await fs.mkdir(output, {recursive: true});
  let ownedDraftId;
  let postAttempted = false;
  let tagInitiallyAbsent = false;
  let tagCreatedWithDraft = false;
  let probeWritten = false;
  let operationError;
  const cleanupErrors = [];
  try {
    const mainRef = await github.request(
      'GET',
      `repos/${REPOSITORY}/git/ref/heads/main`,
    );
    const mainSha = requireSha(mainRef.object.sha);
    if (
      git(root, ['cat-file', '-e', `${mainSha}^{commit}`], {allowFailure: true})
        .status !== 0
    )
      git(root, [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        `https://github.com/${REPOSITORY}.git`,
        'refs/heads/main',
      ]);
    report.defaultBranchCommit = mainSha;
    report.workflowFilesDifferFromMain = Boolean(
      git(root, [
        'diff',
        '--name-only',
        mainSha,
        sourceCommit,
        '--',
        '.github/workflows/',
      ]).text,
    );
    const prior = await releaseForTag(github, temporaryTag);
    if (prior)
      throw new Error(
        'Temporary access-check release name is already in use; refusing to reuse it.',
      );
    if (await tagCommit(github, temporaryTag))
      throw new Error(
        'Temporary access-check tag name is already in use; refusing to reuse it.',
      );
    tagInitiallyAbsent = true;
    const probe =
      JSON.stringify({
        schemaVersion: 1,
        repository: REPOSITORY,
        sourceCommit,
        runId,
        runAttempt,
        purpose: 'publisher-access-check',
      }) + '\n';
    await fs.writeFile(probeFile, probe, {flag: 'wx'});
    probeWritten = true;
    postAttempted = true;
    report.workflowsPermissionExercised = report.workflowFilesDifferFromMain;
    const draft = await github.request('POST', `repos/${REPOSITORY}/releases`, {
      tag_name: temporaryTag,
      target_commitish: sourceCommit,
      name: `Community publisher access check ${runId}/${runAttempt}`,
      body: `Temporary unpublished CI access check. This is not an application release.\n\n${marker}\n`,
      draft: true,
      prerelease: false,
    });
    if (
      !Number.isSafeInteger(draft.id) ||
      draft.id <= 0 ||
      draft.tag_name !== temporaryTag ||
      draft.draft !== true ||
      draft.prerelease
    )
      throw new Error(
        'GitHub did not create the expected unpublished access-check draft.',
      );
    ownedDraftId = draft.id;
    report.draftCreated = true;
    report.verifiedContentsWrite = true;
    const draftTag = await tagCommit(github, temporaryTag);
    if (draftTag && draftTag !== sourceCommit)
      throw new Error(
        'The temporary draft tag points to another commit; it will not be deleted.',
      );
    tagCreatedWithDraft = draftTag === sourceCommit;
    const size = Buffer.byteLength(probe);
    const asset = await github.request('POST', '', undefined, {
      upload: {
        id: draft.id,
        file: probeFile,
        name: 'access-probe.json',
        label: `Publisher access check; source ${sourceCommit}`,
        type: 'application/json',
        size,
      },
    });
    if (
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      asset.name !== 'access-probe.json' ||
      asset.size !== size ||
      asset.state !== 'uploaded'
    )
      throw new Error(
        'The temporary publisher probe was not uploaded correctly.',
      );
    const verified = await github.request(
      'GET',
      `repos/${REPOSITORY}/releases/assets/${asset.id}`,
    );
    if (
      verified.id !== asset.id ||
      verified.name !== 'access-probe.json' ||
      verified.size !== size ||
      verified.state !== 'uploaded'
    )
      throw new Error(
        'GitHub probe asset metadata differs from the uploaded report.',
      );
    report.assetVerified = true;
    report.probeBytes = size;
  } catch (error) {
    operationError = redact(error.message, [appToken]);
  } finally {
    // If POST reached GitHub but its response was lost, discover only our marker.
    if (!ownedDraftId && postAttempted && tagInitiallyAbsent) {
      try {
        const drafts = await github.releases();
        const matching = drafts.filter(
          item =>
            item.tag_name === temporaryTag &&
            String(item.body || '').includes(marker),
        );
        if (matching.length === 1) ownedDraftId = matching[0].id;
      } catch (error) {
        cleanupErrors.push(redact(error.message, [appToken]));
      }
    }
    if (ownedDraftId) {
      try {
        const draft = await github.request(
          'GET',
          `repos/${REPOSITORY}/releases/${ownedDraftId}`,
          undefined,
          {allow404: true},
        );
        if (draft) {
          if (
            !draft.draft ||
            draft.prerelease ||
            draft.tag_name !== temporaryTag ||
            draft.target_commitish !== sourceCommit ||
            !String(draft.body || '').includes(marker)
          )
            throw new Error(
              'Access-check draft changed or was published; refusing to delete it.',
            );
          await github.request(
            'DELETE',
            `repos/${REPOSITORY}/releases/${ownedDraftId}`,
          );
          if (
            await github.request(
              'GET',
              `repos/${REPOSITORY}/releases/${ownedDraftId}`,
              undefined,
              {allow404: true},
            )
          )
            throw new Error(
              'GitHub still returns the temporary draft after deletion.',
            );
        }
        report.cleanup.draftDeleted = true;
      } catch (error) {
        cleanupErrors.push(redact(error.message, [appToken]));
      }
    }
    if (tagInitiallyAbsent && report.cleanup.draftDeleted) {
      try {
        const currentTag = await tagCommit(github, temporaryTag);
        if (currentTag) {
          if (!tagCreatedWithDraft || currentTag !== sourceCommit)
            throw new Error(
              'Temporary tag was not created by this draft or changed; it will not be deleted.',
            );
          const currentRelease = await releaseForTag(github, temporaryTag);
          if (currentRelease)
            throw new Error(
              'A release still uses the temporary tag; refusing to delete the tag.',
            );
          await github.request(
            'DELETE',
            `repos/${REPOSITORY}/git/refs/tags/${temporaryTag}`,
          );
          report.cleanup.tagDeleted = true;
        }
        if (await tagCommit(github, temporaryTag))
          throw new Error(
            'Temporary access-check tag still exists after cleanup.',
          );
        report.cleanup.tagAbsent = true;
      } catch (error) {
        cleanupErrors.push(redact(error.message, [appToken]));
      }
    }
    try {
      if (probeWritten) {
        await fs.rm(probeFile, {force: true});
        report.cleanup.probeFileRemoved = true;
      }
    } catch (error) {
      cleanupErrors.push(error.message);
    }
    report.cleanup.complete =
      cleanupErrors.length === 0 &&
      (!ownedDraftId ||
        (report.cleanup.draftDeleted && report.cleanup.tagAbsent));
    if (cleanupErrors.length) report.cleanup.errors = cleanupErrors;
    report.checkedAtUtc = new Date().toISOString();
    report.passed =
      !operationError && report.assetVerified && report.cleanup.complete;
    if (operationError) report.error = operationError;
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  }
  if (!report.passed)
    throw new Error(
      `Publisher access check failed: ${operationError || cleanupErrors.join('; ') || 'incomplete cleanup'}. See access-check.json.`,
    );
  return report;
}

function parseArguments(values) {
  const result = {command: values.shift()};
  while (values.length) {
    const name = values.shift();
    if (
      !/^--[a-z-]+$/.test(name) ||
      !values.length ||
      values[0].startsWith('--')
    )
      throw new Error(`Expected a value for ${name}.`);
    result[name.slice(2)] = values.shift();
  }
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const root = args.root || process.cwd();
  let result;
  if (args.command === 'prepare' && args.output)
    result = await prepareRelease({root, output: args.output});
  else if (args.command === 'verify-access' && args.output)
    result = await verifyAccess({root, output: args.output});
  else if (args.command === 'restore' && args.input)
    result = await restoreCandidate({root, input: args.input});
  else if (
    args.command === 'publish' &&
    args.candidate &&
    args.artifacts &&
    args.smoke
  )
    result = await publishRelease({
      root,
      candidate: args.candidate,
      artifacts: args.artifacts,
      smoke: args.smoke,
    });
  else
    throw new Error(
      'Usage: community-release.mjs prepare --output DIR | restore --input DIR | publish --candidate DIR --artifacts DIR --smoke DIR | verify-access --output DIR [--root CHECKOUT]',
    );
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(error => {
    console.error(
      redact(error.message, [process.env.APP_TOKEN, process.env.GITHUB_TOKEN]),
    );
    process.exitCode = 1;
  });
}
