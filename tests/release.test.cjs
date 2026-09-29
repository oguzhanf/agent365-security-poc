'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const JSZip = require('jszip');

async function fixture(run) {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'a365-release-test-'));
  const root = path.join(holder, 'source');
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '..', 'tools', 'package-release.cjs'), path.join(root, 'tools', 'package-release.cjs'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = () => {
    git('add', '--all');
    git('commit', '--quiet', '-m', 'Create synthetic release fixture', '-m',
      'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>');
  };
  try {
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.name', 'Synthetic test');
    git('config', 'user.email', 'synthetic@example.invalid');
    git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt text eol=lf\n');
    fs.writeFileSync(path.join(root, 'sample.txt'), 'Synthetic line.\r\nSecond line.\r\n');
    commit();
    await run({ holder, root, git, commit });
  } finally {
    fs.rmSync(holder, { recursive: true, force: true });
  }
}

const invoke = (root, output) => spawnSync(process.execPath, ['tools\\package-release.cjs', output], {
  cwd: root, encoding: 'utf8',
  env: { ...process.env, NODE_PATH: path.resolve(__dirname, '..', 'node_modules') }
});

test('release hashes match archive bytes after Git line-ending conversion', async () => {
  await fixture(async ({ holder, root, git, commit }) => {
    git('config', 'core.autocrlf', 'true');
    fs.writeFileSync(path.join(root, '.gitattributes'), '* text=auto\n*.txt text eol=crlf\n');
    commit();
    const output = path.join(holder, 'release.zip');
    const result = invoke(root, output);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(fs.readFileSync(`${output}.manifest.json`, 'utf8'));
    const entry = manifest.files.find(file => file.path === 'sample.txt');
    const archive = await JSZip.loadAsync(fs.readFileSync(output));
    const archived = await archive.file('agent365-security-poc/sample.txt').async('nodebuffer');
    assert.notDeepEqual(archived, Buffer.from(git('show', 'HEAD:sample.txt')));
    assert.equal(entry.sha256, crypto.createHash('sha256').update(archived).digest('hex'));
    assert.equal(entry.bytes, archived.length);
    assert.equal(manifest.live_product_results_included, false);
    assert.equal(manifest.archive_sha256, crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'));
  });
});

test('release refuses an existing output and a destination inside the repository', async () => {
  await fixture(({ holder, root }) => {
    assert.notEqual(invoke(root, path.join(root, 'release.zip')).status, 0);
    const output = path.join(holder, 'release.zip');
    fs.writeFileSync(output, 'Existing file.');
    assert.notEqual(invoke(root, output).status, 0);
    assert.equal(fs.readFileSync(output, 'utf8'), 'Existing file.');
  });
});

test('release refuses uncommitted files', async () => {
  await fixture(({ holder, root }) => {
    fs.writeFileSync(path.join(root, 'new.txt'), 'Uncommitted file.');
    const output = path.join(holder, 'release.zip');
    assert.notEqual(invoke(root, output).status, 0);
    assert.equal(fs.existsSync(output), false);
  });
});

test('release refuses tracked credentials and evidence', async () => {
  await fixture(({ holder, root, commit }) => {
    fs.writeFileSync(path.join(root, '.env'), 'SYNTHETIC_TEST=true\n');
    commit();
    assert.notEqual(invoke(root, path.join(holder, 'credentials.zip')).status, 0);
    fs.unlinkSync(path.join(root, '.env'));
    fs.mkdirSync(path.join(root, 'evidence'));
    fs.writeFileSync(path.join(root, 'evidence', 'synthetic.txt'), 'Synthetic evidence.');
    commit();
    assert.notEqual(invoke(root, path.join(holder, 'evidence.zip')).status, 0);
  });
});
