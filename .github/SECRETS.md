# GitHub Actions secrets & setup

Repo: `Vijay-Duke/switchboard-router`

## Required for npm publish (`Release` workflow)

No repository secret is required. npm publishing uses Trusted Publishing (OIDC),
and the workflow requests a short-lived credential with `id-token: write`.

The trusted publisher on npmjs.com must be configured with:

- Repository: `Vijay-Duke/switchboard-router`
- Workflow: `release.yml`
- Package: `switchboard-router`

Do not add an `NPM_TOKEN`; the release workflow intentionally has no token-based
fallback.

## Container registry

No registry secret is required. GitHub provides `GITHUB_TOKEN` automatically for
publishing `ghcr.io/vijay-duke/switchboard-router`.

## Docs (GitHub Pages)

No deploy key needed. Source must be **GitHub Actions** (not branch deploy).

```bash
# one-time (or Settings → Pages → Source: GitHub Actions)
gh api -X POST repos/Vijay-Duke/switchboard-router/pages -f build_type=workflow
```

Then push `gitbook/**` to master (or run **Deploy docs**).  
URL: https://vijay-duke.github.io/switchboard-router/

## Legacy 9router

This project was rebranded from **9router** (upstream `decolua/9router`).  
Old workflows deployed docs to `9router/9router.github.io` and Docker to `decolua/9router`.  
Those targets are **removed** — everything ships under Switchboard / this repo.
