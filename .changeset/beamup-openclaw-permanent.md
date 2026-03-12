---
"@omnirun/cli": minor
---

feat: add `omni beamup openclaw` and `--permanent` flag for all beamup commands

- `omni beamup openclaw`: Launch OpenClaw in an E2EE sandbox with full state directory transfer via `files.write()`. Permanent by default (timeout=0).
- `--permanent` flag on `beamup claude`, `beamup codex`, `beamup gemini`: Creates sandboxes that never auto-expire.
- Timeout precedence: `--timeout` > `--permanent` > command default.
- Non-TTY mode for openclaw prints gateway URL via `getHost(4767)`.
- Refactored CLI to export `createProgram()` for DI-based testing.
