'use strict';
// Pure selection only. No remote probe, credential lookup or fallback.
async function selectVaultDefinition(target, local, remote) {
  if (target === 'local') return local();
  if (target === 'remote') return remote();
  throw new Error('vampVault.mcpTarget must be exactly local or remote');
}
module.exports = { selectVaultDefinition };
