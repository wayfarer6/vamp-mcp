import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";
import {
  SCRIPT_SERVER_PORT,
  callScriptServer,
  scriptServerPath,
  startScriptServer,
  stopScriptServer,
} from "./script-server.js";

const mockExecFile = vi.mocked(execFile);

function reply(stdout: unknown, error: Error | null = null, stderr = "") {
  mockExecFile.mockImplementation(((_file: string, _args: string[], _options: unknown, callback: Function) => {
    callback(error, JSON.stringify(stdout), stderr);
    return {} as never;
  }) as unknown as typeof execFile);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("script server helpers", () => {
  it("uses the fixed VAMP port 8421", () => {
    expect(SCRIPT_SERVER_PORT).toBe(8421);
  });

  it("finds scripts/script_server.py from the source tree", () => {
    expect(scriptServerPath()).toMatch(/scripts[\\/]script_server\.py$/);
  });

  it("starts the Python server on port 8421 and parses its JSON", async () => {
    reply({ status: "running", port: 8421, pid: 42, guest_urls: { virtualbox_nat: "http://10.0.2.2:8421" } });
    const info = await startScriptServer({ ttlSeconds: 600, bind: "0.0.0.0" });
    expect(info.status).toBe("running");
    expect(info.pid).toBe(42);
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args.slice(1, 3)).toEqual(["start", "--port"]);
    expect(args).toContain("8421");
    expect(args).toContain("--ttl");
    expect(args).toContain("600");
    expect(args).toContain("--bind");
  });

  it("asks for status and stop without inventing a result", async () => {
    reply({ status: "stopped", port: 8421 });
    expect((await callScriptServer("status")).status).toBe("stopped");
    expect((await stopScriptServer()).status).toBe("stopped");
    expect((mockExecFile.mock.calls[0][1] as string[])[1]).toBe("status");
    expect((mockExecFile.mock.calls[1][1] as string[])[1]).toBe("stop");
  });

  it("surfaces a port conflict instead of pretending to be running", async () => {
    reply({ status: "port_in_use", port: 8421, error: "Port 8421 is already used by another service." });
    const info = await startScriptServer();
    expect(info.status).toBe("port_in_use");
    expect(info.error).toContain("8421");
  });

  it("rejects with the stderr detail when the Python script cannot run", async () => {
    mockExecFile.mockImplementation(((_file: string, _args: string[], _options: unknown, callback: Function) => {
      callback(new Error("spawn python3 ENOENT"), "", "python3: not found");
      return {} as never;
    }) as unknown as typeof execFile);
    await expect(callScriptServer("status")).rejects.toThrow(/python3: not found/);
  });
});
