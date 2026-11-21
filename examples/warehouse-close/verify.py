"""Check the saved Calc workbook independently using only the Python standard library."""
import argparse
import json
import re
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
ROWS = [
    ('PK-101', 'Packing tape', 120, 40, 35, 123, 3000),
    ('LB-202', 'Shipping labels', 80, 60, 45, 95, 1200),
    ('BX-303', 'Carton boxes', 210, 90, 110, 192, 2200),
    ('WR-404', 'Bubble wrap', 50, 25, 20, 54, 7500),
]

def verify(file, period):
    if not re.fullmatch(r'[0-9]{4}-(0[1-9]|1[0-2])', period):
        raise ValueError('Choose a period in YYYY-MM format')
    with ZipFile(file) as archive:
        strings = ET.fromstring(archive.read('xl/sharedStrings.xml'))
        shared = [''.join(item.itertext()) for item in strings.findall('s:si', NS)]
        sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    cells = {c.attrib['r']: c for c in sheet.findall('.//s:c', NS)}
    def check(address, expected, formula=None):
        cell = cells.get(address)
        if cell is None:
            raise ValueError(f'{address}: missing cell')
        value = cell.findtext('s:v', default='', namespaces=NS)
        if cell.get('t') == 's':
            value = shared[int(value)]
        if isinstance(expected, int):
            value = float(value)
        if value != expected:
            raise ValueError(f'{address}: expected {expected!r}, found {value!r}')
        if formula and cell.findtext('s:f', default='', namespaces=NS).upper() != formula:
            raise ValueError(f'{address}: expected formula {formula}')
    check('B2', period)
    totals = {c: 0 for c in 'CDEFHIJK'}
    for row, data in enumerate(ROWS, 5):
        for col, value in zip('ABCDEFG', data):
            check(f'{col}{row}', value)
        _, _, opening, receipts, issues, counted, cost = data
        book = opening + receipts - issues
        variance = counted - book
        outputs = [book, variance, counted * cost, variance * cost]
        formulas = [f'C{row}+D{row}-E{row}', f'F{row}-H{row}', f'F{row}*G{row}', f'I{row}*G{row}']
        for col, value, formula in zip('HIJK', outputs, formulas):
            check(f'{col}{row}', value, formula)
        for col, value in zip(totals, [opening, receipts, issues, counted, *outputs]):
            totals[col] += value
    for col, total in totals.items():
        check(f'{col}9', total, f'SUM({col}5:{col}8)')
    return {'status':'verified', 'period':period, 'skus':len(ROWS), 'book_units':totals['H'],
            'counted_units':totals['F'], 'variance_units':totals['I'], 'close_value_krw':totals['J'],
            'adjustment_krw':totals['K'], 'formulas_checked':24}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbook', type=Path)
    parser.add_argument('--period', required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.workbook, args.period)))
