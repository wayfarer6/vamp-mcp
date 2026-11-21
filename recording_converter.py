"""Parse recorder source as data; never import, eval or execute a recording."""
import argparse
import ast
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parent
KEY_ALIASES={'cmd':'super','command':'super','win':'super','winleft':'super','winright':'superright',
 'ctrl_l':'ctrl','ctrl_r':'ctrlright','ctrlleft':'ctrl','ctrlright':'ctrlright',
 'shift_l':'shift','shift_r':'shiftright','shiftleft':'shift','shiftright':'shiftright',
 'alt_l':'alt','alt_r':'altright','altleft':'alt','altright':'altright',
 'return':'enter','escape':'esc','del':'delete','pgup':'pageup','pgdn':'pagedown'}
SPECIAL_KEYS={'enter','esc','tab','space','ctrl','ctrlright','alt','altright','shift','shiftright',
 'super','superright','backspace','left','right','up','down','delete','home','end','pageup','pagedown',
 'insert','capslock',*[f'f{i}' for i in range(1,13)]}


def key_name(value):
    if not isinstance(value,str) or not value:
        raise ValueError('Expected a key name')
    key=KEY_ALIASES.get(value.lower(),value.lower())
    if key in SPECIAL_KEYS or len(value)==1 and 32<=ord(value)<=126:
        return key if len(value)>1 else value
    raise ValueError('Unsupported recorded key name')


def number(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
        raise ValueError('Expected a finite numeric value')
    return value


def parse_recording(source,width=1920,height=1080,coordinate_space='guest',viewport=None):
    if width<=0 or height<=0:
        raise ValueError('Guest resolution must be positive')
    if coordinate_space=='host' and (not viewport or len(viewport)!=4 or not all(math.isfinite(v) for v in viewport) or viewport[2]<=0 or viewport[3]<=0):
        raise ValueError('Host recordings require --viewport LEFT TOP WIDTH HEIGHT in recorded coordinate units')
    source_lines = source.splitlines()
    modules={}; functions={}; actions=[]
    def point(x,y):
        x,y=number(x),number(y)
        if coordinate_space=='host':
            left,top,w,h=viewport
            if not (left<=x<left+w and top<=y<top+h):
                raise ValueError('Recorded point lies outside the specified guest viewport')
            x,y=(x-left)*width/w,(y-top)*height/h
        if not (0<=x<width and 0<=y<height):
            raise ValueError('Recorded point is outside the declared guest resolution')
        return min(width-1,round(x)),min(height-1,round(y))
    def walk(body):
        for node in body:
            if isinstance(node,ast.Import):
                for alias in node.names:
                    if alias.name not in ('pyautogui','time'):
                        raise ValueError(f'Unsupported import at line {node.lineno}')
                    modules[alias.asname or alias.name]=alias.name
                continue
            if isinstance(node,ast.ImportFrom) and node.module in ('pyautogui','time'):
                for alias in node.names:
                    if alias.name=='*':raise ValueError('Wildcard imports are not supported')
                    functions[alias.asname or alias.name]=(node.module,alias.name)
                continue
            if isinstance(node,ast.If) and ast.dump(node.test)==ast.dump(ast.parse("__name__ == '__main__'",mode='eval').body) and not node.orelse:
                walk(node.body);continue
            if isinstance(node,ast.Expr) and isinstance(node.value,ast.Constant) and isinstance(node.value.value,str):
                continue
            if not isinstance(node,ast.Expr) or not isinstance(node.value,ast.Call):
                raise ValueError(f'Unsupported Python statement at line {node.lineno}; review manually')
            call=node.value
            if isinstance(call.func,ast.Attribute) and isinstance(call.func.value,ast.Name):
                module,name=modules.get(call.func.value.id),call.func.attr
            elif isinstance(call.func,ast.Name) and call.func.id in functions:
                module,name=functions[call.func.id]
            else:
                raise ValueError(f'Unsupported call at line {node.lineno}')
            try:
                args=[ast.literal_eval(a) for a in call.args]
                kwargs={k.arg:ast.literal_eval(k.value) for k in call.keywords if k.arg is not None}
                if any(k.arg is None for k in call.keywords) or len(kwargs)!=len(call.keywords):raise ValueError()
            except (ValueError,TypeError,SyntaxError):
                raise ValueError(f'Only literal arguments are allowed at line {node.lineno}') from None
            action={'line':node.lineno}
            def take(index,key,default=None):
                if len(args)>index and key in kwargs:raise ValueError('Duplicate argument')
                return args[index] if len(args)>index else kwargs.get(key,default)
            allowed=set();max_args=0
            if module=='time' and name=='sleep' or module=='pyautogui' and name=='sleep':
                allowed={'seconds'};max_args=1
                seconds=number(take(0,'seconds'))
                if seconds<0:raise ValueError('Negative sleep')
                action.update(op='wait',seconds=seconds)
            elif module=='pyautogui' and name in ('keyDown','keyUp'):
                allowed={'key'};max_args=1
                action.update(op='key_down' if name=='keyDown' else 'key_up',key=key_name(take(0,'key')))
            elif module=='pyautogui' and name in ('write','typewrite'):
                allowed={'message','interval'};max_args=2
                message=take(0,'message');interval=number(take(1,'interval',.06))
                if interval<0:raise ValueError('Negative key interval')
                if isinstance(message,str) and all(32<=ord(c)<=126 or c in '\n\t' for c in message):
                    action.update(op='write',text=message,interval=interval)
                elif isinstance(message,(list,tuple)):
                    action.update(op='press',keys=[key_name(k) for k in message],presses=1,interval=interval)
                else:raise ValueError('Only ASCII text or literal key lists are supported')
            elif module=='pyautogui' and name=='press':
                allowed={'keys','presses','interval'};max_args=3
                keys=take(0,'keys');keys=[keys] if isinstance(keys,str) else keys
                presses=take(1,'presses',1);interval=number(take(2,'interval',.05))
                if not isinstance(keys,(list,tuple)) or type(presses)!=int or presses<1 or interval<0:raise ValueError('Invalid press arguments')
                action.update(op='press',keys=[key_name(k) for k in keys],presses=presses,interval=interval)
            elif module=='pyautogui' and name=='hotkey':
                allowed={'interval'};max_args=len(args)
                interval=number(kwargs.get('interval',.05))
                if not args or interval<0:raise ValueError('Invalid hotkey')
                action.update(op='hotkey',keys=[key_name(k) for k in args],interval=interval)
            elif module=='pyautogui' and name in ('click','doubleClick','rightClick','middleClick','moveTo'):
                max_args=2;allowed={'x','y','duration','button','clicks','interval'}
                if kwargs.get('duration',0)!=0:raise ValueError('Timed movement requires manual conversion')
                x,y=point(take(0,'x'),take(1,'y'))
                if name=='moveTo':
                    if set(kwargs)-{'x','y','duration'}:raise ValueError('Invalid moveTo arguments')
                    action.update(op='move',x=x,y=y)
                else:
                    button=kwargs.get('button',{'rightClick':'right','middleClick':'middle'}.get(name,'left'))
                    clicks=kwargs.get('clicks',2 if name=='doubleClick' else 1)
                    interval=number(kwargs.get('interval',.1))
                    if button not in ('left','middle','right') or type(clicks)!=int or clicks<1 or interval<0:raise ValueError('Invalid click arguments')
                    action.update(op='click',x=x,y=y,button=button,clicks=clicks,interval=interval)
                    # AST columns are UTF-8 byte offsets. Read only this call's trailing comment.
                    tail = source_lines[node.end_lineno-1].encode('utf8')[node.end_col_offset:].decode('utf8').strip()
                    if tail.startswith('# vamp-target '):
                        target = json.loads(tail[len('# vamp-target '):])
                        if not isinstance(target, dict) or len(target) != 1 or not set(target) <= {'ocr', 'yolo'}:
                            raise ValueError('Specify one OCR text or YOLO class in the click target')
                        label = next(iter(target.values()))
                        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 120:
                            raise ValueError('Invalid recorded click label')
                        action['target'] = target
            elif module=='pyautogui' and name=='scroll':
                allowed={'clicks','x','y'};max_args=3
                clicks=take(0,'clicks')
                if type(clicks)!=int:raise ValueError('Wheel clicks must be an integer')
                action.update(op='scroll',clicks=clicks)
                x,y=take(1,'x'),take(2,'y')
                if x is not None or y is not None:
                    x,y=point(x,y);action.update(x=x,y=y)
            else:
                raise ValueError(f'Unsupported recorder operation at line {node.lineno}; no code was executed')
            if len(args)>max_args or set(kwargs)-allowed:
                raise ValueError(f'Unsupported arguments at line {node.lineno}')
            actions.append(action)
    walk(ast.parse(source).body)
    if not actions:raise ValueError('No supported actions found')
    return actions


def generate(source_path,package_id,guest_os='windows11',width=1920,height=1080,
             coordinate_space='guest',viewport=None,package_root=None):
    if not re.fullmatch('[a-z][a-z0-9_]*',package_id):raise ValueError('Invalid package id')
    source_path=Path(source_path).expanduser().resolve()
    raw=source_path.read_bytes()
    actions=parse_recording(raw.decode('utf-8-sig'),width,height,coordinate_space,viewport)
    parent=Path(package_root) if package_root else ROOT/'rpas'
    target=parent/package_id
    if target.exists():raise ValueError('Package already exists; use a new id to preserve manual edits')
    held=set()
    for action in actions:
        if action['op']=='key_down':held.add(action['key'])
        if action['op']=='key_up':held.discard(action['key'])
    first_inputs=[action for action in actions if action['op']!='wait'][:2]
    starts_launcher=bool(first_inputs) and (
        (len(first_inputs)==2 and first_inputs[0].get('op')=='key_down' and first_inputs[0].get('key')=='super'
         and first_inputs[1].get('op')=='key_down' and first_inputs[1].get('key','').lower()=='r') or (
         first_inputs[0].get('op')=='hotkey' and first_inputs[0].get('keys')==['super','r']))
    warnings=['Mechanical conversion only: review target positions and replace waits with state checks.',
              'Review all recorded input for private credentials before replay or sharing.']
    if held:warnings.append(f'{len(held)} key(s) remain held at recording end; replay teardown will release them.')
    if guest_os=='windows11' and not starts_launcher:warnings.append('No initial Win+R launcher detected; replace desktop-icon launch with a common launcher.')
    manifest={'format_version':1,'id':package_id,'name':'Recorded '+package_id,'version':'0.1.0',
      'default_entrypoint':'run','entrypoints':[{'name':'run','file':'run.robot','credentials':'environment_or_prompt'}],
      'python_libraries':['workflow.py'],'dependencies':['spice','paddleocr_optional'],
      'skill':'spice-recording-convert','outputs':{'summary':'${OUTPUT DIR}/summary.json',
        'robot_log':'${OUTPUT DIR}/log.html','robot_report':'${OUTPUT DIR}/report.html'}}
    report={'format_version':1,'source_name':source_path.name,'source_sha256':hashlib.sha256(raw).hexdigest(),
      'guest_os':guest_os,'coordinate_space':coordinate_space,'guest_resolution':[width,height],
      'action_count':len(actions),'operations':dict(Counter(a['op'] for a in actions)),
      'initial_win_r':starts_launcher,'requires_review':True,'warnings':warnings}
    target.mkdir(parents=True)
    for name,data in [('manifest.json',manifest),('conversion.json',report),
      ('recording.local.json',{'format_version':1,'guest_os':guest_os,'resolution':[width,height],'actions':actions})]:
        path=target/name;path.write_text(json.dumps(data,indent=2)+'\n', encoding='ascii')
        if name=='recording.local.json':path.chmod(0o600)
    (target/'workflow.py').write_text('''"""Generated adapter: keep detailed input and coordinates in Python/local data."""
from pathlib import Path
from robot.api.deco import library
from recording_runtime import RecordedWorkflow


@library(scope='SUITE',auto_keywords=False)
class Workflow(RecordedWorkflow):
    def __init__(self):
        super().__init__(Path(__file__).resolve().parent)
''')
    lines=['*** Settings ***','Resource          ${CURDIR}/../common.resource',
      'Library           ${CURDIR}/workflow.py    WITH NAME    Workflow',
      'Suite Setup       Contract.Begin Result    ${RPA_ID}',
      'Suite Teardown    Stop RPA','Task Teardown     End Recorded Task','',
      '*** Variables ***',f'${{RPA_ID}}         {package_id}',
      '${ALLOW_REPLAY}   ${FALSE}','${EXPECTED_TEXT}  ${EMPTY}','${LANGUAGES}      en',
      '${VIRTUALBOX_VM}  ${EMPTY}','',
      '*** Tasks ***','Replay Reviewed Guest Recording',
      '    ${ready}=    Workflow.Load Recording    ${ALLOW_REPLAY}',
      '    IF    not $ready','    ${review}=    Workflow.Review Result',
      '        Contract.Publish Result    ${review}','        Skip    Review conversion.json and recording.local.json; set ALLOW_REPLAY only after review.',
      '    END','    IF    $VIRTUALBOX_VM',
      '        ${result}=    Workflow.Replay VirtualBox    ${VIRTUALBOX_VM}    ${EXPECTED_TEXT}',
      '    ELSE','        Spice.Connect Spice    ${SPICE_URI}','        Workflow.Check Guest Geometry']
    lines[lines.index('    ${review}=    Workflow.Review Result')]='        ${review}=    Workflow.Review Result'
    lines.extend(['        ${count}=    Workflow.Action Count',
      '        FOR    ${index}    IN RANGE    ${count}',
      '            Workflow.Replay Event    ${index}','        END'])
    lines.extend(['        ${result}=    Workflow.Verify Replay    ${EXPECTED_TEXT}    ${LANGUAGES}','    END',
      '    Contract.Publish Result    ${result}','    Pause For User Verification    ${result}',
      '    Should Not Be Equal    ${result}[status]    verification_failed','','*** Keywords ***','End Recorded Task',
      '    Run Keyword And Continue On Failure    Workflow.Release Recorded Inputs','    Finish RPA Task',''])
    (target/'run.robot').write_text('\n'.join(lines))
    (target/'README.md').write_text(f'''# {package_id}\n\nGenerated from `{source_path.name}` without executing source code.\n\n- Guest: `{guest_os}`, {width}×{height}; source space: `{coordinate_space}`.\n- Review `conversion.json` and the private `recording.local.json` before replay.\n- `run.robot` controls the order; `workflow.py` and `recording_runtime.py` execute guest input.\n- Default run returns `needs_review` without connecting to the VM.\n- Explicit replay: `.venv/bin/python scripts/run_rpa.py {package_id} --var ALLOW_REPLAY:True --var SPICE_URI:<actual-guest-uri>`\n- For VirtualBox, pass `--var VIRTUALBOX_VM:<running-vm-uuid>` instead of `SPICE_URI` and use a host Python with the VirtualBox SDK.\n- No application success is claimed unless an expected OCR text is configured; otherwise result is `replayed_unverified`.\n- `recording.local.json` is excluded from Git because recorded keystrokes can contain credentials. Regenerate from a local source on a new checkout.\n- See [conversion guide](../../docs/RECORDING_CONVERSION.md) for refinement and credential replacement.\n''', encoding='utf-8')
    return {'status':'generated_needs_review','rpa_id':package_id,'package_path':str(target.resolve()),
            'action_count':len(actions),'initial_win_r':starts_launcher,'report':str((target/'conversion.json').resolve())}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('--id',required=True)
    parser.add_argument('--guest-os',choices=['windows11','debian'],default='windows11')
    parser.add_argument('--width',type=int,default=1920);parser.add_argument('--height',type=int,default=1080)
    parser.add_argument('--coordinate-space',choices=['guest','host'],default='guest')
    parser.add_argument('--viewport',type=float,nargs=4,metavar=('LEFT','TOP','WIDTH','HEIGHT'))
    args=parser.parse_args()
    try:result=generate(args.source,args.id,args.guest_os,args.width,args.height,args.coordinate_space,args.viewport)
    except (ValueError,OSError,SyntaxError) as error:parser.error(str(error))
    print(json.dumps(result,indent=2))


if __name__ == '__main__':
    main()
