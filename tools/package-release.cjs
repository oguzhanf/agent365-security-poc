'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const JSZip = require('jszip');

async function main() {
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('Usage: node tools\\package-release.cjs ABSOLUTE_OUTPUT_ZIP');
  process.exitCode = 2;
} else {
  const supplied = args[0];
  if (!path.isAbsolute(supplied)) throw new Error('Use an absolute output path.');
  const output = path.resolve(supplied);
  const relative = path.relative(root, output);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error('Store the package outside the source repository.');
  }
  if (path.extname(output).toLowerCase() !== '.zip') throw new Error('Use a ZIP output filename.');
  if (fs.existsSync(output) || fs.existsSync(`${output}.manifest.json`)) {
    throw new Error('The package or manifest already exists. Select a new filename.');
  }
  const git = (...values) => execFileSync('git', values, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (git('status', '--porcelain').trim()) throw new Error('Commit the approved source before packaging.');
  const revision = git('rev-parse', 'HEAD').trim();
  const files = git('ls-files', '-z').split('\0').filter(Boolean).sort();
  for (const file of files) {
    const segments = file.split('/');
    if (segments.some(segment => /^(node_modules|\.git|\.azure|\.a365|\.venv.*|__pycache__|evidence|results|logs)$/.test(segment))
        && !file.startsWith('tests/')) {
      throw new Error(`Remove the non-release file: ${file}`);
    }
    if (/(^|\/)\.env($|\.)|a365.*config.*\.json$|\.(pem|pfx|p12|key)$/i.test(file)) {
      throw new Error(`Remove the local configuration or credential file: ${file}`);
    }
    const absolute = path.join(root, file);
    if (!fs.lstatSync(absolute).isFile()) throw new Error(`Release entries must be regular files: ${file}`);
  }
  git('archive', '--format=zip', '--prefix=agent365-security-poc/', `--output=${output}`, 'HEAD');
  const archive = fs.readFileSync(output);
  const zip = await JSZip.loadAsync(archive);
  const entries = [];
  for (const file of files) {
    const member = zip.file(`agent365-security-poc/${file}`);
    if (!member) throw new Error(`The archive omitted a tracked file: ${file}`);
    const content = await member.async('nodebuffer');
    entries.push({ path: file, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  const manifest = {
    name: 'agent365-security-poc',
    revision,
    source_as_of: '2026-09-18',
    live_product_results_included: false,
    archive_sha256: crypto.createHash('sha256').update(archive).digest('hex'),
    files: entries
  };
  fs.writeFileSync(`${output}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ output, revision, files: files.length, sha256: manifest.archive_sha256 }, null, 2));
}
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
