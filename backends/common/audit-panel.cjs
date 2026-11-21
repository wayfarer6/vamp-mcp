'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const audit = require('./audit.cjs');
function register(context, command, registry) {
  const store = audit.ledger(audit.profileFor(context.globalStorageUri.fsPath));
  const ko = vscode.env.language?.startsWith('ko');
  let panel;
  context.subscriptions.push(
    vscode.commands.registerCommand(command, (filter = {}) => {
      const preset = {
        script_id: typeof filter?.script_id === 'string' ? filter.script_id : '',
        category: audit.categories.includes(filter?.category) ? filter.category : ''
      };
      if (panel) {
        panel.reveal();
        panel.webview.postMessage({ preset });
        return;
      }
      panel = vscode.window.createWebviewPanel(
        command,
        ko ? '감사 기록' : 'Audit log',
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [] }
      );
      const current = panel;
      current.onDidDispose(() => {
        panel = undefined;
      });
      current.webview.onDidReceiveMessage(async (msg) => {
        if (msg?.type === 'ready') {
          await current.webview.postMessage({ preset });
          return;
        }
        if (!msg || !['query', 'details'].includes(msg.type)) return;
        try {
          const options = msg.filters || {};
          const names = await audit.scripts(registry);
          const map = new Map(names.map((s) => [s.id, s.name]));
          const result =
            msg.type === 'details'
              ? store.search(
                  {
                    run_id: options.run_id,
                    before: options.before,
                    snapshot_seq: options.snapshot_seq,
                    limit: 100
                  },
                  true
                )
              : await audit.search(store, { ...options, group_runs: true }, registry);
          const events = result.events.map((e) => ({
            ...e,
            script: map.get(e.script_id) || e.script_id
          }));
          await current.webview.postMessage({
            id: msg.id,
            events,
            names,
            snapshot: result.snapshot_seq,
            next: result.next_before,
            coverage: store.coverage()
          });
        } catch {
          await current.webview.postMessage({
            id: msg.id,
            error: ko
              ? '기간·필터와 감사 저장소 접근 권한을 확인하세요.'
              : 'Check the time range, filters and access to the local audit database.'
          });
        }
      });
      current.webview.html = fs
        .readFileSync(path.join(__dirname, 'audit-panel.html'), 'utf8')
        .replaceAll('%%NONCE%%', randomBytes(18).toString('base64'))
        .replace('%%LANG%%', ko ? 'ko' : 'en');
    })
  );
}
module.exports = { register, audit };
