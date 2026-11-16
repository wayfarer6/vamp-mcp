// Use shared source during development and its bundled copy in installed VSIX files.
const fs = require('node:fs');
const path = require('node:path');
const source = path.join(__dirname, '../backends/common/host-backends.cjs');
module.exports = fs.existsSync(source) ? require(source) : require('./dist/host_backends.cjs');
