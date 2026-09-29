'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildModel, expandSteps } = require('../../site/lib/model.cjs');

const root = path.resolve(__dirname, '..', '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const model = buildModel();

test('the model has 45 guides and one stable ID for every procedure step', () => {
  const book = read('docs/runbook.json');
  const runbookSteps = book.chapters.reduce((count, chapter) => count + chapter.sections.reduce((sum, section) => sum + (section.steps || []).length, 0), 0);
  assert.equal(model.guides.length, book.chapters.length + 1);
  assert.equal(model.totals.guides, 45);
  const closeOut = model.guides[44];
  assert.equal(closeOut.id, 'G45');
  assert.equal(closeOut.origin, 'scope');
  assert.equal(model.steps.length, runbookSteps + closeOut.step_counts.total);
  const ids = new Set(model.steps.map(step => step.id));
  assert.equal(ids.size, model.steps.length);
  for (const step of model.steps) assert.match(step.id, /^G\d{2}\.\d+\.\d{2}$/);
  assert.equal(model.steps.find(step => step.id === 'G08.2.07').text, book.chapters[7].sections[1].steps[6]);
  assert.deepEqual(model.steps.map(step => step.order), model.steps.map((step, index) => index + 1));
});

test('use case scope follows the customer scope document', () => {
  const ids = scope => model.cases.filter(item => item.scope === scope).map(item => item.id).sort();
  const deferred = ['ONB-03', 'ONB-05', 'ONB-07', 'ONB-10'];
  const required = model.cases.filter(item => item.required).map(item => item.id);
  assert.equal(ids('live').length, 36);
  assert.equal(ids('demo').length, 29);
  assert.deepEqual(ids('unscheduled'), ['DFC-02', 'ENTRA-08']);
  assert.deepEqual(ids('live'), required.filter(id => !deferred.includes(id)).sort());
  for (const id of deferred) assert.equal(model.cases.find(item => item.id === id).scope, 'demo');
  for (const item of model.cases.filter(entry => entry.scope === 'live')) assert.match(item.bucket, /^B[2-7]$/);
  for (const item of model.cases) assert.ok(item.guides.length > 0, `${item.id} has guides`);
});

test('guide numbers cited by the scope document point at the matching guides', () => {
  const expected = {
    G08: /Copilot Studio/, G09: /Foundry hosted/, G10: /Zendesk/, G13: /OpenAI/, G14: /Local Codex/, G15: /Frontier/,
    G29: /Microsoft 365 governance/, G30: /Entra Agent ID/, G32: /Defender security for AI/, G33: /Purview/,
    G34: /Defender for Endpoint/, G35: /Defender for Cloud:/, G36: /Cloud Apps/, G37: /Global Secure Access/,
    G38: /Sentinel/, G39: /Security Copilot/, G43: /Response and cleanup/, G45: /close-out/
  };
  for (const [id, pattern] of Object.entries(expected)) assert.match(model.guides.find(guide => guide.id === id).title, pattern, id);
});

test('every step has a scope, a plan window, and a portal area', () => {
  const buckets = new Set(model.buckets.map(bucket => bucket.id));
  for (const step of model.steps) {
    assert.ok(['live', 'optional', 'demo'].includes(step.scope), step.id);
    assert.ok(buckets.has(step.bucket), step.id);
    assert.ok(model.areas[step.area], step.id);
    if (step.scope === 'demo') assert.equal(step.bucket, 'BD', step.id);
  }
  for (const id of ['G10', 'G11', 'G12', 'G15', 'G25', 'G26', 'G27', 'G37']) {
    assert.ok(model.steps.filter(step => step.guide === id).every(step => step.scope === 'demo'), id);
  }
  const totals = model.totals.steps;
  assert.equal(totals.live + totals.optional + totals.demo, totals.all);
  assert.ok(model.cases.every(item => item.step_ids.length > 0), 'every use case links to a step');
});

test('the tenant build sheet and fixtures reference known guides and cases', () => {
  const guides = new Set(model.guides.map(guide => guide.id));
  const cases = new Set(model.cases.map(item => item.id));
  const types = new Set(model.inventory_types.map(type => type.id));
  const ids = new Set();
  for (const item of model.inventory_template) {
    assert.ok(!ids.has(item.id), item.id);
    ids.add(item.id);
    assert.ok(types.has(item.type), item.id);
    for (const id of item.guides) assert.ok(guides.has(id), `${item.id}: ${id}`);
    for (const id of item.cases) assert.ok(cases.has(id), `${item.id}: ${id}`);
  }
  assert.ok(model.fixtures.some(fixture => fixture.text.includes('POC-APPROVAL-6142')));
  assert.ok(model.fixtures.some(fixture => fixture.text.includes('POC-RESTRICTED-4826')));
  assert.ok(model.queries.length >= 5);
});

test('step ranges expand and invalid ranges fail', () => {
  assert.deepEqual(expandSteps('1-3,5'), [1, 2, 3, 5]);
  assert.throws(() => expandSteps('3-1'));
  assert.throws(() => expandSteps('a'));
});

test('an inconsistent scope overlay fails loudly', () => {
  const scope = read('site/scope/poc-scope.json');
  scope.step_rules.push({ section: 'G99.1', steps: '1', bucket: 'B1' });
  assert.throws(() => buildModel({ scope }), /Step rule matches no step/);
  const moved = read('site/scope/poc-scope.json');
  moved.live_case_buckets.B2.push('GSA-01');
  assert.throws(() => buildModel({ scope: moved }), /exactly one scope classification/);
});
