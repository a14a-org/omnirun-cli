#!/usr/bin/env node

import { Command } from "commander";
import { execFile, spawn } from "node:child_process";
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
  LLM,
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

type PreviewVisibility = "public" | "private";

type PreviewStatus =
  | "pending"
  | "ready"
  | "revoked"
  | "expired"
  | "sandbox_stopped"
  | "error";

type PreviewExposure = {
  id: string;
  sandboxId: string;
  port: number;
  hostname: string;
  url: string;
  accessUrl?: string;
  visibility: PreviewVisibility;
  status: PreviewStatus;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  sandboxStoppedAt?: string;
  lastAccessedAt?: string;
  openPath?: string;
  preserveHost: boolean;
};

type ExposureApi = {
  create: (port: number, options?: {
    visibility?: PreviewVisibility;
    ttlSeconds?: number;
    slug?: string;
    openPath?: string;
    preserveHost?: boolean;
  }) => Promise<PreviewExposure>;
  list: () => Promise<PreviewExposure[]>;
  get: (exposureId: string) => Promise<PreviewExposure>;
  refresh: (exposureId: string, options?: { ttlSeconds?: number }) => Promise<PreviewExposure>;
  close: (exposureId: string) => Promise<void>;
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

function parsePorts(values: string[] | undefined, field: string): number[] {
  if (!values || values.length === 0) return [];
  return values.map((value) => {
    const port = parseInteger(value, field);
    if (port < 1 || port > 65535) {
      throw new Error(`Invalid ${field}: ${value}`);
    }
    return port;
  });
}

function printExposureTable(exposures: PreviewExposure[]): void {
  if (exposures.length === 0) {
    console.log("No preview URLs found.");
    return;
  }

  for (const exposure of exposures) {
    console.log(
      [
        `id=${exposure.id}`,
        `port=${exposure.port}`,
        `status=${exposure.status}`,
        `visibility=${exposure.visibility}`,
        `url=${exposure.accessUrl ?? exposure.url}`,
        `expiresAt=${exposure.expiresAt}`,
      ].join(" ")
    );
  }
}

function getExposureApi(instance: unknown): ExposureApi {
  const api = (instance as { exposures?: ExposureApi }).exposures;
  if (!api) {
    throw new Error(
      "Installed SDK does not support preview URLs yet. Update @omnirun/sdk and try again."
    );
  }
  return api;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExposureReady(
  api: ExposureApi,
  exposure: PreviewExposure,
  waitTimeoutSeconds: number,
): Promise<PreviewExposure> {
  const timeoutMs = Math.max(waitTimeoutSeconds, 1) * 1000;
  const deadline = Date.now() + timeoutMs;
  let current = exposure;

  while (Date.now() < deadline) {
    if (current.status !== "pending") {
      return current;
    }
    await sleep(1000);
    current = await api.get(exposure.id);
  }

  return current;
}

async function pipeToCommand(command: string, args: string[], input: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(input);
  });
}

async function copyToClipboard(value: string): Promise<boolean> {
  if (!value) return false;
  if (process.platform === "darwin") {
    return pipeToCommand("pbcopy", [], value);
  }
  if (process.platform === "win32") {
    return pipeToCommand("clip", [], value);
  }
  if (await pipeToCommand("wl-copy", [], value)) return true;
  if (await pipeToCommand("xclip", ["-selection", "clipboard"], value)) return true;
  return pipeToCommand("xsel", ["--clipboard", "--input"], value);
}

async function openInBrowser(targetUrl: string): Promise<boolean> {
  if (!targetUrl) return false;

  const launch = (command: string, args: string[]): Promise<boolean> =>
    new Promise((resolve) => {
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    });

  if (process.platform === "darwin") {
    return launch("open", [targetUrl]);
  }
  if (process.platform === "win32") {
    return launch("cmd", ["/c", "start", "", targetUrl]);
  }
  return launch("xdg-open", [targetUrl]);
}

type PreviewCreateRequest = {
  ports: number[];
  ttlSeconds?: number;
  slug?: string;
  openPath?: string;
  preserveHost?: boolean;
  visibility: PreviewVisibility;
  wait: boolean;
  waitTimeoutSeconds: number;
  copy?: boolean;
  open?: boolean;
};

async function createPreviewUrls(
  instance: unknown,
  request: PreviewCreateRequest,
): Promise<PreviewExposure[]> {
  const api = getExposureApi(instance);
  const exposures: PreviewExposure[] = [];

  for (const port of request.ports) {
    let exposure = await api.create(port, {
      visibility: request.visibility,
      ttlSeconds: request.ttlSeconds,
      slug: request.slug,
      openPath: request.openPath,
      preserveHost: request.preserveHost,
    });
    if (request.wait) {
      exposure = await waitForExposureReady(api, exposure, request.waitTimeoutSeconds);
    }
    exposures.push(exposure);
  }

  if (request.copy && exposures.length > 0) {
    const copied = await copyToClipboard(exposures[0].accessUrl ?? exposures[0].url);
    if (!copied) {
      console.warn("Warning: Failed to copy preview URL to clipboard.");
    }
  }
  if (request.open && exposures.length > 0) {
    const opened = await openInBrowser(exposures[0].accessUrl ?? exposures[0].url);
    if (!opened) {
      console.warn("Warning: Failed to open preview URL in your browser.");
    }
  }

  return exposures;
}

function printCreatedExposures(exposures: PreviewExposure[]): void {
  for (const exposure of exposures) {
    console.log(`preview_id=${exposure.id}`);
    console.log(`preview_port=${exposure.port}`);
    console.log(`preview_status=${exposure.status}`);
    console.log(`preview_visibility=${exposure.visibility}`);
    console.log(`preview_url=${exposure.accessUrl ?? exposure.url}`);
    console.log(`preview_expires_at=${exposure.expiresAt}`);
    if (exposure.status === "pending") {
      console.log("preview_note=Still pending. Make sure your app is listening on 0.0.0.0.");
    }
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
      e2ee: (instance as any).e2ee
        ? {
            enabled: (instance as any).e2ee.enabled,
            clientPublicKeyLength: (instance as any).e2ee.clientPublicKey?.length ?? 0,
            serverPublicKeyPresent: Boolean((instance as any).e2ee.serverPublicKey),
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

    // Try live sandbox first
    try {
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
      return;
    } catch {
      // Fall through to history lookup
    }

    // TODO: re-enable when SDK adds history methods (moved to gateway)
    const hist: any = null;
    if (!hist) {
      throw new Error("sandbox not found (checked live and history)");
    }

    if (runtime.json) {
      printJson(hist);
      return;
    }

    console.log(`sandbox_id=${hist.sandboxId} (historical)`);
    console.log(`template_id=${hist.templateId}`);
    console.log(`status=${hist.status}`);
    console.log(`created_at=${hist.createdAt}`);
    if (hist.stoppedAt) console.log(`stopped_at=${hist.stoppedAt}`);
    console.log(`cpu_count=${hist.cpuCount}`);
    console.log(`memory_mb=${hist.memoryMB}`);
    console.log(`timeout=${hist.timeoutSeconds}s`);
  });

sandbox
  .command("history")
  .description("List past sandboxes")
  .option("--limit <n>", "Number of records to return", "20")
  .option("--offset <n>", "Offset for pagination", "0")
  .action(async function action(options: { limit: string; offset: string }) {
    const runtime = await resolveRuntime(this, true);
    // TODO: re-enable when SDK adds history methods (moved to gateway)
    const items: any[] = [];

    if (runtime.json) {
      printJson(items);
      return;
    }

    if (items.length === 0) {
      console.log("No sandbox history found.");
      return;
    }

    // Table header
    const cols = [
      { key: "sandboxId", label: "ID", width: 34 },
      { key: "templateId", label: "TEMPLATE", width: 14 },
      { key: "status", label: "STATUS", width: 12 },
      { key: "createdAt", label: "CREATED", width: 20 },
      { key: "stoppedAt", label: "STOPPED", width: 20 },
    ] as const;

    console.log(
      cols.map((c) => c.label.padEnd(c.width)).join("  ")
    );
    for (const item of items) {
      const row = cols.map((c) => {
        const val = (item as any)[c.key] ?? "-";
        return String(val).slice(0, c.width).padEnd(c.width);
      });
      console.log(row.join("  "));
    }
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

sandbox
  .command("expose")
  .description("Create a temporary preview URL for a sandbox port")
  .argument("<sandboxId>", "Sandbox ID")
  .argument("<port>", "Port to expose", (value: string) => parseInteger(value, "port"))
  .option("--ttl <seconds>", "Preview URL lifetime in seconds", (value: string) =>
    parseInteger(value, "ttl")
  )
  .option("--slug <slug>", "Custom preview slug")
  .option("--path <path>", "Open path to append to the preview URL")
  .option("--rewrite-host", "Rewrite Host to the canonical sandbox host instead of preserving preview host")
  .option("--private", "Require a signed preview access URL")
  .option("--no-wait", "Return immediately instead of waiting for readiness")
  .option("--wait-timeout <seconds>", "Max time to wait for readiness", (value: string) =>
    parseInteger(value, "wait-timeout")
  , 30)
  .option("--open", "Open the preview URL in your browser")
  .option("--copy", "Copy the preview URL to your clipboard")
  .action(async function action(
    sandboxId: string,
    port: number,
    options: {
      ttl?: number;
      slug?: string;
      path?: string;
      rewriteHost?: boolean;
      private?: boolean;
      wait?: boolean;
      waitTimeout?: number;
      open?: boolean;
      copy?: boolean;
    },
  ) {
    const runtime = await resolveRuntime(this, true);
    const instance = await Sandbox.connect(sandboxId, runtime.config);
    const [exposure] = await createPreviewUrls(instance, {
      ports: [port],
      ttlSeconds: options.ttl,
      slug: options.slug,
      openPath: options.path,
      preserveHost: !options.rewriteHost,
      visibility: options.private ? "private" : "public",
      wait: options.wait !== false,
      waitTimeoutSeconds: options.waitTimeout ?? 30,
      open: Boolean(options.open),
      copy: Boolean(options.copy),
    });

    if (runtime.json) {
      printJson(exposure);
      return;
    }

    printCreatedExposures([exposure]);
  });

sandbox
  .command("exposures")
  .description("List preview URLs for a sandbox")
  .argument("<sandboxId>", "Sandbox ID")
  .action(async function action(sandboxId: string) {
    const runtime = await resolveRuntime(this, true);
    const instance = await Sandbox.connect(sandboxId, runtime.config);
    const exposures = await getExposureApi(instance).list();

    if (runtime.json) {
      printJson(exposures);
      return;
    }

    printExposureTable(exposures);
  });

const closeExposure = sandbox
  .command("close")
  .description("Close a preview URL")
  .argument("<sandboxId>", "Sandbox ID")
  .argument("<exposureId>", "Preview exposure ID")
  .action(async function action(sandboxId: string, exposureId: string) {
    const runtime = await resolveRuntime(this, true);
    const instance = await Sandbox.connect(sandboxId, runtime.config);
    await getExposureApi(instance).close(exposureId);

    if (runtime.json) {
      printJson({ sandboxId, exposureId, closed: true });
      return;
    }

    console.log(`closed_preview=${exposureId}`);
  });

sandbox
  .command("refresh-exposure")
  .description("Refresh the expiry of a preview URL")
  .argument("<sandboxId>", "Sandbox ID")
  .argument("<exposureId>", "Preview exposure ID")
  .option("--ttl <seconds>", "New preview lifetime in seconds", (value: string) =>
    parseInteger(value, "ttl")
  )
  .action(async function action(
    sandboxId: string,
    exposureId: string,
    options: { ttl?: number },
  ) {
    const runtime = await resolveRuntime(this, true);
    const instance = await Sandbox.connect(sandboxId, runtime.config);
    const exposure = await getExposureApi(instance).refresh(exposureId, {
      ttlSeconds: options.ttl,
    });

    if (runtime.json) {
      printJson(exposure);
      return;
    }

    printCreatedExposures([exposure]);
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
      e2ee: Boolean(options.e2ee),
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
    e2ee: Boolean(options.e2ee),
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

type BeamupPreviewFlags = {
  expose?: string[];
  previewTtl?: string;
  previewPath?: string;
  privatePreview?: boolean;
  rewritePreviewHost?: boolean;
};

function addPreviewOptions(cmd: Command): Command {
  return cmd
    .option("--expose <port>", "Create a preview URL for a sandbox port", collect, [])
    .option("--preview-ttl <seconds>", "Preview URL lifetime in seconds")
    .option("--preview-path <path>", "Path to append to preview URLs")
    .option("--private-preview", "Require access-token URLs for previews")
    .option("--rewrite-preview-host", "Rewrite Host to the canonical sandbox host for previews");
}

async function maybeCreateBeamupPreviews(
  instance: unknown,
  options: BeamupPreviewFlags,
): Promise<PreviewExposure[]> {
  const ports = parsePorts(options.expose, "expose");
  if (ports.length === 0) {
    return [];
  }

  const exposures = await createPreviewUrls(instance, {
    ports,
    ttlSeconds: options.previewTtl ? parseInteger(options.previewTtl, "preview-ttl") : undefined,
    openPath: options.previewPath,
    preserveHost: !options.rewritePreviewHost,
    visibility: options.privatePreview ? "private" : "public",
    wait: false,
    waitTimeoutSeconds: 1,
  });

  printCreatedExposures(exposures);
  console.log("Use `omni sandbox exposures " + (instance as { sandboxId: string }).sandboxId + "` to check readiness.");
  return exposures;
}

// ── beamup command group ────────────────────────────────────────────

const beamup = program
  .command("beamup")
  .description("Launch preconfigured sandbox environments");

addPreviewOptions(
beamup
  .command("claude")
  .description("Launch Claude Code in an E2EE sandbox")
  .option("--template <id>", "Sandbox template ID", "claude-code")
  .option("--skip-permissions", "Run with --dangerously-skip-permissions")
  .option("--no-internet", "Disable internet access")
  .option("--timeout <seconds>", "Sandbox timeout in seconds")
  .option("--permanent", "Don't auto-expire the sandbox (timeout=0)")
  .option("--e2ee", "Enable E2EE (requires key generation)")
  .option("--auth-dir <path>", "Custom Claude auth directory (default: ~/.claude)")
  .option("--skip-auth-transfer", "Don't transfer credentials")
  .option("--env <key=value>", "Extra environment variable", collect, [])
  .option("-y, --yes", "Skip interactive prompts, use defaults")
).action(async function action(options: {
    template: string;
    skipPermissions?: boolean;
    internet?: boolean;
    timeout?: string;
    permanent?: boolean;
    e2ee?: boolean;
    authDir?: string;
    skipAuthTransfer?: boolean;
    env?: string[];
    expose?: string[];
    previewTtl?: string;
    previewPath?: string;
    privatePreview?: boolean;
    rewritePreviewHost?: boolean;
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

    await maybeCreateBeamupPreviews(instance, options);

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

addPreviewOptions(
beamup
  .command("codex")
  .description("Launch OpenAI Codex CLI in an E2EE sandbox")
  .option("--template <id>", "Sandbox template ID", "codex")
  .option("--no-internet", "Disable internet access")
  .option("--timeout <seconds>", "Sandbox timeout in seconds")
  .option("--permanent", "Don't auto-expire the sandbox (timeout=0)")
  .option("--e2ee", "Enable E2EE (requires key generation)")
  .option("--skip-auth-transfer", "Don't transfer credentials")
  .option("--env <key=value>", "Extra environment variable", collect, [])
  .option("-y, --yes", "Skip interactive prompts, use defaults")
).action(async function action(options: {
    template: string;
    internet?: boolean;
    timeout?: string;
    permanent?: boolean;
    e2ee?: boolean;
    skipAuthTransfer?: boolean;
    env?: string[];
    expose?: string[];
    previewTtl?: string;
    previewPath?: string;
    privatePreview?: boolean;
    rewritePreviewHost?: boolean;
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
    const e2ee = Boolean(options.e2ee);

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

    await maybeCreateBeamupPreviews(instance, options);

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

addPreviewOptions(
beamup
  .command("gemini")
  .description("Launch Gemini CLI in an E2EE sandbox")
  .option("--template <id>", "Sandbox template ID", "gemini-cli")
  .option("--no-internet", "Disable internet access")
  .option("--timeout <seconds>", "Sandbox timeout in seconds")
  .option("--permanent", "Don't auto-expire the sandbox (timeout=0)")
  .option("--e2ee", "Enable E2EE (requires key generation)")
  .option("--skip-auth-transfer", "Don't transfer credentials")
  .option("--env <key=value>", "Extra environment variable", collect, [])
  .option("-y, --yes", "Skip interactive prompts, use defaults")
).action(async function action(options: {
    template: string;
    internet?: boolean;
    timeout?: string;
    permanent?: boolean;
    e2ee?: boolean;
    skipAuthTransfer?: boolean;
    env?: string[];
    expose?: string[];
    previewTtl?: string;
    previewPath?: string;
    privatePreview?: boolean;
    rewritePreviewHost?: boolean;
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
    const e2ee = Boolean(options.e2ee);

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

    await maybeCreateBeamupPreviews(instance, options);

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

addPreviewOptions(
beamup
  .command("openclaw")
  .description("Launch OpenClaw in an E2EE sandbox (permanent by default)")
  .option("--template <id>", "Sandbox template ID", "openclaw")
  .option("--no-internet", "Disable internet access")
  .option("--timeout <seconds>", "Override with fixed timeout (overrides --permanent)")
  .option("--permanent", "Don't auto-expire the sandbox (default for openclaw)")
  .option("--e2ee", "Enable E2EE (requires key generation)")
  .option("--skip-auth-transfer", "Don't transfer OpenClaw state")
  .option("--env <key=value>", "Extra environment variable", collect, [])
  .option("-y, --yes", "Skip interactive prompts, use defaults")
).action(async function action(options: {
    template: string;
    internet?: boolean;
    timeout?: string;
    permanent?: boolean;
    e2ee?: boolean;
    skipAuthTransfer?: boolean;
    env?: string[];
    expose?: string[];
    previewTtl?: string;
    previewPath?: string;
    privatePreview?: boolean;
    rewritePreviewHost?: boolean;
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

    const e2ee = Boolean(options.e2ee);

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

    await maybeCreateBeamupPreviews(instance, options);

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

// ── LLM proxy commands ──────────────────────────────────────────────

const llm = program.command("llm").description("LLM proxy for chat completions, models, and usage");

llm
  .command("chat")
  .description("Send a chat completion request")
  .argument("[message]", "Message to send (reads from stdin when omitted)")
  .option("--model <model>", "Model identifier", "openai/gpt-4o-mini")
  .option("--system <prompt>", "System prompt")
  .option("--max-tokens <n>", "Maximum tokens in response", (v: string) => parseInteger(v, "max-tokens"))
  .option("--temperature <n>", "Sampling temperature", Number.parseFloat)
  .option("--no-stream", "Disable streaming")
  .action(async function action(
    message: string | undefined,
    options: {
      model: string;
      system?: string;
      maxTokens?: number;
      temperature?: number;
      stream: boolean;
    },
  ) {
    const { config } = await resolveRuntime(this, true);
    const client = new LLM(config);

    // Read message from positional arg or stdin
    let userMessage = message;
    if (!userMessage) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      userMessage = Buffer.concat(chunks).toString("utf8").trim();
    }
    if (!userMessage) {
      throw new Error("No message provided. Pass as argument or pipe via stdin.");
    }

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
    if (options.system) {
      messages.push({ role: "system", content: options.system });
    }
    messages.push({ role: "user", content: userMessage });

    const request = {
      model: options.model,
      messages,
      ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
    };

    if (options.stream) {
      for await (const chunk of client.streamChatCompletion(request)) {
        process.stdout.write(chunk);
      }
      process.stdout.write("\n");
    } else {
      const resp = await client.chatCompletion(request);
      const content = resp.choices?.[0]?.message?.content ?? "";
      process.stdout.write(content + "\n");
      if (resp.usage) {
        const u = resp.usage;
        process.stderr.write(
          `tokens: ${u.prompt_tokens} prompt + ${u.completion_tokens} completion = ${u.total_tokens} total` +
            (u.cost != null ? ` ($${u.cost.toFixed(4)})` : "") +
            "\n",
        );
      }
    }
  });

llm
  .command("models")
  .description("List available LLM models")
  .action(async function action() {
    const { config, json: jsonOutput } = await resolveRuntime(this, true);
    const client = new LLM(config);
    const models = await client.listModels();

    if (jsonOutput) {
      console.log(JSON.stringify(models, null, 2));
    } else {
      if (models.length === 0) {
        console.log("No models available.");
      } else {
        for (const m of models) {
          console.log(m.id);
        }
      }
    }
  });

llm
  .command("usage")
  .description("Show LLM spend and remaining credits")
  .action(async function action() {
    const { config, json: jsonOutput } = await resolveRuntime(this, true);
    const client = new LLM(config);
    const usage = await client.getUsage();

    if (jsonOutput) {
      console.log(JSON.stringify(usage, null, 2));
    } else {
      console.log(`Spent:     ${(usage.spendUsedCents / 100).toFixed(2)} USD`);
      console.log(`Cap:       ${(usage.spendCapCents / 100).toFixed(2)} USD`);
      console.log(`Remaining: ${(usage.remainingCents / 100).toFixed(2)} USD`);
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
