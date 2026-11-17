// Shared guest bootstrap: VSIX and MCP use the same administrator/UAC plan.
const fs=require('node:fs');
const path=require('node:path');
const source=path.join(__dirname,'../backends/common/guest-bootstrap.cjs');
module.exports=fs.existsSync(source)?require(source):require('./dist/guest_bootstrap.cjs');
