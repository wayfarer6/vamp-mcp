const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
test('legacy extension collision is explained before registering duplicate commands',async()=>{
 const notices=[],commands=[];
 const vscode={extensions:{getExtension:id=>id==='wayfarer6.vamp-mcp'?{}:undefined},window:{showWarningMessage:async(...args)=>{notices.push(args);return 'Show legacy extension';}},commands:{executeCommand:async(...args)=>commands.push(args)}};
 const module={exports:{}};
 const file=path.join(__dirname,'../extension.js');
 vm.runInNewContext('(function(require,module){'+fs.readFileSync(file,'utf8')+'\n})',{process,console})(name=>name==='vscode'?vscode:name==='./package.json'?{version:'0.1.9'}:require(name),module);
 module.exports.activate({});await new Promise(resolve=>setImmediate(resolve));
 assert.match(notices[0][0],/legacy.*conflicts/);
 assert.equal(commands[0][0],'workbench.extensions.search');
 assert.equal(commands[0][1],'@id:wayfarer6.vamp-mcp');
});
