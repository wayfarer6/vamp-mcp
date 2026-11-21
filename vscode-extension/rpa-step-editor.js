// Runs inside the nonce-protected library webview. Keep all labels and values in DOM properties.
module.exports = function stepEditor(document, onChange) {
  const list = document.getElementById('step-list');
  const rows = [];
  let choices = [];
  function field(parent, label, type, initial) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const input = document.createElement(type === 'select' ? 'select' : 'input');
    if (type !== 'select') input.type = type;
    input.value = initial ?? '';
    input.required = true;
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }
  function option(select, text, value) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = text;
    select.append(node);
  }
  function refs(row, pinned) {
    row.ref.replaceChildren();
    option(row.ref, 'Choose a reviewed step', '');
    for (const choice of choices) option(row.ref, choice.label, JSON.stringify(choice.use));
    if (pinned && !Array.from(row.ref.options).some(o => o.value === pinned)) {
      const use = JSON.parse(pinned);
      option(row.ref, use.step + ' @ ' + use.commit.slice(0, 8), pinned);
    }
    row.ref.value = pinned || '';
  }
  function add(spec = {}) {
    const box = document.createElement('fieldset');
    const name = field(box, 'Step ID', 'text', spec.name);
    name.pattern = '[A-Za-z][A-Za-z0-9_\\-]{0,47}';
    const kind = field(box, 'Actions', 'select');
    option(kind, 'Lines from selected script', 'local');
    option(kind, 'Block between step comments', 'section');
    option(kind, 'Step from a reviewed revision', 'use');
    const local = document.createElement('div'), imported = document.createElement('div');
    box.append(local, imported);
    const first = field(local, 'First source line', 'number', spec.lines?.[0]);
    const last = field(local, 'Last source line', 'number', spec.lines?.[1]);
    first.min = last.min = '1';
    const section = field(local, 'ID in # vamp-step: and # vamp-end:', 'text', spec.section);
    const entry = field(local, 'Visible text before this step', 'text', spec.entry);
    const exit = field(local, 'Visible text after this step', 'text', spec.exit);
    entry.maxLength = exit.maxLength = 240;
    const ref = field(imported, 'Pinned step', 'select');
    const row = {box, name, kind, first, last, section, entry, exit, ref};
    rows.push(row);
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'secondary'; del.textContent = 'Remove step';
    del.onclick = () => { rows.splice(rows.indexOf(row), 1); box.remove(); onChange(); };
    box.append(del);
    refs(row, spec.use && JSON.stringify(spec.use));
    kind.value = spec.use ? 'use' : spec.section ? 'section' : 'local';
    function mode() {
      const use = kind.value === 'use';
      local.hidden = use; imported.hidden = !use;
      for (const input of local.querySelectorAll('input')) input.disabled = use;
      const named = kind.value === 'section';
      for (const input of [first, last]) {
        input.parentElement.hidden = named; input.disabled = use || named;
      }
      section.parentElement.hidden = !named; section.disabled = !named;
      ref.disabled = !use;
    }
    kind.onchange = mode;
    box.oninput = onChange;
    mode(); list.append(box);
    return row;
  }
  document.getElementById('step-add').onclick = () => {add().name.focus(); onChange();};
  return {
    reset(plan) { rows.length = 0; list.replaceChildren(); for (const spec of plan || []) add(spec); },
    options(values) {choices = values; for (const row of rows) refs(row, row.ref.value);},
    read() {return rows.length ? rows.map(r => r.kind.value === 'use'
      ? {name:r.name.value, use:JSON.parse(r.ref.value)}
      : {name:r.name.value, ...(r.kind.value==='section' ? {section:r.section.value} : {lines:[r.first.valueAsNumber,r.last.valueAsNumber]}), entry:r.entry.value, exit:r.exit.value}) : null;}
  };
};
