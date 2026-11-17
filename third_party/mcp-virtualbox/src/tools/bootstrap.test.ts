import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../vbox.js", () => ({
  vboxManage: vi.fn(),
  formatError: vi.fn((e: unknown) => e instanceof Error ? e.message : String(e)),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { vboxManage } from "../vbox.js";
import {
  registerBootstrapTools,
  runBootstrap,
  planBootstrap,
  redactPlan,
  DEFAULT_BOOTSTRAP_COMMANDS,
  WINDOWS_SHELL_COMMAND,
  SCRIPT_SERVER_PORT,
  defaultBootstrapCommand,
  type BootstrapOptions,
} from "./bootstrap.js";

const mockVboxManage = vi.mocked(vboxManage);

let toolHandlers: Map<string, Function>;

beforeEach(() => {
  vi.clearAllMocks();
  mockVboxManage.mockResolvedValue("");
  const server = new McpServer({ name: "test", version: "1.0.0" }, { capabilities: { tools: {} } });
  toolHandlers = new Map();
  // @ts-ignore
  server.tool = (...args: unknown[]) => {
    toolHandlers.set(args[0] as string, args[args.length - 1] as Function);
  };
  registerBootstrapTools(server);
});

function callTool(name: string, params: Record<string, unknown> = {}) {
  const handler = toolHandlers.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  return handler(params);
}

/** Options with instant timings so a sequence test does not sleep through the real delays. */
function options(overrides: Partial<BootstrapOptions> = {}): BootstrapOptions {
  return {
    vm: "TestVM",
    guestOs: "windows11",
    bootWaitSec: 0,
    clickX: 960,
    clickY: 540,
    dryRun: false,
    focusClick: true,
    serveScripts: false,
    ...overrides,
  };
}

const noSleep = async () => {};
const noClick = async () => {};

describe("vm_guest_bootstrap registration", () => {
  it("registers the tool", () => {
    expect(toolHandlers.has("vm_guest_bootstrap")).toBe(true);
  });

  it("returns the planned keystrokes in dryRun without touching the VM", async () => {
    const result = await callTool("vm_guest_bootstrap", {
      vm: "TestVM", os: "windows11", bootWaitSec: 0, clickX: 960, clickY: 540, dryRun: true,
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("dry_run");
    expect(parsed.vm).toBe("TestVM");
    expect(parsed.command).toBe(DEFAULT_BOOTSTRAP_COMMANDS.windows11);
    expect(parsed.verified).toBe(false);
    expect(parsed.plan.map((step: { kind: string }) => step.kind)).toEqual([
      "wait", "keys", "wait", "type", "wait", "click", "wait", "type", "wait", "type",
    ]);
    expect(mockVboxManage).not.toHaveBeenCalled();
  });

  it("defaults to windows11 and the HTTP setup command on port 8421", async () => {
    const result = await callTool("vm_guest_bootstrap", { vm: "TestVM", bootWaitSec: 0, dryRun: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.os).toBe("windows11");
    expect(parsed.command).toBe('powershell -ExecutionPolicy Bypass -Command "irm http://10.0.2.2:8421/setup.ps1 | iex"');
    expect(parsed.command).not.toContain("ProgramData");
  });

  it("strips a trailing dot that Windows resolves to the local machine", async () => {
    const result = await callTool("vm_guest_bootstrap", { vm: "TestVM.", bootWaitSec: 0, dryRun: true });
    expect(JSON.parse(result.content[0].text).vm).toBe("TestVM");
  });
});

describe("windows11 sequence", () => {
  it("opens Run, starts cmd, clicks for focus, then types PowerShell and the script", async () => {
    await runBootstrap(options(), { sleep: noSleep, click: noClick });
    const calls = mockVboxManage.mock.calls;
    expect(calls[0]).toEqual(["controlvm", "TestVM", "keyboardputscancode", "e0", "5b", "13", "93", "e0", "db"]);
    expect(calls[1]).toEqual(["controlvm", "TestVM", "keyboardputstring", "cmd"]);
    expect(calls[2]).toEqual(["controlvm", "TestVM", "keyboardputscancode", "1c", "9c"]);
    expect(calls[3]).toEqual(["controlvm", "TestVM", "keyboardputstring", WINDOWS_SHELL_COMMAND]);
    expect(calls[4]).toEqual(["controlvm", "TestVM", "keyboardputscancode", "1c", "9c"]);
    // The script path is longer than one chunk, so it is split and closed with Enter.
    expect(calls.slice(5, -1).every(call => call[2] === "keyboardputstring")).toBe(true);
    expect(calls.at(-1)).toEqual(["controlvm", "TestVM", "keyboardputscancode", "1c", "9c"]);
    expect(calls.slice(5, -1).map(call => call[3]).join("")).toBe(DEFAULT_BOOTSTRAP_COMMANDS.windows11);
  });

  it("clicks the configured focus point once", async () => {
    const clicks: Array<[number, number]> = [];
    await runBootstrap(options({ clickX: 100, clickY: 200 }), { sleep: noSleep, click: async (x, y) => { clicks.push([x, y]); } });
    expect(clicks).toEqual([[100, 200]]);
  });

  it("skips the click when focusClick is false", async () => {
    const click = vi.fn(noClick);
    const result = await runBootstrap(options({ focusClick: false }), { sleep: noSleep, click });
    expect(click).not.toHaveBeenCalled();
    expect(result.plan.some(step => step.kind === "click")).toBe(false);
    expect(result.executed).not.toContain("click the console to pin keyboard focus");
  });

  it("sends a custom command instead of the default script", async () => {
    const result = await runBootstrap(options({ command: "powershell -NoProfile -File C:\\setup\\all.ps1" }), { sleep: noSleep, click: noClick });
    const typed = mockVboxManage.mock.calls.filter(call => call[2] === "keyboardputstring").map(call => call[3]);
    expect(typed.at(-1)).toBe("powershell -NoProfile -File C:\\setup\\all.ps1");
    expect(typed).not.toContain(DEFAULT_BOOTSTRAP_COMMANDS.windows11);
    expect(result.command).toBe("powershell -NoProfile -File C:\\setup\\all.ps1");
  });
});

describe("debian sequence", () => {
  it("clicks the screen centre then types the command without opening Run", async () => {
    const clicks: Array<[number, number]> = [];
    const result = await runBootstrap(options({ guestOs: "debian" }), { sleep: noSleep, click: async (x, y) => { clicks.push([x, y]); } });
    expect(clicks).toEqual([[960, 540]]);
    expect(result.command).toBe(DEFAULT_BOOTSTRAP_COMMANDS.debian);
    const codes = mockVboxManage.mock.calls.filter(call => call[2] === "keyboardputscancode");
    // Only Enter is sent: no Win+R.
    expect(codes).toEqual([["controlvm", "TestVM", "keyboardputscancode", "1c", "9c"]]);
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "keyboardputstring", "wget -qO- http://10.0.2.2:8421/setup.sh | sh");
  });

  it("types the TTY login before the command and never returns the password", async () => {
    const result = await runBootstrap(
      options({ guestOs: "debian", username: "vboxuser", password: "password123!" }),
      { sleep: noSleep, click: noClick },
    );
    const typed = mockVboxManage.mock.calls.filter(call => call[2] === "keyboardputstring").map(call => call[3]);
    expect(typed).toEqual(["vboxuser", "password123!", "wget -qO- http://10.0.2.2:8421/setup.sh | sh"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("password123!");
    expect(serialized).toContain("********");
  });

  it("opens a desktop terminal on request", async () => {
    await runBootstrap(options({ guestOs: "debian", openTerminal: true }), { sleep: noSleep, click: noClick });
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "keyboardputscancode", "1d", "38", "14", "94", "b8", "9d");
  });

  it("uses the click point that a scaled 1920x1080 screen needs", () => {
    const plan = planBootstrap({ ...options({ guestOs: "debian", clickX: 640, clickY: 400 }), command: "/media/cdrom/setup.sh" });
    expect(plan.find(step => step.kind === "click")).toMatchObject({ x: 640, y: 400 });
  });
});

describe("HTTP guest setup", () => {
  it("starts the host script server before typing the default command", async () => {
    const ensureScriptServer = vi.fn(async () => ({ status: "running", port: 8421, pid: 7 }));
    const result = await runBootstrap(options({ serveScripts: true }), { sleep: noSleep, click: noClick, ensureScriptServer });
    expect(ensureScriptServer).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(result.scriptServer).toMatchObject({ status: "running", port: 8421 });
    expect(result.command).toContain(`http://10.0.2.2:${SCRIPT_SERVER_PORT}/setup.ps1`);
  });

  it("types nothing when the script server cannot start", async () => {
    const result = await runBootstrap(options({ serveScripts: true }), {
      sleep: noSleep,
      click: noClick,
      ensureScriptServer: async () => ({ status: "port_in_use", port: 8421, error: "Port 8421 is already used" }),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("8421");
    expect(mockVboxManage).not.toHaveBeenCalled();
  });

  it("does not start a server for an explicit command", async () => {
    const ensureScriptServer = vi.fn(async () => ({ status: "running", port: 8421 }));
    await runBootstrap(options({ serveScripts: true, command: "powershell -NoProfile -File C:\\setup\\all.ps1" }), {
      sleep: noSleep,
      click: noClick,
      ensureScriptServer,
    });
    expect(ensureScriptServer).not.toHaveBeenCalled();
  });

  it("uses a guest base URL for the libvirt default network", () => {
    const plan = planBootstrap({
      ...options({ guestOs: "debian", scriptServerUrl: "http://192.168.122.1:8421/" }),
      command: defaultBootstrapCommand("debian", "http://192.168.122.1:8421"),
    });
    expect(plan.at(-1)).toMatchObject({ text: "wget -qO- http://192.168.122.1:8421/setup.sh | sh" });
  });
});

describe("execution limits", () => {
  it("chunks a long command and waits between chunks", async () => {
    const waits: number[] = [];
    const command = "x".repeat(120);
    await runBootstrap(options({ command, chunkSize: 50, keyDelayMs: 30 }), {
      sleep: async (ms) => { waits.push(ms); },
      click: noClick,
    });
    const typed = mockVboxManage.mock.calls.filter(call => call[2] === "keyboardputstring").map(call => call[3]);
    expect(typed.slice(-3)).toEqual(["x".repeat(50), "x".repeat(50), "x".repeat(20)]);
    expect(waits.filter(ms => ms === 30)).toHaveLength(2);
  });

  it("keeps going when the focus click fails and records a warning", async () => {
    const result = await runBootstrap(options(), {
      sleep: noSleep,
      click: async () => { throw new Error("vboxapi is not installed"); },
    });
    expect(result.status).toBe("completed");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("vboxapi is not installed");
    expect(result.executed).not.toContain("click (960, 540) to pin keyboard focus");
    expect(mockVboxManage).toHaveBeenCalledWith("controlvm", "TestVM", "keyboardputstring", "cmd");
  });

  it("stops with the failing step when VBoxManage rejects a keystroke", async () => {
    mockVboxManage.mockRejectedValueOnce(new Error("VBoxManage controlvm failed: machine is not running"));
    const result = await runBootstrap(options(), { sleep: noSleep, click: noClick });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("machine is not running");
    expect(result.executed.filter(label => !label.startsWith("wait"))).toHaveLength(0);
    expect(result.verified).toBe(false);
  });

  it("never waits or types in dryRun", async () => {
    const waits: number[] = [];
    const click = vi.fn(noClick);
    const result = await runBootstrap(options({ dryRun: true, bootWaitSec: 30 }), { sleep: async (ms) => { waits.push(ms); }, click });
    expect(result.status).toBe("dry_run");
    expect(waits).toHaveLength(0);
    expect(click).not.toHaveBeenCalled();
    expect(mockVboxManage).not.toHaveBeenCalled();
    expect(result.plan[0]).toMatchObject({ kind: "wait", ms: 30000 });
  });

  it("says delivery is not proof of execution", async () => {
    const result = await runBootstrap(options(), { sleep: noSleep, click: noClick });
    expect(result.status).toBe("completed");
    expect(result.verified).toBe(false);
    expect(result.next_action).toMatch(/not proof of execution/i);
  });

  it("redacts secret plan steps", () => {
    const plan = planBootstrap({
      ...options({ guestOs: "debian", username: "vboxuser", password: "hunter2" }),
      command: "/media/cdrom/setup.sh",
    });
    const redacted = redactPlan(plan);
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
    expect(JSON.stringify(plan)).toContain("hunter2");
  });
});
