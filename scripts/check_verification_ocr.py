"""Verify detection of challenge INSTRUCTIONS; no challenge answers are present."""
import json
import subprocess
import sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root))
from verification import detect_verification
output=root/'artifacts/verification-smoke'
output.mkdir(parents=True,exist_ok=True)
image=Image.new('RGB',(1200,500),'white')
draw=ImageDraw.Draw(image)
font=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',36)
for y,text in [(30,'Please complete the CAPTCHA'),(140,'보안문자를 직접 입력하세요'),
               (250,'画像認証'),(360,'图形验证码')]:
    draw.text((40,y),text,fill='black',font=font)
image.save(output/'instructions.png')
subprocess.run([str(root/'.venv-ocr/bin/python'),str(root/'ocr_worker.py'),
                str(output/'instructions.png'),'--output',str(output/'ocr.json')],check=True)
result=detect_verification(json.loads((output/'ocr.json').read_text()))
assert result['status']=='needs_user_captcha',result
required={'captcha','security_characters_ko','captcha_ja','captcha_zh'}
assert required.issubset(result['matched_rules']),result
(output/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(result,ensure_ascii=False,indent=2))
