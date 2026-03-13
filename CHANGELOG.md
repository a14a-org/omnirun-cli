# @omnirun/cli

## 0.5.1

### Patch Changes

- 692bd4d: Bump @omnirun/sdk dependency to >=0.3.1 to include exposures module

## 0.5.0

### Minor Changes

- 21eea4e: Add preview URL commands (expose, exposures, close, refresh-exposure) and --expose flag on beamup commands

## 0.4.1

### Patch Changes

- e3d63d9: feat: guided OpenClaw setup when no local state exists. Prompts for API keys with masked input, generates minimal config on the sandbox, and auto-generates a gateway auth token.

## 0.4.0

### Minor Changes

- 224c429: Add `omni beamup codex` and `omni beamup gemini` commands for launching OpenAI Codex CLI and Google Gemini CLI in E2EE sandboxes with automatic credential transfer
- 6755ae9: feat: add `omni beamup openclaw` and `--permanent` flag for all beamup commands

  - `omni beamup openclaw`: Launch OpenClaw in an E2EE sandbox with full state directory transfer via `files.write()`. Permanent by default (timeout=0).
  - `--permanent` flag on `beamup claude`, `beamup codex`, `beamup gemini`: Creates sandboxes that never auto-expire.
  - Timeout precedence: `--timeout` > `--permanent` > command default.
  - Non-TTY mode for openclaw prints gateway URL via `getHost(4767)`.
  - Refactored CLI to export `createProgram()` for DI-based testing.

## 0.3.3

### Patch Changes

- bfee67a: Fix credential transfer: read OAuth tokens from macOS Keychain, use CLAUDE_CONFIG_DIR for sandbox auth

## 0.3.2

### Patch Changes

- 13830b0: Use pre-baked coder user instead of runtime useradd in sandbox

## 0.3.1

### Patch Changes

- 5e6988f: Run Claude Code as non-root user in sandbox to fix permission restrictions

## 0.3.0

### Minor Changes

- d971908: Add `omni beamup claude` command to launch Claude Code in an E2EE sandbox with automatic credential transfer

## 0.2.0

### Minor Changes

- Replace manual API key entry with email-based OTP authentication in `omni auth init`
