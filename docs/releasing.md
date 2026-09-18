# Releasing to npm

End users install CGW from npm:

```bash
npx -y codex-chatgpt-web-mcp@latest login
codex mcp add chatgpt-web -- npx -y codex-chatgpt-web-mcp@latest mcp
```

README install commands therefore do not change for every release.

## One-time bootstrap

The npm package must exist once before npm trusted publishing can be configured.

1. Sign in to npm with the account that should own `codex-chatgpt-web-mcp`.
2. From a clean checkout of the release commit:

```bash
npm install
npm run typecheck
npm test
npm publish --access public
```

For v0.9.0 this creates the package for the first time.

If npm reports that the package name is already owned by someone else, stop.
Do not publish under an unexpected package name without updating the repository
and user-facing install commands deliberately.

## Configure trusted publishing

After the first package exists, configure npm to trust this repository's
GitHub Actions publish workflow.

Recommended CLI form:

```bash
npm trust github codex-chatgpt-web-mcp \
  --file publish.yml \
  --repo jiho-symply/codex-chatgpt-web-mcp \
  --allow-publish
```

npm may require an interactive 2FA confirmation for this account-level change.

Equivalent npmjs.com settings:

- Provider: GitHub Actions
- Organization/user: `jiho-symply`
- Repository: `codex-chatgpt-web-mcp`
- Workflow file: `publish.yml`
- Allow: direct `npm publish`

The workflow uses GitHub OIDC (`id-token: write`) and does not require a
long-lived npm publish token after trusted publishing is configured.

## Normal release

1. Update the version in both:
   - `package.json`
   - `src/version.ts`
2. Merge to `main` after CI passes.
3. Create and push a matching Git tag:

```bash
git tag v0.9.1
git push origin v0.9.1
```

The `.github/workflows/publish.yml` workflow then:

1. verifies `vX.Y.Z` matches `package.json`;
2. installs dependencies;
3. runs typecheck and tests;
4. inspects the package with `npm pack --dry-run`;
5. publishes to npm using trusted publishing;
6. verifies the published version through `npx`.

Stable versions publish under npm's `latest` dist-tag.
Prerelease versions such as `0.10.0-beta.1` publish under `next`.

## Package contents

`package.json#files` deliberately limits the public npm package to runtime and
documentation files:

- `bin/`
- `src/`
- `docs/`
- `README.md`
- `README.ko-KR.md`
- `SECURITY.md`
- `LICENSE`

Tests, GitHub workflow files, and repository-only development files are not
included in the published package.

## Security

npm recommends trusted publishing over long-lived access tokens. GitHub Actions
receives a short-lived OIDC credential for each release, and npm generates
provenance for public packages published from supported GitHub-hosted runners.

If the trusted publisher configuration is removed or no longer matches
`publish.yml`, publishing fails closed with an npm authentication error.
