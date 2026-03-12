# @omnirun/cli

CLI for basic OmniRun sandbox creation and interaction, built on `@omnirun/sdk`.

Primary command: `omni`

Compatibility alias: `omnirun`

## Install (local dev)

```bash
cd /Users/dafmulder/Documents/code/omnirun-cli
npm install
npm run build
npm link
```

Then run:

```bash
omni --help
```

## Auth bootstrap

Create or update `.env` with API URL and key:

```bash
omni auth init --api-url https://api.omnirun.io --api-key <your_key>
```

This writes:

- `OMNIRUN_API_URL`
- `OMNIRUN_API_KEY`

By default it writes to `./.env`. You can override with `--env-path`.

## Sandbox commands

Create a sandbox:

```bash
omni sandbox create python-3.11 --internet
```

Create secure + E2EE bootstrap sandbox:

```bash
omni sandbox create python-3.11 --secure --e2ee
```

List sandboxes:

```bash
omni sandbox list
```

Show sandbox details:

```bash
omni sandbox info <sandbox_id>
```

Kill sandbox:

```bash
omni sandbox kill <sandbox_id>
```

Create a temporary preview URL for a web app running inside the sandbox:

```bash
omni sandbox expose <sandbox_id> 3000 --path /app
omni sandbox exposures <sandbox_id>
omni sandbox close <sandbox_id> <preview_id>
```

## Command execution

Run a command:

```bash
omni command run <sandbox_id> "echo hello"
```

Stream output live:

```bash
omni command run <sandbox_id> "python -u -c 'import time\nfor i in range(3):\n print(i)\n time.sleep(1)'" --stream
```

Run in background:

```bash
omni command run <sandbox_id> "sleep 20" --background
omni command ps <sandbox_id>
omni command kill <sandbox_id> <pid>
```

## Beamup previews

You can request preview URLs during launcher flows without blocking on readiness:

```bash
omni beamup claude --expose 3000 -y
omni beamup codex --expose 5173 --preview-path /app -y
```

## Global options

Use these on any command:

- `--api-url <url>`
- `--api-key <key>`
- `--env-path <path>`
- `--request-timeout <ms>`
- `--json`

Environment variables are also supported:

- `OMNIRUN_API_URL`
- `OMNIRUN_API_KEY`

## Release automation

This repo is configured for Changesets-based npm publishing.

- CI workflow: `.github/workflows/ci.yml`
- Release workflow: `.github/workflows/release.yml`

For GitHub Actions publishing, configure repository secret:

- `NPM_TOKEN` (token with publish access for `@omnirun/cli`)

Release flow:

1. Add a changeset with `npm run changeset`.
2. Push to `main`.
3. Changesets action opens/updates a release PR with version bumps/changelog.
4. Merge that PR to publish automatically to npm.
