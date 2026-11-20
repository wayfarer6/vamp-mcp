"""Small result contract shared by independently runnable Robot RPA packages."""
import json
from pathlib import Path
from robot.api import logger
from robot.api.deco import keyword,library
from robot.libraries.BuiltIn import BuiltIn


@library(scope='SUITE',auto_keywords=False)
class RpaContract:
    def __init__(self):
        self.rpa_id=None

    def _path(self):
        directory=Path(BuiltIn().get_variable_value('${OUTPUT DIR}')).resolve()
        directory.mkdir(parents=True,exist_ok=True)
        return directory/'summary.json'

    @keyword
    def begin_result(self,rpa_id):
        self.rpa_id=rpa_id
        self._path().unlink(missing_ok=True)

    @keyword
    def publish_result(self,result):
        summary={**result,'schema_version':1,'rpa_id':self.rpa_id}
        self._path().write_text(json.dumps(summary,ensure_ascii=False,indent=2), encoding='utf-8')
        logger.info(json.dumps(summary,ensure_ascii=False))
        logger.console(json.dumps(summary,ensure_ascii=False))
        return summary

    @keyword
    def publish_failure_if_missing(self,message):
        if self._path().exists():
            summary=json.loads(self._path().read_text(encoding='utf-8'))
            summary['execution_status']='failed'
            summary.setdefault('error_summary',str(message)[:300])
            return self.publish_result(summary)
        return self.publish_result({'status':'error','execution_status':'failed',
                                    'error_summary':str(message)[:300]})
