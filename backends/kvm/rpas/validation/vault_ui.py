"""Real installed VS Code UI scenarios through its local Chromium debugger."""
from io import BytesIO
import json
from pathlib import Path
import subprocess
import time
from PIL import Image
from playwright.sync_api import sync_playwright
from robot.api.deco import keyword, library
from robot.libraries.BuiltIn import BuiltIn

ROOT = Path(__file__).resolve().parents[4]
TEST_MASTER = 'Vamp-UI-Test-Master-2026!'


@library(scope='SUITE', auto_keywords=False)
class VaultUI:
    @keyword
    def connect_to_real_vscode(self, endpoint='http://127.0.0.1:9322'):
        self.driver = sync_playwright().start()
        self.browser = self.driver.chromium.connect_over_cdp(endpoint)
        self.page = self.browser.contexts[0].pages[0]
        self.output = Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))
        self.data = ROOT/'artifacts/kvm-validation'
        self.db = self.data/'ui-vault-final.kdbx'
        assert 'VAMP Vault Validation' in self.page.title()

    @keyword
    def disconnect_vscode(self):
        if hasattr(self, 'driver'):
            self.driver.stop()

    @property
    def surface(self):
        return True

    def _raw_image(self):
        return Image.open(BytesIO(self.page.screenshot())).convert('RGB')

    def pause(self, seconds=.5):
        from spice_recording import sample
        end = time.monotonic()+seconds
        while time.monotonic() < end:
            sample(self)
            self.page.wait_for_timeout(min(500, max(1, (end-time.monotonic())*1000)))

    def command(self, title):
        self.page.keyboard.press('Escape')
        self.page.keyboard.press('Control+Shift+P')
        box = self.page.locator('.quick-input-widget input:visible').first
        box.fill('>'+title)
        self.pause(.5)
        self.page.keyboard.press('Enter')
        self.pause(.7)

    def input(self, text):
        box = self.page.locator('.quick-input-widget input:visible').first
        box.wait_for(state='visible', timeout=15000)
        box.fill(text)
        self.pause(.4)
        box.press('Enter')
        self.pause(.5)

    def visible(self, text, timeout=15000):
        self.page.get_by_text(text, exact=False).filter(visible=True).first.wait_for(state='visible', timeout=timeout)
        self.pause(.4)

    @keyword
    def verify_installed_cli_setup(self):
        self.command('VAMP Vault: Set Up KeePassXC & VeraCrypt CLI')
        self.visible('KeePassXC:')
        self.visible('VeraCrypt:')
        dialog = self.page.locator('.monaco-dialog-box')
        text = dialog.inner_text()
        assert 'not available' not in text, text
        assert '2.8.0' in text and '1.26.31' in text, text
        self.page.screenshot(path=str(self.output/'cli-setup.png'))
        self.page.get_by_role('button', name='Cancel', exact=True).click()
        self.pause(.5)

    @keyword
    def create_test_database_in_vscode(self):
        assert not self.db.exists(), 'Test DB already exists; select a fresh test profile/database'
        self.command('VAMP Vault: Create Vault')
        self.input(str(self.db))
        self.input(TEST_MASTER)
        self.input(TEST_MASTER)
        deadline = time.monotonic()+30
        while not self.db.exists() and time.monotonic()<deadline:
            self.pause(.5)
        assert self.db.exists(), 'Create Vault did not write the database'
        self.command('VAMP Vault: Focus on Vault Status View')
        self.visible('Unlocked')
        self.page.screenshot(path=str(self.output/'vault-created.png'))
        # Fixture is public, synthetic test data. Passwords go to the CLI on stdin.
        program = '''import {VaultCli} from './vscode-vault-extension/src/vault_cli.mjs';
const cli=new VaultCli({keepassxcCli:process.argv[1],kdbxPath:process.argv[2]});
await cli.addEntry({entry:'Browser',group:'Validation',username:'vamp-demo',secret:'Dummy-Entry-2026!',url:'http://127.0.0.1:8080',databasePassword:process.argv[3]});'''
        # Send the test master on stdin instead of exposing it in process arguments.
        program=program.replace('databasePassword:process.argv[3]', "databasePassword:await new Promise(resolve=>{let s='';process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>resolve(s));})")
        result=subprocess.run(['node','--input-type=module','-e',program,str(self.data/'bin/keepassxc-cli'),str(self.db)],
                              input=TEST_MASTER,text=True,capture_output=True,cwd=ROOT,timeout=30)
        assert result.returncode==0, result.stderr
        self.command('VAMP Vault: Refresh')
        self.visible('Validation')

    @keyword
    def lock_and_unlock_real_secret_storage(self):
        self.command('VAMP Vault: Lock (Forget Master Password)')
        self.visible('Locked')
        self.page.screenshot(path=str(self.output/'vault-locked.png'))
        self.command('VAMP Vault: Unlock')
        self.input(TEST_MASTER)
        self.visible('Unlocked')
        self.command('VAMP Vault: Search Credentials')
        self.visible('Validation/Browser')
        self.page.screenshot(path=str(self.output/'vault-search.png'))
        self.page.keyboard.press('Escape')
        self.command('VAMP Vault: Lock (Forget Master Password)')
        self.visible('Locked')
