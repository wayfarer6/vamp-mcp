const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
function harness({models=true,approval=true,warning='Check all files before upload / 업로드 전 전체 파일을 확인하세요.',confirm=true}={}){
 const requests=[],notices=[];let selected=0;
 const model={name:'Fixture',vendor:'Test',sendRequest:async messages=>{requests.push(messages);return {text:(async function*(){yield JSON.stringify({allow_export:approval,warning});})()};}};
 const vscode={lm:{selectChatModels:async()=>models?[model]:[]},LanguageModelChatMessage:{User:content=>({content})},ProgressLocation:{Notification:1},window:{showQuickPick:async rows=>rows[0],showWarningMessage:async(...args)=>{notices.push(args);return selected++===0?'Review structure with AI':confirm?'I reviewed every file — Export':undefined;},withProgress:async(options,fn)=>fn({}, {isCancellationRequested:false})}};
 const module={exports:{}};vm.runInNewContext('(function(require,module){'+fs.readFileSync(path.join(__dirname,'../rpa-export-review.js'),'utf8')+'\n})',{})(name=>name==='vscode'?vscode:require(name),module);
 return {...module.exports,requests,notices};
}
const report=()=>({summary:{file_count:1,findings:[],files:[{file:1,type:'.py',lines:5}],limitations:['No original source is provided']}});
test('AI warning and explicit personal inspection are required; only the structural report is transmitted',async()=>{
 const api=harness();const snapshot=report();snapshot.rawSecret='never-send-this-private-value';
 assert.equal(await api.reviewExport(snapshot),true);assert.equal(api.requests.length,1);
 assert.ok(!JSON.stringify(api.requests).includes(snapshot.rawSecret));assert.match(api.notices.at(-1)[1].detail,/AI warning:/);assert.match(api.notices.at(-1)[0],/EVERY exported file/);
});
test('detected secrets block before sending anything to AI',async()=>{const api=harness(),snapshot=report();snapshot.summary.findings=[{file:1,line:2,kind:'credential-assignment'}];assert.equal(await api.reviewExport(snapshot),false);assert.equal(api.requests.length,0);});
test('missing AI, rejected AI review, missing warning and cancelled final review all prevent export',async()=>{
 await assert.rejects(harness({models:false}).reviewExport(report()),/requires an AI/);
 assert.equal(await harness({approval:false}).reviewExport(report()),false);
 await assert.rejects(harness({warning:''}).reviewExport(report()),/invalid result/);
 assert.equal(await harness({confirm:false}).reviewExport(report()),false);
});
test('local checks detect Robot literal passwords even with a parameterized locator, and dynamic GUI writes',()=>{
 const privacy=require('../rpa-privacy');
 assert.ok(privacy.inspectText('Input Password    ${field}    private-value','.robot').findings.length);
 assert.equal(privacy.inspectText('Input Password    ${field}    ${password}','.robot').findings.length,0);
 assert.ok(privacy.inspectText('pyautogui.write(secret_variable)').findings.length);
 assert.ok(privacy.inspectText('pyautogui.write("""private-value""")').findings.length);
 assert.equal(privacy.inspectText('pyautogui.write("${username}")').findings.length,0);
});
