# Plan: `omni beamup openclaw` + Permanent Sandbox Support

## Overview

Add `omni beamup openclaw` to launch OpenClaw (open-source agentic AI gateway) in an E2EE sandbox, and introduce "permanent" sandbox mode where instances don't auto-expire.

**Repos and dependency order:**
1. `omnirun` (server) — permanent timeout support + template spec + rootfs/snapshot scripts
2. `omnirun/sdk/typescript` — SDK type updates (same repo, published separately)
3. `omnirun` — deploy server, trigger template build
4. `omnirun-cli` — CLI commands + changeset + publish to npm

---

## Part 1: Permanent Sandbox Support (Server — `omnirun` repo)

### Context

Current timeout system enforces a hard cap of 24 hours (`MaxTimeout = 86400`). Sandboxes always auto-kill or auto-pause when their timer fires. We need a way to opt out of auto-expiry for long-running agents like OpenClaw.

### Design Decision: `timeout = 0` as "no expiry" sentinel

Using `0` is the simplest approach — it's already an invalid value (rejected by the API), so repurposing it as "permanent" is backward-compatible. No new struct fields needed.

**Note**: The CLI already forwards `--timeout 0` through `sandbox create` (`cli.ts:340`, `sandbox.ts:122`), so permanent mode will also work via the generic `omni sandbox create --timeout 0` path. Both the generic and beamup paths must be tested.

### Changes

#### 1. `internal/sandbox/sandbox.go`

- Add a new constant: `PermanentTimeout = 0`
- Update `MaxTimeout` comment to document the sentinel
- Update `EndAt()` to return `*time.Time` (pointer) so the JSON serializer omits the field when nil. This avoids leaking `"0001-01-01T00:00:00Z"` to clients.

```go
const (
    MaxTimeout       = 86400 // 24 hours max for non-permanent sandboxes
    PermanentTimeout = 0     // sentinel: no auto-expiry
)

// Change EndAt from time.Time to *time.Time
func (s *Sandbox) EndAt() *time.Time {
    if s.Timeout == PermanentTimeout {
        return nil // omitted from JSON = no expiry
    }
    t := s.CreatedAt.Add(time.Duration(s.Timeout) * time.Second)
    return &t
}
```

- Update the JSON struct tag for `endAt` to `omitempty` so nil serializes as absent.
- Add a `Permanent() bool` helper method: `return s.Timeout == PermanentTimeout`

#### 2. `internal/sandbox/manager.go`

- Update timeout resolution logic (lines 73-82): allow `timeout = 0` to pass through without capping
- Update `startTimer()`: skip `time.AfterFunc()` when timeout is 0

```go
// Timeout resolution
if opts.Timeout == PermanentTimeout {
    timeout = PermanentTimeout // explicit permanent request, skip cap
} else {
    // ... existing resolution logic ...
    if timeout > MaxTimeout {
        timeout = MaxTimeout
    }
}

// Timer creation
func (m *Manager) startTimer(sandboxID string) {
    sbx := m.boxes[sandboxID]
    if sbx.Timeout == PermanentTimeout {
        return // no timer for permanent sandboxes
    }
    // ... existing timer logic ...
}
```

#### 3. `internal/api/handlers_sandbox.go`

- Update `setTimeout` validation: allow `timeout = 0` as permanent
- Update `createSandbox` handler: pass through `timeout = 0`

```go
// Before:  if req.Timeout <= 0 { reject }
// After:   if req.Timeout < 0 { reject }
// 0 is now valid (permanent)
```

#### 4. `internal/sandbox/sandbox_test.go`

- Test: `timeout=0` → `EndAt()` returns nil, `Permanent()` returns true
- Test: `timeout=0` → no timer created in `startTimer()`
- Test: `timeout=0` survives `MaxTimeout` cap (not clamped to 86400)
- Test: `timeout=300` → `EndAt()` returns non-nil, `Permanent()` returns false

#### 5. SDK: `sdk/typescript/src/models.ts`

The `endAt` field is already typed as `endAt?: string` (optional). When the server omits `endAt` (nil pointer), the SDK will naturally receive `undefined`. No type change needed, but add a JSDoc comment:

```typescript
/** ISO timestamp when the sandbox expires. Absent for permanent sandboxes (timeout=0). */
endAt?: string;
```

Add a `permanent` computed field in the `SandboxInfo` mapping (`sandbox.ts`):

```typescript
/** True if sandbox has no auto-expiry (timeout=0). */
permanent: !s.endAt,
```

---

## Part 2: OpenClaw Template (Server — `omnirun` repo)

### Rootfs: `scripts/build-rootfs-openclaw.sh`

Based on the claude-code template pattern. Key differences:

- **Node.js 22** (OpenClaw requires Node >= 22, up from Node 20 used by other templates)
- **Install**: `npm install -g openclaw@latest`
- **User**: `coder` (non-root, same as other templates)

```dockerfile
FROM ubuntu:22.04

# ... base packages (same as claude-code) ...

# Node.js 22 (OpenClaw requires Node >= 22)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# OpenClaw
RUN npm install -g openclaw@latest

# ... seed-entropy, coder user (same pattern) ...
```

### Snapshot: `scripts/create-snapshot-openclaw.sh`

Same pattern as codex/gemini-cli. 4 vCPU, 8GB RAM.

### Template spec: `internal/sandbox/sandbox.go`

```go
"openclaw": {CpuCount: 4, MemoryMB: 8192, Internet: true, DefaultTimeout: 0},
```

`DefaultTimeout: 0` means OpenClaw sandboxes are permanent by default. Users can override with `--timeout <seconds>`.

### GitHub Actions: `.github/workflows/build-template.yml`

Add `openclaw` to the template choice options.

---

## Part 3: CLI — `omni beamup openclaw` (`omnirun-cli` repo)

### State Transfer via `instance.files.write()`

**Review finding addressed (v1)**: The original plan cherry-picked 3 files. OpenClaw stores auth in `agents/<id>/agent/auth-profiles.json`, legacy OAuth in `credentials/oauth.json`, and workspace state in `workspace/`. The migration docs recommend copying the entire state directory.

**Review finding addressed (v2)**: Inlining a base64-encoded tar (up to ~67MB after encoding) into a shell command string is too brittle — breaks command-line length limits and HTTP request body constraints.

**Solution**: Use the SDK's `instance.files.write()` to transfer the tarball as binary data, then extract on the sandbox side. The `files.write()` API handles upload via signed URLs (not shell strings), so it can handle large payloads reliably.

```typescript
async function discoverOpenClawStateDir(): Promise<string | null> {
  const stateDir = process.env.OPENCLAW_STATE_DIR
    ?? path.join(process.env.OPENCLAW_HOME ?? os.homedir(), ".openclaw");

  try {
    const stat = await fs.stat(stateDir);
    if (stat.isDirectory()) return stateDir;
  } catch {}

  return null;
}

async function transferOpenClawState(
  instance: SandboxConnection,
  stateDir: string,
  targetDir: string,
  sandboxUser: string,
): Promise<void> {
  // 1. Create tar archive locally (excluding large caches)
  const execFileAsync = promisify(execFile);
  const { stdout: tarBuffer } = await execFileAsync("tar", [
    "czf", "-",
    "--exclude", "memory/lancedb",
    "--exclude", "nodes",
    "-C", path.dirname(stateDir),
    path.basename(stateDir),
  ], { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 });

  // 2. Upload tarball via files.write (uses signed URLs, handles large payloads)
  const tarPath = "/tmp/openclaw-state.tar.gz";
  await instance.files.write(tarPath, new Uint8Array(tarBuffer));

  // 3. Extract on sandbox side, renaming to target dir
  //    Source dir is path.basename(stateDir) (e.g. ".openclaw").
  //    Target dir is e.g. "/tmp/openclaw-state".
  //    Extract to a temp location, then move to target.
  const extractDir = "/tmp/openclaw-extract";
  await instance.commands.run(
    `mkdir -p ${extractDir} && ` +
    `tar xzf ${tarPath} -C ${extractDir} && ` +
    `mv ${extractDir}/${path.basename(stateDir)} ${targetDir} && ` +
    `rm -rf ${extractDir} ${tarPath}`
  );
  await instance.commands.run(`chmod -R 700 ${targetDir}`);
  await instance.commands.run(`chown -R ${sandboxUser}:${sandboxUser} ${targetDir}`);
}
```

**Key details:**
- `tar` creates from `path.basename(stateDir)` (e.g. `.openclaw`) with `-C path.dirname(stateDir)`
- Upload via `files.write()` to `/tmp/openclaw-state.tar.gz` (binary, not shell string)
- Extract to `/tmp/openclaw-extract/`, then `mv` the inner dir (`.openclaw`) to `targetDir` (`/tmp/openclaw-state`)
- This handles the path mismatch: source basename `.openclaw` ≠ target basename `openclaw-state`

### Runtime Environment

**Review finding addressed**: OpenClaw distinguishes `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_CONFIG_PATH`. Setting only `OPENCLAW_HOME` causes path resolution issues.

**Solution**: Set `OPENCLAW_STATE_DIR` explicitly (it takes precedence over `OPENCLAW_HOME` for all state resolution). Also set `OPENCLAW_CONFIG_PATH` to point at the config file inside the state dir.

```typescript
const targetDir = `/tmp/openclaw-state`;
const envSetup = [
  `export OPENCLAW_STATE_DIR=${targetDir}`,
  `export OPENCLAW_CONFIG_PATH=${targetDir}/openclaw.json`,
].join("; ");
const fullCommand = `su - ${sandboxUser} -c '${envSetup}; openclaw tui'`;
```

### Command Definition

```
omni beamup openclaw [options]
```

**Flags:**
- `--template <id>` — Sandbox template ID (default: `openclaw`)
- `--permanent` — Don't auto-expire the sandbox (default: true for openclaw)
- `--timeout <seconds>` — Override with fixed timeout (overrides --permanent)
- `--no-internet` — Disable internet access
- `--no-e2ee` — Disable E2EE
- `--skip-auth-transfer` — Don't transfer credentials
- `--env <key=value>` — Extra environment variables
- `-y, --yes` — Skip interactive prompts

### Interactive Prompt Flow

1. **Auth transfer** — `confirm`: "Transfer local OpenClaw state to sandbox?" (default: yes)
2. **Permanent mode** — `confirm`: "Keep sandbox running permanently?" (default: yes)
3. **Network** — `confirm`: "Enable full internet access?" (default: yes)
4. If not permanent: **Timeout** — `input`: "Sandbox timeout in seconds:" (default: "3600")

### Non-TTY / Gateway Reconnect

**Review finding addressed**: There is no `omni sandbox pty <id>` command. The SDK has `getHost(port)` which returns `https://<sandboxId>-<port>.claudebox.io`. For OpenClaw as a gateway, we should print the actual gateway URL.

**Solution**: After sandbox creation, use `instance.getHost(4767)` (OpenClaw's default gateway port) to print a usable gateway URL. In non-TTY mode, start the gateway daemon and print connection details.

```typescript
if (process.stdin.isTTY) {
  console.log("Attaching to OpenClaw TUI...\n");
  await attachPty(instance, fullCommand);
} else {
  // Start gateway daemon in background
  const daemonCommand = `su - ${sandboxUser} -c '${envSetup}; openclaw gateway start'`;
  await instance.commands.run(daemonCommand, { background: true });

  const gatewayUrl = instance.getHost(4767);
  console.log("OpenClaw gateway started in background.");
  console.log(`Sandbox ID: ${instance.sandboxId}`);
  console.log(`Gateway URL: ${gatewayUrl}`);
  console.log(`Reconnect: omni sandbox info ${instance.sandboxId}`);
}
```

---

## Part 4: `--permanent` Flag for All Beamup Commands (`omnirun-cli` repo)

**Review finding addressed**: The current Claude/Codex/Gemini flows hard-default to 3600 in both interactive and non-interactive mode. Adding `--permanent` without changing those defaults would be inconsistent.

### Design

| Command | Default (interactive) | Default (-y / non-TTY) | --permanent |
|---------|----------------------|----------------------|-------------|
| `beamup claude` | Prompt for timeout (default 3600) | 3600 | timeout=0 |
| `beamup codex` | Prompt for timeout (default 3600) | 3600 | timeout=0 |
| `beamup gemini` | Prompt for timeout (default 3600) | 3600 | timeout=0 |
| `beamup openclaw` | Prompt for permanent (default yes) | permanent (timeout=0) | timeout=0 |

### Flag Precedence

1. `--timeout <N>` wins over everything (explicit value)
2. `--permanent` sets timeout=0 (explicit flag)
3. Default behavior per command (as table above)

### Implementation

Add to each beamup command:
```typescript
.option("--permanent", "Don't auto-expire the sandbox (timeout=0)")
```

Update timeout resolution in each command's action:
```typescript
let timeout: number;
if (options.timeout != null) {
  timeout = parseInteger(options.timeout, "timeout");
} else if (options.permanent) {
  timeout = 0;
} else if (isPermanentByDefault) {
  // OpenClaw: default permanent in both interactive and non-interactive
  timeout = useDefaults
    ? 0
    : (await promptConfirm("Keep sandbox running permanently?", true)) ? 0
    : parseInteger(await promptInput("Sandbox timeout in seconds:", "3600"), "timeout");
} else {
  // Claude/Codex/Gemini: default 3600
  timeout = useDefaults
    ? 3600
    : parseInteger(await promptInput("Sandbox timeout in seconds:", "3600"), "timeout");
}
```

---

## Part 5: CLI Tests (`omnirun-cli` repo)

**Review finding addressed**: No beamup test coverage exists in `cli.test.mjs`. Tests must cover timeout/permanent precedence, state-dir discovery/skip, and non-TTY output.

### Test Cases

Add to `tests/cli.test.mjs`:

```javascript
// -- Timeout / permanent precedence --

await runCase("beamup claude --permanent -y passes timeout=0", async () => {
  const state = makeState();
  await runCli(["beamup", "claude", "--permanent", "-y"], state);
  assert.equal(state.creates[0].options.timeout, 0);
});

await runCase("beamup claude --timeout 600 -y passes timeout=600", async () => {
  const state = makeState();
  await runCli(["beamup", "claude", "--timeout", "600", "-y"], state);
  assert.equal(state.creates[0].options.timeout, 600);
});

await runCase("beamup claude --timeout 600 --permanent -y: --timeout wins", async () => {
  const state = makeState();
  await runCli(["beamup", "claude", "--timeout", "600", "--permanent", "-y"], state);
  assert.equal(state.creates[0].options.timeout, 600);
});

await runCase("beamup openclaw -y defaults to permanent (timeout=0)", async () => {
  const state = makeState();
  await runCli(["beamup", "openclaw", "-y"], state);
  assert.equal(state.creates[0].options.timeout, 0);
});

await runCase("beamup openclaw --timeout 3600 -y overrides permanent default", async () => {
  const state = makeState();
  await runCli(["beamup", "openclaw", "--timeout", "3600", "-y"], state);
  assert.equal(state.creates[0].options.timeout, 3600);
});

// -- State-dir discovery / skip --

await runCase("beamup openclaw --skip-auth-transfer -y skips state transfer", async () => {
  const state = makeState();
  const result = await runCli(["beamup", "openclaw", "--skip-auth-transfer", "-y"], state);
  // Verify no file writes for openclaw state
  const stateWrites = state.fileWrites.filter(w => w.path.includes("openclaw"));
  assert.equal(stateWrites.length, 0);
});

await runCase("beamup openclaw -y warns when no state dir found", async () => {
  const state = makeState();
  // With OPENCLAW_STATE_DIR pointing to nonexistent dir, should warn
  const origEnv = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = "/tmp/nonexistent-openclaw-test-dir";
  try {
    const result = await runCli(["beamup", "openclaw", "-y"], state);
    assert.match(result.errors, /No OpenClaw state/i);
  } finally {
    if (origEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = origEnv;
  }
});

// -- Non-TTY output --

await runCase("beamup openclaw -y in non-TTY prints gateway URL and sandbox ID", async () => {
  const state = makeState();
  // process.stdin.isTTY is already falsy in test environment
  const result = await runCli(["beamup", "openclaw", "-y"], state);
  assert.match(result.logs, /sandbox_id=/);
  assert.match(result.logs, /Gateway URL:/i);
});
```

**Notes:**
- Tests run in non-TTY context (no `process.stdin.isTTY`), so the `-y` path and non-TTY branch are naturally exercised.
- `FakeSandbox.create` captures `options` including `timeout`, so we assert on `state.creates[0].options.timeout`.
- `discoverOpenClawStateDir` returns null in test (no `~/.openclaw/`), so auth transfer is skipped unless we mock the env var.
- Beamup commands need the `createProgram` DI pattern (already used by existing tests) to inject `FakeSandbox`.

---

## Implementation Order

### Phase 1: Server — Permanent sandbox support (`omnirun` repo)
1. Update `sandbox.go` — `PermanentTimeout` const, `EndAt()` → `*time.Time`, `Permanent()` method, `openclaw` template spec
2. Update `manager.go` — timeout resolution, skip timer for timeout=0
3. Update `handlers_sandbox.go` — allow timeout=0 in validation
4. Update `sandbox_test.go` — permanent timeout tests
5. Update `sdk/typescript/src/models.ts` — JSDoc for `endAt`, add `permanent` field
6. Commit, push, deploy server (`systemctl restart omnirun`)

### Phase 2: OpenClaw template (`omnirun` repo)
7. Create `build-rootfs-openclaw.sh` (Node.js 22 + openclaw)
8. Create `create-snapshot-openclaw.sh`
9. Add `openclaw` to GitHub Actions workflow
10. Trigger template build via workflow dispatch

### Phase 3: CLI (`omnirun-cli` repo)
11. Add `discoverOpenClawStateDir()` and `transferOpenClawState()` helpers
12. Add `beamup openclaw` command with full state transfer + `OPENCLAW_STATE_DIR`
13. Add `--permanent` flag to all beamup commands with correct precedence
14. Add test cases in `cli.test.mjs`
15. Create changeset (minor bump)
16. Push → CI creates version PR → merge → publish to npm

### Phase 4: Landing page (optional, `omnirun` repo)
17. OpenClaw prelaunch page already exists at `/openclaw-sandbox`
18. Update once template is live (remove "prelaunch" label)

---

## Files Modified

### `omnirun` repo (server)
| File | Changes |
|------|---------|
| `internal/sandbox/sandbox.go` | `PermanentTimeout` const, `EndAt()` → `*time.Time`, `Permanent()`, `openclaw` template spec |
| `internal/sandbox/manager.go` | Skip timer for timeout=0, allow 0 through cap logic |
| `internal/api/handlers_sandbox.go` | Allow timeout=0 in validation |
| `internal/sandbox/sandbox_test.go` | Permanent timeout tests |
| `sdk/typescript/src/models.ts` | JSDoc for `endAt`, `permanent` computed field |
| `scripts/build-rootfs-openclaw.sh` | New file (Node.js 22 + openclaw rootfs) |
| `scripts/create-snapshot-openclaw.sh` | New file |
| `.github/workflows/build-template.yml` | Add `openclaw` option |

### `omnirun-cli` repo (CLI)
| File | Changes |
|------|---------|
| `src/cli.ts` | `discoverOpenClawStateDir()`, `transferOpenClawState()`, `beamup openclaw`, `--permanent` on all beamup commands |
| `tests/cli.test.mjs` | Beamup permanent/timeout tests, state-dir discovery tests, non-TTY output tests |

---

## Verification

1. `go build ./...` — server compiles
2. `go test ./internal/sandbox/` — tests pass including permanent timeout
3. `npm run build` — CLI compiles
4. `npm test` — CLI tests pass including new beamup tests
5. `omni beamup openclaw --help` — verify command/flag registration
6. Template build workflow succeeds for `openclaw`
7. E2E: `omni sandbox create python-3.11 --timeout 0` — verify permanent via generic path
8. E2E: `omni beamup openclaw` → state transferred, TUI launches, sandbox doesn't expire
9. E2E: `omni beamup claude --permanent` → sandbox stays alive indefinitely
10. E2E: `omni beamup openclaw --timeout 3600` → overrides permanent default, expires after 1h

---

## Operational Concerns

- **Resource leaks**: Permanent sandboxes consume 8GB RAM each. Max ~7 concurrent on current server (62GB). Consider adding a quota per API key.
- **Monitoring**: Log permanent sandbox creation distinctly for alerting. Add `permanent` field to sandbox list/info API responses.
- **Cleanup**: Users must manually `omni sandbox kill <id>`. Consider adding `omni sandbox list --permanent` filter.
- **Billing**: Permanent sandboxes need a different billing model (hourly vs. session-based). Document this for pricing page.
- **Future: `omni sandbox attach <id>`**: Not in scope, but would improve reconnect UX for all beamup commands (not just OpenClaw). Track as a follow-up.
