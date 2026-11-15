"""Run once to verify all four OCR languages on rendered text (not a live VM)."""
import json
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
output = root/'artifacts/ocr-smoke'
output.mkdir(parents=True, exist_ok=True)
font = ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',36)
image = Image.new('RGB',(1100,500),'white')
draw = ImageDraw.Draw(image)
for x,y,text in [(50,50,'확인 취소'),(580,50,'OK Cancel'),(50,260,'確認 キャンセル'),(580,260,'确定 取消')]:
    draw.rounded_rectangle((x,y,x+440,y+120),radius=12,fill='#eeeeee',outline='#555555',width=2)
    draw.text((x+35,y+30),text,font=font,fill='black')
image.save(output/'buttons.png')
subprocess.run([str(root/'.venv-ocr/bin/python'),str(root/'ocr_worker.py'),str(output/'buttons.png'),
    '--output',str(output/'ocr.json')],check=True)
lines = json.loads((output/'ocr.json').read_text())
for language,expected in [('ko','확인취소'),('en','OKCancel'),('ja','確認キャンセル'),('zh','确定取消')]:
    assert any(line['language']==language and line['text'].replace(' ','')==expected and line['confidence']>.8
               for line in lines), f'{language} recognition failed; inspect {output}'
print('PASS: Korean, English, Japanese and Chinese')
