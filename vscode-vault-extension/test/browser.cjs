const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
function harness(){
 const commands=new Map(),messages=[];let receive,disposed,resolveSecret;
 const panel={reveal(){},webview:{postMessage:m=>messages.push(m),onDidReceiveMessage:fn=>receive=fn},onDidDispose:fn=>disposed=fn,dispose(){disposed?.();}};
 const vscode={ViewColumn:{Active:1},window:{createWebviewPanel:()=>panel},commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return {dispose(){}};},executeCommand:async()=>{}}};
 const module={exports:{}};vm.runInNewContext(`(function(require,module){${fs.readFileSync(path.join(__dirname,'../vault-browser.js'),'utf8')}\n})`,{})(name=>name==='vscode'?vscode:require(name),module);
 const state={database:'fixture.kdbx',available:true,exists:true,unlocked:true,entries:[{path:'Mail/Example',title:'Example',group:'Mail'}]};
 const actions={load:async()=>state,details:async()=>({username:'alice',password:'must-not-leak',url:'https://example.test',notes:'fixture'}),reveal:()=>new Promise(resolve=>resolveSecret=resolve),copyUsername:async()=>{},copyPassword:async()=>{},sendCredential:async()=>({status:'delivered',destination:'test-vm',password:'must-not-leak'})};
 const browser=module.exports.registerBrowser({subscriptions:[]},actions);
 return {messages,state,browser,open:()=>commands.get('vampVault.openBrowser')(),send:m=>receive(m),resolve:secret=>resolveSecret(secret),close:()=>panel.dispose()};
}
test('credential details omit passwords and reject unknown entry paths',async()=>{const h=harness();try{await h.open();await h.send({type:'detail',path:'Mail/Example'});const detail=h.messages.findLast(m=>m.type==='detail');assert.equal(detail.record.username,'alice');assert.equal(detail.record.password,undefined);await h.send({type:'detail',path:'Other/Entry'});assert.match(h.messages.at(-1).message,/choose an available entry/);}finally{h.close();}});
test('locking during password reveal clears the view and discards a delayed secret',async()=>{const h=harness();try{await h.open();const pending=h.send({type:'reveal',path:'Mail/Example'});h.state.unlocked=false;h.state.entries=[];h.browser.reset();h.resolve('late-secret');await pending;assert.ok(h.messages.some(m=>m.type==='clear'));assert.ok(!h.messages.some(m=>m.type==='secret'));}finally{h.close();}});
test('credential delivery only returns the destination receipt to the webview',async()=>{const h=harness();try{await h.open();await h.send({type:'send',path:'Mail/Example'});const receipt=h.messages.at(-1);assert.equal(receipt.type,'delivered');assert.equal(receipt.destination,'test-vm');assert.equal(receipt.password,undefined);}finally{h.close();}});
