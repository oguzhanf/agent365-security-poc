'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { buildModel, REPO_ROOT } = require('../../site/lib/model.cjs');
const { Store } = require('../../site/lib/store.cjs');

const model = buildModel();
const loadCompute = () => import(pathToFileURL(path.join(REPO_ROOT, 'site', 'public', 'js', 'core', 'compute.mjs')).href);

async function withStore(run, { seed } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a365-site-store-'));
  try {
    const compute = await loadCompute();
    const store = new Store({ dataDir, repoRoot: REPO_ROOT, model, compute });
    const seedFiles = [];
    if (seed) {
      const seedFile = path.join(dataDir, '..', `${path.basename(dataDir)}-seed.json`);
      fs.writeFileSync(seedFile, JSON.stringify(seed));
      seedFiles.push(seedFile);
    }
    await store.init({ seedFiles });
    await run(store, dataDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(`${dataDir}-seed.json`, { force: true });
  }
}

test('the store refuses a data directory inside the repository', async () => {
  const compute = await loadCompute();
  const store = new Store({ dataDir: path.join(REPO_ROOT, 'evidence', 'site-data'), repoRoot: REPO_ROOT, model, compute });
  await assert.rejects(store.init(), /outside the source repository/);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'evidence', 'site-data')), false);
});

test('engagements are created with role defaults and validated settings', async () => {
  await withStore(async store => {
    const engagement = await store.create({ preset: 'evaluation', settings: { name: 'Contoso Evaluation!', start_date: '2026-09-29' } });
    assert.equal(engagement.id, 'contoso-evaluation');
    assert.deepEqual(engagement.settings.scopes, { live: true, optional: false, demo: false });
    const demo = await store.create({ preset: 'demonstration', settings: { name: 'Contoso Evaluation!' } });
    assert.equal(demo.id, 'contoso-evaluation-2');
    assert.deepEqual(demo.settings.scopes, { live: true, optional: true, demo: true });
    await assert.rejects(store.create({ settings: { name: 'Bad', start_date: '2026-02-30' } }), /YYYY-MM-DD/);
    await assert.rejects(store.create({ settings: { name: 'Bad', unknown: 1 } }), /Unknown setting/);
    await assert.rejects(store.mutate(engagement.id, current => store.opSettings(current, { tenant: { tenant_id: 'not-a-guid' } })), /tenant GUID/);
    await store.mutate(engagement.id, current => store.opSettings(current, { scopes: { live: false, demo: true } }));
    const updated = await store.get(engagement.id);
    assert.equal(updated.settings.scopes.live, true);
    assert.equal(updated.settings.scopes.demo, true);
    assert.equal((await store.list()).length, 2);
  });
});

test('parallel step updates are all applied', async () => {
  await withStore(async store => {
    const { id } = await store.create({ settings: { name: 'Parallel' } });
    const ids = model.steps.slice(0, 25).map(step => step.id);
    await Promise.all(ids.map(stepId => store.mutate(id, current => store.opStep(current, stepId, { status: 'done' }))));
    const engagement = await store.get(id);
    assert.equal(ids.filter(stepId => engagement.steps[stepId]?.status === 'done').length, 25);
    assert.equal(engagement.revision, 25);
    assert.ok(engagement.steps[ids[0]].done_at);
    await store.mutate(id, current => store.opStep(current, ids[0], { status: 'todo' }));
    assert.equal((await store.get(id)).steps[ids[0]], undefined);
    await assert.rejects(store.mutate(id, current => store.opStep(current, 'G99.9.99', { status: 'done' })), /Unknown step/);
    await assert.rejects(store.mutate(id, current => store.opStep(current, ids[1], { status: 'finished' })), /must be one of/);
    const history = Object.values((await store.get(id)).history);
    assert.equal(history.length, 1);
    assert.equal(history[0].steps_done, 24);
  });
});

test('use case records track completion, demonstrations, and exclusions', async () => {
  await withStore(async store => {
    const { id } = await store.create({ settings: { name: 'Cases' } });
    await store.mutate(id, current => store.opCase(current, 'ONB-01', { phases: { positive: { result: 'PASS' }, negative: { result: 'PASS', reason: 'Denied.' } }, checklist: { 'setup.1': true } }));
    let record = (await store.get(id)).cases['ONB-01'];
    assert.ok(record.started_at && record.completed_at);
    await store.mutate(id, current => store.opCase(current, 'ONB-01', { phases: { negative: { result: 'NOT_RUN' } } }));
    record = (await store.get(id)).cases['ONB-01'];
    assert.equal(record.completed_at, undefined);
    await store.mutate(id, current => store.opCase(current, 'GSA-02', { demo: { status: 'DEMONSTRATED', audience: 'Customer SOC' } }));
    assert.match((await store.get(id)).cases['GSA-02'].demo.date, /^\d{4}-\d{2}-\d{2}$/);
    await assert.rejects(store.mutate(id, current => store.opCase(current, 'GSA-02', { exclusion: { reason: 'x', approved_by: 'rev', approved_date: '2026-10-01' } })), /Only live-proofed/);
    await assert.rejects(store.mutate(id, current => store.opCase(current, 'ONB-02', { exclusion: { reason: 'x', approved_by: '', approved_date: '' } })), /approver alias/);
    await store.mutate(id, current => store.opCase(current, 'ONB-02', { exclusion: { reason: 'Moved to follow-up.', approved_by: 'reviewer', approved_date: '2026-10-01' } }));
    assert.equal((await store.get(id)).cases['ONB-02'].exclusion.approved_by, 'reviewer');
    await assert.rejects(store.mutate(id, current => store.opCase(current, 'ONB-01', { checklist: { 'other.1': true } })), /Unknown checklist item/);
    await assert.rejects(store.mutate(id, current => store.opCase(current, 'ONB-01', { agent: 'bad alias!' })), /agent/);
    await assert.rejects(store.mutate(id, current => store.opCase(current, 'NOPE-01', {})), /Unknown use case/);
  });
});

test('notes, tenant objects, and measurements are validated', async () => {
  await withStore(async store => {
    const { id } = await store.create({ settings: { name: 'Records' } });
    await assert.rejects(store.mutate(id, current => store.opAddNote(current, { title: '' })), /title is required/);
    await store.mutate(id, current => { store.opAddNote(current, { title: 'Kickoff', category: 'meeting', shareable: true }); });
    const note = (await store.get(id)).notes[0];
    await store.mutate(id, current => store.opUpdateNote(current, note.id, { resolved: true, body: 'Done.' }));
    assert.equal((await store.get(id)).notes[0].resolved, true);
    await store.mutate(id, current => store.opDeleteNote(current, note.id));
    assert.equal((await store.get(id)).notes.length, 0);
    await store.mutate(id, current => store.opInventory(current, 'INV-U-ALLOW', { status: 'created', actual_name: 'u-allow@contoso.test' }));
    await assert.rejects(store.mutate(id, current => store.opInventory(current, 'INV-NOPE', { status: 'created' })), /Unknown tenant object/);
    await store.mutate(id, current => { store.opAddInventory(current, { type: 'policies', name: 'Extra policy', scope: 'live' }); });
    const custom = (await store.get(id)).custom_inventory[0];
    assert.match(custom.id, /^CUS-/);
    await store.mutate(id, current => store.opDeleteInventory(current, custom.id));
    await assert.rejects(store.mutate(id, current => store.opDeleteInventory(current, 'INV-U-ALLOW')), /Only added/);
    await store.mutate(id, current => store.opMeasurement(current, 'revocation_minutes', { start_utc: '2026-10-01T10:00', end_utc: '2026-10-01T10:45', target_minutes: 60, case: 'ENTRA-06' }));
    assert.equal((await store.get(id)).measurements.revocation_minutes.measured_minutes, 45);
    await assert.rejects(store.mutate(id, current => store.opMeasurement(current, 'revocation_minutes', { start_utc: '2026-10-01T11:00', end_utc: '2026-10-01T10:00' })), /end time/);
  });
});

test('export and import round-trip an engagement', async () => {
  await withStore(async store => {
    const { id } = await store.create({ preset: 'demonstration', settings: { name: 'Source', customer: 'Contoso' } });
    await store.mutate(id, current => {
      store.opStep(current, 'G01.1.01', { status: 'done', note: 'Sponsor named.' });
      store.opCase(current, 'ONB-01', { phases: { positive: { result: 'PASS' }, negative: { result: 'PASS' } }, customer_summary: 'Verified.' });
      store.opAddNote(current, { title: 'Decision', category: 'decision', shareable: true });
      const item = store.opAddInventory(current, { type: 'agents', name: 'Extra agent' });
      store.opInventory(current, item.id, { status: 'created' });
    });
    const exported = JSON.parse(JSON.stringify(await store.get(id)));
    exported.steps['G99.1.01'] = { status: 'done' };
    const result = await store.importEngagement(exported);
    assert.equal(result.skipped, 1);
    const imported = await store.get(result.id);
    assert.notEqual(result.id, id);
    assert.equal(imported.settings.role, 'demonstration');
    assert.equal(imported.steps['G01.1.01'].note, 'Sponsor named.');
    assert.equal(imported.cases['ONB-01'].customer_summary, 'Verified.');
    assert.equal(imported.notes.length, 1);
    assert.equal(imported.custom_inventory.length, 1);
    assert.equal(imported.inventory[imported.custom_inventory[0].id].status, 'created');
    await assert.rejects(store.importEngagement({ hello: 'world' }), /not an exported PoC engagement/);
  });
});

test('seeding runs once and deletion moves the file to the trash folder', async () => {
  const seed = { engagements: [{ id: 'seeded', preset: 'demonstration', settings: { name: 'Seeded' }, inventory: { 'INV-DEVICE-TEST': { status: 'pre-existing', actual_name: 'DEVICE-01' } }, custom_inventory: [{ type: 'policies', name: 'Existing pilot', scope: 'demo', status: 'pre-existing' }], notes: [{ title: 'Internal', category: 'general', shareable: false }] }] };
  await withStore(async (store, dataDir) => {
    const engagement = await store.get('seeded');
    assert.equal(engagement.inventory['INV-DEVICE-TEST'].actual_name, 'DEVICE-01');
    assert.equal(engagement.custom_inventory.length, 1);
    assert.equal(engagement.notes.length, 1);
    await store.remove('seeded');
    assert.equal((await store.list()).length, 0);
    assert.equal(fs.readdirSync(path.join(dataDir, 'trash')).length, 1);
    await store.init({ seedFiles: [`${dataDir}-seed.json`] });
    assert.equal((await store.list()).length, 0, 'seed does not run twice');
  }, { seed });
});
