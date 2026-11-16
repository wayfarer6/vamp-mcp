// Local-only inspection. Never return source, filenames or matched values to an AI.
const crypto=require('node:crypto');
const textTypes=new Set(['.py','.robot','.resource','.md','.json','.txt','.yaml','.yml','.toml']);
const rules=[
 ['email',/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
 ['credential-assignment',/(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|username|user_id|login_id|client_secret|비밀번호|아이디)\s*["']?\s*[:=]\s*["']?(\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^\s"',;}]+)/gi],
 ['private-key',/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g],
 ['access-token',/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,})\b/g],
 ['url-userinfo',/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi],
];
function placeholder(value){return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim());}
function inspectText(text,extension='.py'){
 const findings=[];
 function add(kind,index){if(findings.length>=500)return;const line=text.slice(0,index).split('\n').length;if(!findings.some(f=>f.kind===kind&&f.line===line))findings.push({kind,line});}
 for(const [kind,pattern] of rules){pattern.lastIndex=0;let match;while(findings.length<500&&(match=pattern.exec(text))){if(kind==='credential-assignment'&&placeholder(match[1]))continue;add(kind,match.index);}}
 // Every literal text-input value is private until replaced with a declared input.
 const writes=/(?:\b(?:write|typewrite|write_text|type_text|send_text)\s*\(\s*|\b(?:TEXT|text)\s*["']?\s*[:=]\s*)["']([^"'\r\n]*)["']/g;
 let match;while(findings.length<500&&(match=writes.exec(text))){const value=match[1];if(value&&!placeholder(value)&&!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}(?:\s*\$\{[A-Za-z_][A-Za-z0-9_]*\})*$/.test(value))add('literal-typed-text',match.index);}
 const guiCalls=/\b(?:pyautogui|keyboard)\s*\.\s*(?:write|typewrite)\s*\(\s*([^\r\n)]*)/g;
 while(findings.length<500&&(match=guiCalls.exec(text))){
  const arg=match[1].trim();
  if(!/^["']\$\{[A-Za-z_][A-Za-z0-9_]*\}["']\s*(?:,|$)/.test(arg)&&!(/^["']["']\s*(?:,|$)/.test(arg)))add('unparameterized-typed-text',match.index);
 }
 if(extension==='.robot')for(const [index,line] of text.split('\n').entries()){
  const parts=line.trim().split(/\s{2,}|\t+/);const command=parts.findIndex(value=>/^(?:Input Text|Input Password|Type Text|Write Text)$/i.test(value));
  if(command>=0&&!placeholder(parts.at(-1)||''))findings.push({kind:'literal-typed-text',line:index+1});
 }
 return {lines:text.split('\n').length,findings};
}
function summarize(files){
 const report={format:'vamp-private-export-review',version:1,file_count:files.length,text_file_count:0,binary_file_count:0,line_count:0,files:[],findings:[],limitations:['No source, names, paths, recorded values or metadata content is sent to AI.','Pattern checks cannot identify every secret. User must inspect every file and image before upload.']};
 for(const [index,file] of files.entries()){
  const type=require('node:path').extname(file.relative).toLowerCase();
  const text=textTypes.has(type)&&!file.bytes.includes(0);
  const result=text?inspectText(file.bytes.toString('utf8'),type):{lines:0,findings:[]};
  report.text_file_count+=Number(text);report.binary_file_count+=Number(!text);report.line_count+=result.lines;
  report.files.push({file:index+1,type:textTypes.has(type)?type:'binary',lines:result.lines,requires_manual_visual_review:!text});
  report.findings.push(...result.findings.map(f=>({file:index+1,...f})));
 }
 return report;
}
function digest(files,commit=''){const hash=crypto.createHash('sha256');hash.update(commit);for(const f of files){hash.update(JSON.stringify([f.relative,f.bytes.length]));hash.update(f.bytes);}return hash.digest('hex');}
module.exports={inspectText,summarize,digest};
