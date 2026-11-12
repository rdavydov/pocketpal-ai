# PocketPal AI Community

Independent Android fork maintained by **Roman Davydov (rdavydov)**, based on
[PocketPal AI](https://github.com/a-ghorbani/pocketpal-ai) by **Asghar Ghorbani and
contributors**. Maintainer website: https://rdavydov.github.io/.

| Identity | Value |
| --- | --- |
| Launcher/application name | PocketPal AI Community |
| Android application ID | `io.github.rdavydov.pocketpalai` |
| First fork release | 1.23.0 (160), based on upstream-derived commit `80cba5bbdc6cb524a8dec407b31c5e75df024265` |
| Minimum / target SDK | API 24 (Android 7.0) / API 36 |
| Packaged ABIs | `arm64-v8a`, `x86_64` |
| Default signing | Public upstream Android Debug test key, alias `androiddebugkey` |

This is an unofficial source-built fork, not the original Google Play release.
The package uses the reverse-domain prefix of `rdavydov.github.io`. The internal
Android namespace and React Native registration stay unchanged; they are not
the installed application ID or the visible launcher name.

## Changes from the original

- Separate Android application ID and launcher name, allowing installation next
  to the original `com.pocketpalai` with independent data.
- Published Windows build/verification scripts: [build-apk.cmd](build-apk.cmd)
  and [tools/apk](tools/apk/). Native Windows Ninja, explicit dependency patches
  and Android grammar preparation handle the existing upstream native stack.
- Local release builds use upstream `PLUS_STORE_GATE=false`, `E2E_BUILD=false`
  and compile the native engine from source with the upstream patches. This
  configuration already includes implemented local Plus features; this fork
  does not add a purchase bypass or unlock server-owned PalsHub content.

The LLM, speech, chat and model-loading implementation is inherited from the
upstream project. Models are not included in the APK. After installing the fork,
download/import a model and configure speech/voice normally.

## Build on Windows

Run from the checkout root:

```powershell
.\build-apk.cmd
```

See [the Russian build README](tools/apk/README-RU.md) for prerequisites,
toolchain locations, dependency preparation, temporary Yarn cache policy and
Git Bash usage. The ready APK is named
`build/apk/pocketpal-ai-community-<version>-android7.apk` and is verified before
publication into that local directory. The version is read from the source and
checked against the compiled manifest. Android SDKs/toolchains are not included
in this source repository. The Hexagon host subset is provisioned from the
upstream-pinned SDK; see `.github/actions/setup-hexagon-sdk/action.yml`.

## Signing, updates and data

The default APK uses the **public test key** shipped in upstream
`android/app/debug.keystore`, not a unique private release identity. Verify the
actual signer in each build's report if you configure a custom release key.
Android updates require the same installed package ID and signing certificate.

The original app and the fork have independent private storage. Renaming the
package does not automatically migrate chats, settings, downloaded models or
credentials. Export/import through available application controls or import
your GGUF files explicitly; automatic migration is not claimed.

The compatible Hugging Face deep link `pocketpal://hub` is retained. With both
apps installed, Android may ask which app should open it.

## Online services and verification limits

Google Sign-In, Firebase/App Check, purchase integrations and authenticated
PalsHub operations may require configuration for this separate package and its
certificate. The local no-secret build uses CI-style dummy Firebase metadata;
it does not claim original production credentials or server entitlements.
Do not assume that a server feature works solely because local chat works.

The API 24 installation floor is read from the APK manifest. It does not prove
runtime compatibility with every Android 7 device. Native backend exports and
16 KB alignment checks do not prove physical GPU/NPU execution. Full voice
conversation and hardware acceleration require separate device testing.

## License and attribution

The original MIT copyright and [LICENSE](LICENSE) are retained. This fork's
source changes and build scripts are provided under the same MIT license.
Original application/library/asset authorship remains with its authors.
