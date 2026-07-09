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
| **Release** | tag `v*` or Actions → Release | npm publish, GitHub release + tarball, GHCR image |
| **Deploy docs** | `gitbook/**` on master | GitHub Pages |

### Cut a release

```bash
git tag v0.5.21
git push origin v0.5.21
```

Or: **Actions → Release → Run workflow** → enter version without `v`.

Release always attaches a stable asset name:

`https://github.com/Vijay-Duke/switchboard-router/releases/latest/download/switchboard-router.tgz`

### Secrets

See [`.github/SECRETS.md`](.github/SECRETS.md).

| Secret | Required for |
|--------|----------------|
| `NPM_TOKEN` | `npm publish` of `switchboard-router` |

`GITHUB_TOKEN` is enough for GHCR and GitHub Releases.

### Docs Pages

```bash
gh api -X POST repos/Vijay-Duke/switchboard-router/pages -f build_type=workflow
```

Site: https://vijay-duke.github.io/switchboard-router/

## License

MIT
