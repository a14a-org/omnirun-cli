#!/usr/bin/env node

import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import {
  CommandExitException,
  Sandbox,
  resolveConfig,
  type CreateSandboxOptions,
  type ListSandboxOptions,
  type RunCommandOptions,
} from "@omnirun/sdk";

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
    } catch (err) {
      if (err instanceof CommandExitException) {
        if (runtime.json) {
          printJson({
            stdout: err.stdout,
            stderr: err.stderr,
            exitCode: err.exitCode,
          });
        } else {
          if (err.stdout) process.stdout.write(err.stdout);
          if (err.stderr) process.stderr.write(err.stderr);
          console.error(`\nexit_code=${err.exitCode}`);
        }
        process.exitCode = err.exitCode || 1;
        return;
      }

      throw err;
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

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
