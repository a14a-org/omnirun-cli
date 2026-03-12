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
    ptyCreates: [],
    commandKills: [],
    networkPolicies: [],
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

console.log("\nAll tests passed!");
