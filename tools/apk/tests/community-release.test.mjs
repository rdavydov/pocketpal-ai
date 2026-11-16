import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  APP_NAME,
  PACKAGE,
  REPOSITORY,
  UPSTREAM,
  compareVersions,
  prepareRelease,
  restoreCandidate,
  publishRelease,
  validateArtifactSet,
  applyIdentity,
  GitHub,
  verifyAccess,
} from '../community-release.mjs';

function run(root, args, allowFailure = false) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0)
    throw new Error(result.stderr || result.stdout);
  return {text: result.stdout.trim(), status: result.status};
}

async function write(root, name, text) {
  const filename = path.join(root, name);
  await fs.mkdir(path.dirname(filename), {recursive: true});
  await fs.writeFile(filename, text);
}

async function versionFiles(root, version, code) {
  await write(root, 'package.json', JSON.stringify({version}, null, 2) + '\n');
  await write(root, '.version', version + '\n');
  await write(
    root,
    'android/app/build.gradle',
    `android {\n defaultConfig {\n  applicationId "com.pocketpalai"\n  minSdkVersion rootProject.ext.minSdkVersion\n  targetSdkVersion rootProject.ext.targetSdkVersion\n  versionCode ${code}\n  versionName "${version}"\n }\n}\n`,
  );
}

async function fixture(t, {unknownConflict = false, nextCode = 2} = {}) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pocketpal-release-test-'),
  );
  t.after(async () => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('pocketpal-release-test-'));
    await fs.rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const root = path.join(temporary, 'work');
  const origin = path.join(temporary, 'origin.git');
  const upstream = path.join(temporary, 'upstream.git');
  const output = path.join(temporary, 'candidate');
  await fs.mkdir(root);
  run(root, ['init', '-b', 'main']);
  run(root, ['config', 'user.name', 'Test']);
  run(root, ['config', 'user.email', 'test@example.invalid']);
  run(root, ['config', 'core.autocrlf', 'false']);
  await versionFiles(root, '1.0.0', 1);
  await write(
    root,
    'android/app/src/main/res/values/strings.xml',
    '<resources>\n<string name="app_name">PocketPal</string>\n<string name="other">old</string>\n</resources>\n',
  );
  await write(
    root,
    'android/app/debug.keystore',
    'public test certificate original',
  );
  await write(root, '.github/workflows/ci.yml', 'name: original workflow\n');
  await write(root, 'src/code.txt', 'base line\n');
  run(root, ['add', '.']);
  run(root, ['commit', '-m', 'original 1.0.0']);
  run(root, ['tag', 'v1.0.0']);
  run(root, ['switch', '-c', 'fork']);
  for (const name of [
    'android/app/build.gradle',
    'android/app/src/main/res/values/strings.xml',
  ])
    await write(
      root,
      name,
      applyIdentity(await fs.readFile(path.join(root, name), 'utf8'), name),
    );
  await write(root, '.github/workflows/ci.yml', 'name: Community workflow\n');
  await write(root, 'tools/apk/owned.txt', 'keep fork tools\n');
  await write(root, 'COMMUNITY.md', 'fork attribution\n');
  await write(root, 'build-apk.cmd', 'fork entry point\n');
  if (unknownConflict) await write(root, 'src/code.txt', 'fork line\n');
  run(root, ['add', '.']);
  run(root, ['commit', '-m', 'fork identity']);
  const baseSha = run(root, ['rev-parse', 'HEAD']).text;
  run(root, ['tag', 'community-v1.0.0']);
  run(root, ['clone', '--bare', root, origin]);
  run(root, ['clone', '--bare', root, upstream]);
  run(root, ['remote', 'add', 'origin', origin]);
  run(root, ['remote', 'add', 'upstream', upstream]);
  run(root, ['push', 'origin', 'fork:main']);
  run(root, ['switch', 'main']);
  await versionFiles(root, '1.1.0', nextCode);
  await write(
    root,
    'android/app/src/main/res/values/strings.xml',
    '<resources>\n<string name="app_name">PocketPal AI</string>\n<string name="other">new</string>\n</resources>\n',
  );
  await write(
    root,
    '.github/workflows/ci.yml',
    'name: changed upstream store workflow\n',
  );
  await write(root, 'tools/apk/new-upstream.txt', 'not a fork build tool\n');
  await write(
    root,
    'android/app/debug.keystore',
    'different upstream test certificate',
  );
  await write(root, 'src/code.txt', 'updated upstream line\n');
  run(root, ['add', '.']);
  run(root, ['commit', '-m', 'original 1.1.0']);
  const upstreamSha = run(root, ['rev-parse', 'HEAD']).text;
  run(root, ['tag', 'v1.1.0']);
  run(root, ['push', 'upstream', 'main', '--tags']);
  run(root, ['switch', 'fork']);
  const published = {
    id: 1,
    tag_name: 'community-v1.0.0',
    draft: false,
    prerelease: false,
    html_url: `https://github.com/${REPOSITORY}/releases/tag/community-v1.0.0`,
  };
  const github = new FakeGitHub(origin, published);
  return {
    temporary,
    root,
    origin,
    upstream,
    output,
    baseSha,
    upstreamSha,
    github,
  };
}

class FakeGitHub {
  constructor(origin, published) {
    this.origin = origin;
    this.published = published;
    this.release = null;
    this.calls = [];
    this.nextAsset = 20;
    this.failUploadOnce = false;
    this.failCreateOnce = false;
    this.failProbeUploadOnce = false;
    this.createDraftTag = false;
    this.latest = {
      tag_name: 'v1.1.0',
      draft: false,
      prerelease: false,
      html_url: `https://github.com/${UPSTREAM}/releases/tag/v1.1.0`,
      body: 'Original changelog',
    };
  }
  async releases() {
    return [
      this.published,
      ...(this.release ? [structuredClone(this.release)] : []),
    ];
  }
  async request(method, endpoint, body, options = {}) {
    this.calls.push({method, endpoint, body, upload: options.upload?.name});
    const root = path.dirname(this.origin);
    const bare = args => run(root, ['--git-dir', this.origin, ...args]);
    if (
      method === 'GET' &&
      endpoint.endsWith('/git/matching-refs/tags/community-v')
    )
      return bare([
        'for-each-ref',
        '--format=%(refname)',
        'refs/tags/community-v*',
      ])
        .text.split('\n')
        .filter(Boolean)
        .map(ref => ({ref}));
    if (method === 'GET' && endpoint === `repos/${UPSTREAM}/releases/latest`)
      return structuredClone(this.latest);
    if (
      method === 'GET' &&
      endpoint.startsWith(`repos/${UPSTREAM}/releases/tags/`)
    )
      return {
        ...this.latest,
        tag_name: decodeURIComponent(endpoint.split('/').at(-1)),
      };
    if (
      method === 'GET' &&
      endpoint === `repos/${REPOSITORY}/git/ref/heads/main`
    )
      return {
        object: {
          sha: bare(['rev-parse', 'refs/heads/main']).text,
          type: 'commit',
        },
      };
    if (
      method === 'GET' &&
      endpoint.startsWith(`repos/${REPOSITORY}/git/ref/tags/`)
    ) {
      const tag = decodeURIComponent(endpoint.split('/').at(-1));
      const result = run(
        root,
        ['--git-dir', this.origin, 'rev-parse', '--verify', `refs/tags/${tag}`],
        true,
      );
      return result.status === 0
        ? {object: {sha: result.text, type: 'commit'}}
        : null;
    }
    if (
      method === 'GET' &&
      endpoint.startsWith(`repos/${REPOSITORY}/releases/tags/`)
    )
      return this.release &&
        !this.release.draft &&
        decodeURIComponent(endpoint.split('/').at(-1)) === this.release.tag_name
        ? structuredClone(this.release)
        : null;
    if (method === 'POST' && endpoint === `repos/${REPOSITORY}/releases`) {
      if (this.failCreateOnce) {
        this.failCreateOnce = false;
        throw new Error('simulated create failure');
      }
      this.release = {
        id: 2,
        ...body,
        assets: [],
        html_url: `https://github.com/${REPOSITORY}/releases/tag/${body.tag_name}`,
      };
      if (
        this.createDraftTag &&
        body.tag_name.startsWith('community-ci-check-')
      )
        bare([
          'update-ref',
          `refs/tags/${body.tag_name}`,
          body.target_commitish,
        ]);
      return structuredClone(this.release);
    }
    if (method === 'POST' && options.upload) {
      if (
        this.failProbeUploadOnce &&
        options.upload.name === 'access-probe.json'
      ) {
        this.failProbeUploadOnce = false;
        throw new Error('simulated probe upload failure');
      }
      if (this.failUploadOnce && options.upload.name === 'build-info.json') {
        this.failUploadOnce = false;
        throw new Error('simulated network failure');
      }
      const asset = {
        id: this.nextAsset++,
        name: options.upload.name,
        label: options.upload.label,
        size: options.upload.size,
        state: 'uploaded',
        browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${this.release.tag_name}/${options.upload.name}`,
      };
      this.release.assets.push(asset);
      return structuredClone(asset);
    }
    if (
      method === 'GET' &&
      endpoint.startsWith(`repos/${REPOSITORY}/releases/assets/`)
    )
      return structuredClone(
        this.release.assets.find(
          asset => asset.id === Number(endpoint.split('/').at(-1)),
        ) || null,
      );
    if (method === 'DELETE' && endpoint === `repos/${REPOSITORY}/releases/2`) {
      this.release = null;
      return null;
    }
    if (
      method === 'DELETE' &&
      endpoint.startsWith(
        `repos/${REPOSITORY}/git/refs/tags/community-ci-check-`,
      )
    ) {
      bare([
        'update-ref',
        '-d',
        `refs/tags/${decodeURIComponent(endpoint.split('/').at(-1))}`,
      ]);
      return null;
    }
    if (
      method === 'DELETE' &&
      endpoint.startsWith(`repos/${REPOSITORY}/releases/assets/`)
    ) {
      this.release.assets = this.release.assets.filter(
        asset => asset.id !== Number(endpoint.split('/').at(-1)),
      );
      return null;
    }
    if (method === 'GET' && endpoint === `repos/${REPOSITORY}/releases/2`)
      return structuredClone(this.release);
    if (method === 'PATCH' && endpoint === `repos/${REPOSITORY}/releases/2`) {
      Object.assign(this.release, body);
      return structuredClone(this.release);
    }
    throw new Error(`Unexpected API request: ${method} ${endpoint}`);
  }
}

async function prepare(f) {
  return prepareRelease({
    root: f.root,
    output: f.output,
    github: f.github,
    originUrl: f.origin,
    upstreamUrl: f.upstream,
  });
}

async function cloneTrusted(f, name = 'trusted') {
  const root = path.join(f.temporary, name);
  run(f.temporary, ['clone', '--branch', 'main', f.origin, root]);
  return root;
}

async function artifacts(f, state) {
  const output = path.join(f.temporary, 'artifacts');
  const smoke = path.join(f.temporary, 'smoke');
  await fs.mkdir(output, {recursive: true});
  await fs.mkdir(smoke, {recursive: true});
  const apk = Buffer.from('PK\x03\x04a verified APK fixture');
  const info = {
    sourceCommit: state.candidateSha,
    versionName: state.version,
    versionCode: state.versionCode,
    package: PACKAGE,
    appName: APP_NAME,
    bytes: apk.length,
    trackedChanges: [],
    minSdk: 24,
    debuggable: false,
    plusGate: 'off',
    signature: 'verified for API 24+',
    signerMatchesDebugKeystore: true,
    nativePayload: 'passed',
    zipAlignment16kb: 'passed',
    elfLayout16kb: 'passed',
    abis: ['arm64-v8a', 'x86_64'],
  };
  const runtime = {
    sourceCommit: state.candidateSha,
    package: PACKAGE,
    versionName: state.version,
    versionCode: state.versionCode,
    passed: true,
    install: true,
    launch: true,
    ui: true,
    device: {api: 35, abi: 'x86_64'},
  };
  await write(
    output,
    `pocketpal-ai-community-${state.version}-android7.apk`,
    apk,
  );
  await write(output, 'build-info.json', JSON.stringify(info));
  await write(smoke, 'checks.json', JSON.stringify(runtime));
  const png = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(1080, 16);
  png.writeUInt32BE(2400, 20);
  await write(smoke, 'smoke.png', png);
  return {output, smoke, info, runtime};
}

test('stable versions compare numerically and reject prereleases', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.throws(() => compareVersions('1.0.0-rc.1', '1.0.0'), /stable/);
});

test('no newer upstream version produces no bundle and never mutates main', async t => {
  const f = await fixture(t);
  f.github.latest = {...f.github.latest, tag_name: 'v1.0.0'};
  const result = await prepare(f);
  assert.equal(result.mode, 'no-update');
  assert.equal(run(f.root, ['rev-parse', 'HEAD']).text, f.baseSha);
  await assert.rejects(
    fs.stat(path.join(f.output, 'candidate.bundle')),
    /ENOENT/,
  );
  assert.ok(f.github.calls.every(call => call.method === 'GET'));
});

test('normal merge preserves fork CI, signing key and tools while taking upstream version and code', async t => {
  const f = await fixture(t);
  const state = await prepare(f);
  assert.equal(state.mode, 'candidate');
  assert.equal(state.version, '1.1.0');
  assert.equal(
    await fs.readFile(path.join(f.root, 'src/code.txt'), 'utf8'),
    'updated upstream line\n',
  );
  assert.equal(
    await fs.readFile(path.join(f.root, '.github/workflows/ci.yml'), 'utf8'),
    'name: Community workflow\n',
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'android/app/debug.keystore'), 'utf8'),
    'public test certificate original',
  );
  await assert.rejects(
    fs.stat(path.join(f.root, 'tools/apk/new-upstream.txt')),
    /ENOENT/,
  );
  assert.match(
    await fs.readFile(path.join(f.root, 'android/app/build.gradle'), 'utf8'),
    /io\.github\.rdavydov\.pocketpalai/,
  );
  const strings = await fs.readFile(
    path.join(f.root, 'android/app/src/main/res/values/strings.xml'),
    'utf8',
  );
  assert.match(strings, /PocketPal AI Community/);
  assert.match(strings, />new<\/string>/);
  assert.ok(
    run(f.root, ['show', '-s', '--format=%B', 'HEAD']).text.includes(
      '[skip ci]',
    ),
  );
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', 'main']).text,
    f.baseSha,
  );
  const trusted = await cloneTrusted(f);
  await restoreCandidate({root: trusted, input: f.output});
  assert.equal(run(trusted, ['rev-parse', 'HEAD']).text, state.candidateSha);
});

test('an unknown source conflict stops before any remote changes', async t => {
  const f = await fixture(t, {unknownConflict: true});
  await assert.rejects(prepare(f), /unknown merge conflict: src\/code.txt/);
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', 'main']).text,
    f.baseSha,
  );
  assert.ok(f.github.calls.every(call => call.method === 'GET'));
});

test('non-increasing Android build number cannot create a release candidate', async t => {
  const f = await fixture(t, {nextCode: 1});
  await assert.rejects(prepare(f), /versionCode must increase/);
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', 'main']).text,
    f.baseSha,
  );
});

test('an unrelated bundle ref or altered source identifier is rejected', async t => {
  const f = await fixture(t);
  const state = await prepare(f);
  const trusted = await cloneTrusted(f);
  await write(
    f.output,
    'candidate.json',
    JSON.stringify({...state, candidateSha: f.baseSha}),
  );
  await assert.rejects(
    restoreCandidate({root: trusted, input: f.output}),
    /bundle ref differs/,
  );
});

test('publisher requires same source, original certificate and successful smoke', async t => {
  const f = await fixture(t);
  const state = await prepare(f);
  const a = await artifacts(f, state);
  await write(
    a.output,
    'build-info.json',
    JSON.stringify({...a.info, signerMatchesDebugKeystore: false}),
  );
  await assert.rejects(
    validateArtifactSet(state, a.output, a.smoke),
    /verification did not pass/,
  );
  await write(a.output, 'build-info.json', JSON.stringify(a.info));
  await write(
    a.smoke,
    'checks.json',
    JSON.stringify({...a.runtime, passed: false}),
  );
  const trusted = await cloneTrusted(f);
  await assert.rejects(
    publishRelease({
      root: trusted,
      candidate: f.output,
      artifacts: a.output,
      smoke: a.smoke,
      appToken: 'test-token',
      github: f.github,
      remoteUrl: f.origin,
    }),
    /smoke test/,
  );
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', 'main']).text,
    f.baseSha,
  );
});

test('publisher refuses to replace main changed while the build was running', async t => {
  const f = await fixture(t);
  const state = await prepare(f);
  const a = await artifacts(f, state);
  const trusted = await cloneTrusted(f);
  run(f.root, ['switch', '--detach', f.baseSha]);
  await write(f.root, 'README.md', 'concurrent change');
  run(f.root, ['add', '.']);
  run(f.root, ['commit', '-m', 'concurrent main change']);
  const newer = run(f.root, ['rev-parse', 'HEAD']).text;
  run(f.root, ['push', 'origin', 'HEAD:main']);
  await assert.rejects(
    publishRelease({
      root: trusted,
      candidate: f.output,
      artifacts: a.output,
      smoke: a.smoke,
      appToken: 'test-token',
      github: f.github,
      remoteUrl: f.origin,
    }),
    /main changed/,
  );
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', 'main']).text,
    newer,
  );
});

test('successful publication promotes exact source once and never overwrites a published release', async t => {
  const f = await fixture(t);
  const state = await prepare(f);
  const a = await artifacts(f, state);
  const trusted = await cloneTrusted(f);
  const options = {
    root: trusted,
    candidate: f.output,
    artifacts: a.output,
    smoke: a.smoke,
    appToken: 'test-token',
    github: f.github,
    remoteUrl: f.origin,
  };
  const result = await publishRelease(options);
  assert.equal(result.status, 'published');
  assert.equal(f.github.release.draft, false);
  assert.equal(f.github.release.assets.length, 4);
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', 'main']).text,
    state.candidateSha,
  );
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', state.tag]).text,
    state.candidateSha,
  );
  assert.ok(f.github.release.body.includes('Полный разговор через микрофон'));
  assert.ok(f.github.release.body.includes('**Подпись тестовая:**'));
  const mutationCount = f.github.calls.filter(
    call => call.method !== 'GET',
  ).length;
  const repeated = await publishRelease(options);
  assert.equal(repeated.status, 'already-published');
  assert.equal(
    f.github.calls.filter(call => call.method !== 'GET').length,
    mutationCount,
  );
});

test('failed upload recovers pending exact tag before considering a newer upstream release', async t => {
  const f = await fixture(t);
  const state = await prepare(f);
  const a = await artifacts(f, state);
  const trusted = await cloneTrusted(f);
  f.github.failUploadOnce = true;
  await assert.rejects(
    publishRelease({
      root: trusted,
      candidate: f.output,
      artifacts: a.output,
      smoke: a.smoke,
      appToken: 'test-token',
      github: f.github,
      remoteUrl: f.origin,
    }),
    /simulated network failure/,
  );
  assert.equal(f.github.release.draft, true);
  assert.equal(f.github.release.assets.length, 1);
  assert.equal(
    await f.github.request(
      'GET',
      `repos/${REPOSITORY}/releases/tags/${state.tag}`,
    ),
    null,
    'A draft is intentionally hidden by the published-only by-tag endpoint',
  );
  const recoveryRoot = await cloneTrusted(f, 'recovery');
  const recoveryOutput = path.join(f.temporary, 'recovery-candidate');
  f.github.latest = {...f.github.latest, tag_name: 'v9.0.0'};
  f.github.calls = [];
  const recovered = await prepareRelease({
    root: recoveryRoot,
    output: recoveryOutput,
    github: f.github,
    originUrl: f.origin,
    upstreamUrl: f.upstream,
  });
  assert.equal(recovered.mode, 'recover');
  assert.equal(recovered.candidateSha, state.candidateSha);
  assert.ok(
    !f.github.calls.some(
      call => call.endpoint === `repos/${UPSTREAM}/releases/latest`,
    ),
  );
  const finished = await publishRelease({
    root: recoveryRoot,
    candidate: recoveryOutput,
    artifacts: a.output,
    smoke: a.smoke,
    appToken: 'test-token',
    github: f.github,
    remoteUrl: f.origin,
  });
  assert.equal(finished.status, 'published');
  assert.equal(f.github.release.id, 2, 'Recovery must resume the same draft');
  assert.equal(f.github.release.assets.length, 4);
  assert.equal(
    f.github.calls.filter(
      call =>
        call.method === 'POST' &&
        call.endpoint === `repos/${REPOSITORY}/releases`,
    ).length,
    0,
    'Recovery must not create another draft',
  );
  assert.equal(
    f.github.calls.filter(call => call.upload?.endsWith('.apk')).length,
    0,
  );
});

test('a tag promoted before a failed draft creation is recovered without a version bump', async t => {
  const f = await fixture(t);
  const state = await prepare(f);
  const a = await artifacts(f, state);
  const trusted = await cloneTrusted(f);
  f.github.failCreateOnce = true;
  await assert.rejects(
    publishRelease({
      root: trusted,
      candidate: f.output,
      artifacts: a.output,
      smoke: a.smoke,
      appToken: 'test-token',
      github: f.github,
      remoteUrl: f.origin,
    }),
    /simulated create failure/,
  );
  assert.equal(f.github.release, null);
  const recoveryRoot = await cloneTrusted(f, 'recovery');
  const recoveryOutput = path.join(f.temporary, 'recovery-candidate');
  const recovered = await prepareRelease({
    root: recoveryRoot,
    output: recoveryOutput,
    github: f.github,
    originUrl: f.origin,
    upstreamUrl: f.upstream,
  });
  assert.equal(recovered.mode, 'recover');
  assert.equal(recovered.version, '1.1.0');
  assert.equal(recovered.candidateSha, state.candidateSha);
  const result = await publishRelease({
    root: recoveryRoot,
    candidate: recoveryOutput,
    artifacts: a.output,
    smoke: a.smoke,
    appToken: 'test-token',
    github: f.github,
    remoteUrl: f.origin,
  });
  assert.equal(result.status, 'published');
});

test('read API errors redact a token rather than exposing response text', async () => {
  const github = new GitHub('secret-value', async () => ({
    ok: false,
    status: 403,
    json: async () => ({message: 'bad secret-value'}),
  }));
  await assert.rejects(
    github.request('GET', 'repos/test'),
    error =>
      error.message.includes('***') && !error.message.includes('secret-value'),
  );
});

async function accessFixture(t) {
  const f = await fixture(t);
  await write(
    f.root,
    '.github/workflows/access-check.yml',
    'name: access check feature\n',
  );
  run(f.root, ['add', '.']);
  run(f.root, ['commit', '-m', 'new controller workflow']);
  f.accessSha = run(f.root, ['rev-parse', 'HEAD']).text;
  run(f.root, ['push', 'origin', 'HEAD:refs/heads/access-fixture']);
  f.accessOutput = path.join(f.temporary, 'access-report');
  return f;
}

function accessOptions(f) {
  return {
    root: f.root,
    output: f.accessOutput,
    appToken: 'test-access-token',
    github: f.github,
    runId: '12345678',
    runAttempt: '2',
  };
}

test('publisher access probe exercises workflow commit and removes its draft, asset and optional tag', async t => {
  const f = await accessFixture(t);
  f.github.createDraftTag = true;
  const result = await verifyAccess(accessOptions(f));
  assert.equal(result.passed, true);
  assert.equal(result.verifiedContentsWrite, true);
  assert.equal(result.workflowsPermissionExercised, true);
  assert.equal(result.sourceCommit, f.accessSha);
  assert.equal(result.temporaryTag, 'community-ci-check-12345678-2');
  assert.equal(result.assetVerified, true);
  assert.deepEqual(result.cleanup, {
    draftDeleted: true,
    tagDeleted: true,
    tagAbsent: true,
    probeFileRemoved: true,
    complete: true,
  });
  assert.equal(f.github.release, null);
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', 'main']).text,
    f.baseSha,
  );
  assert.equal(run(f.root, ['rev-parse', 'HEAD']).text, f.accessSha);
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', 'community-v1.0.0']).text,
    f.baseSha,
  );
  assert.ok(
    f.github.calls
      .filter(call => call.method !== 'GET')
      .every(
        call =>
          call.endpoint === '' ||
          call.endpoint.includes('/releases') ||
          call.endpoint.endsWith(
            '/git/refs/tags/community-ci-check-12345678-2',
          ),
      ),
  );
  await assert.rejects(
    fs.stat(path.join(f.accessOutput, 'access-probe.json')),
    /ENOENT/,
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(f.accessOutput, 'access-check.json'), 'utf8'),
    ).passed,
    true,
  );
});

test('publisher access probe cleans a draft after upload failure and writes a failed report', async t => {
  const f = await accessFixture(t);
  f.github.failProbeUploadOnce = true;
  await assert.rejects(
    verifyAccess(accessOptions(f)),
    /simulated probe upload failure/,
  );
  assert.equal(f.github.release, null);
  const report = JSON.parse(
    await fs.readFile(path.join(f.accessOutput, 'access-check.json'), 'utf8'),
  );
  assert.equal(report.passed, false);
  assert.equal(report.cleanup.draftDeleted, true);
  assert.equal(report.cleanup.tagAbsent, true);
  assert.equal(report.cleanup.complete, true);
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', 'main']).text,
    f.baseSha,
  );
});

test('publisher access on main reports that workflow-write was not exercised', async t => {
  const f = await fixture(t);
  f.accessOutput = path.join(f.temporary, 'access-report');
  const result = await verifyAccess(accessOptions(f));
  assert.equal(result.passed, true);
  assert.equal(result.verifiedContentsWrite, true);
  assert.equal(result.workflowFilesDifferFromMain, false);
  assert.equal(result.workflowsPermissionExercised, false);
  assert.equal(result.cleanup.tagAbsent, true);
});

test('publisher access never reuses or deletes an unrelated existing draft', async t => {
  const f = await accessFixture(t);
  f.github.release = {
    id: 2,
    tag_name: 'community-ci-check-12345678-2',
    draft: true,
    prerelease: false,
    target_commitish: f.accessSha,
    body: 'Unrelated draft',
    assets: [],
  };
  assert.equal(
    await f.github.request(
      'GET',
      'repos/' + REPOSITORY + '/releases/tags/community-ci-check-12345678-2',
    ),
    null,
    'The existing draft is not discoverable through the by-tag endpoint',
  );
  await assert.rejects(verifyAccess(accessOptions(f)), /already in use/);
  assert.equal(f.github.release.body, 'Unrelated draft');
  assert.ok(f.github.calls.every(call => call.method === 'GET'));
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', 'main']).text,
    f.baseSha,
  );
});

test('publisher stops on duplicate release tags before promoting main', async t => {
  const f = await fixture(t);
  const state = await prepare(f);
  const a = await artifacts(f, state);
  const trusted = await cloneTrusted(f);
  const duplicate = {
    id: 2,
    tag_name: state.tag,
    draft: true,
    prerelease: false,
  };
  f.github.releases = async () => [
    f.github.published,
    duplicate,
    {...duplicate, id: 3},
  ];
  await assert.rejects(
    publishRelease({
      root: trusted,
      candidate: f.output,
      artifacts: a.output,
      smoke: a.smoke,
      appToken: 'test-token',
      github: f.github,
      remoteUrl: f.origin,
    }),
    /More than one GitHub release/,
  );
  assert.equal(
    run(f.root, ['--git-dir', f.origin, 'rev-parse', 'main']).text,
    f.baseSha,
  );
  assert.ok(f.github.calls.every(call => call.method === 'GET'));
});

test('publisher access rejects missing workflow run identifiers before API writes', async t => {
  const f = await accessFixture(t);
  await assert.rejects(
    verifyAccess({...accessOptions(f), runId: ''}),
    /numeric GITHUB_RUN_ID/,
  );
  assert.equal(f.github.calls.length, 0);
});
