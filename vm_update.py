"""Run apt update through a SPICE terminal and judge every state with OCR only."""
import json
import re
import secrets
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def encoded_printf(text):
    # The echoed command never contains the final marker as readable text.
    encoded = ''.join(f'\\{ord(c):03o}' for c in text+'\n')
    return f"printf '{encoded}'"


def compact(text):
    return re.sub(r'[^A-Z0-9]', '', text.upper()).translate(str.maketrans({'0':'O','1':'I'}))


def has_marker(lines, marker):
    expected = compact(marker)
    return any(expected in compact(line['text']) and line['confidence'] >= 0.65 for line in lines)


def apt_outcome(lines, success, failure):
    if has_marker(lines, failure):
        return 'failed'
    if not has_marker(lines, success):
        return 'running_or_unverified'
    text = '\n'.join(line['text'] for line in lines if line['confidence'] >= 0.6
                     and 'apt does not have a stable cli interface' not in line['text'].casefold()).casefold()
    if any(term in text for term in ['failed to fetch', 'some index files failed',
                                     'could not resolve', 'temporary failure',
                                     'warning:']) or re.search(r'(?m)^\s*[we]:',text):
        return 'completed_with_warnings'
    return 'succeeded'


def type_text(robot, text):
    from spice_robot import SCANCODES, SHIFTED
    # No host input, clipboard, shell transport, or Robot argument logging.
    for char in text:
        if SHIFTED.get(char, char.lower()) not in SCANCODES:
            raise ValueError('Unsupported character in terminal input')
    for char in text:
        base = SHIFTED.get(char, char.lower())
        shifted = char in SHIFTED or char.isupper()
        if shifted:
            robot.inputs.key_press(SCANCODES['shift'])
        robot.inputs.key_press_and_release(SCANCODES[base])
        if shifted:
            robot.inputs.key_release(SCANCODES['shift'])
        robot._pump(0.02)
    robot._pump(0.15)


class UpdateRun:
    def __init__(self, robot, directory):
        self.robot = robot
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.events = []
        self.index = 0

    def read(self, stage):
        from vision import run_ocr
        self.index += 1
        path = self.directory / f'{self.index:02d}-{stage}.png'
        self.robot.capture_guest_screen(path)
        lines = run_ocr(self.robot, path, 'en', path.with_suffix('.ocr.json'))
        self.events.append({'stage':stage,'screenshot':str(path),
                            'texts':[line['text'] for line in lines if line['confidence']>=0.6]})
        return lines

    def finish(self, status, **details):
        result = {'status':status,'verification':'ocr_only','command':'apt update',
                  'events':self.events,**details}
        (self.directory/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
        return result

    def command(self, text):
        type_text(self.robot, text)
        self.robot.guest_hotkey('enter')


def terminal_visible(lines, hostname):
    text = '\n'.join(line['text'] for line in lines if line['confidence'] >= 0.6
                     and 'apt does not have a stable cli interface' not in line['text'].casefold()).casefold()
    return bool(re.search(r'(?:root|debian)\s*@\s*'+re.escape(hostname),text))


def run_update(robot, config_path='config/sandbox-vm.json', output='artifacts/vm-update', timeout=300):
    config = json.loads(Path(config_path).read_text())
    if not config.get('public_test_credentials'):
        raise ValueError('This workflow expects the explicitly public sandbox configuration')
    if robot.session.get_property('uri').rstrip('/') != config['uri'].rstrip('/'):
        raise ValueError('Connected SPICE URI does not match sandbox VM configuration')
    run = UpdateRun(robot, output)
    robot.guest_hotkey('ctrl','alt','t'); robot._pump(1)
    lines = run.read('terminal-shortcut')
    if not terminal_visible(lines, config['hostname']):
        robot.guest_hotkey('alt','f2'); robot._pump(0.7)
        type_text(robot,'gnome-terminal --maximize'); robot.guest_hotkey('enter'); robot._pump(2)
        lines = run.read('terminal-fallback')
    if not terminal_visible(lines, config['hostname']):
        return run.finish('terminal_not_verified')
    nonce = ''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ') for _ in range(6))
    root_marker, user_marker = f'RPAROOT{nonce}', f'RPAUSER{nonce}'
    run.command(f'if [ "$(id -u)" = 0 ]; then {encoded_printf(root_marker)}; else {encoded_printf(user_marker)}; fi')
    lines = run.read('identity')
    if not has_marker(lines,root_marker):
        if not has_marker(lines,user_marker):
            return run.finish('shell_execution_not_verified')
        run.command('su root'); robot._pump(0.6)
        lines = run.read('password-prompt')
        if not any(re.search(r'password\s*:',line['text'],re.I) and line['confidence']>=0.7 for line in lines):
            return run.finish('password_prompt_not_verified')
        type_text(robot,config['root_password']); robot.guest_hotkey('enter'); robot._pump(1)
        # Password entry occurs only after the OCR-verified hidden prompt.
        lines = run.read('root-prompt')
        if not any(re.search(r'root\s*@\s*'+re.escape(config['hostname']),line['text'],re.I)
                   and line['confidence']>=0.6 for line in lines):
            return run.finish('root_authentication_not_verified')
        run.command(f'if [ "$(id -u)" = 0 ]; then {encoded_printf(root_marker)}; fi')
        lines = run.read('root-identity')
        if not has_marker(lines,root_marker):
            return run.finish('root_identity_not_verified')
    success, failure = f'RPAAPTOK{nonce}', f'RPAAPTFAIL{nonce}'
    guest_log = f'/tmp/spice-rpa-apt-{nonce.lower()}.log'
    run.command(f'apt update > {guest_log} 2>&1; rpa_rc=$?; tail -n 16 {guest_log}; '
                f'if [ "$rpa_rc" -eq 0 ]; then {encoded_printf(success)}; else {encoded_printf(failure)}; fi')
    deadline = time.monotonic()+float(timeout)
    while time.monotonic()<deadline:
        robot._pump(2)
        lines = run.read('apt-result')
        status = apt_outcome(lines,success,failure)
        if status != 'running_or_unverified':
            # Explicitly leave the elevated shell after a completed command.
            run.command('exit')
            final_lines = run.read('exit-root')
            prompts = [line for line in final_lines if line['confidence'] >= 0.6
                       and re.search(r'(?:root|debian)\s*@\s*'+re.escape(config['hostname']),line['text'],re.I)]
            last_prompt = max(prompts,key=lambda line:line['xyxy'][1]) if prompts else None
            exited = bool(last_prompt and re.search(r'debian\s*@',last_prompt['text'],re.I))
            return run.finish(status,root_verified=True,root_shell_exited=exited,guest_log=guest_log)
    return run.finish('timed_out_unverified',root_verified=True,guest_log=guest_log,
                      note='Command may still be running; inspect OCR before further terminal input.')
