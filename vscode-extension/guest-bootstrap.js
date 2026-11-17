'use strict';
/**
 * Packer-style guest bootstrap: after a Windows or Debian VM finishes booting,
 * inject the post-install script with pointer focus plus keystrokes.
 *
 * Windows: Win+R -> "cmd" -> Enter -> focus click -> "powershell -ExecutionPolicy Bypass" -> script.
 * Debian:  focus click -> optional TTY login -> script.
 *
 * Delivery is not proof of execution: the guest may still be booting, may show a
 * different window, or may ignore the keys. Verify the guest before reporting success.
 */

const DEFAULT_COMMANDS = {
  windows11: 'cmd.exe /c C:\\ProgramData\\RPA-Recorder-Setup\\setup-win.cmd',
  debian: '/media/cdrom/setup.sh',
};
const WINDOWS_SHELL_COMMAND = 'powershell -ExecutionPolicy Bypass';
const ENTER = [0x1c, 0x9c];
const RUN_DIALOG = [0xe0, 0x5b, 0x13, 0x93, 0xe0, 0xdb];
const OPEN_TERMINAL = [0x1d, 0x38, 0x14, 0x94, 0xb8, 0x9d];

/** Map a VirtualBox ostype such as Windows11_64 or Debian12_64 to a bootstrap profile. */
function guestOsFromType(ostype) {
  const value = String(ostype || '').toLowerCase();
  if (value.includes('windows')) return 'windows11';
  if (value.includes('debian') || value.includes('ubuntu') || value.includes('linux')) return 'debian';
  return undefined;
}

function clickStep(x, y) {
  return {kind:'click', x, y, label:`click (${x}, ${y}) to pin keyboard focus`};
}

function planBootstrap(options) {
  const guestOs = options.os === 'debian' ? 'debian' : 'windows11';
  const command = String(options.command || '').trim() || DEFAULT_COMMANDS[guestOs];
  const bootWaitSec = Math.max(0, Number(options.bootWaitSec ?? 30));
  const focusClick = options.focusClick !== false;
  const clickX = Number(options.clickX ?? 960);
  const clickY = Number(options.clickY ?? 540);
  const steps = [{kind:'wait', ms:bootWaitSec * 1000, label:`wait ${bootWaitSec}s for the guest to finish booting and reach its desktop`}];

  if (guestOs === 'windows11') {
    steps.push({kind:'keys', codes:RUN_DIALOG, label:'open the Run dialog (Win+R)'});
    steps.push({kind:'wait', ms:2000, label:'wait for the Run dialog'});
    steps.push({kind:'type', text:'cmd', enter:true, label:'start cmd'});
    steps.push({kind:'wait', ms:2500, label:'wait for the console window'});
    if (focusClick) {
      steps.push(clickStep(clickX, clickY));
      steps.push({kind:'wait', ms:1000, label:'wait for the console to take keyboard focus'});
    }
    steps.push({kind:'type', text:WINDOWS_SHELL_COMMAND, enter:true, label:'start PowerShell with a bypass execution policy'});
    steps.push({kind:'wait', ms:1500, label:'wait for PowerShell'});
  } else {
    if (focusClick) {
      steps.push(clickStep(clickX, clickY));
      steps.push({kind:'wait', ms:1000, label:'wait for the terminal to take keyboard focus'});
    }
    if (options.openTerminal) {
      steps.push({kind:'keys', codes:OPEN_TERMINAL, label:'open a desktop terminal (Ctrl+Alt+T)'});
      steps.push({kind:'wait', ms:2000, label:'wait for the terminal window'});
    }
    if (options.username) {
      steps.push({kind:'type', text:String(options.username), enter:true, label:'type the TTY login name'});
      steps.push({kind:'wait', ms:1500, label:'wait for the password prompt'});
      if (options.password) {
        steps.push({kind:'type', text:String(options.password), enter:true, label:'type the TTY password', secret:true});
        steps.push({kind:'wait', ms:1500, label:'wait for the shell prompt'});
      }
    }
  }
  steps.push({kind:'type', text:command, enter:true, label:'run the bootstrap script'});
  return {guestOs, command, steps};
}

function redactSteps(steps) {
  return steps.map(step => (step.kind === 'type' && step.secret ? {...step, text:'********'} : step));
}

/**
 * @param {object} options os, command, bootWaitSec, clickX, clickY, focusClick, openTerminal, username, password, chunkSize, keyDelayMs, dryRun
 * @param {object} deps vbox(args), click(x,y), sleep(ms), log(message)
 */
async function runGuestBootstrap(options, deps = {}) {
  const {guestOs, command, steps} = planBootstrap(options);
  const vbox = deps.vbox || (() => Promise.reject(new Error('No VBoxManage runner was provided.')));
  const click = deps.click;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const log = deps.log || (() => {});
  const chunkSize = Math.max(1, Number(options.chunkSize ?? 50));
  const keyDelayMs = Math.max(0, Number(options.keyDelayMs ?? 30));
  const result = {status:'dry_run', os:guestOs, command, plan:redactSteps(steps), executed:[], warnings:[], verified:false};

  if (options.dryRun) {
    result.next_action = 'Review the ordered steps, then run without dryRun to inject them.';
    return result;
  }

  for (const step of steps) {
    try {
      if (step.kind === 'wait') {
        if (step.ms > 0) await sleep(step.ms);
      } else if (step.kind === 'keys') {
        await vbox(['controlvm', options.vm, 'keyboardputscancode', ...step.codes.map(code => code.toString(16).padStart(2, '0'))]);
      } else if (step.kind === 'type') {
        for (let i = 0; i < step.text.length; i += chunkSize) {
          await vbox(['controlvm', options.vm, 'keyboardputstring', step.text.slice(i, i + chunkSize)]);
          if (i + chunkSize < step.text.length && keyDelayMs > 0) await sleep(keyDelayMs);
        }
        if (step.enter) await vbox(['controlvm', options.vm, 'keyboardputscancode', ...ENTER.map(code => code.toString(16).padStart(2, '0'))]);
      } else if (step.kind === 'click') {
        try {
          if (click) await click(step.x, step.y);
        } catch (error) {
          const detail = error?.message || String(error);
          result.warnings.push(`Focus click at (${step.x}, ${step.y}) failed: ${detail}. Keystrokes were still sent; if the guest lost keyboard focus, inject again.`);
          log(`Focus click failed: ${detail}`);
          continue;
        }
      }
      result.executed.push(step.label);
      log(step.label);
    } catch (error) {
      result.status = 'failed';
      result.error = `${step.label}: ${error?.message || String(error)}`;
      result.next_action = 'Confirm the desktop is running, then inject again or type the command in the VM screen.';
      return result;
    }
  }
  result.status = 'completed';
  result.next_action = 'Delivery is not proof of execution. Check the guest screen or setup log before treating the script as installed.';
  return result;
}

module.exports = {DEFAULT_COMMANDS, WINDOWS_SHELL_COMMAND, ENTER, RUN_DIALOG, OPEN_TERMINAL, guestOsFromType, planBootstrap, runGuestBootstrap, redactSteps};
