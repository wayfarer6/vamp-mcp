// AI-free host prerequisite preparation. Only publisher-verified binaries run.
import {ensureClis} from '../vscode-vault-extension/src/downloader.mjs';
const binDir=process.argv[2];
if(!binDir) throw new Error('Provide a host CLI storage directory');
const report=await ensureClis({binDir,tools:['veracrypt'],allowDownload:true,log:message=>console.error(message)});
console.log(JSON.stringify(report));
const result=report.tools.veracrypt;
if(!result.path) process.exitCode=1;
