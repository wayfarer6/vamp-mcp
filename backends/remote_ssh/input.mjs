// Keyboard maps for remote guest input.
// KVM guests receive qcodes through the QEMU monitor, VirtualBox guests receive
// PS/2 scancodes; both are limited to a US layout so a typo never becomes a
// silent wrong password.
export const QCODES = {
  '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '0': '0',
  '-': 'minus', '=': 'equal', '[': 'bracket_left', ']': 'bracket_right', '\\': 'backslash',
  ';': 'semicolon', "'": 'apostrophe', '`': 'grave_accent', ',': 'comma', '.': 'dot', '/': 'slash',
  ' ': 'spc', '\n': 'ret', '\t': 'tab',
};
export const SHIFTED = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': 'minus', '+': 'equal', '{': 'bracket_left', '}': 'bracket_right', '|': 'backslash',
  ':': 'semicolon', '"': 'apostrophe', '~': 'grave_accent', '<': 'comma', '>': 'dot', '?': 'slash',
};
export const NAMED_QCODES = {
  enter: 'ret', return: 'ret', tab: 'tab', esc: 'esc', escape: 'esc', space: 'spc', backspace: 'backspace',
  delete: 'delete', del: 'delete', insert: 'insert', home: 'home', end: 'end', pageup: 'pgup', pagedown: 'pgdn',
  up: 'up', down: 'down', left: 'left', right: 'right', ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift',
  super: 'meta_l', meta: 'meta_l', win: 'meta_l', command: 'meta_l', capslock: 'caps_lock', numlock: 'num_lock',
  printscreen: 'print', pause: 'pause', menu: 'menu',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `f${index + 1}`])),
};

/** Translate one character into the qcode and whether Shift must be held. */
export function charToQcode(char) {
  if (/^[a-z]$/.test(char)) return { qcode: char, shift: false };
  if (/^[A-Z]$/.test(char)) return { qcode: char.toLowerCase(), shift: true };
  if (QCODES[char]) return { qcode: QCODES[char], shift: false };
  if (SHIFTED[char]) return { qcode: SHIFTED[char], shift: true };
  return null;
}

/** Build ordered QEMU input-send-event key events for literal text and named keys. */
export function keyEvents({ text = '', keys = [] } = {}) {
  const events = [];
  const unsupported = [];
  const press = (qcode, shift) => {
    if (shift) events.push({ type: 'key', data: { down: true, key: { type: 'qcode', data: 'shift' } } });
    events.push({ type: 'key', data: { down: true, key: { type: 'qcode', data: qcode } } });
    events.push({ type: 'key', data: { down: false, key: { type: 'qcode', data: qcode } } });
    if (shift) events.push({ type: 'key', data: { down: false, key: { type: 'qcode', data: 'shift' } } });
  };
  for (const char of String(text)) {
    const mapped = charToQcode(char);
    if (!mapped) {
      unsupported.push(char);
      continue;
    }
    press(mapped.qcode, mapped.shift);
  }
  for (const raw of keys) {
    const named = NAMED_QCODES[String(raw).toLowerCase().replace(/[\s_-]/g, '')];
    if (!named) {
      unsupported.push(String(raw));
      continue;
    }
    press(named, false);
  }
  return { events, unsupported };
}

/** Resolve a simultaneous chord before sending any guest input. */
export function chordKeys(keys = []) {
  if (!Array.isArray(keys) || keys.length > 8) throw new Error('hotkey must be an array of at most eight keys');
  return keys.map(raw => {
    const key = String(raw).toLowerCase().replace(/[\s_-]/g, '');
    const qcode = NAMED_QCODES[key] || (/^[a-z0-9]$/.test(key) ? key : null);
    if (!qcode) throw new Error(`Unsupported hotkey key: ${raw}`);
    return { key, qcode };
  });
}

export const SCANCODES = (() => {
  const map = {};
  '1234567890'.split('').forEach((char, index) => { map[char] = 2 + index; });
  'qwertyuiop'.split('').forEach((char, index) => { map[char] = 16 + index; });
  'asdfghjkl'.split('').forEach((char, index) => { map[char] = 30 + index; });
  'zxcvbnm'.split('').forEach((char, index) => { map[char] = 44 + index; });
  Object.assign(map, {
    super: 0x15b, win: 0x15b, meta: 0x15b, enter: 28, esc: 1, tab: 15, space: 57, ctrl: 29, alt: 56, shift: 42, backspace: 14,
    left: 0x14b, right: 0x14d, up: 0x148, down: 0x150, delete: 0x153,
    '-': 12, '=': 13, '[': 26, ']': 27, ';': 39, "'": 40, '`': 41, '\\': 43, ',': 51, '.': 52, '/': 53, '\n': 28,
  });
  for (let index = 1; index <= 10; index += 1) map[`f${index}`] = 58 + index;
  map.f11 = 87;
  map.f12 = 88;
  return map;
})();
