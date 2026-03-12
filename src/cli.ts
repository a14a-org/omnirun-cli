#!/usr/bin/env node

import { Command } from "commander";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import {
  CommandExitException as DefaultCommandExitException,
  Sandbox as DefaultSandbox,
  resolveConfig,
  type CreateSandboxOptions,
  type ListSandboxOptions,
  type RunCommandOptions,
} from "@omnirun/sdk";

type SdkModule = {
  Sandbox: typeof DefaultSandbox;
  CommandExitException: typeof DefaultCommandExitException;
  [key: string]: unknown;
};

const DEFAULT_API_URL = "https://api.omnirun.io";
const DEFAULT_ENV_FILE = ".env";
const ENV_API_URL = "OMNIRUN_API_URL";
const ENV_API_KEY = "OMNIRUN_API_KEY";

type CLIOptions = {
  apiUrl?: string;
  apiKey?: string;
  requestTimeout?: number;
  envPath?: string;
  json?: boolean;
};

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseInteger(value: string, field: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return parsed;
}

function parseKeyValueList(values: string[] | undefined, field: string): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (const item of values) {
    const index = item.indexOf("=");
    if (index <= 0 || index === item.length - 1) {
      throw new Error(`Invalid ${field} entry \"${item}\". Use key=value.`);
    }
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (!key || !value) {
      throw new Error(`Invalid ${field} entry \"${item}\". Use key=value.`);
    }
    out[key] = value;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const index = trimmed.indexOf("=");
  if (index <= 0) return null;

  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  if (!key) return null;
  return [key, value];
}

async function loadEnvFileIfPresent(filePath: string): Promise<void> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (process.env[key] == null) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== "ENOENT") {
      throw err;
    }
  }
}

async function writeAuthEnv(filePath: string, apiUrl: string, apiKey: string): Promise<void> {
  let lines: string[] = [];
  try {
    const existing = await fs.readFile(filePath, "utf8");
    lines = existing
      .split(/\r?\n/)
      .filter((line) => !line.startsWith(`${ENV_API_URL}=`) && !line.startsWith(`${ENV_API_KEY}=`));
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== "ENOENT") {
      throw err;
    }
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  lines.push(`${ENV_API_URL}=${apiUrl}`);
  lines.push(`${ENV_API_KEY}=${apiKey}`);

  const next = `${lines.join("\n")}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, next, "utf8");
}

async function promptValue(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const value = (await rl.question(question)).trim();
    if (!value) {
      throw new Error("Input cannot be empty");
    }
    return value;
  } finally {
    rl.close();
  }
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printSandboxTable(
  rows: Array<{
    sandboxId: string;
    templateId: string;
    state?: string;
    status?: string;
    startedAt: string;
  }>
): void {
  if (rows.length === 0) {
    console.log("No sandboxes found.");
    return;
  }

  for (const row of rows) {
    console.log(
      [
        `id=${String(row.sandboxId ?? "")}`,
        `template=${String(row.templateId ?? "")}`,
        `state=${String(row.state ?? row.status ?? "")}`,
        `startedAt=${String(row.startedAt ?? "")}`,
      ].join(" ")
    );
  }
}

async function resolveRuntime(command: Command, requireApiKey: boolean): Promise<{
  config: { apiUrl: string; apiKey: string; requestTimeout: number };
  json: boolean;
  envPath: string;
}> {
  const opts = command.optsWithGlobals() as CLIOptions;
  const envPath = path.resolve(process.cwd(), opts.envPath ?? DEFAULT_ENV_FILE);
  await loadEnvFileIfPresent(envPath);

  const config = resolveConfig({
    apiUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    requestTimeout: opts.requestTimeout,
  });

  if (!config.apiUrl) {
    config.apiUrl = DEFAULT_API_URL;
  }

  if (requireApiKey && !config.apiKey) {
    throw new Error(
      `Missing API key. Set ${ENV_API_KEY}, pass --api-key, or run \"omni auth init\".`
    );
  }

  return { config, json: Boolean(opts.json), envPath };
}

function commandOptionsFromInput(opts: {
  cwd?: string;
  timeout?: number;
}): RunCommandOptions {
  const out: RunCommandOptions = {};
  if (opts.cwd) out.cwd = opts.cwd;
  if (typeof opts.timeout === "number") out.timeout = opts.timeout;
  return out;
}

export function createProgram(sdk?: SdkModule): Command {
const Sandbox = sdk?.Sandbox ?? DefaultSandbox;
const CommandExitException = sdk?.CommandExitException ?? DefaultCommandExitException;

const program = new Command();
program
  .name("omni")
  .description("CLI for OmniRun sandbox creation and interaction")
  .option("--api-url <url>", `API base URL (default ${DEFAULT_API_URL})`)
  .option("--api-key <key>", "API key")
  .option(
    "--request-timeout <ms>",
    "Request timeout in milliseconds",
    (value: string) => parseInteger(value, "request-timeout")
  )
  .option("--env-path <path>", "Path to .env file", DEFAULT_ENV_FILE)
  .option("--json", "Emit JSON output where supported");

const auth = program.command("auth").description("Manage CLI authentication settings");
auth
  .command("init")
  .description("Authenticate with OmniRun via email")
  .option("--api-url <url>", `API base URL (default ${DEFAULT_API_URL})`)
  .option("--api-key <key>", "API key (skip email flow)")
  .option("--env-path <path>", "Path to .env file")
  .action(async function action(options: { apiUrl?: string; apiKey?: string; envPath?: string }) {
    const merged = this.optsWithGlobals() as CLIOptions;
    const envPath = path.resolve(
      process.cwd(),
      options.envPath ?? merged.envPath ?? DEFAULT_ENV_FILE
    );

    await loadEnvFileIfPresent(envPath);

    const apiUrl =
      options.apiUrl ??
      merged.apiUrl ??
      process.env[ENV_API_URL] ??
      DEFAULT_API_URL;

    // If --api-key is provided, skip the email flow (backwards compatible)
    if (options.apiKey ?? merged.apiKey) {
      const apiKey = (options.apiKey ?? merged.apiKey)!;
      await writeAuthEnv(envPath, apiUrl, apiKey);
      console.log(`Wrote ${envPath}`);
      console.log(`${ENV_API_URL}=${apiUrl}`);
      console.log(`${ENV_API_KEY}=<redacted>`);
      return;
    }

    // Email-based auth flow
    const email = await promptValue("Enter your email: ");

    console.log("Sending verification code...");
    const requestRes = await fetch(`${apiUrl}/auth/magic-link/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (!requestRes.ok) {
      const body = (await requestRes.json().catch(() => ({}))) as Record<string, string>;
      throw new Error(body.message ?? `Failed to send verification email (${requestRes.status})`);
    }

    console.log(`Verification code sent to ${email}. Check your inbox.`);
    const code = await promptValue("Enter 6-digit code: ");

    const verifyRes = await fetch(`${apiUrl}/auth/otp/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code }),
    });

    if (!verifyRes.ok) {
      const body = (await verifyRes.json().catch(() => ({}))) as Record<string, string>;
      if (verifyRes.status === 401) {
        throw new Error("Invalid or expired code. Run 'omni auth init' to try again.");
      }
      throw new Error(body.message ?? `Verification failed (${verifyRes.status})`);
    }

    const verifyData = (await verifyRes.json()) as {
      token?: string;
      mfaRequired?: boolean;
      mfaChallengeToken?: string;
    };

    let apiKey: string;

    if (verifyData.mfaRequired && verifyData.mfaChallengeToken) {
      console.log("MFA is enabled on your account.");
      const totpCode = await promptValue("Enter TOTP code from your authenticator: ");

      const mfaRes = await fetch(`${apiUrl}/auth/mfa/totp/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mfa_challenge_token: verifyData.mfaChallengeToken,
          code: totpCode,
        }),
      });

      if (!mfaRes.ok) {
        const body = (await mfaRes.json().catch(() => ({}))) as Record<string, string>;
        if (mfaRes.status === 401) {
          throw new Error("Invalid TOTP code. Run 'omni auth init' to try again.");
        }
        throw new Error(body.message ?? `MFA verification failed (${mfaRes.status})`);
      }

      const mfaData = (await mfaRes.json()) as { token: string };
      apiKey = mfaData.token;
    } else {
      apiKey = verifyData.token!;
    }

    await writeAuthEnv(envPath, apiUrl, apiKey);
    console.log("\nAuthenticated successfully!");
    console.log(`Wrote ${envPath}`);
    console.log(`${ENV_API_URL}=${apiUrl}`);
    console.log(`${ENV_API_KEY}=<redacted>`);
  });

const sandbox = program.command("sandbox").description("Sandbox lifecycle operations");

sandbox
  .command("create")
  .description("Create a new sandbox")
  .argument("[template]", "Template ID", "python-3.11")
  .option("--timeout <seconds>", "Sandbox timeout in seconds", (value: string) =>
    parseInteger(value, "timeout")
  )
  .option("--internet", "Enable outbound internet")
  .option("--secure", "Enable secure traffic token mode")
  .option("--e2ee", "Enable E2EE bootstrap on create")
  .option("--metadata <key=value>", "Metadata entry", collect, [])
  .option("--env <key=value>", "Environment variable", collect, [])
  .action(async function action(
    template: string,
    options: {
      timeout?: number;
      internet?: boolean;
      secure?: boolean;
      e2ee?: boolean;
      metadata?: string[];
      env?: string[];
    }
  ) {
    const runtime = await resolveRuntime(this, true);
    const metadata = parseKeyValueList(options.metadata, "metadata");
    const envVars = parseKeyValueList(options.env, "env");

    const createOptions: CreateSandboxOptions = {
      apiUrl: runtime.config.apiUrl,
      apiKey: runtime.config.apiKey,
      requestTimeout: runtime.config.requestTimeout,
      timeout: options.timeout,
      internet: Boolean(options.internet),
      secure: Boolean(options.secure),
      e2ee: Boolean(options.e2ee),
      metadata,
      envVars,
    };

    const instance = await Sandbox.create(template, createOptions);
    const info = await instance.getInfo();

    const payload = {
      sandboxId: instance.sandboxId,
      templateId: info.templateId,
      state: info.state,
      trafficTokenLength: instance.trafficAccessToken.length,
      e2ee: instance.e2ee
        ? {
            enabled: instance.e2ee.enabled,
            clientPublicKeyLength: instance.e2ee.clientPublicKey.length,
            serverPublicKeyPresent: Boolean(instance.e2ee.serverPublicKey),
          }
        : null,
    };

    if (runtime.json) {
      printJson(payload);
      return;
    }

    console.log(`sandbox_id=${payload.sandboxId}`);
    console.log(`template_id=${payload.templateId}`);
    console.log(`state=${payload.state}`);
    if (payload.trafficTokenLength > 0) {
      console.log(`traffic_token_len=${payload.trafficTokenLength}`);
    }
    if (payload.e2ee) {
      console.log(`e2ee_enabled=${payload.e2ee.enabled}`);
      console.log(`server_public_key_present=${payload.e2ee.serverPublicKeyPresent}`);
    }
  });

sandbox
  .command("list")
  .description("List sandboxes")
  .option("--limit <n>", "Max results", (value: string) => parseInteger(value, "limit"))
  .option("--state <state>", "Filter by state")
  .option("--metadata <key=value>", "Metadata filter", collect, [])
  .action(async function action(options: { limit?: number; state?: string; metadata?: string[] }) {
    const runtime = await resolveRuntime(this, true);
    const metadata = parseKeyValueList(options.metadata, "metadata");

    const listOptions: ListSandboxOptions = {
      apiUrl: runtime.config.apiUrl,
      apiKey: runtime.config.apiKey,
      limit: options.limit,
      state: options.state,
      metadata,
    };

    const sandboxes = await Sandbox.list(listOptions);
    if (runtime.json) {
      printJson(sandboxes);
      return;
    }

    printSandboxTable(sandboxes);
  });

sandbox
  .command("info")
  .description("Get sandbox details")
  .argument("<sandboxId>", "Sandbox ID")
  .action(async function action(sandboxId: string) {
    const runtime = await resolveRuntime(this, true);
    const instance = await Sandbox.connect(sandboxId, runtime.config);
    const info = await instance.getInfo();

    if (runtime.json) {
      printJson(info);
      return;
    }

    console.log(`sandbox_id=${info.sandboxId}`);
    console.log(`template_id=${info.templateId}`);
    console.log(`state=${info.state}`);
    console.log(`started_at=${info.startedAt}`);
    console.log(`cpu_count=${info.cpuCount}`);
    console.log(`memory_mb=${info.memoryMB}`);
  });

sandbox
  .command("kill")
  .description("Terminate a sandbox")
  .argument("<sandboxId>", "Sandbox ID")
  .action(async function action(sandboxId: string) {
    const runtime = await resolveRuntime(this, true);
    const instance = await Sandbox.connect(sandboxId, runtime.config);
    await instance.kill();

    if (runtime.json) {
      printJson({ sandboxId, killed: true });
      return;
    }

    console.log(`killed=${sandboxId}`);
  });

const command = program.command("command").description("Run and manage sandbox commands");

command
  .command("run")
  .description("Run a command inside a sandbox")
  .argument("<sandboxId>", "Sandbox ID")
  .argument("<cmd...>", "Command string")
  .option("--cwd <path>", "Working directory")
  .option("--timeout <seconds>", "Command timeout in seconds", (value: string) =>
    parseInteger(value, "timeout")
  )
  .option("--background", "Run in background and return pid")
  .option("--stream", "Stream output to terminal")
  .action(async function action(
    sandboxId: string,
    cmdParts: string[],
    options: {
      cwd?: string;
      timeout?: number;
      background?: boolean;
      stream?: boolean;
    }
  ) {
    const runtime = await resolveRuntime(this, true);
    const commandText = cmdParts.join(" ").trim();
    if (!commandText) {
      throw new Error("Command cannot be empty");
    }

    const instance = await Sandbox.connect(sandboxId, runtime.config);
    const baseOptions = commandOptionsFromInput({
      cwd: options.cwd,
      timeout: options.timeout,
    });

    if (options.background) {
      const backgroundOptions: RunCommandOptions & { background: true } = {
        cwd: baseOptions.cwd,
        timeout: baseOptions.timeout,
        background: true,
      };
      const handle = (await instance.commands.run(
        commandText,
        backgroundOptions
      )) as unknown as { pid: number };

      const payload = { sandboxId, pid: handle.pid, background: true };
      if (runtime.json) {
        printJson(payload);
      } else {
        console.log(`pid=${payload.pid}`);
      }
      return;
    }

    try {
      const result = options.stream
        ? await instance.commands.run(commandText, {
            ...baseOptions,
            onStdout: (chunk: string) => process.stdout.write(chunk),
            onStderr: (chunk: string) => process.stderr.write(chunk),
          })
        : await instance.commands.run(commandText, baseOptions);

      if (runtime.json) {
        printJson(result);
        return;
      }

      if (!options.stream) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      console.log(`\nexit_code=${result.exitCode}`);
    } catch (caughtErr) {
      if (caughtErr instanceof CommandExitException) {
        if (runtime.json) {
          printJson({
            stdout: caughtErr.stdout,
            stderr: caughtErr.stderr,
            exitCode: caughtErr.exitCode,
          });
        } else {
          if (caughtErr.stdout) process.stdout.write(caughtErr.stdout);
          if (caughtErr.stderr) process.stderr.write(caughtErr.stderr);
          console.error(`\nexit_code=${caughtErr.exitCode}`);
        }
        process.exitCode = caughtErr.exitCode || 1;
        return;
      }

      throw caughtErr;
    }
  });

command
  .command("ps")
  .description("List running/background commands in a sandbox")
  .argument("<sandboxId>", "Sandbox ID")
  .action(async function action(sandboxId: string) {
    const runtime = await resolveRuntime(this, true);
    const instance = await Sandbox.connect(sandboxId, runtime.config);
    const processes = await instance.commands.list();

    if (runtime.json) {
      printJson(processes);
      return;
    }

    if (processes.length === 0) {
      console.log("No active processes.");
      return;
    }

    for (const proc of processes) {
      console.log(
        [
          `pid=${proc.pid}`,
          `running=${proc.running}`,
          `exit_code=${proc.exitCode}`,
          `cmd=${proc.command}`,
        ].join(" ")
      );
    }
  });

command
  .command("kill")
  .description("Kill a background command process")
  .argument("<sandboxId>", "Sandbox ID")
  .argument("<pid>", "Process ID", (value: string) => parseInteger(value, "pid"))
  .action(async function action(sandboxId: string, pid: number) {
    const runtime = await resolveRuntime(this, true);
    const instance = await Sandbox.connect(sandboxId, runtime.config);
    await instance.commands.kill(pid);

    if (runtime.json) {
      printJson({ sandboxId, pid, killed: true });
      return;
    }

    console.log(`killed pid=${pid} sandbox=${sandboxId}`);
  });

// ── beamup helpers ──────────────────────────────────────────────────

async function discoverClaudeCredentials(authDir: string): Promise<string | null> {
  // Try reading full credentials JSON from macOS Keychain (where Claude Code stores tokens)
  if (process.platform === "darwin") {
    try {
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s", "Claude Code-credentials",
        "-w",
      ]);
      const creds = stdout.trim();
      const parsed = JSON.parse(creds);
      if (parsed.claudeAiOauth?.accessToken) {
        return creds;
      }
    } catch {
      // Keychain entry may not exist
    }
  }

  // Fall back to .credentials.json file (used on Linux)
  try {
    const credFile = await fs.readFile(path.join(authDir, ".credentials.json"), "utf-8");
    const parsed = JSON.parse(credFile);
    if (parsed.claudeAiOauth?.accessToken) {
      return credFile;
    }
  } catch {
    // file may not exist
  }

  return null;
}


async function discoverCodexCredentials(): Promise<string | null> {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  try {
    const authFile = await fs.readFile(path.join(codexHome, "auth.json"), "utf-8");
    const parsed = JSON.parse(authFile);
    if (parsed.access_token || parsed.api_key) {
      return authFile;
    }
  } catch {
    // file may not exist
  }
  return null;
}

async function discoverGeminiCredentials(): Promise<string | null> {
  const geminiHome = path.join(os.homedir(), ".gemini");
  try {
    const oauthFile = await fs.readFile(path.join(geminiHome, "oauth_creds.json"), "utf-8");
    const parsed = JSON.parse(oauthFile);
    if (parsed.refresh_token) {
      return oauthFile;
    }
  } catch {
    // file may not exist
  }
  return null;
}

async function discoverOpenClawStateDir(): Promise<string | null> {
  const stateDir = process.env.OPENCLAW_STATE_DIR
    ?? path.join(process.env.OPENCLAW_HOME ?? os.homedir(), ".openclaw");

  try {
    const stat = await fs.stat(stateDir);
    if (stat.isDirectory()) return stateDir;
  } catch {
    // directory may not exist
  }

  return null;
}

async function transferOpenClawState(
  instance: Awaited<ReturnType<typeof Sandbox.create>>,
  stateDir: string,
  targetDir: string,
  sandboxUser: string,
): Promise<void> {
  const execFileAsync = promisify(execFile);
  const { stdout: tarBuffer } = await execFileAsync("tar", [
    "czf", "-",
    "--exclude", "memory/lancedb",
    "--exclude", "nodes",
    "-C", path.dirname(stateDir),
    path.basename(stateDir),
  ], { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 });

  const tarPath = "/tmp/openclaw-state.tar.gz";
  await instance.files.write(tarPath, new Uint8Array(tarBuffer));

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

async function promptConfirm(question: string, defaultValue: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const hint = defaultValue ? "Y/n" : "y/N";
  try {
    const answer = (await rl.question(`${question} (${hint}) `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function promptSelect(question: string, choices: string[]): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (let i = 0; i < choices.length; i++) {
      process.stderr.write(`  ${i + 1}) ${choices[i]}\n`);
    }
    const answer = (await rl.question(`${question} [1-${choices.length}]: `)).trim();
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isNaN(index) || index < 0 || index >= choices.length) {
      return 0; // default to first choice
    }
    return index;
  } finally {
    rl.close();
  }
}

async function promptInput(question: string, defaultValue: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} (${defaultValue}): `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

async function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question + " ");
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let value = "";
    const onData = (data: Buffer) => {
      const char = data.toString();
      if (char === "\n" || char === "\r") {
        process.stderr.write("\n");
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        resolve(value);
      } else if (char === "\u007f" || char === "\b") {
        // Backspace
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stderr.write("\b \b");
        }
      } else if (char === "\u0003") {
        // Ctrl+C
        process.stderr.write("\n");
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        resolve("");
      } else if (char >= " ") {
        value += char;
        process.stderr.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

type OpenClawSetupResult = {
  config: string;
  envFile: string;
  gatewayToken: string;
};

function generateOpenClawConfig(keys: {
  anthropicKey?: string;
  openaiKey?: string;
  gatewayToken: string;
}): OpenClawSetupResult {
  const providers: Record<string, { apiKey: string }> = {};
  const envLines: string[] = [];

  if (keys.anthropicKey) {
    providers.anthropic = { apiKey: "${ANTHROPIC_API_KEY}" };
    envLines.push(`ANTHROPIC_API_KEY=${keys.anthropicKey}`);
  }
  if (keys.openaiKey) {
    providers.openai = { apiKey: "${OPENAI_API_KEY}" };
    envLines.push(`OPENAI_API_KEY=${keys.openaiKey}`);
  }

  const primaryModel = keys.anthropicKey
    ? "anthropic/claude-sonnet-4-5"
    : "openai/gpt-4o";

  const config = {
    meta: {
      lastTouchedVersion: "1.0.0",
      lastTouchedAt: new Date().toISOString().slice(0, 10),
    },
    gateway: {
      port: 18789,
      bind: "loopback",
      auth: { mode: "token", token: keys.gatewayToken },
    },
    agents: {
      defaults: {
        workspace: "~/.openclaw/workspace",
        model: { primary: primaryModel },
      },
      list: [{ id: "main", default: true }],
    },
    models: { providers },
    session: { dmScope: "per-channel-peer" },
  };

  return {
    config: JSON.stringify(config, null, 2),
    envFile: envLines.join("\n") + "\n",
    gatewayToken: keys.gatewayToken,
  };
}

async function setupOpenClawOnSandbox(
  instance: Awaited<ReturnType<typeof Sandbox.create>>,
  targetDir: string,
  sandboxUser: string,
  setup: OpenClawSetupResult,
): Promise<void> {
  await instance.commands.run(`mkdir -p ${targetDir}/workspace`);
  await instance.files.write(`${targetDir}/openclaw.json`, setup.config);
  await instance.files.write(`${targetDir}/.env`, setup.envFile);
  await instance.commands.run(`chmod -R 700 ${targetDir}`);
  await instance.commands.run(`chown -R ${sandboxUser}:${sandboxUser} ${targetDir}`);
}

type BeamupClaudeConfig = {
  transferAuth: boolean;
  skipPermissions: boolean;
  internet: boolean;
  timeout: number;
  e2ee: boolean;
  authDir: string;
  envVars: Record<string, string> | undefined;
};

async function promptBeamupClaude(options: {
  skipPermissions?: boolean;
  internet?: boolean;
  timeout?: string;
  permanent?: boolean;
  e2ee?: boolean;
  authDir?: string;
  skipAuthTransfer?: boolean;
  env?: string[];
  yes?: boolean;
}): Promise<BeamupClaudeConfig> {
  const authDir = options.authDir ?? path.join(os.homedir(), ".claude");
  const envVars = parseKeyValueList(options.env, "env");

  // Timeout resolution: --timeout wins > --permanent > default
  const resolveTimeout = async (useDefaults: boolean): Promise<number> => {
    if (options.timeout != null) return parseInteger(options.timeout, "timeout");
    if (options.permanent) return 0;
    if (useDefaults) return 3600;
    return parseInteger(await promptInput("Sandbox timeout in seconds:", "3600"), "timeout");
  };

  if (options.yes || !process.stdin.isTTY) {
    return {
      transferAuth: !options.skipAuthTransfer,
      skipPermissions: Boolean(options.skipPermissions),
      internet: options.internet !== false,
      timeout: await resolveTimeout(true),
      e2ee: options.e2ee !== false,
      authDir,
      envVars,
    };
  }

  // Interactive prompt flow
  const transferAuth = options.skipAuthTransfer
    ? false
    : await promptConfirm("Transfer local Claude credentials to sandbox?", true);

  const modeIndex = options.skipPermissions != null
    ? (options.skipPermissions ? 1 : 0)
    : await promptSelect("Run mode:", [
        "Standard",
        "Bypass restrictions (--dangerously-skip-permissions)",
      ]);

  const internet = options.internet != null
    ? options.internet
    : await promptConfirm("Enable full internet access?", true);

  const timeout = await resolveTimeout(false);

  return {
    transferAuth,
    skipPermissions: modeIndex === 1,
    internet,
    timeout,
    e2ee: options.e2ee !== false,
    authDir,
    envVars,
  };
}

async function attachPty(
  instance: Awaited<ReturnType<typeof Sandbox.create>>,
  claudeCommand: string
): Promise<void> {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const session = await instance.pty.create({ cols, rows });
  await session.sendStdin(claudeCommand + "\n");

  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  let exiting = false;

  const cleanup = () => {
    if (exiting) return;
    exiting = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw ?? false);
    }
    process.stdin.pause();
    console.log(`\nSandbox ID: ${instance.sandboxId}`);
    console.log("Reconnect with: omni sandbox info " + instance.sandboxId);
  };

  // Forward local stdin to PTY
  const onData = (data: Buffer) => {
    if (exiting) return;
    session.sendStdin(data.toString()).catch(() => {
      cleanup();
    });
  };
  process.stdin.on("data", onData);

  // Handle terminal resize
  const onResize = () => {
    if (exiting) return;
    const newCols = process.stdout.columns || 80;
    const newRows = process.stdout.rows || 24;
    session.resize(newCols, newRows).catch(() => {});
  };
  process.stdout.on("resize", onResize);

  // Poll PTY output
  let emptyReads = 0;
  let hasOutput = false;

  const poll = async () => {
    while (!exiting) {
      try {
        const data = await session.read();
        if (data) {
          hasOutput = true;
          emptyReads = 0;
          process.stdout.write(data);
        } else {
          emptyReads++;
          // After receiving output, many consecutive empty reads means session ended
          if (hasOutput && emptyReads > 100) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } catch {
        // Session ended or error
        break;
      }
    }

    process.stdin.removeListener("data", onData);
    process.stdout.removeListener("resize", onResize);
    cleanup();
  };

  await poll();
}

// ── beamup command group ────────────────────────────────────────────

const beamup = program
  .command("beamup")
  .description("Launch preconfigured sandbox environments");

beamup
  .command("claude")
  .description("Launch Claude Code in an E2EE sandbox")
  .option("--template <id>", "Sandbox template ID", "claude-code")
  .option("--skip-permissions", "Run with --dangerously-skip-permissions")
  .option("--no-internet", "Disable internet access")
  .option("--timeout <seconds>", "Sandbox timeout in seconds")
  .option("--permanent", "Don't auto-expire the sandbox (timeout=0)")
  .option("--no-e2ee", "Disable E2EE")
  .option("--auth-dir <path>", "Custom Claude auth directory (default: ~/.claude)")
  .option("--skip-auth-transfer", "Don't transfer credentials")
  .option("--env <key=value>", "Extra environment variable", collect, [])
  .option("-y, --yes", "Skip interactive prompts, use defaults")
  .action(async function action(options: {
    template: string;
    skipPermissions?: boolean;
    internet?: boolean;
    timeout?: string;
    permanent?: boolean;
    e2ee?: boolean;
    authDir?: string;
    skipAuthTransfer?: boolean;
    env?: string[];
    yes?: boolean;
  }) {
    const runtime = await resolveRuntime(this, true);

    const config = await promptBeamupClaude(options);

    // Discover local Claude credentials (full JSON from Keychain or .credentials.json)
    let credentials: string | null = null;
    if (config.transferAuth) {
      credentials = await discoverClaudeCredentials(config.authDir);
      if (credentials) {
        console.log(`Found Claude credentials (${credentials.length} bytes).`);
      } else {
        console.warn(
          "Warning: No Claude credentials found (checked macOS Keychain and " +
            path.join(config.authDir, ".credentials.json") +
            "). You may need to authenticate manually inside the sandbox."
        );
      }
    }

    // Warn if E2EE disabled but transferring auth
    if (!config.e2ee && config.transferAuth && credentials) {
      console.warn(
        "Warning: E2EE is disabled but credentials will be transferred. " +
          "Secrets will not be encrypted in transit."
      );
    }

    // Create sandbox
    console.log("Creating Claude Code sandbox...");
    const instance = await Sandbox.create(options.template, {
      apiUrl: runtime.config.apiUrl,
      apiKey: runtime.config.apiKey,
      requestTimeout: runtime.config.requestTimeout,
      e2ee: config.e2ee,
      internet: config.internet,
      timeout: config.timeout,
      envVars: config.envVars,
    });
    console.log(`sandbox_id=${instance.sandboxId}`);

    // Use pre-baked non-root user (Claude Code refuses --dangerously-skip-permissions as root)
    const sandboxUser = "coder";
    const sandboxHome = `/home/${sandboxUser}`;

    // Use a fresh config dir to avoid corrupted .claude from snapshot.
    // Claude Code reads CLAUDE_CONFIG_DIR to find its config/credentials.
    const configDir = `/tmp/claude-config`;

    try {
      await instance.commands.run(`mkdir -p ${configDir}`);
      if (credentials) {
        const b64 = Buffer.from(credentials).toString("base64");
        await instance.commands.run(
          `echo '${b64}' | base64 -d > ${configDir}/.credentials.json`
        );
      }
      // Mark onboarding as complete so Claude Code skips the theme/welcome flow
      await instance.commands.run(
        `echo '{"hasCompletedOnboarding":true}' > ${configDir}/.claude.json`
      );
      await instance.commands.run(`chmod -R 700 ${configDir}`);
      await instance.commands.run(`chown -R ${sandboxUser}:${sandboxUser} ${configDir}`);
      if (credentials) {
        const verify = await instance.commands.run(`cat ${configDir}/.credentials.json | head -c 60`);
        console.log(`  credentials written: ${verify.stdout.trim().slice(0, 50)}...`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: Failed to set up config: ${message}`);
    }

    // Build claude command, run as non-root user
    let claudeCommand = "claude";
    if (config.skipPermissions) {
      claudeCommand += " --dangerously-skip-permissions";
    }
    const envSetup = `export CLAUDE_CONFIG_DIR=${configDir}`;
    const fullCommand = `su - ${sandboxUser} -c '${envSetup}; ${claudeCommand}'`;

    if (process.stdin.isTTY) {
      console.log("Attaching to Claude Code session...\n");
      await attachPty(instance, fullCommand);
    } else {
      // Non-TTY: start claude in background
      await instance.commands.run(fullCommand, { background: true } as RunCommandOptions & { background: true });
      console.log("Claude Code started in background.");
      console.log(`Connect to sandbox: omni sandbox info ${instance.sandboxId}`);
    }
  });

// ── beamup codex ────────────────────────────────────────────────────

beamup
  .command("codex")
  .description("Launch OpenAI Codex CLI in an E2EE sandbox")
  .option("--template <id>", "Sandbox template ID", "codex")
  .option("--no-internet", "Disable internet access")
  .option("--timeout <seconds>", "Sandbox timeout in seconds")
  .option("--permanent", "Don't auto-expire the sandbox (timeout=0)")
  .option("--no-e2ee", "Disable E2EE")
  .option("--skip-auth-transfer", "Don't transfer credentials")
  .option("--env <key=value>", "Extra environment variable", collect, [])
  .option("-y, --yes", "Skip interactive prompts, use defaults")
  .action(async function action(options: {
    template: string;
    internet?: boolean;
    timeout?: string;
    permanent?: boolean;
    e2ee?: boolean;
    skipAuthTransfer?: boolean;
    env?: string[];
    yes?: boolean;
  }) {
    const runtime = await resolveRuntime(this, true);
    const envVars = parseKeyValueList(options.env, "env");

    const useDefaults = Boolean(options.yes) || !process.stdin.isTTY;
    const transferAuth = options.skipAuthTransfer
      ? false
      : useDefaults || await promptConfirm("Transfer local Codex credentials to sandbox?", true);
    const internet = options.internet != null
      ? options.internet
      : useDefaults || await promptConfirm("Enable full internet access?", true);
    const timeout = options.timeout != null
      ? parseInteger(options.timeout, "timeout")
      : options.permanent
        ? 0
        : useDefaults
          ? 3600
          : parseInteger(await promptInput("Sandbox timeout in seconds:", "3600"), "timeout");
    const e2ee = options.e2ee !== false;

    // Discover credentials
    let credentials: string | null = null;
    if (transferAuth) {
      credentials = await discoverCodexCredentials();
      if (credentials) {
        console.log(`Found Codex credentials (${credentials.length} bytes).`);
      } else {
        console.warn(
          "Warning: No Codex credentials found (checked ~/.codex/auth.json). " +
            "You may need to run 'codex login' inside the sandbox."
        );
      }
    }

    if (!e2ee && transferAuth && credentials) {
      console.warn(
        "Warning: E2EE is disabled but credentials will be transferred. " +
          "Secrets will not be encrypted in transit."
      );
    }

    console.log("Creating Codex sandbox...");
    const instance = await Sandbox.create(options.template, {
      apiUrl: runtime.config.apiUrl,
      apiKey: runtime.config.apiKey,
      requestTimeout: runtime.config.requestTimeout,
      e2ee,
      internet,
      timeout,
      envVars,
    });
    console.log(`sandbox_id=${instance.sandboxId}`);

    const sandboxUser = "coder";
    const configDir = `/tmp/codex-config`;

    try {
      await instance.commands.run(`mkdir -p ${configDir}`);
      if (credentials) {
        const b64 = Buffer.from(credentials).toString("base64");
        await instance.commands.run(
          `echo '${b64}' | base64 -d > ${configDir}/auth.json`
        );
      }
      await instance.commands.run(`chmod -R 700 ${configDir}`);
      await instance.commands.run(`chown -R ${sandboxUser}:${sandboxUser} ${configDir}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: Failed to set up config: ${message}`);
    }

    const envSetup = `export CODEX_HOME=${configDir}`;
    const fullCommand = `su - ${sandboxUser} -c '${envSetup}; codex'`;

    if (process.stdin.isTTY) {
      console.log("Attaching to Codex session...\n");
      await attachPty(instance, fullCommand);
    } else {
      await instance.commands.run(fullCommand, { background: true } as RunCommandOptions & { background: true });
      console.log("Codex started in background.");
      console.log(`Connect to sandbox: omni sandbox info ${instance.sandboxId}`);
    }
  });

// ── beamup gemini ───────────────────────────────────────────────────

beamup
  .command("gemini")
  .description("Launch Gemini CLI in an E2EE sandbox")
  .option("--template <id>", "Sandbox template ID", "gemini-cli")
  .option("--no-internet", "Disable internet access")
  .option("--timeout <seconds>", "Sandbox timeout in seconds")
  .option("--permanent", "Don't auto-expire the sandbox (timeout=0)")
  .option("--no-e2ee", "Disable E2EE")
  .option("--skip-auth-transfer", "Don't transfer credentials")
  .option("--env <key=value>", "Extra environment variable", collect, [])
  .option("-y, --yes", "Skip interactive prompts, use defaults")
  .action(async function action(options: {
    template: string;
    internet?: boolean;
    timeout?: string;
    permanent?: boolean;
    e2ee?: boolean;
    skipAuthTransfer?: boolean;
    env?: string[];
    yes?: boolean;
  }) {
    const runtime = await resolveRuntime(this, true);
    const envVars = parseKeyValueList(options.env, "env");

    const useDefaults = Boolean(options.yes) || !process.stdin.isTTY;
    const transferAuth = options.skipAuthTransfer
      ? false
      : useDefaults || await promptConfirm("Transfer local Gemini credentials to sandbox?", true);
    const internet = options.internet != null
      ? options.internet
      : useDefaults || await promptConfirm("Enable full internet access?", true);
    const timeout = options.timeout != null
      ? parseInteger(options.timeout, "timeout")
      : options.permanent
        ? 0
        : useDefaults
          ? 3600
          : parseInteger(await promptInput("Sandbox timeout in seconds:", "3600"), "timeout");
    const e2ee = options.e2ee !== false;

    // Discover credentials
    let credentials: string | null = null;
    if (transferAuth) {
      credentials = await discoverGeminiCredentials();
      if (credentials) {
        console.log(`Found Gemini credentials (${credentials.length} bytes).`);
      } else {
        console.warn(
          "Warning: No Gemini credentials found (checked ~/.gemini/oauth_creds.json). " +
            "You may need to authenticate inside the sandbox."
        );
      }
    }

    if (!e2ee && transferAuth && credentials) {
      console.warn(
        "Warning: E2EE is disabled but credentials will be transferred. " +
          "Secrets will not be encrypted in transit."
      );
    }

    console.log("Creating Gemini CLI sandbox...");
    const instance = await Sandbox.create(options.template, {
      apiUrl: runtime.config.apiUrl,
      apiKey: runtime.config.apiKey,
      requestTimeout: runtime.config.requestTimeout,
      e2ee,
      internet,
      timeout,
      envVars,
    });
    console.log(`sandbox_id=${instance.sandboxId}`);

    const sandboxUser = "coder";
    const configDir = `/tmp/gemini-config`;

    try {
      await instance.commands.run(`mkdir -p ${configDir}`);
      if (credentials) {
        const b64 = Buffer.from(credentials).toString("base64");
        await instance.commands.run(
          `echo '${b64}' | base64 -d > ${configDir}/oauth_creds.json`
        );
      }
      await instance.commands.run(`chmod -R 700 ${configDir}`);
      await instance.commands.run(`chown -R ${sandboxUser}:${sandboxUser} ${configDir}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: Failed to set up config: ${message}`);
    }

    const envSetup = `export GEMINI_CONFIG_DIR=${configDir}`;
    const fullCommand = `su - ${sandboxUser} -c '${envSetup}; gemini'`;

    if (process.stdin.isTTY) {
      console.log("Attaching to Gemini CLI session...\n");
      await attachPty(instance, fullCommand);
    } else {
      await instance.commands.run(fullCommand, { background: true } as RunCommandOptions & { background: true });
      console.log("Gemini CLI started in background.");
      console.log(`Connect to sandbox: omni sandbox info ${instance.sandboxId}`);
    }
  });

// ── beamup openclaw ─────────────────────────────────────────────────

beamup
  .command("openclaw")
  .description("Launch OpenClaw in an E2EE sandbox (permanent by default)")
  .option("--template <id>", "Sandbox template ID", "openclaw")
  .option("--no-internet", "Disable internet access")
  .option("--timeout <seconds>", "Override with fixed timeout (overrides --permanent)")
  .option("--permanent", "Don't auto-expire the sandbox (default for openclaw)")
  .option("--no-e2ee", "Disable E2EE")
  .option("--skip-auth-transfer", "Don't transfer OpenClaw state")
  .option("--env <key=value>", "Extra environment variable", collect, [])
  .option("-y, --yes", "Skip interactive prompts, use defaults")
  .action(async function action(options: {
    template: string;
    internet?: boolean;
    timeout?: string;
    permanent?: boolean;
    e2ee?: boolean;
    skipAuthTransfer?: boolean;
    env?: string[];
    yes?: boolean;
  }) {
    const runtime = await resolveRuntime(this, true);
    const envVars = parseKeyValueList(options.env, "env");

    const useDefaults = Boolean(options.yes) || !process.stdin.isTTY;

    const transferAuth = options.skipAuthTransfer
      ? false
      : useDefaults || await promptConfirm("Transfer local OpenClaw state to sandbox?", true);
    const internet = options.internet != null
      ? options.internet
      : useDefaults || await promptConfirm("Enable full internet access?", true);

    // OpenClaw defaults to permanent (timeout=0)
    let timeout: number;
    if (options.timeout != null) {
      timeout = parseInteger(options.timeout, "timeout");
    } else if (options.permanent === false) {
      // Explicit --no-permanent
      timeout = useDefaults
        ? 3600
        : parseInteger(await promptInput("Sandbox timeout in seconds:", "3600"), "timeout");
    } else {
      // Default: permanent
      timeout = useDefaults
        ? 0
        : (await promptConfirm("Keep sandbox running permanently?", true))
          ? 0
          : parseInteger(await promptInput("Sandbox timeout in seconds:", "3600"), "timeout");
    }

    const e2ee = options.e2ee !== false;

    // Discover local OpenClaw state directory
    let stateDir: string | null = null;
    let freshSetup: OpenClawSetupResult | null = null;

    if (transferAuth) {
      stateDir = await discoverOpenClawStateDir();
      if (stateDir) {
        console.log(`Found OpenClaw state directory: ${stateDir}`);
      } else if (!useDefaults && process.stdin.isTTY) {
        // No local state — offer guided setup
        console.log("\nNo OpenClaw state found locally.\n");
        const wantSetup = await promptConfirm("Set up OpenClaw now?", true);
        if (wantSetup) {
          const anthropicKey = await promptSecret("Anthropic API key:");
          const openaiKey = await promptSecret("OpenAI API key (optional, Enter to skip):");
          const gatewayToken = crypto.randomBytes(24).toString("hex");

          if (!anthropicKey && !openaiKey) {
            console.warn("Warning: No API keys provided. OpenClaw will need manual configuration.");
          } else {
            freshSetup = generateOpenClawConfig({
              anthropicKey: anthropicKey || undefined,
              openaiKey: openaiKey || undefined,
              gatewayToken,
            });
            console.log(`Gateway token: ${gatewayToken}`);
          }
        }
      } else {
        console.warn(
          "Warning: No OpenClaw state directory found. " +
            "You may need to set up OpenClaw manually inside the sandbox."
        );
      }
    }

    if (!e2ee && transferAuth && (stateDir || freshSetup)) {
      console.warn(
        "Warning: E2EE is disabled but secrets will be transferred. " +
          "They will not be encrypted in transit."
      );
    }

    console.log("Creating OpenClaw sandbox...");
    const instance = await Sandbox.create(options.template, {
      apiUrl: runtime.config.apiUrl,
      apiKey: runtime.config.apiKey,
      requestTimeout: runtime.config.requestTimeout,
      e2ee,
      internet,
      timeout,
      envVars,
    });
    console.log(`sandbox_id=${instance.sandboxId}`);

    const sandboxUser = "coder";
    const targetDir = "/tmp/openclaw-state";

    // Transfer existing state or write fresh config
    if (stateDir) {
      try {
        await transferOpenClawState(instance, stateDir, targetDir, sandboxUser);
        console.log("OpenClaw state transferred.");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: Failed to transfer OpenClaw state: ${message}`);
      }
    } else if (freshSetup) {
      try {
        await setupOpenClawOnSandbox(instance, targetDir, sandboxUser, freshSetup);
        console.log("OpenClaw config written to sandbox.");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: Failed to write OpenClaw config: ${message}`);
      }
    }

    const envSetup = [
      `export OPENCLAW_STATE_DIR=${targetDir}`,
      `export OPENCLAW_CONFIG_PATH=${targetDir}/openclaw.json`,
    ].join("; ");

    if (process.stdin.isTTY) {
      const fullCommand = `su - ${sandboxUser} -c '${envSetup}; openclaw tui'`;
      console.log("Attaching to OpenClaw TUI...\n");
      await attachPty(instance, fullCommand);
    } else {
      const daemonCommand = `su - ${sandboxUser} -c '${envSetup}; openclaw gateway start'`;
      await instance.commands.run(daemonCommand, { background: true } as RunCommandOptions & { background: true });

      const gatewayUrl = instance.getHost(4767);
      console.log("OpenClaw gateway started in background.");
      console.log(`Gateway URL: ${gatewayUrl}`);
      console.log(`Reconnect: omni sandbox info ${instance.sandboxId}`);
    }
  });

return program;
}

// Run CLI when executed directly (not imported for testing)
const isDirectExecution = process.argv[1] && (
  process.argv[1].endsWith("/cli.js") ||
  process.argv[1].endsWith("/cli.ts") ||
  process.argv[1].endsWith("omni")
);
if (isDirectExecution) {
  createProgram().parseAsync(process.argv).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
}
