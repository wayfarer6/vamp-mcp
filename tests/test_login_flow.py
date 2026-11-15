import unittest
from login_flow import detect_login_form


def element(text,x,y):
    return {'text':text,'center':[x,y],'xyxy':[x-40,y-10,x+40,y+10],
            'ocr_confidence':0.98,'kind':'ui_region'}


def page(extra=()):
    return {'screenshot':'empty.png','annotated':'empty.annotated.png','elements':[
        element('nid.naver.com/nidlogin.login',300,95),
        element('ID or phone number',800,330),element('Password',800,430),
        element('Sign in',960,580),*extra]}


class LoginDetectionTests(unittest.TestCase):
    def test_unique_form_requires_credential_handoff(self):
        result=detect_login_form(page())
        self.assertEqual(result['status'],'needs_credentials')
        self.assertTrue(result['origin_verified'])

    def test_duplicate_forms_fail_closed(self):
        result=detect_login_form(page([element('ID',820,340)]))
        self.assertEqual(result['status'],'ambiguous_login_form')

    def test_origin_is_required(self):
        analysis=page(); analysis['elements'].pop(0)
        self.assertEqual(detect_login_form(analysis)['status'],'origin_not_verified')

    def test_password_word_alone_is_not_a_login_form(self):
        analysis=page(); analysis['elements']=[element('Password',800,430)]
        self.assertEqual(detect_login_form(analysis)['status'],'login_form_not_found')


if __name__=='__main__':unittest.main()
