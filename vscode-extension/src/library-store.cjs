const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {createWriteStream}=require('node:fs');
const {ZipFile}=require('yazl');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const git=promisify(execFile);
const privacy=require('../rpa-privacy.js');
const snapshots=new WeakMap();
const extensions=new Set(['.py','.robot','.resource','.md','.json','.png','.jpg','.jpeg','.txt','.yaml','.yml','.toml']);
const skipped=new Set(['node_modules','__pycache__','.git','.venv','logs','screenshots','recordings']);
const idFor=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,24);
async function safeFiles(root,limit=1000){
 const base=await fs.realpath(root);const files=[];
 async function visit(folder,depth){
  if(depth>12)return;
  for(const entry of await fs.readdir(folder,{withFileTypes:true})){
   if(entry.isSymbolicLink()||entry.name.startsWith('.')||skipped.has(entry.name))continue;
   const file=path.join(folder,entry.name);
   if(entry.isDirectory()){await visit(file,depth+1);continue;}
   if(!entry.isFile()||!extensions.has(path.extname(file).toLowerCase())||(entry.name.endsWith('.local.json')||entry.name==='VAMP_EXPORT.json'))continue;
   const stat=await fs.stat(file);if(stat.size>5*1024**2)continue;
   files.push({file,relative:path.relative(base,file).split(path.sep).join('/'),bytes:stat.size,modified:stat.mtimeMs});
   if(files.length>limit)throw Error('This folder has too many files. Choose a smaller RPA folder.');
  }
 }
 await visit(base,0);return files;
}
async function catalog(roots){
 const items=[],seen=new Set(),issues=[];
 for(const root of roots){
  try{
   const real=await fs.realpath(root.path);if(seen.has(real))continue;seen.add(real);
   const files=await safeFiles(real);const packaged=new Set();
   for(const file of files.filter(f=>['manifest.json','rpa-draft.json','rpa.json'].includes(path.basename(f.file)))){
    let manifest;try{manifest=JSON.parse(await fs.readFile(file.file,'utf8'));}catch{continue;}
    if(!manifest.id||!manifest.name||!Array.isArray(manifest.entrypoints))continue;
    const folder=path.dirname(file.file);packaged.add(folder);
    const packageFiles=files.filter(f=>f.file.startsWith(folder+path.sep)).map(f=>({...f,relative:path.relative(folder,f.file).split(path.sep).join('/')}));
    items.push({id:idFor(folder),name:manifest.name,version:manifest.version || '',kind:manifest.format==='vamp-cli-workflow'?'cli':manifest.format==='vamp-saved-rpa'?'saved':manifest.format==='vamp-ai-draft'?'draft':'package',origin:root.label,path:folder,files:packageFiles,entries:manifest.entrypoints.map(e=>e.name),dependencies:manifest.dependencies||[],modified:Math.max(...packageFiles.map(f=>f.modified)),manifest,description:manifest.description||'',when_to_use:manifest.when_to_use||'',expected_result:manifest.expected_result||'',tags:manifest.tags||[],inputs:manifest.inputs||[],backend:manifest.backend||'',resolution:manifest.resolution||[],reviewed:manifest.reviewed===true});
   }
   for(const file of files){
    if([...packaged].some(folder=>file.file.startsWith(folder+path.sep)))continue;
    if(!/\.(py|robot)$|\.handoff\.json$/i.test(file.file))continue;
    items.push({id:idFor(file.file),name:path.basename(file.file),version:'',kind:'recording',origin:root.label,path:file.file,files:[{...file,relative:path.basename(file.file)}],entries:[],dependencies:[],modified:file.modified});
   }
  }catch(error){if(error.code!=='ENOENT')issues.push({origin:root.label,message:error.message});}
 }
 const unique=new Map(items.map(item=>[item.id,item]));
 return {items:[...unique.values()].sort((a,b)=>b.modified-a.modified),issues};
}
async function checkedBuffer(item,file){
 const current=await fs.lstat(file.file);if(!current.isFile()||current.isSymbolicLink()||current.size>5*1024**2)throw Error('The selected file changed. Refresh the library.');
 const real=await fs.realpath(file.file);const base=await fs.realpath(item.kind==='package'?item.path:path.dirname(item.path));
 if(!real.startsWith(base+path.sep))throw Error('The selected source is outside its RPA folder.');
 return fs.readFile(real);
}
async function preview(item,relative){
 const file=item.files.find(file=>file.relative===relative);if(!file)throw Error('Choose a file from this RPA.');
 if(!['.py','.robot','.json','.resource','.md','.txt','.yaml','.yml','.toml'].includes(path.extname(relative).toLowerCase()))return 'Binary asset · included in the export.';
 const bytes=await checkedBuffer(item,file);const text=bytes.toString('utf8');return text.length>64000?text.slice(0,64000)+'\n… preview truncated; export retains the complete file.':text;
}
async function collectExport(item){
 let commit;let revisionFiles;
 if(item.kind==='saved'){
  commit=(await git('git',['-C',item.path,'rev-parse','HEAD'],{timeout:15000})).stdout.trim();
  revisionFiles=[];
  for(const name of ['rpa.json','actions.json','source.py','README.md']){const result=await git('git',['-C',item.path,'show',commit+':'+name],{timeout:15000,encoding:'buffer',maxBuffer:5*1024**2});revisionFiles.push({relative:name,buffer:result.stdout});}
 }
 const files=[];let total=0;
 for(const file of revisionFiles||item.files){
  if(file.relative.split('/').includes('..')||path.isAbsolute(file.relative))throw Error('Invalid export path.');
  const bytes=Buffer.from(file.buffer||await checkedBuffer(item,file));total+=bytes.length;if(total>50*1024**2)throw Error('The RPA exceeds the export limit.');
  files.push({relative:file.relative,bytes});
 }
 return {files,commit,name:item.name,kind:item.kind,version:revisionFiles?JSON.parse(revisionFiles[0].buffer).version:item.version};
}
async function prepareExport(item){
 const data=await collectExport(item);const summary=privacy.summarize([...data.files,{relative:'VAMP_EXPORT.json',bytes:Buffer.from(JSON.stringify({name:data.name,paths:data.files.map(f=>f.relative)}))}]);
 const snapshot=Object.freeze({digest:privacy.digest(data.files,JSON.stringify([data.commit,data.name,data.kind,data.version])),summary});
 snapshots.set(snapshot,{...data,item,approved:false,findingsCount:summary.findings.length});return snapshot;
}
function approveExport(snapshot,{aiReviewed,userConfirmed}={}){
 const data=snapshots.get(snapshot);if(!data||aiReviewed!==true||userConfirmed!==true||data.findingsCount)throw Error('AI privacy review and manual user review are required before export.');
 data.approved=true;
}
async function exportItem(item,destination,{snapshot}={}){
 const data=snapshots.get(snapshot);if(!data||data.item!==item||!data.approved)throw Error('AI privacy review and manual user review are required before export.');
 if(item.files.some(f=>path.resolve(f.file)===path.resolve(destination)))throw Error('Choose an export path that does not replace an RPA source file.');
 const current=await collectExport(item);if(privacy.digest(current.files,JSON.stringify([current.commit,current.name,current.kind,current.version]))!==snapshot.digest)throw Error('RPA files changed after privacy review. Review the updated files again.');
 const {commit,version}=data;const zip=new ZipFile();const checksums=[];
 for(const file of data.files){zip.addBuffer(file.bytes,file.relative,{mode:0o100600});checksums.push({path:file.relative,sha256:crypto.createHash('sha256').update(file.bytes).digest('hex'),bytes:file.bytes.length});}
 zip.addBuffer(Buffer.from(JSON.stringify({format:'vamp-rpa-source-export',version:1,name:data.name,kind:data.kind,rpa_version:version,privacy_review:{scope:'structural-report-only',not_a_privacy_guarantee:true,ai_reviewed:true,user_confirmed:true,snapshot_sha256:snapshot.digest,ai_received_source:false},commit,latest_committed_only:!!commit,requires_matching_vamp_runtime:item.kind==='package'||item.kind==='saved',source_executed:false,files:checksums},null,2)+'\n'),'VAMP_EXPORT.json');
 const temporary=destination+'.'+crypto.randomBytes(8).toString('hex')+'.part';
 try{
  const writing=pipeline(zip.outputStream,createWriteStream(temporary,{flags:'wx',mode:0o600}));
  zip.on('error',error=>zip.outputStream.destroy(error));zip.end();await writing;await fs.rename(temporary,destination);
 }catch(error){await fs.rm(temporary,{force:true});throw error;}
 snapshots.delete(snapshot);
 return {path:destination,files:checksums.length,sha256:crypto.createHash('sha256').update(await fs.readFile(destination)).digest('hex')};
}
async function sourceText(item){const file=item.files.find(f=>/\.(py|robot)$|\.handoff\.json$/i.test(f.file));if(!file)throw Error('Select a Python, Robot or handoff recording.');const text=(await checkedBuffer(item,file)).toString('utf8');if(text.length>64000)throw Error('This recording is too long for one AI request. Split it into a smaller task.');return text;}
module.exports={catalog,preview,prepareExport,approveExport,exportItem,safeFiles,sourceText};
