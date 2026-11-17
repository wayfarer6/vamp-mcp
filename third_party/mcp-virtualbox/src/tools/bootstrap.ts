import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { vboxManage, formatError } from "../vbox.js";
import { resolveScancodes } from "../scancodes.js";
import { config } from "../types.js";

export type GuestOs = "windows11" | "debian";

export const DEFAULT_BOOTSTRAP_COMMANDS: Record<GuestOs, string> = {
  windows11: "cmd.exe /c C:\\ProgramData\\RPA-Recorder-Setup\\setup-win.cmd",
  debian: "/media/cdrom/setup.sh",
};

/** Key combinations used by the Packer-style sequence. */
export const BOOTSTRAP_COMBOS = {
  runDialog: "win+r",
  enter: "enter",
  terminal: "ctrl+alt+t",
} as const;

/** Default PowerShell used on Windows: bypass execution policy so .ps1 post-install scripts run. */
export const WINDOWS_SHELL_COMMAND = "powershell -ExecutionPolicy Bypass";

export interface BootstrapOptions {
  vm: string;
  guestOs: GuestOs;
  /** Command or script path executed in the guest. Defaults to the recorder setup script per OS. */
  command?: string;
  /** Seconds to wait after boot before the first keystroke. */
  bootWaitSec: number;
  clickX: number;
  clickY: number;
  dryRun: boolean;
  /** Click the screen centre to pin keyboard focus. The pointer stays in the middle; keystrokes go to the guest either way. */
  focusClick?: boolean;
  /** Debian only: open a desktop terminal with Ctrl+Alt+T before typing. */
  openTerminal?: boolean;
  /** Debian only: TTY login before typing the command. */
  username?: string;
  password?: string;
  chunkSize?: number;
  keyDelayMs?: number;
}

export type BootstrapStep =
  | { kind: "wait"; ms: number; label: string }
  | { kind: "keys"; combo: string; label: string }
  | { kind: "type"; text: string; enter: boolean; label: string; secret?: boolean }
  | { kind: "click"; x: number; y: number; label: string };

export interface BootstrapRuntime {
  /** VBoxManage runner. Defaults to the controlvm executor. */
  vbox?: (args: string[]) => Promise<string>;
  /** Absolute pointer click on the guest screen. Defaults to the VirtualBox API mouse helper. */
  click?: (x: number, y: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface BootstrapResult {
  status: "completed" | "dry_run" | "failed";
  vm: string;
  os: GuestOs;
  command: string;
  plan: BootstrapStep[];
  executed: string[];
  warnings: string[];
  /** Keystroke and pointer delivery is not proof that the guest script ran. */
  verified: boolean;
  error?: string;
  next_action?: string;
}

export function planBootstrap(options: BootstrapOptions & { command: string }): BootstrapStep[] {
  const steps: BootstrapStep[] = [];
  const focus = options.focusClick !== false;
  const bootWait = Math.max(0, options.bootWaitSec);
  steps.push({
    kind: "wait",
    ms: bootWait * 1000,
    label: `wait ${bootWait}s for the guest to finish booting and reach its desktop`,
  });

  if (options.guestOs === "windows11") {
    steps.push({ kind: "keys", combo: BOOTSTRAP_COMBOS.runDialog, label: "open the Run dialog (Win+R)" });
    steps.push({ kind: "wait", ms: 2000, label: "wait for the Run dialog" });
    steps.push({ kind: "type", text: "cmd", enter: true, label: "start cmd" });
    steps.push({ kind: "wait", ms: 2500, label: "wait for the console window" });
    if (focus) steps.push(clickStep(options));
    if (focus) steps.push({ kind: "wait", ms: 1000, label: "wait for the console to take keyboard focus" });
    steps.push({ kind: "type", text: WINDOWS_SHELL_COMMAND, enter: true, label: "start PowerShell with a bypass execution policy" });
    steps.push({ kind: "wait", ms: 1500, label: "wait for PowerShell" });
  } else {
    if (focus) steps.push(clickStep(options));
    steps.push({ kind: "wait", ms: 1000, label: "wait for the terminal to take keyboard focus" });
    if (options.openTerminal) {
      steps.push({ kind: "keys", combo: BOOTSTRAP_COMBOS.terminal, label: "open a desktop terminal (Ctrl+Alt+T)" });
      steps.push({ kind: "wait", ms: 2000, label: "wait for the terminal window" });
    }
    if (options.username) {
      steps.push({ kind: "type", text: options.username, enter: true, label: "type the TTY login name" });
      steps.push({ kind: "wait", ms: 1500, label: "wait for the password prompt" });
      if (options.password) {
        steps.push({ kind: "type", text: options.password, enter: true, label: "type the TTY password", secret: true });
        steps.push({ kind: "wait", ms: 1500, label: "wait for the shell prompt" });
      }
    }
  }

  steps.push({ kind: "type", text: options.command, enter: true, label: "run the bootstrap script" });
  return steps;
}

function clickStep(options: BootstrapOptions): BootstrapStep {
  return {
    kind: "click",
    x: options.clickX,
    y: options.clickY,
    label: `click (${options.clickX}, ${options.clickY}) to pin keyboard focus`,
  };
}

/** Replace secrets so a plan can be returned or logged without exposing a guest password. */
export function redactPlan(plan: BootstrapStep[]): BootstrapStep[] {
  return plan.map(step => (step.kind === "type" && step.secret ? { ...step, text: "********" } : step));
}

function mouseHelperClick(vm: string, x: number, y: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(config.pythonPath, [config.mouseHelperPath, vm, String(x), String(y), "left"], { timeout: config.defaultTimeout }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim() || "mouse helper failed"));
      else resolve();
    });
  });
}

export async function runBootstrap(options: BootstrapOptions, runtime: BootstrapRuntime = {}): Promise<BootstrapResult> {
  const command = (options.command ?? "").trim() || DEFAULT_BOOTSTRAP_COMMANDS[options.guestOs];
  const plan = planBootstrap({ ...options, command });
  const vm = options.vm;
  const vbox = runtime.vbox ?? ((args: string[]) => vboxManage(...args));
  const click = runtime.click ?? ((x: number, y: number) => mouseHelperClick(vm, x, y));
  const sleep = runtime.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const log = runtime.log ?? config.log;
  const chunkSize = Math.max(1, options.chunkSize ?? 50);
  const keyDelayMs = Math.max(0, options.keyDelayMs ?? 30);

  const result: BootstrapResult = {
    status: "dry_run",
    vm,
    os: options.guestOs,
    command,
    plan: redactPlan(plan),
    executed: [],
    warnings: [],
    verified: false,
  };
  if (options.dryRun) {
    result.next_action = "Review the ordered steps, then call again with dryRun=false to inject them.";
    return result;
  }

  for (const step of plan) {
    try {
      if (step.kind === "wait") {
        if (step.ms > 0) await sleep(step.ms);
      } else if (step.kind === "keys") {
        await vbox(["controlvm", vm, "keyboardputscancode", ...resolveScancodes(step.combo)]);
      } else if (step.kind === "type") {
        for (let i = 0; i < step.text.length; i += chunkSize) {
          const chunk = step.text.slice(i, i + chunkSize);
          await vbox(["controlvm", vm, "keyboardputstring", chunk]);
          if (i + chunkSize < step.text.length && keyDelayMs > 0) await sleep(keyDelayMs);
        }
        if (step.enter) await vbox(["controlvm", vm, "keyboardputscancode", ...resolveScancodes(BOOTSTRAP_COMBOS.enter)]);
      } else if (step.kind === "click") {
        try {
          await click(step.x, step.y);
        } catch (error) {
          // A failed focus click does not stop the sequence: the Run dialog or a fresh console already holds focus.
          const detail = formatError(error);
          result.warnings.push(`Focus click at (${step.x}, ${step.y}) failed: ${detail}. Keystrokes were still sent; if the guest lost keyboard focus, inject again.`);
          log(`[bootstrap] focus click failed: ${detail}`);
          continue;
        }
      }
      result.executed.push(step.kind === "type" && step.secret ? step.label : step.label);
      log(`[bootstrap] ${step.label}`);
    } catch (error) {
      result.status = "failed";
      result.error = `${step.label}: ${formatError(error)}`;
      result.next_action = "Confirm the VM is running, then call vm_guest_bootstrap again or send the command with vm_keyboard_type.";
      return result;
    }
  }

  result.status = "completed";
  result.next_action = "Delivery is not proof of execution. Screenshot the guest or read its setup log before treating the recorder or script as installed.";
  return result;
}

function sanitizeVm(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

export function registerBootstrapTools(server: McpServer) {
  server.tool(
    "vm_guest_bootstrap",
    "Bootstrap a newly installed Windows or Debian VM using keystroke injection (Packer style). Opens the Run dialog (Win+R) or focuses the terminal, launches PowerShell/shell, and executes the bootstrap script. Send keystrokes and pointer events only; success means the keys were delivered, not that the guest ran the script.",
    {
      vm: z.string().describe("VM name or UUID"),
      os: z.enum(["windows11", "debian"]).default("windows11").describe("Guest OS type"),
      command: z.string().optional().describe(`Command/script path to execute in guest. Default for windows11: "${DEFAULT_BOOTSTRAP_COMMANDS.windows11}", for debian: "${DEFAULT_BOOTSTRAP_COMMANDS.debian}".`),
      bootWaitSec: z.number().default(30).describe("Seconds to wait after boot before injecting keys"),
      clickX: z.number().default(960).describe("X coordinate for focus click"),
      clickY: z.number().default(540).describe("Y coordinate for focus click"),
      dryRun: z.boolean().default(false).describe("Return planned keystroke/mouse actions without executing"),
      focusClick: z.boolean().default(true).describe("Click the screen centre to pin keyboard focus before typing"),
      openTerminal: z.boolean().default(false).describe("Debian only: press Ctrl+Alt+T to open a desktop terminal first"),
      username: z.string().optional().describe("Debian only: TTY login name, typed before the command when a console login is needed"),
      password: z.string().optional().describe("Debian only: TTY password, typed after the login name. Never echoed back in the result"),
      chunkSize: z.number().default(50).describe("Characters per keyboardputstring call. Smaller is safer; the guest keyboard buffer drops characters if overrun"),
      keyDelayMs: z.number().default(30).describe("Delay in ms between chunks"),
    },
    async ({ vm, os, command, bootWaitSec, clickX, clickY, dryRun, focusClick, openTerminal, username, password, chunkSize, keyDelayMs }) => {
      const result = await runBootstrap({
        vm: sanitizeVm(vm),
        guestOs: os ?? "windows11",
        command,
        bootWaitSec: bootWaitSec ?? 30,
        clickX: clickX ?? 960,
        clickY: clickY ?? 540,
        dryRun: dryRun ?? false,
        focusClick: focusClick ?? true,
        openTerminal: openTerminal ?? false,
        username,
        password,
        chunkSize: chunkSize ?? 50,
        keyDelayMs: keyDelayMs ?? 30,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: result.status === "failed",
      };
    },
  );
}
