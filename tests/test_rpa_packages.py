import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from robot import run
from rpa_package import ROOT,load_package


class PackageTests(unittest.TestCase):
    def test_default_login_entry_never_submits_credentials(self):
        from scripts import run_rpa
        with tempfile.TemporaryDirectory() as directory, \
             patch('sys.argv',['run_rpa.py','naver_login','--output',directory,'--dryrun']), \
             patch('robot.run',return_value=0) as execute:
            self.assertEqual(run_rpa.main(),0)
            selected=Path(execute.call_args.args[0])
            self.assertEqual(selected,ROOT/'rpas/naver_login/run.robot')
            self.assertTrue(execute.call_args.kwargs['dryrun'])

    def test_all_manifest_entries_and_python_libraries_exist(self):
        for path in (ROOT/'rpas').glob('*/manifest.json'):
            with self.subTest(package=path.parent.name):
                _,manifest=load_package(path.parent.name)
                self.assertIn(manifest['default_entrypoint'],[e['name'] for e in manifest['entrypoints']])
        with self.assertRaises(ValueError):
            load_package('../naver_login')


class ContractTests(unittest.TestCase):
    def execute_suite(self,directory,body):
        suite=Path(directory)/'test.robot'
        suite.write_text(f'''*** Settings ***
Library    {ROOT}/rpa_contract.py    WITH NAME    Contract
Suite Setup    Contract.Begin Result    example
Task Teardown    Contract.Publish Failure If Missing    ${{TEST MESSAGE}}
*** Tasks ***
Example
{body}
''')
        # Use a conditional teardown so passing tasks do not acquire failure metadata.
        suite.write_text(suite.read_text().replace(
            'Task Teardown    Contract.Publish Failure If Missing    ${TEST MESSAGE}',
            "Task Teardown    Run Keyword If    '${TEST STATUS}' == 'FAIL'    Contract.Publish Failure If Missing    ${TEST MESSAGE}"))
        with contextlib.redirect_stdout(io.StringIO()):
            code=run(str(suite),outputdir=directory,console='none')
        return code,json.loads((Path(directory)/'summary.json').read_text())

    def test_success_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            code,result=self.execute_suite(directory,'''    ${result}=    Evaluate    {'status':'succeeded','rpa_id':'wrong'}
    Contract.Publish Result    ${result}''')
            self.assertEqual(code,0)
            self.assertEqual(result['status'],'succeeded')
            self.assertEqual(result['rpa_id'],'example')
            self.assertEqual(result['schema_version'],1)

    def test_failure_before_result_is_machine_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            code,result=self.execute_suite(directory,'    Fail    expected failure')
            self.assertEqual(code,1)
            self.assertEqual(result['status'],'error')
            self.assertEqual(result['execution_status'],'failed')
            self.assertIn('expected failure',result['error_summary'])

    def test_failed_verification_preserves_actual_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            code,result=self.execute_suite(directory,'''    ${result}=    Evaluate    {'status':'failed','error_summary':'APT repository unavailable'}
    Contract.Publish Result    ${result}
    Fail    expected succeeded''')
            self.assertEqual(code,1)
            self.assertEqual(result['status'],'failed')
            self.assertEqual(result['error_summary'],'APT repository unavailable')
            self.assertEqual(result['execution_status'],'failed')


class NavigationVerificationTests(unittest.TestCase):
    def test_address_alone_does_not_prove_naver_loaded(self):
        from rpas.firefox_naver.workflow import Workflow
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory() as directory, \
             patch('rpas.firefox_naver.workflow.BuiltIn') as builtin, \
             patch('vision.run_ocr') as read:
            builtin.return_value.get_variable_value.return_value=directory
            spice=MagicMock()
            spice.capture_guest_screen.return_value='naver.png'
            builtin.return_value.get_library_instance.return_value=spice
            read.return_value=[{'text':'www.naver.com','confidence':.99}]
            with self.assertRaises(AssertionError):
                Workflow().verify_naver()
            read.return_value.append({'text':'NAVER','confidence':.99})
            self.assertEqual(Workflow().verify_naver()['status'],'succeeded')
