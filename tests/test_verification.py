import unittest
from unittest.mock import MagicMock,patch
from verification import detect_verification


def lines(text, confidence=.98):
    return [{'text':text,'confidence':confidence}]


class VerificationTests(unittest.TestCase):
    def test_captcha_in_four_languages(self):
        for text in ['Please complete the CAPTCHA', '보안 문자를 입력하세요',
                     '画像認証', '图形验证码']:
            with self.subTest(text=text):
                result=detect_verification(lines(text))
                self.assertEqual(result['status'],'needs_user_captcha')
                self.assertEqual(result['action'],'stop_automation_and_ask_user')

    def test_otp_stops_automation(self):
        self.assertEqual(detect_verification(lines('Enter verification code'))['status'],
                         'needs_user_verification')

    def test_no_text_is_not_proof_of_clearance(self):
        result=detect_verification(lines('Welcome'))
        self.assertEqual(result['status'],'no_challenge_text')
        self.assertEqual(result['action'],'verify_expected_next_screen')

    def test_low_confidence_does_not_claim_captcha_detection(self):
        self.assertEqual(detect_verification(lines('captcha',.3))['status'],'no_challenge_text')


class LoginHandoffTests(unittest.TestCase):
    def test_captcha_prevents_credential_handoff(self):
        from login_flow import prepare
        robot=MagicMock()
        robot.analyze_guest_ui.return_value={'elements':[{'readings':lines('CAPTCHA')} ]}
        with patch('login_flow.detect_login_form',side_effect=AssertionError('Do not treat challenge as form')), \
             patch('pathlib.Path.write_text'):
            result=prepare(robot)
        self.assertEqual(result['status'],'needs_user_captcha')
        self.assertEqual(result['action'],'stop_automation_and_ask_user')
