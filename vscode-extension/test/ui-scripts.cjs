const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
function load(relative){const module={exports:{}};const file=path.resolve(__dirname,relative);const local=name=>{if(name==='vscode')return {};if(name.startsWith('./')||name.startsWith('../'))return require(path.resolve(path.dirname(file),name));return require(name);};vm.runInNewContext(`(function(require,module){${fs.readFileSync(file,'utf8')}\n})`,{process,console})(local,module);return module.exports;}
test('every embedded manager, library, sidebar and vault script parses before packaging',()=>{
 const manager=load('../vm-manager.js'),library=load('../rpa-library.js'),vault=load('../../vscode-vault-extension/vault-browser.js');
 for(const html of [manager.managerHTML(),manager.screenHTML('<unsafe>'),manager.sidebarHTML('safe:logo','safe:'),library.libraryHTML(),vault.browserHTML()]){
  assert.match(html,/Content-Security-Policy/);for(const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
 }
});
