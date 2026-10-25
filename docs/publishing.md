# Publishing the extension

Checklist for releasing Flowbook to the VS Code Marketplace and Open VSX. Steps marked
**(manual)** need the maintainer's accounts; the rest can be done by an agent.

Suggested order: README → icon → manifest polish → accounts → first upload by hand → automate.

## 1. Prepare the extension

- [ ] **README** (backlog D1). The Marketplace page _is_ the README: what Flowbook does,
      screenshots of both views, install, quick start for agents, file format link. Images must
      use `https` URLs (e.g. raw GitHub links), not relative paths to SVGs.
- [ ] **Icon**: PNG, at least 128×128, referenced by `"icon"` in `packages/extension/package.json`
      and included in `.vscodeignore`'s allow-list. SVG icons are rejected; `media/flowbook.svg`
      can be the source.
- [ ] **CHANGELOG.md** in `packages/extension/` (allow-list it in `.vscodeignore`).
- [ ] **Manifest**: `keywords`, `galleryBanner`, check `categories`, `engines.vscode`,
      `repository`, `license` (MIT, done). Check whether `"private": true` blocks `vsce publish`
      and drop it if so.
- [ ] Optional: ship 0.x as pre-release (`vsce publish --pre-release`).

## 2. Accounts (manual, one time)

- [ ] Sign in at https://marketplace.visualstudio.com/manage with a **personal** Microsoft account.
- [ ] Create publisher `rameesrpu` (must equal `"publisher"` in `packages/extension/package.json`).
- [ ] Credentials for `vsce`: either an Azure DevOps Personal Access Token (scope
      **Marketplace → Manage**, organization **All accessible organizations**), or Entra ID
      sign-in via `vsce publish --azure-credential`. Microsoft is phasing out PATs, so check the
      current vsce docs first.
- [ ] Open VSX (used by VSCodium, Cursor, Windsurf, …): Eclipse account at https://open-vsx.org,
      sign the publisher agreement, create an access token, claim namespace `rameesrpu`
      (`npx ovsx create-namespace rameesrpu -p <token>`).

## 3. First release (manual)

- [ ] Run the full CI sequence from CLAUDE.md; `pnpm --filter flowbook package` produces
      `packages/extension/flowbook-<version>.vsix`.
- [ ] Upload the `.vsix` through the web UI at /manage (simplest first time), or
      `npx vsce publish --packagePath <vsix>`.
- [ ] `npx ovsx publish <vsix> -p <token>`.
- [ ] The Marketplace runs an automated scan; usually live within minutes. Install it from the
      Marketplace in a clean VS Code profile and smoke-test.

## 4. Automate (backlog D3)

- [ ] GitHub Actions workflow on tags `v*`: CI sequence → package → `vsce publish` and
      `ovsx publish` with the `.vsix`. Tokens as repo secrets (`VSCE_PAT`, `OVSX_PAT`).
- [ ] Release flow: bump `version` in `packages/extension/package.json`, update CHANGELOG,
      tag `vX.Y.Z`, push the tag; attach the `.vsix` to a GitHub Release too.
