'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const cancel = Symbol('cancelled');
async function field(title, value = '', validateInput) {
  const answer = await vscode.window.showInputBox({
    title,
    value,
    validateInput,
    ignoreFocusOut: true
  });
  if (answer === undefined) throw cancel;
  return answer;
}
async function pick(title, options) {
  const chosen = await vscode.window.showQuickPick(options, { title, ignoreFocusOut: true });
  if (!chosen) throw cancel;
  return chosen;
}
async function file(title) {
  const result = await vscode.window.showOpenDialog({ title, canSelectMany: false });
  if (!result?.length) throw cancel;
  return result[0].fsPath;
}
async function textFile(name) {
  const stat = await fs.lstat(name);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
    throw Error('Select a regular file under 2 MB.');
  return (await fs.readFile(name, 'utf8')).replace(/^\uFEFF/, '');
}
async function confirm(title, detail, label) {
  if ((await vscode.window.showWarningMessage(title, { modal: true, detail }, label)) !== label)
    throw cancel;
}
async function inspect(text) {
  const doc = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
  await vscode.window.showTextDocument(doc, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside
  });
}
function ui(context, registry) {
  const { catalog, runs } = require('./dist/cli_library.cjs');
  const repo = catalog(registry),
    service = runs(repo);
  async function install(p) {
    let existing = await repo.snapshot(p.id);
    if (existing)
      await confirm(
        'Import a revision of ' + existing.pkg.name + '?',
        Object.keys({ ...existing.pkg.files, ...p.files })
          .filter((k) => existing.pkg.files[k] !== p.files[k])
          .join('\n') || 'Review the workflow metadata.',
        'Import revision'
      );
    return repo.install(p, existing?.revision);
  }
  async function create() {
    const method = await pick('CLI workflow', [
      'Create from source files',
      'Create with AI',
      'Import a shared workflow'
    ]);
    if (method === 'Import a shared workflow')
      return install(JSON.parse(await textFile(await file('Open exported CLI workflow JSON'))));
    const runner = await pick('Prepared guest runtime', ['python', 'playwright']);
    const files = {};
    const entry = runner === 'python' ? 'main.py' : 'main.cjs';
    files[entry] = await textFile(await file('Choose the entry script for ' + entry));
    const lock = runner === 'python' ? 'requirements.lock' : 'package-lock.json';
    files[lock] = await textFile(await file('Choose ' + lock + ' for the prepared runtime image'));
    if (
      (await pick('Result verification', [
        'Include verify.py',
        'Record completion without verification'
      ])) === 'Include verify.py'
    )
      files['verify.py'] = await textFile(await file('Select the independent artifact verifier'));
    let meta = {};
    if (method === 'Create with AI') {
      meta = await require('./rpa-author').createMetadata(
        { name: 'CLI workflow', kind: 'cli', runner },
        files[entry],
        context
      );
      if (!meta) throw cancel;
    }
    const name = await field('Workflow name', meta.title),
      description = await field('Description', meta.description);
    const inputs = (
      await field('Declared input names, separated by commas', (meta.inputs || []).join(','))
    )
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    return install({
      id: randomUUID(),
      format: 'vamp-cli-workflow',
      name,
      description,
      when_to_use: await field('When to use', meta.when_to_use),
      expected_result: await field('Expected result', meta.expected_result),
      inputs,
      runner,
      tags: meta.tags || [],
      files,
      output_input: (await field('Input containing the output filename (optional)')) || null
    });
  }
  async function bind() {
    const b = {
      id: await field('Workspace name'),
      backend: await pick('Virtualization platform', ['virtualbox', 'kvm', 'hyperv']),
      vm_id: (await field('Exact VM UUID')).toLowerCase(),
      host: await field('Guest SSH hostname or IP'),
      port: Number(await field('Guest SSH port', '22')),
      user: await field('Non-root guest worker account'),
      identity: await file('Select the workspace SSH identity'),
      known_hosts: await file('Select a verified known_hosts file'),
      image: await field('Prepared guest image ID (sha256:…)')
    };
    await confirm(
      'Bind this workspace?',
      b.backend + ' · ' + b.vm_id + '\n' + b.user + '@' + b.host + ':' + b.port + '\n' + b.image,
      'Bind workspace'
    );
    await repo.bind(b);
    return b;
  }
  async function chooseBinding() {
    const choices = (await repo.workspaces()).map((b) => ({
      label: b.id,
      description: b.backend + ' · ' + b.vm_id,
      b
    }));
    const choice = await pick('Execution workspace', [
      ...choices,
      { label: 'Configure a VM workspace…' }
    ]);
    return choice.b || bind();
  }
  async function exportPackage(s) {
    const privacy = require('./rpa-privacy');
    const { files, ...meta } = s.pkg;
    const material = [
      { relative: 'metadata.json', bytes: Buffer.from(JSON.stringify(meta)) },
      ...Object.entries(files).map(([relative, body]) => ({ relative, bytes: Buffer.from(body) }))
    ];
    if (
      !(await require('./rpa-export-review').reviewExport({ summary: privacy.summarize(material) }))
    )
      return;
    const uri = await vscode.window.showSaveDialog({
      saveLabel: 'Export reviewed CLI package',
      filters: { Workflow: ['json'] }
    });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(s.pkg, null, 2)));
  }
  async function action(which, item) {
    try {
      if (which === 'cliCreate') {
        await create();
        return 'CLI workflow saved. Review it for a workspace before execution.';
      }
      if (which === 'cliBind') {
        await bind();
        return 'Workspace configured.';
      }
      if (item?.kind !== 'cli') throw Error('Select a saved CLI workflow.');
      const s = await repo.snapshot(item.manifest.id);
      if (!s || s.revision !== item.manifest.revision)
        throw Error('Revision changed. Refresh the library.');
      if (which === 'cliExport') {
        await exportPackage(s);
        return;
      }
      if (which === 'cliHistory') {
        const dir = path.join(repo.state, 'runs');
        const ids = await fs.readdir(dir).catch((e) => {
          if (e.code === 'ENOENT') return [];
          throw e;
        });
        const entries = [];
        for (const id of ids) {
          const r = await service.status(id);
          if (r.id === s.pkg.id)
            entries.push({ label: r.status + ' · ' + id, description: r.workspace_id, r });
        }
        if (!entries.length) return 'No runs for this workflow.';
        const selected = await pick('Run history', entries);
        await inspect(JSON.stringify(selected.r, null, 2));
        if (
          selected.r.artifacts?.length &&
          (await vscode.window.showInformationMessage(
            'Show this run’s outputs?',
            'Open folder'
          )) === 'Open folder'
        )
          await vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(path.join(dir, selected.r.run_id, 'outputs'))
          );
        return;
      }
      const b = await chooseBinding();
      if (which === 'cliReview') {
        const lines = Object.entries(s.pkg.files).map(
          ([name, body]) => '--- ' + name + ' ---\n' + body
        );
        await inspect([s.pkg.name, s.pkg.expected_result, ...lines].join('\n\n'));
        await confirm(
          'Approve this exact version for ' + b.id + '?',
          s.revision + '\n' + b.backend + ' · ' + b.vm_id + '\n' + b.image,
          'Approve reviewed version'
        );
        await repo.approve(s.pkg.id, s.revision, b.id);
        return 'Version approved for ' + b.id;
      }
      if (which !== 'cliRun') throw Error('Unknown action');
      const inputs = Object.create(null);
      for (const name of s.pkg.inputs) {
        inputs[name] = await field(name, '', (value) => {
          if (value.length > 10000) return 'Enter up to 10,000 characters.';
          if (name === s.pkg.output_input && !require('./dist/cli_library.cjs').leaf(value))
            return 'Enter one filename using letters, numbers, periods, underscores or hyphens.';
        });
      }
      const request = { id: s.pkg.id, expected_revision: s.revision, workspace_id: b.id, inputs };
      const preview = await service.start(request);
      await confirm(
        'Run ' + s.pkg.name + ' in ' + b.id + '?',
        JSON.stringify({ ...preview, inputs }, null, 2),
        'Run workflow'
      );
      const r = await service.start({
        ...request,
        mode: 'run',
        confirmed: true,
        request_id: randomUUID()
      });
      return (
        'Run ' + r.run_id + ' · ' + r.status + '. Open Run history for verification and outputs.'
      );
    } catch (e) {
      if (e === cancel) return;
      throw e;
    }
  }
  return { action, repo };
}
module.exports = { ui };
