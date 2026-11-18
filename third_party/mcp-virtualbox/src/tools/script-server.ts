import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError } from "../vbox.js";

/** VAMP serves guest setup over HTTP on this fixed, non-well-known port. */
export const SCRIPT_SERVER_PORT = 8421;

export interface ScriptServerInfo {
  status: "running" | "stopped" | "starting" | "port_in_use" | "failed" | string;
  port: number;
  pid?: number;
  bind?: string;
  directory?: string;
  started_at?: string;
  ttl_seconds?: number;
  url?: string;
  guest_urls?: Record<string, string>;
  commands?: Record<string, string>;
  manifest?: string;
  log?: string;
  error?: string;
  reused?: boolean;
}

export function scriptServerPython(): string {
  return (
    process.env.RPA_HOST_PYTHON ||
    process.env.PYTHON_PATH ||
    (process.platform === "win32" ? "python" : "python3")
  );
}

/** Locate scripts/script_server.py in the repository, the VSIX runtime or the npm runtime. */
export function scriptServerPath(assets?: string | null): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  if (process.env.VAMP_SCRIPT_SERVER_PATH) candidates.push(process.env.VAMP_SCRIPT_SERVER_PATH);
  if (assets) candidates.push(join(assets, "scripts", "script_server.py"));
  // Walk up from the module: the bundle lives in dist/runtime/backends/virtualbox, the
  // TypeScript build in dist/tools, and the source in src/tools.
  let directory = here;
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(join(directory, "scripts", "script_server.py"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  candidates.push(join(process.cwd(), "scripts", "script_server.py"));
  if (process.env.VAMP_REMOTE_REPO) {
    candidates.push(join(process.env.VAMP_REMOTE_REPO, "scripts", "script_server.py"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `scripts/script_server.py was not found next to the VAMP runtime (looked in ${candidates.join(", ")}).`,
  );
}

export interface ScriptServerCallOptions {
  port?: number;
  timeoutMs?: number;
}

/** Run one script_server.py subcommand and parse its JSON document. */
export async function callScriptServer(
  command: "start" | "stop" | "status" | "stage",
  extra: string[] = [],
  options: ScriptServerCallOptions = {},
): Promise<ScriptServerInfo> {
  const loadAssets = process.env.VAMP_SCRIPT_SERVER_PATH ? undefined : Reflect.get(globalThis, Symbol.for("vamp.provisioningAssets"));
  const assets = await loadAssets?.(command === "status" || command === "stop");
  if (loadAssets && !assets) {
    throw new Error("The provisioning cache is not installed. Install the matching assets to check or stop a script server.");
  }
  const script = scriptServerPath(assets);
  const port = options.port ?? SCRIPT_SERVER_PORT;
  const args = [script, command, "--port", String(port), "--json", ...extra];
  return new Promise<ScriptServerInfo>((resolve, reject) => {
    execFile(
      scriptServerPython(),
      args,
      { timeout: options.timeoutMs ?? 120000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const text = String(stdout || "").trim();
        if (text) {
          try {
            const parsed = JSON.parse(text) as ScriptServerInfo;
            if (parsed.status === "failed" || parsed.status === "port_in_use") {
              resolve(parsed);
              return;
            }
            if (!error) {
              resolve(parsed);
              return;
            }
          } catch {
            // fall through to the error below
          }
        }
        const detail = String(stderr || "").trim() || (error ? error.message : "no output");
        reject(new Error(`VAMP script server ${command} failed: ${detail}`));
      },
    );
  });
}

export async function startScriptServer(options: {
  port?: number;
  bind?: string;
  ttlSeconds?: number;
} = {}): Promise<ScriptServerInfo> {
  const extra: string[] = [];
  if (options.bind) extra.push("--bind", options.bind);
  if (options.ttlSeconds !== undefined) extra.push("--ttl", String(options.ttlSeconds));
  return callScriptServer("start", extra, { port: options.port });
}

export async function stopScriptServer(options: { port?: number } = {}): Promise<ScriptServerInfo> {
  return callScriptServer("stop", [], { port: options.port });
}

export async function scriptServerStatus(options: { port?: number } = {}): Promise<ScriptServerInfo> {
  return callScriptServer("status", [], { port: options.port });
}

function errorMessage(error: unknown): string {
  return formatError(error);
}

export function registerScriptServerTools(server: McpServer) {
  server.tool(
    "vm_script_server_start",
    `Start the host Python HTTP server on port ${SCRIPT_SERVER_PORT} that serves the guest setup folder (recorder, vault helpers, setup.sh/setup.ps1). Guests fetch it with wget/curl instead of a mounted or rewritten ISO; xorriso is not used. The server stops itself after ttlSeconds.`,
    {
      ttlSeconds: z
        .number()
        .int()
        .min(0)
        .max(86400)
        .default(1800)
        .describe("Seconds before the server stops itself (0 disables the limit)"),
      bind: z
        .string()
        .default("0.0.0.0")
        .describe("Bind address. 0.0.0.0 serves VirtualBox NAT (10.0.2.2) and libvirt NAT (192.168.122.1); 127.0.0.1 is enough for VirtualBox NAT only"),
    },
    async ({ ttlSeconds, bind }) => {
      try {
        const info = await startScriptServer({ ttlSeconds: ttlSeconds ?? 1800, bind: bind ?? "0.0.0.0" });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...info, verified: info.status === "running" }, null, 2) }],
          isError: info.status !== "running",
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "failed",
                port: SCRIPT_SERVER_PORT,
                error: errorMessage(error),
                next_action: "Start it manually with: python3 scripts/script_server.py start",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "vm_script_server_status",
    `Report whether the VAMP guest setup HTTP server is running on port ${SCRIPT_SERVER_PORT}, with its guest URLs and wget/curl commands.`,
    {},
    async () => {
      const info = await scriptServerStatus();
      return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }], isError: info.status === "port_in_use" };
    },
  );

  server.tool(
    "vm_script_server_stop",
    `Stop the VAMP guest setup HTTP server on port ${SCRIPT_SERVER_PORT}. Do this once the guest finished installing; it also stops itself after its TTL.`,
    {},
    async () => {
      const info = await stopScriptServer();
      return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }], isError: info.status === "failed" };
    },
  );
}
