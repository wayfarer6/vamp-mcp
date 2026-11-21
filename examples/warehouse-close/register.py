"""Review and register the warehouse demo with VAMP's standard recording registry."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))
from backends.library.registry import register, validate_revision

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', type=Path, required=True,
                        help='The same catalog directory used by your MCP or VS Code profile')
    parser.add_argument('--reviewed', action='store_true',
                        help='Register after reviewing the demo inputs, keystrokes and output path')
    args = parser.parse_args()
    request = {
        'title': '월말 창고 결산 · Warehouse month-end close',
        'description': 'Create a synthetic month-end inventory reconciliation XLSX in LibreOffice Calc. 창고 재고를 입력하고 장부·실사 차이와 금액을 계산합니다.',
        'when_to_use': '월말 창고 결산 해줘 / close the warehouse for the month. Open a clean Warehouse Intake.xlsx on the approved VirtualBox demo guest. Use YYYY-MM as period; choose a new output filename.',
        'expected_result': 'A new warehouse-close-YYYY-MM.xlsx in /home/warehouse/warehouse-demo, with four synthetic SKUs, formulas and a counted closing value of KRW 1,310,400. Verify the workbook independently.',
        'tags': ['warehouse', 'inventory', 'LibreOffice', '월말', '창고', '결산'],
        'source_path': str(HERE / 'recording.py'),
        'inputs': ['period'], 'backend': 'virtualbox', 'width': 1920, 'height': 1080,
        'start_text': 'Ready to close', 'reviewed': args.reviewed,
    }
    if args.reviewed:
        for entry in args.registry.glob('*/rpa.json'):
            metadata = json.loads(entry.read_text(encoding='utf-8-sig'))
            if metadata.get('name') != request['title']:
                continue
            digest = hashlib.sha256((HERE / 'recording.py').read_bytes()).hexdigest()
            if (metadata.get('reviewed') and metadata.get('source_sha256') == digest
                    and metadata.get('start_text') == request['start_text']):
                print(json.dumps({'status': 'already_registered', 'id': metadata['id']}))
                return
            parser.exit(1, 'A different revision with this title exists. Review that catalog entry in the RPA Library.\n')
        print(json.dumps(register(args.registry, request), ensure_ascii=False))
    else:
        print(json.dumps(validate_revision(request), ensure_ascii=False))

if __name__ == '__main__':
    main()
