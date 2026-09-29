'use strict';

// Keeps a copy of the customer scope document outside the repository.
// docs/Agent-365-Security-PoC.docx can hold the customer scope document or the runbook
// that npm run build:docs generates. Only a file that is not the generated runbook is
// preserved, so a document build never replaces the scope document that the site serves.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');

const SCOPE_SOURCE = 'docs/Agent-365-Security-PoC.docx';
const RUNBOOK_PDF = 'docs/Agent-365-Security-PoC.pdf';
// tools/build-document.cjs writes this description into the generated runbook.
const GENERATED_MARKER = 'Procedures, control boundaries, and evidence requirements.';

async function isGeneratedRunbook(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  try {
    const zip = await JSZip.loadAsync(buffer);
    const core = zip.file('docProps/core.xml');
    return Boolean(core) && (await core.async('string')).includes(GENERATED_MARKER);
  } catch {
    return false;
  }
}

function scopeCopyPath(dataDir) {
  return path.join(dataDir, 'documents', 'scope-document.docx');
}

async function preserveScopeDocument(repoRoot, dataDir) {
  const source = path.join(repoRoot, SCOPE_SOURCE);
  const target = scopeCopyPath(dataDir);
  const result = { preserved: false, available: fs.existsSync(target), path: target, note: '' };
  if (!fs.existsSync(source)) return result;
  const buffer = await fsp.readFile(source);
  if (await isGeneratedRunbook(buffer)) {
    result.note = `${SCOPE_SOURCE} is the generated runbook. The site keeps serving the preserved scope document.`;
    return result;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    const current = await fsp.readFile(target);
    if (current.equals(buffer)) return { ...result, available: true };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.copyFile(target, path.join(path.dirname(target), `scope-document-${stamp}.docx`));
  }
  await fsp.writeFile(target, buffer);
  return { ...result, preserved: true, available: true };
}

module.exports = { preserveScopeDocument, isGeneratedRunbook, scopeCopyPath, SCOPE_SOURCE, RUNBOOK_PDF, GENERATED_MARKER };
