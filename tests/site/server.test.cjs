'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const JSZip = require('jszip');
const { createServer, probeSite } = require('../../site/server.cjs');

async function withServer(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a365-site-server-'));
  const { server } = await createServer({ dataDir, seedFiles: [] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-a365-site': '1', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') || '';
    return { status: response.status, headers: response.headers, buffer, json: type.startsWith('application/json') ? JSON.parse(buffer.toString('utf8')) : null, text: buffer.toString('utf8') };
  };
  const rawGet = (url, host) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: url, headers: { host } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end();
  });
  try {
    await run({ call, rawGet });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('the server protects the local API', async () => {
  await withServer(async ({ call, rawGet }) => {
    assert.equal(await rawGet('/api/health', 'attacker.example'), 403);
    assert.equal(await rawGet('/api/health', 'localhost:4365'), 200);
    const created = await call('POST', '/api/engagements', { settings: { name: 'Contoso' } });
    assert.equal(created.status, 201);
    const noCsrf = await call('PUT', '/api/engagements/contoso/steps/G01.1.01', { status: 'done' }, { 'x-a365-site': '' });
    assert.equal(noCsrf.status, 403);
    const wrongType = await call('PUT', '/api/engagements/contoso/steps/G01.1.01', { status: 'done' }, { 'content-type': 'text/plain' });
    assert.equal(wrongType.status, 415);
    const traversal = await call('GET', '/..%2f..%2fpackage.json');
    assert.equal(traversal.status, 404);
    const hidden = await call('GET', '/.git/config');
    assert.equal(hidden.status, 404);
    const index = await call('GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await call('GET', '/api/engagements/Bad_ID')).status, 404);
    assert.equal((await call('GET', '/api/nothing')).status, 404);
  });
});

test('the API tracks progress and produces reports and exports', async () => {
  await withServer(async ({ call }) => {
    const model = (await call('GET', '/api/model')).json;
    assert.equal(model.guides.length, 45);
    const created = (await call('POST', '/api/engagements', { preset: 'evaluation', settings: { name: 'Contoso eval', customer: 'Contoso', start_date: '2026-09-29', evidence_location: 'C:\\Evidence\\run-01' } })).json;
    const id = created.id;
    assert.equal((await call('PUT', `/api/engagements/${id}/steps/G01.1.01`, { status: 'done' })).status, 200);
    assert.equal((await call('POST', `/api/engagements/${id}/steps`, { ids: ['G01.1.02', 'G01.1.03'], status: 'done' })).json.steps['G01.1.03'].status, 'done');
    assert.equal((await call('PUT', `/api/engagements/${id}/steps/G01.1.04`, { status: 'nope' })).status, 400);
    await call('PUT', `/api/engagements/${id}/cases/ONB-01`, { phases: { positive: { result: 'PASS' }, negative: { result: 'PASS' } }, agent: 'CPS-01', evidence_refs: ['onb-01\\positive.png', 'C:\\abs\\bad.png'], correlation_id: 'trace-01', customer_summary: 'Verified.' });
    await call('PUT', `/api/engagements/${id}/cases/ONB-04`, { phases: { positive: { result: 'PASS' } } });
    await call('PUT', `/api/engagements/${id}/cases/ONB-08`, { phases: { positive: { result: 'BLOCKED', reason: 'Selector not reachable.' } } });
    await call('PUT', `/api/engagements/${id}/cases/ONB-02`, { exclusion: { reason: 'Follow-up phase.', approved_by: 'reviewer', approved_date: '2026-10-01' } });
    await call('POST', `/api/engagements/${id}/notes`, { title: 'Kickoff', category: 'meeting', shareable: true, body: 'Agreed scope.' });
    await call('PUT', `/api/engagements/${id}/inventory/INV-AGENT-CPS01`, { status: 'created' });
    await call('PUT', `/api/engagements/${id}/measurements/discovery_minutes`, { target_minutes: 30 });

    const markdown = await call('GET', `/api/engagements/${id}/report.md?type=progress&from=2026-09-29&to=2030-01-01`);
    assert.equal(markdown.status, 200);
    assert.match(markdown.headers.get('content-disposition'), /attachment; filename="Agent365-PoC-contoso-progress-report-/);
    assert.match(markdown.text, /## Live-proofed use cases/);
    assert.match(markdown.text, /Kickoff/);
    assert.match(markdown.text, /Selector not reachable\./);

    for (const type of ['progress', 'final']) {
      const docx = await call('GET', `/api/engagements/${id}/report.docx?type=${type}`);
      assert.equal(docx.status, 200);
      const zip = await JSZip.loadAsync(docx.buffer);
      const xml = await zip.file('word/document.xml').async('string');
      assert.match(xml, type === 'final' ? /Final report/ : /Progress report/);
      assert.match(xml, /Verified\./);
    }
    const html = await call('GET', `/api/engagements/${id}/report.html?type=final`);
    assert.match(html.text, /<article class="report">/);
    assert.match(html.text, /src="\/js\/print\.js"/);

    const plan = (await call('GET', `/api/engagements/${id}/poc-plan.json`)).json;
    assert.equal(plan.agents.find(agent => agent.alias === 'CPS-01').state, 'PROVISIONED');
    assert.equal(plan.agents.find(agent => agent.alias === 'EXT-01').poc_scope, 'DEMONSTRATION_ONLY');
    assert.equal(plan.data.evidence_location, 'C:\\Evidence\\run-01');
    assert.equal(plan.acceptance.targets.discovery_minutes, 30);
    assert.deepEqual(plan.acceptance.agreed_scope.approved_exclusions, ['ONB-02']);

    const script = (await call('GET', `/api/engagements/${id}/evidence-commands.ps1`)).text;
    assert.match(script, /--scenario 'ONB-01' --agent 'CPS-01' --phase positive --result PASS/);
    assert.match(script, /--artifact 'onb-01\\positive\.png'/);
    assert.match(script, /Skipped artifact .*C:\\abs\\bad\.png/);
    assert.match(script, /# PASS needs at least one artifact[\s\S]*# python -m poc_evidence record .*'ONB-04'/);
    assert.match(script, /--scenario 'ONB-02' --exclude --reason 'Follow-up phase\.' --approved-by 'reviewer' --approved-date 2026-10-01/);
    if (process.platform === 'win32') {
      const parse = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$t,[ref]$e);$e.Count'], { input: script, encoding: 'utf8' });
      if (parse.status === 0) assert.equal(parse.stdout.trim(), '0', 'the evidence script parses as PowerShell');
    }

    const exported = await call('GET', `/api/engagements/${id}/export`);
    const imported = await call('POST', '/api/engagements/import', exported.json);
    assert.equal(imported.status, 201);
    assert.notEqual(imported.json.id, id);
    const list = (await call('GET', '/api/engagements')).json;
    assert.equal(list.length, 2);
    assert.equal((await call('DELETE', `/api/engagements/${imported.json.id}`)).status, 200);
    assert.equal((await call('GET', '/api/engagements')).json.length, 1);
  });
});

test('a second start detects a running site and ignores other programs', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a365-site-probe-'));
  const { server } = await createServer({ dataDir, seedFiles: [] });
  const other = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"up"}'); });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
    const running = await probeSite(server.address().port);
    assert.equal(running.ok, true);
    assert.equal(path.resolve(running.data_dir), path.resolve(dataDir));
    assert.equal(await probeSite(other.address().port), null);
    const closedPort = other.address().port;
    await new Promise(resolve => other.close(resolve));
    assert.equal(await probeSite(closedPort, 500), null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (other.listening) await new Promise(resolve => other.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the scope document copy survives a document build', async () => {
  const { preserveScopeDocument, isGeneratedRunbook, GENERATED_MARKER } = require('../../site/lib/documents.cjs');
  const { Document, Packer, Paragraph } = require('docx');
  const docx = async description => Packer.toBuffer(new Document({ description, sections: [{ children: [new Paragraph('Synthetic content.')] }] }));
  const generated = await docx(GENERATED_MARKER);
  const scopeV1 = await docx('Customer scope document revision 1.1');
  assert.equal(await isGeneratedRunbook(generated), true);
  assert.equal(await isGeneratedRunbook(scopeV1), false);
  assert.equal(await isGeneratedRunbook(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), false, 'a protected compound file is kept');
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'a365-site-docs-'));
  try {
    const repo = path.join(holder, 'repo');
    const data = path.join(holder, 'data');
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    const source = path.join(repo, 'docs', 'Agent-365-Security-PoC.docx');
    assert.equal((await preserveScopeDocument(repo, data)).available, false);
    fs.writeFileSync(source, scopeV1);
    const first = await preserveScopeDocument(repo, data);
    assert.equal(first.preserved, true);
    assert.deepEqual(fs.readFileSync(first.path), scopeV1);
    fs.writeFileSync(source, generated);
    const afterBuild = await preserveScopeDocument(repo, data);
    assert.equal(afterBuild.preserved, false);
    assert.match(afterBuild.note, /generated runbook/);
    assert.deepEqual(fs.readFileSync(first.path), scopeV1, 'the build did not replace the preserved copy');
    const scopeV2 = await docx('Customer scope document revision 1.2');
    fs.writeFileSync(source, scopeV2);
    assert.equal((await preserveScopeDocument(repo, data)).preserved, true);
    assert.deepEqual(fs.readFileSync(first.path), scopeV2);
    assert.equal(fs.readdirSync(path.join(data, 'documents')).filter(name => /^scope-document-.+\.docx$/.test(name)).length, 1, 'the previous copy is kept');
  } finally {
    fs.rmSync(holder, { recursive: true, force: true });
  }
});

test('downloads include the reference pack, fixtures, and queries', async () => {
  await withServer(async ({ call }) => {
    const pack = await call('GET', '/api/reference-pack.zip');
    assert.equal(pack.status, 200);
    const zip = await JSZip.loadAsync(pack.buffer);
    const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
    assert.ok(names.includes('agent365-poc-reference-pack/INDEX.md'));
    assert.ok(names.includes('agent365-poc-reference-pack/TABLES.md'));
    assert.equal(names.filter(name => name.includes('/guides/')).length, 45);
    assert.equal(names.filter(name => name.includes('/test-procedures/')).length, 67);
    assert.ok(names.includes('agent365-poc-reference-pack/test-procedures/ONB-01_onboard-an-authenticated-copilot-studio-agent.md'));
    assert.ok(names.some(name => /guides\/01_GUIDE_agent-365-and-security-prerequisites\.md$/.test(name)));
    const docx = await call('GET', '/api/fixtures/restricted-record.docx');
    const fixture = await JSZip.loadAsync(docx.buffer);
    assert.match(await fixture.file('word/document.xml').async('string'), /POC-RESTRICTED-4826/);
    assert.match((await call('GET', '/api/fixtures/public-procedure.txt')).text, /POC-APPROVAL-6142/);
    assert.equal((await call('GET', '/api/fixtures/untrusted-instruction.docx')).status, 404);
    assert.equal((await call('GET', '/api/fixtures/..%2fpackage.json')).status, 404);
    assert.match((await call('GET', '/api/queries/defender/local-agent-inventory.kql')).text, /\S/);
    const health = (await call('GET', '/api/health')).json;
    for (const [name, url] of [['runbook_pdf', '/api/docs/runbook.pdf'], ['scope_docx', '/api/docs/scope.docx']]) {
      assert.equal((await call('GET', url)).status, health.documents[name] ? 200 : 404, name);
    }
  });
});
