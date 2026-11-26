# Releasing

1. Bump `version` in `package.json`, commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **Release** workflow builds Windows (`.exe`), macOS (`.dmg`) and Linux (`.AppImage`, `.deb`) installers and
   attaches them to a **draft** GitHub release. Check it, write the notes, publish.

Run the workflow by hand (Actions → Release → Run workflow) to get installers as build artifacts without a release.

## Signing (not set up yet)

Unsigned builds work, but Windows SmartScreen and macOS Gatekeeper warn users.

- **macOS:** an Apple Developer account (99 USD/year). Add secrets `CSC_LINK` (base64 .p12), `CSC_KEY_PASSWORD`,
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, then remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` and add
  `notarize: true` under `mac:` in `electron-builder.yml`.
- **Windows:** a code-signing certificate (or Azure Trusted Signing). Add `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.

## Auto-update (not set up yet)

Once releases are published, `electron-updater` can read them from GitHub (the `publish:` block in
`electron-builder.yml` is already there). macOS auto-update requires signed builds.
