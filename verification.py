"""Detect challenge instructions, never recognize or answer challenge contents."""
import re
import unicodedata
from pathlib import Path
from tempfile import TemporaryDirectory


def normalized(text):
    return re.sub(r'[^\w]', '', unicodedata.normalize('NFKC',text).casefold())


CAPTCHA_PHRASES = {
    'captcha': 'captcha',
    'recaptcha': 'recaptcha',
    'hcaptcha': 'hcaptcha',
    'not_a_robot': "I'm not a robot",
    'human_check': 'verify you are human',
    'human_verification': 'human verification',
    'select_images': 'select all images',
    'security_characters_ko': '보안문자',
    'anti_automation_ko': '자동입력방지',
    'robot_check_ko': '로봇이 아닙니다',
    'captcha_ja': '画像認証',
    'robot_check_ja': '私はロボットではありません',
    'captcha_zh': '图形验证码',
    'captcha_zh_traditional': '圖形驗證碼',
    'robot_check_zh': '我不是机器人',
}
VERIFICATION_PHRASES = {
    'otp': 'one-time password',
    'verification_code': 'verification code',
    'authentication_code': 'authentication code',
    'code_ko': '인증번호',
    'code_ko_spaced': '인증 코드',
    'two_factor_ko': '2단계 인증',
    'two_factor_ja': '二段階認証',
    'sms_zh': '短信验证码',
    'email_zh': '邮箱验证码',
}


def detect_verification(lines):
    texts = [(normalized(line['text']),float(line['confidence'])) for line in lines
             if float(line['confidence']) >= 0.65]
    for status, rules in [('needs_user_captcha',CAPTCHA_PHRASES),
                          ('needs_user_verification',VERIFICATION_PHRASES)]:
        hits = [(name,score) for name,phrase in rules.items()
                for text,score in texts if normalized(phrase) in text]
        if hits:
            return {'status':status,'matched_rules':sorted({name for name,_ in hits}),
                    'confidence':max(score for _,score in hits),
                    'action':'stop_automation_and_ask_user',
                    'message':'VM 창에서 CAPTCHA 또는 추가 인증을 직접 완료한 뒤 완료했다고 알려주세요.'}
    return {'status':'no_challenge_text','matched_rules':[],
            'action':'verify_expected_next_screen',
            'message':'OCR에서 인증 안내 문구를 찾지 못했습니다. 인증 해제나 로그인 성공을 뜻하지는 않습니다.'}


def check_guest_verification(robot, languages='ko,en,ja,zh'):
    from vision import run_ocr
    with TemporaryDirectory(prefix='spice-verification-') as directory:
        path = robot.capture_guest_screen(Path(directory)/'screen.png')
        lines = run_ocr(robot,path,languages,Path(directory)/'ocr.json')
    return detect_verification(lines)
