# Contributing & maintainers

Public install instructions live in [README.md](./README.md). This file is for people shipping the project.

## Development

```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev
```

Tests (from repo root):

```bash
npm install && cd tests && npm install
npx vitest run unit/dashboard-guard.test.js unit/combo-fusion.test.js unit/switchboard-auto.test.js
```

CLI pack (builds app into `cli/`):

```bash
npm install
cd cli && npm install && npm run pack:cli
```

## CI/CD (do not publish npm by hand)

| Workflow | When | What |
|----------|------|------|
| **CI** | push / PR | tests, docs build, CLI pack |
| **Release** | new immutable tag `v*` | npm publish, GitHub release + tarball, GHCR image |
| **Deploy docs** | `gitbook/**` on `main` or `master` | GitHub Pages deployment only; never a product release |

### Cut a release

```bash
git switch master
git pull --ff-only origin master
git tag -a v0.5.22 -m "Release v0.5.22"
git push origin v0.5.22
```

Release tags matching `v*` are immutable. Never delete, recreate, or force-update
an existing release tag. If a release needs a code or packaging correction,
increment the patch version (for example, `v0.5.22` → `v0.5.23`) and create a
new tag. A failed workflow may only be rerun against its original tag and commit;
the tag itself must not move.

Release always attaches a stable asset name:

`https://github.com/Vijay-Duke/switchboard-router/releases/latest/download/switchboard-router.tgz`

### Secrets

See [`.github/SECRETS.md`](.github/SECRETS.md).

The npm package uses Trusted Publishing (OIDC), so the release workflow does not
use an `NPM_TOKEN`. `GITHUB_TOKEN` is provided automatically for GHCR and GitHub
Releases.

### Docs Pages

```bash
gh api -X POST repos/Vijay-Duke/switchboard-router/pages -f build_type=workflow
```

Site: https://vijay-duke.github.io/switchboard-router/

## License

MIT
