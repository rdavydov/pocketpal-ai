const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = file =>
  fs.readFileSync(path.join(ROOT, file), 'utf-8').replace(/\r\n/g, '\n');

// Community owns its release control plane. Check the pipeline that ships this
// fork, rather than upstream's independent APK/AAB/iOS store-release layout.
const workflow = read('.github/workflows/release.yml');
const android = read('.github/workflows/community-android.yml');
const build = read('tools/apk/build-linux.sh');
const verifier = read('tools/apk/android-apk.mjs');

const job = (source, name) => {
  const match = source.match(
    new RegExp(
      `^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`,
      'm',
    ),
  );
  if (!match) throw new Error(`Missing Community job: ${name}`);
  return match[1];
};

describe('Community release Plus mode', () => {
  it('builds the production APK with local Plus enabled and E2E disabled', () => {
    expect(build).toMatch(/^export PLUS_STORE_GATE=false$/m);
    expect(build).toMatch(/^export E2E_BUILD=false$/m);
    expect(build).toMatch(
      /^export ORG_GRADLE_PROJECT_rnllamaBuildFromSource=true$/m,
    );
    expect(build).toMatch(/\bassembleProdRelease\b/);
    expect(job(android, 'build')).toMatch(/PLUS_STORE_GATE:\s*'false'/);
    expect(job(android, 'build')).toMatch(/E2E_BUILD:\s*'false'/);
  });

  it('checks the actual APK ungated after building it', () => {
    const checks = [
      ...verifier.matchAll(/\['scripts\/verify-plus-gate\.sh',([^\]]*)\]/g),
    ];
    expect(checks).toHaveLength(1);
    expect(checks[0][1]).toContain("'--ungated'");
    expect(checks[0][1]).not.toContain("'--gated'");
    const verify = build.indexOf(
      'android-apk.mjs verify --apk "$task_source_apk"',
    );
    expect(verify).toBeGreaterThan(build.indexOf('assembleProdRelease'));
    expect(build).toContain(
      'android/app/build/outputs/apk/prod/release/app-prod-release.apk',
    );
  });

  it('publishes only after the reusable quality, build and smoke pipeline succeeds', () => {
    const androidJob = job(workflow, 'android');
    expect(androidJob).toMatch(
      /uses:\s*\.\/\.github\/workflows\/community-android\.yml/,
    );
    expect(androidJob).toMatch(/run_quality:\s*true/);
    expect(job(android, 'build')).toMatch(/needs:\s*quality/);
    expect(job(android, 'smoke')).toMatch(/needs:\s*build/);
    const publish = job(workflow, 'publish');
    expect(publish).toMatch(/needs:\s*\[prepare, android\]/);
    expect(publish).toContain("needs.android.result == 'success'");
  });

  it('does not run the upstream store-publishing lanes', () => {
    for (const source of [workflow, android, build]) {
      expect(source).not.toMatch(/bundle exec fastlane|upload_to_play_store/);
      expect(source).not.toMatch(/PLUS_STORE_GATE(?:=|:\s*['"]?)true/);
    }
  });
});
