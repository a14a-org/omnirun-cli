import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createProgram } from "../dist/cli.js";

class FakeCommandExitException extends Error {}

function makeSdk(state) {
  class FakeSandboxConnection {
    constructor(sandboxId) {
      this.sandboxId = sandboxId;
      this.trafficAccessToken = "";
      this.e2ee = null;
      this.commands = {
        run: async () => ({ stdout: "/home/coder\n", stderr: "", exitCode: 0 }),
        list: async () => [],
        kill: async (pid) => {
          state.commandKills.push(pid);
        },
      };
      this.files = {
        read: async (targetPath, format) => {
          state.fileReads.push({ path: targetPath, format: format ?? "text" });
          return "file-body";
        },
        write: async (targetPath, content) => {
          state.fileWrites.push({ path: targetPath, content });
          return {
            path: targetPath,
            name: path.basename(targetPath),
            isDir: false,
            size: typeof content === "string" ? content.length : content.length,
          };
        },
        list: async (targetPath) => {
          state.fileLists.push(targetPath);
          return [];
        },
        makeDir: async (targetPath) => {
          state.dirCreates.push(targetPath);
        },
      };
      this.pty = {
        create: async ({ cols, rows }) => {
          state.ptyCreates.push({ cols, rows });
          return {
            pid: 99,
            sendStdin: async () => {},
            read: async () => null,
            resize: async () => {},
          };
        },
      };
      this.production = {
        metrics: async () => ({
          cpuTimeMs: 20,
          memoryUsedMb: 32,
          diskUsedMb: 12,
          networkRxKb: 4,
          networkTxKb: 2,
          commandCount: 1,
          uptime: "2026-03-06T12:00:00Z",
        }),
      };
      this.desktop = {
        screenshot: async () => {
          state.desktopActions.push({ action: "screenshot" });
          return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
        },
        mouse: async (opts) => {
          state.desktopActions.push({ action: "mouse", ...opts });
        },
        keyboard: async (opts) => {
          state.desktopActions.push({ action: "keyboard", ...opts });
        },
        getScreen: async () => {
          state.desktopActions.push({ action: "getScreen" });
          return { width: 1024, height: 768, cursorX: 512, cursorY: 384 };
        },
        getStreamInfo: async () => {
          state.desktopActions.push({ action: "getStreamInfo" });
          return { novncPort: 6080, vncPort: 5900, wsPath: "/websockify" };
        },
      };
      this.exposures = {
        create: async (port, options = {}) => {
          const exposure = {
            id: `exp-${state.previewCreates.length + 1}`,
            sandboxId: this.sandboxId,
            port,
            hostname: `preview-${port}.omnirun-preview.dev`,
            url: `https://preview-${port}.omnirun-preview.dev${options.openPath ?? ""}`,
            accessUrl: options.visibility === "private"
              ? `https://preview-${port}.omnirun-preview.dev${options.openPath ?? ""}?token=secret`
              : undefined,
            visibility: options.visibility ?? "public",
            status: "ready",
            createdAt: "2026-03-12T00:00:00Z",
            expiresAt: "2026-03-12T01:00:00Z",
            openPath: options.openPath,
            preserveHost: options.preserveHost ?? true,
          };
          state.previewCreates.push({ sandboxId: this.sandboxId, port, options });
          state.previewRecords.push(exposure);
          return exposure;
        },
        list: async () => state.previewRecords.filter((record) => record.sandboxId === this.sandboxId),
        get: async (exposureId) => {
          const exposure = state.previewRecords.find((record) => record.id === exposureId);
          return exposure ?? null;
        },
        refresh: async (exposureId, options = {}) => {
          const exposure = state.previewRecords.find((record) => record.id === exposureId);
          if (!exposure) throw new Error("exposure not found");
          state.previewRefreshes.push({ sandboxId: this.sandboxId, exposureId, options });
          return exposure;
        },
        close: async (exposureId) => {
          state.previewCloses.push({ sandboxId: this.sandboxId, exposureId });
          const exposure = state.previewRecords.find((record) => record.id === exposureId);
          if (exposure) {
            exposure.status = "revoked";
          }
        },
      };
    }

    getHost(port) {
      return `https://${this.sandboxId}-${port}.claudebox.io`;
    }

    async getInfo() {
      return {
        sandboxId: this.sandboxId,
        templateId: "python-3.11",
        state: "running",
        startedAt: "2026-03-06T12:00:00Z",
        cpuCount: 2,
        memoryMB: 512,
      };
    }

    async kill() {
      state.sandboxKills.push(this.sandboxId);
    }
  }

  class FakeSandbox {
    static async create(template, options) {
      state.creates.push({ template, options });
      return new FakeSandboxConnection("sbx-created");
    }

    static async connect(sandboxId) {
      state.connects.push(sandboxId);
      return new FakeSandboxConnection(sandboxId);
    }

    static async list() {
      return [];
    }
  }

  return {
    Sandbox: FakeSandbox,
    CommandExitException: FakeCommandExitException,
  };
}

function makeState() {
  return {
    creates: [],
    connects: [],
    sandboxKills: [],
    fileReads: [],
    fileWrites: [],
    fileLists: [],
    fileRemovals: [],
    dirCreates: [],
    desktopActions: [],
    ptyCreates: [],
    commandKills: [],
    networkPolicies: [],
    previewCreates: [],
    previewRecords: [],
    previewRefreshes: [],
    previewCloses: [],
  };
}

async function runCli(args, state) {
  const program = createProgram(makeSdk(state));
  program.exitOverride();

  const stdout = [];
  const stderr = [];
  const logs = [];
  const errors = [];

  const originalEnv = {
    apiKey: process.env.OMNIRUN_API_KEY,
    apiUrl: process.env.OMNIRUN_API_URL,
  };
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  process.env.OMNIRUN_API_KEY = "test-key";
  process.env.OMNIRUN_API_URL = "https://api.example.test";

  process.stdout.write = ((chunk, encoding, cb) => {
    stdout.push(String(chunk));
    if (typeof cb === "function") cb();
    return true;
  });
  process.stderr.write = ((chunk, encoding, cb) => {
    stderr.push(String(chunk));
    if (typeof cb === "function") cb();
    return true;
  });
  console.log = (...values) => {
    logs.push(values.join(" "));
  };
  console.error = (...values) => {
    errors.push(values.join(" "));
  };
  console.warn = (...values) => {
    errors.push(values.join(" "));
  };

  try {
    await program.parseAsync(["node", "omni", ...args]);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    process.env.OMNIRUN_API_KEY = originalEnv.apiKey;
    process.env.OMNIRUN_API_URL = originalEnv.apiUrl;
  }

  return {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    logs: logs.join("\n"),
    errors: errors.join("\n"),
  };
}

async function runCase(name, fn) {
  await fn();
  console.log(`ok - ${name}`);
}

// ── help ──

await runCase("help shows top-level command groups", async () => {
  const program = createProgram(makeSdk(makeState()));
  const help = program.helpInformation();
  assert.match(help, /\bsandbox\b/);
  assert.match(help, /\bcommand\b/);
  assert.match(help, /\bbeamup\b/);
});

// ── sandbox commands ──

await runCase("sandbox info connects and prints details", async () => {
  const state = makeState();
  const result = await runCli(["sandbox", "info", "sbx-1"], state);
  assert.equal(state.connects[0], "sbx-1");
  assert.match(result.logs, /sandbox_id=sbx-1/);
  assert.match(result.logs, /state=running/);
});

await runCase("sandbox kill terminates sandbox", async () => {
  const state = makeState();
  const result = await runCli(["sandbox", "kill", "sbx-1"], state);
  assert.equal(state.sandboxKills[0], "sbx-1");
  assert.match(result.logs, /killed=sbx-1/);
});

await runCase("sandbox expose creates a preview URL and waits by default", async () => {
  const state = makeState();
  const result = await runCli(["sandbox", "expose", "sbx-1", "3000", "--path", "/app"], state);
  assert.equal(state.previewCreates.length, 1);
  assert.equal(state.previewCreates[0].port, 3000);
  assert.equal(state.previewCreates[0].options.openPath, "/app");
  assert.match(result.logs, /preview_url=https:\/\/preview-3000\.omnirun-preview\.dev\/app/);
});

await runCase("sandbox exposures lists preview URLs", async () => {
  const state = makeState();
  state.previewRecords.push({
    id: "exp-1",
    sandboxId: "sbx-1",
    port: 3000,
    hostname: "preview-3000.omnirun-preview.dev",
    url: "https://preview-3000.omnirun-preview.dev",
    visibility: "public",
    status: "ready",
    createdAt: "2026-03-12T00:00:00Z",
    expiresAt: "2026-03-12T01:00:00Z",
    preserveHost: true,
  });
  const result = await runCli(["sandbox", "exposures", "sbx-1"], state);
  assert.match(result.logs, /id=exp-1/);
  assert.match(result.logs, /url=https:\/\/preview-3000\.omnirun-preview\.dev/);
});

await runCase("sandbox close closes a preview URL", async () => {
  const state = makeState();
  state.previewRecords.push({
    id: "exp-1",
    sandboxId: "sbx-1",
    port: 3000,
    hostname: "preview-3000.omnirun-preview.dev",
    url: "https://preview-3000.omnirun-preview.dev",
    visibility: "public",
    status: "ready",
    createdAt: "2026-03-12T00:00:00Z",
    expiresAt: "2026-03-12T01:00:00Z",
    preserveHost: true,
  });
  const result = await runCli(["sandbox", "close", "sbx-1", "exp-1"], state);
  assert.equal(state.previewCloses[0].exposureId, "exp-1");
  assert.match(result.logs, /closed_preview=exp-1/);
});

await runCase("sandbox refresh-exposure refreshes a preview URL", async () => {
  const state = makeState();
  state.previewRecords.push({
    id: "exp-1",
    sandboxId: "sbx-1",
    port: 3000,
    hostname: "preview-3000.omnirun-preview.dev",
    url: "https://preview-3000.omnirun-preview.dev",
    visibility: "public",
    status: "ready",
    createdAt: "2026-03-12T00:00:00Z",
    expiresAt: "2026-03-12T01:00:00Z",
    preserveHost: true,
  });
  const result = await runCli(
    ["sandbox", "refresh-exposure", "sbx-1", "exp-1", "--ttl", "1800"],
    state
  );
  assert.equal(state.previewRefreshes[0].exposureId, "exp-1");
  assert.equal(state.previewRefreshes[0].options.ttlSeconds, 1800);
  assert.match(result.logs, /preview_id=exp-1/);
});

// ── beamup claude ──

await runCase("beamup claude -y creates sandbox with default timeout", async () => {
  const state = makeState();
  await runCli(["beamup", "claude", "-y"], state);
  assert.equal(state.creates.length, 1);
  assert.equal(state.creates[0].template, "claude-code");
  assert.equal(state.creates[0].options.timeout, 3600);
});

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

await runCase("beamup claude -y --skip-auth-transfer skips credential transfer", async () => {
  const state = makeState();
  const result = await runCli(["beamup", "claude", "-y", "--skip-auth-transfer"], state);
  // Should not log "Found Claude credentials"
  assert.ok(!result.logs.includes("Found Claude credentials"));
});

await runCase("beamup claude --expose 3000 -y creates a preview URL", async () => {
  const state = makeState();
  const result = await runCli(["beamup", "claude", "--expose", "3000", "-y"], state);
  assert.equal(state.previewCreates.length, 1);
  assert.equal(state.previewCreates[0].port, 3000);
  assert.match(result.logs, /preview_url=https:\/\/preview-3000\.omnirun-preview\.dev/);
});

// ── beamup codex ──

await runCase("beamup codex -y creates sandbox with codex template", async () => {
  const state = makeState();
  await runCli(["beamup", "codex", "-y"], state);
  assert.equal(state.creates[0].template, "codex");
  assert.equal(state.creates[0].options.timeout, 3600);
});

await runCase("beamup codex --permanent -y passes timeout=0", async () => {
  const state = makeState();
  await runCli(["beamup", "codex", "--permanent", "-y"], state);
  assert.equal(state.creates[0].options.timeout, 0);
});

// ── beamup gemini ──

await runCase("beamup gemini -y creates sandbox with gemini-cli template", async () => {
  const state = makeState();
  await runCli(["beamup", "gemini", "-y"], state);
  assert.equal(state.creates[0].template, "gemini-cli");
  assert.equal(state.creates[0].options.timeout, 3600);
});

await runCase("beamup gemini --permanent -y passes timeout=0", async () => {
  const state = makeState();
  await runCli(["beamup", "gemini", "--permanent", "-y"], state);
  assert.equal(state.creates[0].options.timeout, 0);
});

// ── beamup openclaw ──

await runCase("beamup openclaw -y defaults to permanent (timeout=0)", async () => {
  const state = makeState();
  await runCli(["beamup", "openclaw", "-y"], state);
  assert.equal(state.creates[0].template, "openclaw");
  assert.equal(state.creates[0].options.timeout, 0);
});

await runCase("beamup openclaw --timeout 3600 -y overrides permanent default", async () => {
  const state = makeState();
  await runCli(["beamup", "openclaw", "--timeout", "3600", "-y"], state);
  assert.equal(state.creates[0].options.timeout, 3600);
});

await runCase("beamup openclaw --skip-auth-transfer -y skips state transfer", async () => {
  const state = makeState();
  await runCli(["beamup", "openclaw", "--skip-auth-transfer", "-y"], state);
  // No file writes for openclaw state
  const stateWrites = state.fileWrites.filter(w => w.path.includes("openclaw"));
  assert.equal(stateWrites.length, 0);
});

await runCase("beamup openclaw -y warns when no state dir found", async () => {
  const state = makeState();
  const origEnv = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = "/tmp/nonexistent-openclaw-test-dir-" + Date.now();
  try {
    const result = await runCli(["beamup", "openclaw", "-y"], state);
    assert.match(result.errors, /No OpenClaw state/i);
  } finally {
    if (origEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = origEnv;
  }
});

await runCase("beamup openclaw -y in non-TTY prints gateway URL and sandbox ID", async () => {
  const state = makeState();
  const result = await runCli(["beamup", "openclaw", "-y"], state);
  assert.match(result.logs, /sandbox_id=/);
  assert.match(result.logs, /Gateway URL:/i);
});

// ── openclaw fresh setup (non-interactive path) ──

await runCase("beamup openclaw -y without local state writes no config (non-TTY)", async () => {
  const state = makeState();
  const origEnv = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = "/tmp/nonexistent-openclaw-" + Date.now();
  try {
    await runCli(["beamup", "openclaw", "-y"], state);
    // In non-TTY/-y mode, no guided setup — just a warning
    const configWrites = state.fileWrites.filter(w => w.path.includes("openclaw"));
    assert.equal(configWrites.length, 0);
  } finally {
    if (origEnv === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = origEnv;
  }
});

// ── desktop commands ──

await runCase("desktop screenshot connects and captures image", async () => {
  const state = makeState();
  const result = await runCli(["desktop", "screenshot", "sbx-1", "--output", "/tmp/test-shot.png"], state);
  assert.equal(state.connects[0], "sbx-1");
  assert.equal(state.desktopActions[0].action, "screenshot");
  assert.match(result.logs, /Screenshot saved/);
});

await runCase("desktop click sends click action with coordinates", async () => {
  const state = makeState();
  const result = await runCli(["desktop", "click", "sbx-1", "100", "200"], state);
  assert.equal(state.connects[0], "sbx-1");
  assert.deepEqual(state.desktopActions[0], { action: "mouse", action: "click", x: 100, y: 200 });
  assert.match(result.logs, /Clicked at \(100, 200\)/);
});

await runCase("desktop click --right sends rightClick action", async () => {
  const state = makeState();
  const result = await runCli(["desktop", "click", "sbx-1", "50", "75", "--right"], state);
  assert.deepEqual(state.desktopActions[0], { action: "mouse", action: "rightClick", x: 50, y: 75 });
});

await runCase("desktop click --double sends doubleClick action", async () => {
  const state = makeState();
  await runCli(["desktop", "click", "sbx-1", "300", "400", "--double"], state);
  assert.deepEqual(state.desktopActions[0], { action: "mouse", action: "doubleClick", x: 300, y: 400 });
});

await runCase("desktop type sends keyboard type action", async () => {
  const state = makeState();
  const result = await runCli(["desktop", "type", "sbx-1", "hello world"], state);
  assert.equal(state.connects[0], "sbx-1");
  assert.deepEqual(state.desktopActions[0], { action: "keyboard", action: "type", text: "hello world" });
  assert.match(result.logs, /Typed: hello world/);
});

await runCase("desktop press sends keyboard press action", async () => {
  const state = makeState();
  const result = await runCli(["desktop", "press", "sbx-1", "Return"], state);
  assert.deepEqual(state.desktopActions[0], { action: "keyboard", action: "press", key: "Return" });
  assert.match(result.logs, /Pressed: Return/);
});

await runCase("desktop move sends mouse move action", async () => {
  const state = makeState();
  const result = await runCli(["desktop", "move", "sbx-1", "500", "600"], state);
  assert.deepEqual(state.desktopActions[0], { action: "mouse", action: "move", x: 500, y: 600 });
  assert.match(result.logs, /Moved to \(500, 600\)/);
});

await runCase("desktop scroll sends scroll action with direction", async () => {
  const state = makeState();
  const result = await runCli(["desktop", "scroll", "sbx-1", "down", "--amount", "5"], state);
  assert.deepEqual(state.desktopActions[0], { action: "mouse", action: "scroll", direction: "down", amount: 5 });
  assert.match(result.logs, /Scrolled down \(5 clicks\)/);
});

await runCase("desktop screen returns resolution and cursor info", async () => {
  const state = makeState();
  const result = await runCli(["desktop", "screen", "sbx-1"], state);
  assert.equal(state.desktopActions[0].action, "getScreen");
  assert.match(result.logs, /Resolution: 1024x768/);
  assert.match(result.logs, /Cursor: \(512, 384\)/);
});

await runCase("desktop screen --json returns JSON output", async () => {
  const state = makeState();
  const result = await runCli(["--json", "desktop", "screen", "sbx-1"], state);
  const parsed = JSON.parse(result.logs);
  assert.equal(parsed.width, 1024);
  assert.equal(parsed.height, 768);
  assert.equal(parsed.cursorX, 512);
  assert.equal(parsed.cursorY, 384);
});

await runCase("desktop click --json returns JSON output", async () => {
  const state = makeState();
  const result = await runCli(["--json", "desktop", "click", "sbx-1", "100", "200"], state);
  const parsed = JSON.parse(result.logs);
  assert.equal(parsed.action, "click");
  assert.equal(parsed.x, 100);
  assert.equal(parsed.y, 200);
});

// ── beamup desktop ──

await runCase("beamup desktop -y creates sandbox with desktop template", async () => {
  const state = makeState();
  const result = await runCli(["beamup", "desktop", "-y"], state);
  assert.equal(state.creates.length, 1);
  assert.equal(state.creates[0].template, "desktop");
  assert.equal(state.creates[0].options.timeout, 3600);
  assert.match(result.logs, /sandbox_id=/);
});

await runCase("beamup desktop --permanent -y passes timeout=0", async () => {
  const state = makeState();
  await runCli(["beamup", "desktop", "--permanent", "-y"], state);
  assert.equal(state.creates[0].options.timeout, 0);
});

await runCase("beamup desktop --timeout 600 -y passes timeout=600", async () => {
  const state = makeState();
  await runCli(["beamup", "desktop", "--timeout", "600", "-y"], state);
  assert.equal(state.creates[0].options.timeout, 600);
});

await runCase("beamup desktop -y creates noVNC exposure on port 6080", async () => {
  const state = makeState();
  const result = await runCli(["beamup", "desktop", "-y"], state);
  // Should create at least one exposure for noVNC
  const novncExposure = state.previewCreates.find(p => p.port === 6080);
  assert.ok(novncExposure, "Expected a preview on port 6080 for noVNC");
  assert.match(result.logs, /desktop_url=/);
});

await runCase("beamup desktop -y passes resolution as env var", async () => {
  const state = makeState();
  await runCli(["beamup", "desktop", "-y", "--resolution", "1920x1080"], state);
  assert.equal(state.creates[0].options.envVars.RESOLUTION, "1920x1080");
});

console.log("\nAll tests passed!");
