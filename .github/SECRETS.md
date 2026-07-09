# GitHub Actions secrets & setup

Repo: `Vijay-Duke/switchboard-router`

## Required for npm publish (`Release` workflow)

| Secret | Purpose |
|--------|---------|
| `NPM_TOKEN` | npm **automation** token with publish access for the `switchboard-router` package (or the npm org that owns it). |

Create at https://www.npmjs.com/settings/~/tokens → Automation → copy into  
GitHub → Settings → Secrets and variables → Actions → New repository secret.

First-time package name: ensure you can `npm publish` as that user for `switchboard-router`.

## Optional Docker Hub

| Secret | Purpose |
|--------|---------|
| `DOCKERHUB_USERNAME` | Docker Hub user |
| `DOCKERHUB_TOKEN` | Access token |

If unset, release still publishes to **GHCR**:  
`ghcr.io/vijay-duke/switchboard-router`

## Docs (GitHub Pages)

No deploy key needed. Enable:

1. Settings → Pages → Source: **GitHub Actions**
2. Push to `master` with `gitbook/**` changes (or run **Deploy docs** workflow)

Site URL (project pages):  
`https://vijay-duke.github.io/switchboard-router/`

## Legacy 9router

This project was rebranded from **9router** (upstream `decolua/9router`).  
Old workflows deployed docs to `9router/9router.github.io` and Docker to `decolua/9router`.  
Those targets are **removed** — everything ships under Switchboard / this repo.
