const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
function load(consent='Continue with AI'){
 const requests=[],answers=['Search invoices','When asked for an invoice','The results list is visible'];
 const results=[JSON.stringify({questions:['What does this task do?','When should an agent use it?','What result confirms it?']}),JSON.stringify({title:'Find invoice',description:'Search the guest invoice list for an exact query',when_to_use:'When the user asks to find invoices',expected_result:'An invoice list is visible',tags:['invoice','search'],inputs:[]})];
 const model={name:'Test model',vendor:'fixture',async sendRequest(messages){requests.push(messages);const text=results.shift();return {text:(async function*(){yield text;})()};}};
 const vscode={lm:{selectChatModels:async()=>[model]},LanguageModelChatMessage:{User:text=>({content:text})},ProgressLocation:{Notification:1},window:{showQuickPick:async rows=>rows[0],showWarningMessage:async()=>consent,showInputBox:async()=>answers.shift(),withProgress:async(options,fn)=>fn({}, {isCancellationRequested:false})}};
 const module={exports:{}};vm.runInNewContext(`(function(require,module){${fs.readFileSync(path.join(__dirname,'../rpa-author.js'),'utf8')}\n})`,{})(name=>name==='vscode'?vscode:require(name),module);return {...module.exports,requests};
}
test('AI asks questions, uses user answers and returns editable metadata without executing or rewriting source',async()=>{
 const api=load();const result=await api.createMetadata({name:'recorded.py'},'import pyautogui\npyautogui.press("enter")',{globalState:{get:()=> 'kvm'}});assert.equal(result.title,'Find invoice');assert.equal(api.requests.length,2);assert.match(api.requests[1][0].content,/Search invoices/);assert.match(api.requests[1][0].content,/Do not execute or rewrite/);
});
test('declining source sharing prevents every model request',async()=>{const api=load(undefined);/* explicit cancellation value */
 const cancelled=load('Cancel');assert.equal(await cancelled.createMetadata({name:'recorded.py'},'pass',{globalState:{get:()=> 'kvm'}}),undefined);assert.equal(cancelled.requests.length,0);
});
