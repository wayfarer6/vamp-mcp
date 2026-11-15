"""Deterministic visual login form detection. No DOM, WebDriver, or guest-side code."""
import getpass
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

LOGIN_URL = 'https://nid.naver.com/nidlogin.login?locale=en_US'


def normalize(text):
    return re.sub(r'[^\w]', '', unicodedata.normalize('NFKC', text).casefold())


LABELS = {
    'username': {'id', 'id or phone number', 'id or phone', 'username', 'user id',
                 '아이디', '아이디 또는 전화번호', 'id전화번호', '用户名', '帳號', 'ユーザーid'},
    'password': {'password', '비밀번호', '密码', '密碼', 'パスワード'},
    'submit': {'sign in', 'log in', 'login', '로그인', '登录', '登入', 'ログイン'},
}


def detect_login_form(analysis):
    candidates = {}
    for role, labels in LABELS.items():
        normalized = {normalize(label) for label in labels}
        candidates[role] = [e for e in analysis['elements']
            if normalize(e.get('text','')) in normalized
            and (e.get('ocr_confidence') or 0) >= 0.7]
    forms = []
    for username in candidates['username']:
        for password in candidates['password']:
            ux, uy = username['center']; px, py = password['center']
            # Labels/fields must be vertically aligned in a plausible single form.
            if not (12 < py-uy < 180 and abs(ux-px) < 220):
                continue
            for submit in candidates['submit']:
                sx, sy = submit['center']
                if 15 < sy-py < 250 and abs(sx-px) < 300:
                    forms.append({'username':username,'password':password,'submit':submit})
    if len(forms) != 1:
        return {'status':'login_form_not_found' if not forms else 'ambiguous_login_form',
                'candidate_counts':{k:len(v) for k,v in candidates.items()}, 'form_count':len(forms)}
    # OCR of browser chrome gives an additional origin check before entering credentials.
    origin_visible = any('nid.naver.com' in e.get('text','').casefold() for e in analysis['elements'])
    return {'status':'needs_credentials' if origin_visible else 'origin_not_verified',
            'origin_verified':origin_visible, 'form':forms[0],
            'screenshot':analysis['screenshot'], 'annotated':analysis['annotated']}


def prepare(robot, languages='en', device='auto'):
    # GNOME Run dialog establishes browser foreground rather than assuming current focus.
    robot.guest_hotkey('alt','f2'); robot._pump(1)
    robot.guest_write('firefox'); robot.guest_hotkey('enter'); robot._pump(4)
    robot.guest_hotkey('ctrl','l'); robot.guest_write(LOGIN_URL)
    robot.guest_hotkey('enter'); robot._pump(6)
    robot.guest_hotkey('esc')
    analysis = robot.analyze_guest_ui('artifacts/login/ui.json', languages, device)
    from verification import detect_verification
    challenge = detect_verification([reading for element in analysis['elements'] for reading in element.get('readings',[])])
    state = challenge if challenge['status'] != 'no_challenge_text' else detect_login_form(analysis)
    path = Path('artifacts/login/state.json')
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    return state


def read_credentials(prompt=False, robot=None):
    if prompt:
        if sys.stdin.isatty():
            username = input('Naver ID (not saved): ').strip()
            password = getpass.getpass('Naver password (hidden): ')
        else:
            dialog = subprocess.Popen(['zenity','--forms','--title=SPICE RPA: Naver login',
                '--text=Enter your Naver credentials. They are sent through SPICE and not saved.',
                '--add-entry=Naver ID','--add-password=Password','--separator=\t'],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            try:
                if robot:
                    while dialog.poll() is None:
                        robot._pump(0.1)
                payload, _ = dialog.communicate()
                if dialog.returncode:
                    raise RuntimeError('Credential entry cancelled')
                username, password = payload.rstrip('\n').split('\t',1)
                payload = None
            finally:
                if dialog.poll() is None:
                    dialog.terminate()
                    dialog.wait()
    else:
        username, password = os.environ.get('NAVER_ID',''), os.environ.get('NAVER_PASSWORD','')
    if not username or not password:
        raise ValueError('Credentials missing: use --prompt-credentials or NAVER_ID and NAVER_PASSWORD')
    # Validate all input BEFORE sending anything. Physical keyboard supports printable US ASCII.
    if any(not (32 <= ord(c) <= 126) for c in username+password):
        raise ValueError('Only printable ASCII credentials are supported by this keyboard backend')
    return username, password


def fill_and_submit(robot, state, username, password):
    if state['status'] != 'needs_credentials' or not state.get('origin_verified'):
        raise AssertionError('Login form and Naver origin must be visually verified first')
    # Verify form pixels before typing. No screenshots of plaintext credentials are taken.
    from PIL import Image
    import pyautogui
    reference = Image.open(state['screenshot'])
    current = robot._image()
    for role in ['username','password','submit']:
        coords = tuple(int(v) for v in state['form'][role]['xyxy'])
        try:
            match = pyautogui.locate(reference.crop(coords), current.crop(coords), grayscale=False, confidence=0.98)
        except pyautogui.ImageNotFoundException:
            match = None
        if match is None:
            raise AssertionError('Login form changed; detect it again before typing credentials')
    robot.guest_click(*state['form']['username']['center'])
    robot.guest_hotkey('ctrl','a'); robot.guest_write(username, interval=0.01)
    robot.guest_click(*state['form']['password']['center'])
    robot.guest_hotkey('ctrl','a'); robot.guest_write(password, interval=0.01)
    robot.guest_click(*state['form']['submit']['center'])
    robot._pump(7)
    # Do not persist a post-submit screen: it could contain account information.
    from tempfile import TemporaryDirectory
    from vision import run_ocr
    with TemporaryDirectory(prefix='spice-login-') as directory:
        screen = robot.capture_guest_screen(Path(directory)/'screen.png')
        lines = run_ocr(robot, screen, 'ko,en,ja,zh', Path(directory)/'ocr.json')
    text = ' '.join(line['text'] for line in lines if line['confidence'] >= 0.7).casefold()
    from verification import detect_verification
    challenge = detect_verification(lines)
    if challenge['status'] != 'no_challenge_text':
        return {**challenge, 'submitted':True}
    if any(term in text for term in ['로그아웃','log out','sign out','logout']):
        status = 'logged_in'
    elif any(term in text for term in ['captcha','인증','verification','验证码','認証','otp']):
        status = 'needs_user_verification'
    else:
        status = 'submitted_unverified'
    return {'status':status, 'submitted':True}
