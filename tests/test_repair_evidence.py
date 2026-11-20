import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('repair_collector',
    ROOT/'.agents/skills/spice-rpa-repair/scripts/collect_failure.py')
collector=importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class RepairEvidenceTests(unittest.TestCase):
    def test_reports_failure_without_dumping_private_keyword_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            run=Path(directory)
            (run/'summary.json').write_text(json.dumps({'rpa_id':'naver_login','status':'error',
                'error_summary':'필드를 찾지 못했습니다'},ensure_ascii=False), encoding='utf-8')
            (run/'output.xml').write_text('''<robot><suite><test>
              <kw name="Outer" owner="Workflow"><kw name="Click" owner="Spice" lineno="12">
              <arg>PRIVATE_INPUT_DO_NOT_PRINT</arg><msg>PRIVATE_LOG_DO_NOT_PRINT</msg>
              <status status="FAIL"/></kw><status status="FAIL"/></kw>
              </test></suite></robot>''')
            for index in range(12):
                (run/f'{index}.ocr.json').write_text('[{"text":"PRIVATE_OCR_DO_NOT_PRINT"}]')
            result=collector.collect('naver_login',directory)
            self.assertEqual(result['summary']['status'],'error')
            self.assertEqual(result['summary']['error_summary'],'필드를 찾지 못했습니다')
            self.assertEqual([item['keyword'] for item in result['failed_keywords']],['Click','Outer'])
            self.assertEqual(len(result['ocr_files']),8)
            self.assertNotIn('PRIVATE_',json.dumps(result))
            self.assertTrue(result['read_only'])

    def test_mismatched_package_evidence_is_not_used(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'summary.json').write_text(json.dumps({'rpa_id':'naver_login','status':'failed'}))
            result=collector.collect('debian_update',directory)
            self.assertEqual(result['evidence_status'],'rpa_id_mismatch')
            self.assertNotIn('summary',result)

    def test_missing_run_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            result=collector.collect('debian_update',Path(directory)/'missing')
            self.assertEqual(result['evidence_status'],'run_directory_missing')
