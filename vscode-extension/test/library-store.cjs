const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const yauzl=require('yauzl');
const {catalog,preview,prepareExport,approveExport,exportItem}=require('../src/library-store.cjs');
async function reviewedExport(item,target){const snapshot=await prepareExport(item);approveExport(snapshot,{aiReviewed:true,userConfirmed:true});return exportItem(item,target,{snapshot});}
function unzip(bytes){return new Promise((resolve,reject)=>{yauzl.fromBuffer(bytes,{lazyEntries:true},(error,zip)=>{if(error)return reject(error);const files=new Map();zip.on('error',reject);zip.on('end',()=>resolve(files));zip.on('entry',entry=>zip.openReadStream(entry,(err,stream)=>{if(err)return reject(err);const chunks=[];stream.on('data',chunk=>chunks.push(chunk));stream.on('error',reject);stream.on('end',()=>{files.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();});}));zip.readEntry();});});}
test('finds saved RPAs and recordings, previews without executing, exports complete source and exact checksums',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vamp-library-'));
 try{
  await fs.mkdir(path.join(root,'hello'));await fs.writeFile(path.join(root,'hello/manifest.json'),JSON.stringify({id:'hello',name:'Hello Desktop',version:'1.0.0',entrypoints:[{name:'run'}]}));
  const source='raise RuntimeError("this file must never be executed")\n';await fs.writeFile(path.join(root,'hello/run.py'),source);await fs.writeFile(path.join(root,'saved.py'),'print("recorded")\n');
  const result=await catalog([{path:root,label:'My workflows'}]);assert.equal(result.items.length,2);const item=result.items.find(i=>i.kind==='package');assert.equal(item.name,'Hello Desktop');assert.equal(await preview(item,'run.py'),source);
  const target=path.join(root,'export.zip');const exported=await reviewedExport(item,target);const files=await unzip(await fs.readFile(target));assert.equal(files.get('run.py').toString(),source);const manifest=JSON.parse(files.get('VAMP_EXPORT.json'));assert.equal(manifest.source_executed,false);assert.equal(manifest.requires_matching_vamp_runtime,true);
  for(const file of manifest.files)assert.equal(crypto.createHash('sha256').update(files.get(file.path)).digest('hex'),file.sha256);assert.equal(exported.files,2);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('recordings never export neighboring databases, VM images, hidden files or symlinks',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vamp-library-'));
 try{
  for(const [name,value] of [['saved.py','print("safe")'],['secret.kdbx','private'],['disk.qcow2','disk'],['.env','TOKEN=private']])await fs.writeFile(path.join(root,name),value);
  await t.test('symlink fixture is excluded from the catalog',async sub=>{
   try { await fs.symlink(path.join(root,'secret.kdbx'),path.join(root,'linked.py')); }
   catch(error) { if(process.platform==='win32'&&error.code==='EPERM'){sub.skip('Windows account cannot create symlinks');return;}throw error; }
   const {items}=await catalog([{path:root,label:'Recordings'}]);assert.equal(items.length,1);
  });
  const {items}=await catalog([{path:root,label:'Recordings'}]);assert.equal(items.length,1);await assert.rejects(preview(items[0],'../secret.kdbx'),/Choose a file/);
  await reviewedExport(items[0],path.join(root,'saved.zip'));const files=await unzip(await fs.readFile(path.join(root,'saved.zip')));assert.deepEqual([...files.keys()].sort(),['VAMP_EXPORT.json','saved.py']);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('saved skill exports only latest committed revision without Git history or dirty working files',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vamp-revision-export-'));
 try{
  const {execFileSync}=require('node:child_process');
  for(const [name,source] of [['rpa.json',JSON.stringify({format:'vamp-saved-rpa',id:'fixture',name:'Latest skill',version:'1.0.1',entrypoints:[{name:'run'}]})],['source.py','print("committed")'],['actions.json','[]'],['README.md','# latest']])await fs.writeFile(path.join(root,name),source);
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});git('init','--quiet');git('add','.');git('-c','user.name=Test','-c','user.email=test@localhost','commit','--quiet','-m','Current revision');
  await fs.writeFile(path.join(root,'source.py'),'print("uncommitted")');const result=await catalog([{path:root,label:'Saved'}]);const target=path.join(root,'export.zip');await reviewedExport(result.items[0],target);
  const files=await unzip(await fs.readFile(target));assert.equal(files.get('source.py').toString(),'print("committed")');assert.ok(![...files.keys()].some(name=>name.includes('.git')));const metadata=JSON.parse(files.get('VAMP_EXPORT.json'));assert.equal(metadata.latest_committed_only,true);assert.match(metadata.commit,/^[a-f0-9]{40}$/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('privacy gate blocks missing review and secret-bearing recordings before creating an archive',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vamp-private-export-'));
 try {
  await fs.writeFile(path.join(root,'recording.py'),'pyautogui.write("private-account")\npassword="sensitive-pass"');
  const {items}=await catalog([{path:root,label:'Private'}]);const target=path.join(root,'blocked.zip');
  await assert.rejects(exportItem(items[0],target),/privacy review/);
  const snapshot=await prepareExport(items[0]);assert.ok(snapshot.summary.findings.length>=2);
  const report=JSON.stringify(snapshot.summary);assert.ok(!report.includes('private-account'));assert.ok(!report.includes('sensitive-pass'));assert.ok(!report.includes(root));
  assert.throws(()=>approveExport(snapshot,{aiReviewed:true,userConfirmed:true}),/privacy review/);
  await assert.rejects(fs.access(target));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('review is tied to the exact archive bytes and cannot be reused after source changes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vamp-reviewed-export-'));
 try {
  const source=path.join(root,'recording.py');await fs.writeFile(source,'pyautogui.write("${username}")');
  const {items}=await catalog([{path:root,label:'Source'}]);const item=items[0],target=path.join(root,'export.zip');
  const snapshot=await prepareExport(item);assert.equal(snapshot.summary.findings.length,0);
  assert.throws(()=>approveExport(snapshot,{aiReviewed:true,userConfirmed:false}),/manual user/);
  approveExport(snapshot,{aiReviewed:true,userConfirmed:true});
  await fs.writeFile(source,'pyautogui.write("new-private-value")');
  await assert.rejects(exportItem(item,target,{snapshot}),/changed after privacy review/);await assert.rejects(fs.access(target));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
