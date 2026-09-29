#!/usr/bin/env node
'use strict';

// Agent 365 Security PoC demonstrator and tracker.
// Local web server: static site, JSON API, and report downloads.
// Usage: node site/server.cjs [--port 4365] [--host 127.0.0.1] [--data <dir>] [--open]

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const JSZip = require('jszip');
const { buildModel, REPO_ROOT } = require('./lib/model.cjs');
const { Store, HttpError, defaultDataDir } = require('./lib/store.cjs');
const { renderDocx } = require('./lib/report-docx.cjs');
const exportsLib = require('./lib/exports.cjs');
const { preserveScopeDocument, scopeCopyPath, RUNBOOK_PDF } = require('./lib/documents.cjs');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 5 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function parseArgs(argv) {
  const options = { port: Number(process.env.A365_POC_SITE_PORT) || 4365, host: '127.0.0.1', dataDir: undefined, open: false, allowHosts: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`${arg} needs a value.`);
      return argv[++index];
    };
    if (arg === '--port') options.port = Number(next());
    else if (arg === '--host') options.host = next();
    else if (arg === '--data') options.dataDir = next();
    else if (arg === '--allow-host') options.allowHosts.push(next().toLowerCase());
    else if (arg === '--open') options.open = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Use a port from 0 to 65535.');
  return options;
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': payload.length, ...headers });
  res.end(payload);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function attachment(name) {
  const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 150) || 'download';
  return `attachment; filename="${safe}"`;
}

function sendError(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.message });
  } else if (error instanceof SyntaxError) {
    sendJson(res, 400, { error: 'The request body is not valid JSON.' });
  } else {
    console.error(error);
    sendJson(res, 500, { error: 'The server could not complete the request.' });
  }
}

async function readBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Send JSON with Content-Type application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'The request body is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function createServer(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const compute = await import(pathToFileURL(path.join(PUBLIC_DIR, 'js', 'core', 'compute.mjs')).href);
  const reports = await import(pathToFileURL(path.join(PUBLIC_DIR, 'js', 'core', 'report.mjs')).href);
  const model = buildModel({ root: repoRoot });
  const store = new Store({ dataDir: options.dataDir || defaultDataDir(), repoRoot, model, compute });
  const seedFiles = options.seedFiles !== undefined
    ? options.seedFiles
    : [path.join(__dirname, 'seed.local.json'), path.join(__dirname, 'seed.example.json')];
  await store.init({ seedFiles });
  const scopeDocument = await preserveScopeDocument(repoRoot, store.dataDir)
    .catch(error => ({ preserved: false, available: false, note: `The scope document copy failed: ${error.message}` }));
  const documents = () => ({
    scope_docx: fs.existsSync(scopeCopyPath(store.dataDir)),
    runbook_pdf: fs.existsSync(path.join(repoRoot, RUNBOOK_PDF))
  });
  const modelJson = JSON.stringify(model);
  const allowHosts = new Set((options.allowHosts || []).map(host => host.toLowerCase()));

  const hostAllowed = header => {
    const value = String(header || '').toLowerCase();
    const match = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec(value);
    if (!match) return false;
    return LOCAL_HOSTS.has(match[1]) || allowHosts.has(match[1]) || allowHosts.has(value);
  };

  async function reportFor(id, url) {
    const engagement = await store.get(id);
    const type = url.searchParams.get('type') === 'final' ? 'final' : 'progress';
    return {
      engagement,
      report: reports.buildReport(model, engagement, {
        type,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined
      })
    };
  }

  async function api(req, res, url, parts) {
    const method = req.method;
    const mutating = method === 'POST' || method === 'PUT' || method === 'DELETE';
    if (mutating && req.headers['x-a365-site'] !== '1') throw new HttpError(403, 'Missing the site request header.');
    const [, resource, id, sub, subId] = parts;
    const body = mutating && method !== 'DELETE' ? await readBody(req) : undefined;

    if (resource === 'health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, data_dir: store.dataDir, seeded_from: store.seededFrom ? path.basename(store.seededFrom) : null, documents: documents() });
    }
    if (resource === 'model' && method === 'GET') {
      return send(res, 200, modelJson, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    }
    if (resource === 'reference-pack.zip' && method === 'GET') {
      const zip = new JSZip();
      for (const file of exportsLib.referencePackFiles(model)) zip.file(`agent365-poc-reference-pack/${file.path}`, file.content);
      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      return send(res, 200, buffer, { 'Content-Type': 'application/zip', 'Content-Disposition': attachment('Agent365-PoC-reference-pack.zip'), 'Cache-Control': 'no-store' });
    }
    if (resource === 'docs' && method === 'GET' && id === 'scope.docx') {
      const file = scopeCopyPath(store.dataDir);
      if (!fs.existsSync(file)) throw new HttpError(404, 'No scope document is available. Place the customer scope document at docs/Agent-365-Security-PoC.docx and restart the site.');
      return send(res, 200, await fsp.readFile(file), { 'Content-Type': DOCX_TYPE, 'Content-Disposition': attachment('Agent-365-Security-PoC-scope.docx'), 'Cache-Control': 'no-store' });
    }
    if (resource === 'docs' && method === 'GET' && id === 'runbook.pdf') {
      const file = path.join(repoRoot, RUNBOOK_PDF);
      if (!fs.existsSync(file)) throw new HttpError(404, 'The runbook PDF is not built. Run npm run build:docs and tools\\Export-RunbookPdf.ps1.');
      return send(res, 200, await fsp.readFile(file), { 'Content-Type': 'application/pdf', 'Content-Disposition': attachment('Agent-365-Security-PoC-runbook.pdf'), 'Cache-Control': 'no-store' });
    }
    if (resource === 'fixtures' && method === 'GET' && id) {
      const match = /^([a-z-]+)\.(txt|docx|json)$/.exec(id);
      if (!match) throw new HttpError(404, 'Fixture not found.');
      const [, name, extension] = match;
      if (name === 'test-prompts' && extension === 'json') {
        const buffer = await fsp.readFile(path.join(repoRoot, 'fixtures', 'test-prompts.json'));
        return send(res, 200, buffer, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': attachment('test-prompts.json') });
      }
      const fixture = model.fixtures.find(item => item.id === name && item.formats.includes(extension));
      if (!fixture) throw new HttpError(404, 'Fixture not found.');
      if (extension === 'txt') {
        return send(res, 200, fixture.text, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': attachment(`${name}.txt`) });
      }
      const buffer = await exportsLib.fixtureDocx(model, name);
      return send(res, 200, buffer, { 'Content-Type': DOCX_TYPE, 'Content-Disposition': attachment(`${name}.docx`) });
    }
    if (resource === 'queries' && method === 'GET' && id && sub) {
      const query = model.queries.find(item => item.id === `${id}/${String(sub).replace(/\.kql$/, '')}`);
      if (!query) throw new HttpError(404, 'Query not found.');
      return send(res, 200, query.text, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': attachment(path.basename(query.file)) });
    }
    if (resource !== 'engagements') throw new HttpError(404, 'Not found.');

    if (!id) {
      if (method === 'GET') return sendJson(res, 200, await store.list());
      if (method === 'POST') return sendJson(res, 201, await store.create(body || {}));
      throw new HttpError(405, 'Method not allowed.');
    }
    if (id === 'import') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      return sendJson(res, 201, await store.importEngagement(body));
    }
    if (!sub) {
      if (method === 'GET') return sendJson(res, 200, await store.get(id));
      if (method === 'DELETE') return sendJson(res, 200, await store.remove(id));
      throw new HttpError(405, 'Method not allowed.');
    }

    const mutate = change => store.mutate(id, change).then(engagement => sendJson(res, 200, engagement));
    switch (sub) {
      case 'settings':
        if (method === 'PUT') return mutate(engagement => { store.opSettings(engagement, body); });
        break;
      case 'steps':
        if (method === 'PUT' && subId) return mutate(engagement => { store.opStep(engagement, subId, body); });
        if (method === 'POST' && !subId) return mutate(engagement => { store.opSteps(engagement, body.ids, body.status); });
        break;
      case 'cases':
        if (method === 'PUT' && subId) return mutate(engagement => { store.opCase(engagement, subId, body); });
        break;
      case 'notes':
        if (method === 'POST' && !subId) return mutate(engagement => { store.opAddNote(engagement, body); });
        if (method === 'PUT' && subId) return mutate(engagement => { store.opUpdateNote(engagement, subId, body); });
        if (method === 'DELETE' && subId) return mutate(engagement => { store.opDeleteNote(engagement, subId); });
        break;
      case 'inventory':
        if (method === 'POST' && !subId) return mutate(engagement => { store.opAddInventory(engagement, body); });
        if (method === 'PUT' && subId) return mutate(engagement => { store.opInventory(engagement, subId, body); });
        if (method === 'DELETE' && subId) return mutate(engagement => { store.opDeleteInventory(engagement, subId); });
        break;
      case 'measurements':
        if (method === 'PUT' && subId) return mutate(engagement => { store.opMeasurement(engagement, subId, body); });
        break;
      case 'export':
        if (method === 'GET') {
          const engagement = await store.get(id);
          return send(res, 200, `${JSON.stringify(engagement, null, 2)}\n`, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': attachment(`Agent365-PoC-${id}-export-${new Date().toISOString().slice(0, 10)}.json`),
            'Cache-Control': 'no-store'
          });
        }
        break;
      case 'report.md':
        if (method === 'GET') {
          const { report } = await reportFor(id, url);
          return send(res, 200, reports.renderMarkdown(report), { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': attachment(`${report.filename}.md`), 'Cache-Control': 'no-store' });
        }
        break;
      case 'report.docx':
        if (method === 'GET') {
          const { engagement, report } = await reportFor(id, url);
          const buffer = await renderDocx(report, { author: engagement.settings.prepared_by });
          return send(res, 200, buffer, { 'Content-Type': DOCX_TYPE, 'Content-Disposition': attachment(`${report.filename}.docx`), 'Cache-Control': 'no-store' });
        }
        break;
      case 'report.html':
        if (method === 'GET') {
          const { report } = await reportFor(id, url);
          const html = [
            '<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
            `<title>${reports.escapeHtml(report.title)}</title>`,
            '<link rel="stylesheet" href="/css/report.css">', '</head>', '<body class="print-page">',
            '<div class="print-bar"><button type="button" id="print-now">Print or save as PDF</button><span>Use the browser print dialog. Choose Save as PDF to create a PDF.</span></div>',
            reports.renderHtml(report),
            '<script src="/js/print.js"></script>', '</body>', '</html>'
          ].join('\n');
          return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        }
        break;
      case 'poc-plan.json':
        if (method === 'GET') {
          const engagement = await store.get(id);
          const plan = exportsLib.pocPlan(model, engagement, compute);
          return send(res, 200, `${JSON.stringify(plan, null, 2)}\n`, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': attachment(`poc-plan-${id}.json`), 'Cache-Control': 'no-store' });
        }
        break;
      case 'evidence-commands.ps1':
        if (method === 'GET') {
          const engagement = await store.get(id);
          const script = exportsLib.evidenceCommands(model, engagement, compute);
          return send(res, 200, script, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': attachment(`Record-Evidence-${id}.ps1`), 'Cache-Control': 'no-store' });
        }
        break;
      default:
        break;
    }
    throw new HttpError(404, 'Not found.');
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (relative.split('/').some(part => part === '..' || part.startsWith('.')) || relative.includes('\\') || relative.includes('\0')) {
      throw new HttpError(404, 'Not found.');
    }
    const file = path.join(PUBLIC_DIR, relative);
    const resolved = await fsp.realpath(file).catch(() => null);
    const root = await fsp.realpath(PUBLIC_DIR);
    if (!resolved || !resolved.startsWith(root + path.sep) || !(await fsp.stat(resolved)).isFile()) {
      throw new HttpError(404, 'Not found.');
    }
    const type = MIME[path.extname(resolved).toLowerCase()];
    if (!type) throw new HttpError(404, 'Not found.');
    const buffer = await fsp.readFile(resolved);
    return send(res, 200, req.method === 'HEAD' ? Buffer.alloc(0) : buffer, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  }

  const server = http.createServer((req, res) => {
    (async () => {
      if (!hostAllowed(req.headers.host)) throw new HttpError(403, 'This host name is not allowed.');
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        throw new HttpError(400, 'Invalid URL.');
      }
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new HttpError(400, 'Invalid URL encoding.');
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const parts = pathname.split('/').filter(Boolean);
        return api(req, res, url, parts);
      }
      return serveStatic(req, res, pathname);
    })().catch(error => sendError(res, error));
  });
  server.requestTimeout = 60000;
  return { server, store, model, scopeDocument };
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

// Returns the health record when a PoC site already answers on the local port, otherwise null.
function probeSite(port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) request.destroy();
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(response.statusCode === 200 && body && body.ok === true && typeof body.data_dir === 'string' ? body : null);
        } catch {
          resolve(null);
        }
      });
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('Usage: node site/server.cjs [--port 4365] [--host 127.0.0.1] [--data <dir>] [--allow-host <name>] [--open]');
    console.log('The data directory defaults to %USERPROFILE%\\Agent365-PoC-Site or A365_POC_SITE_DATA.');
    return;
  }
  const { server, store, model, scopeDocument } = await createServer({ dataDir: options.dataDir, allowHosts: options.allowHosts });
  server.on('error', async error => {
    if (error.code === 'EADDRINUSE') {
      const running = await probeSite(options.port);
      if (running) {
        const url = `http://127.0.0.1:${options.port}/`;
        console.log(`The Agent 365 PoC site is already running: ${url}`);
        if (path.resolve(running.data_dir) !== path.resolve(store.dataDir)) console.log(`It uses the data directory ${running.data_dir}.`);
        if (options.open) openBrowser(url);
        return;
      }
      console.error(`Port ${options.port} is in use by another program. Start with --port <number>.`);
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  });
  server.listen(options.port, options.host, () => {
    const address = server.address();
    const host = options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host.includes(':') ? `[${options.host}]` : options.host;
    const url = `http://${host}:${address.port}/`;
    console.log(`Agent 365 PoC site: ${url}`);
    console.log(`Data directory: ${store.dataDir}`);
    if (store.seededFrom) console.log(`Created engagements from ${path.basename(store.seededFrom)}.`);
    if (scopeDocument.preserved) console.log(`Kept a copy of the customer scope document in ${path.dirname(scopeDocument.path)}.`);
    if (scopeDocument.note) console.log(scopeDocument.note);
    console.log(`Model: ${model.totals.guides} guides, ${model.totals.steps.all} steps (${model.totals.steps.live} live), ${model.totals.cases.all} use cases (${model.totals.cases.live} live-proofed).`);
    console.log('Press Ctrl+C to stop.');
    if (options.open) openBrowser(url);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createServer, parseArgs, probeSite };
