"""Read bounded failure metadata without VM access, OCR text dumps or replay."""
import argparse
from collections import deque
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT))
from rpa_package import load_package


def collect(package_id,run_directory=None):
    package,manifest=load_package(package_id)
    directory=Path(run_directory).resolve() if run_directory else ROOT/'artifacts/rpas'/package_id
    result={'rpa_id':package_id,'run_directory':str(directory),'read_only':True,
            'package_files':[str(package/'manifest.json'),
                *[str(package/e['file']) for e in manifest['entrypoints']],
                *[str(package/p) for p in manifest['python_libraries']]]}
    if not directory.is_dir():
        return {**result,'evidence_status':'run_directory_missing'}
    summary_path=directory/'summary.json'
    if summary_path.is_file():
        summary=json.loads(summary_path.read_text())
        reported=summary.get('rpa_id')
        if reported is not None and reported!=package_id:
            return {**result,'evidence_status':'rpa_id_mismatch','reported_rpa_id':str(reported)[:80]}
        result['summary']={}
        for key in ['status','execution_status','root_verified','root_shell_exited']:
            if key in summary:
                value=summary[key]
                result['summary'][key]=value if value is None or isinstance(value,bool) else str(value)[:80]
        if 'error_summary' in summary:
            result['summary']['error_summary']=str(summary['error_summary'])[:300]
        if 'details_path' in summary:
            # Return the pointer only: do not automatically read arbitrary log-selected files.
            result['details_path']=str(summary['details_path'])[:500]
        result['evidence_status']='summary_found'
    else:
        result['evidence_status']='summary_missing'
    output_xml=directory/'output.xml'
    failed=deque(maxlen=6)
    if output_xml.is_file():
        # Skip args, messages and return values: these can contain private input.
        for _,node in ET.iterparse(output_xml,events=('end',)):
            if node.tag=='kw':
                status=node.find('status')
                if status is not None and status.get('status')=='FAIL':
                    failed.append({'keyword':node.get('name','')[:120],
                                   'owner':node.get('owner','')[:80],
                                   'line':node.get('lineno')})
            # Retain direct kw/status until its parent is processed, but discard large payloads.
            if node.tag in ('arg','msg','doc','return','kw'):
                node.clear()
        result['failed_keywords']=list(failed)
    candidates=[]
    for pattern in ('*.ocr.json','*ocr*.json'):
        candidates.extend(directory.rglob(pattern))
    candidates=sorted(set(candidates),key=lambda p:p.stat().st_mtime,reverse=True)
    result['ocr_files']=[str(p) for p in candidates[:8]]
    result['robot_log']=str(directory/'log.html') if (directory/'log.html').is_file() else None
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('rpa_id')
    parser.add_argument('--run-dir')
    args=parser.parse_args()
    try:
        result=collect(args.rpa_id,args.run_dir)
    except (ValueError,OSError,ET.ParseError) as error:
        parser.error(str(error))
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
