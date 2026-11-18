const placeholder = /^\$\{vault:([^{}#\x00-\x1f]+)#(username|password|totp)\}$/u;

export function parseVaultPlaceholder(reference) {
  if (typeof reference !== 'string' || reference.length > 1024) return null;
  const normalized = reference.startsWith('{{vault:') && reference.endsWith('}}')
    ? '${' + reference.slice(2, -2) + '}'
    : reference;
  const match = placeholder.exec(normalized);
  if (!match) return null;
  const [, entry, field] = match;
  if (entry.split('/').some(part => !part.trim() || part === '.' || part === '..')) return null;
  return { entry, field };
}

export function checkVaultPlaceholders(references, entries) {
  const counts = new Map();
  for (const { path } of entries) counts.set(path, (counts.get(path) ?? 0) + 1);
  return references.map((reference, index) => {
    const parsed = parseVaultPlaceholder(reference);
    if (!parsed) return { index, status: 'invalid_placeholder' };
    const count = counts.get(parsed.entry) ?? 0;
    return { index, ...parsed, status: count === 0 ? 'placeholder_unresolved' :
      count === 1 ? 'entry_found' : 'placeholder_ambiguous' };
  });
}
