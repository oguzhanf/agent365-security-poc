'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { buildModel } = require('../../site/lib/model.cjs');

const core = file => import(pathToFileURL(path.resolve(__dirname, '..', '..', 'site', 'public', 'js', 'core', file)).href);
const model = buildModel();
const phases = (positive, negative, control) => ({
  phases: { positive: { result: positive }, negative: { result: negative }, ...(control ? { control: { result: control } } : {}) }
});

test('case results follow the evidence recorder precedence', async () => {
  const C = await core('compute.mjs');
  assert.equal(C.caseResult(phases('PASS', 'PASS')), 'PASS');
  assert.equal(C.caseResult(phases('PASS', 'NOT_RUN')), 'NOT_RUN');
  assert.equal(C.caseResult(phases('PASS', 'FAIL')), 'FAIL');
  assert.equal(C.caseResult(phases('BLOCKED', 'FAIL')), 'FAIL');
  assert.equal(C.caseResult(phases('BLOCKED', 'NOT_RUN')), 'BLOCKED');
  assert.equal(C.caseResult(phases('NOT_APPLICABLE', 'NOT_RUN')), 'NOT_APPLICABLE');
  assert.equal(C.caseResult(phases('PASS', 'PASS', 'PASS')), 'PASS');
  assert.equal(C.caseResult(phases('PASS', 'PASS', 'BLOCKED')), 'BLOCKED');
  assert.equal(C.caseResult(phases('NOT_RUN', 'NOT_RUN', 'PASS')), 'NOT_RUN');
  assert.equal(C.caseResult(undefined), 'NOT_RUN');
});

test('local simulation evidence cannot pass a live product case', async () => {
  const C = await core('compute.mjs');
  const item = model.cases.find(entry => entry.id === 'ONB-04');
  const record = { ...phases('PASS', 'PASS'), evidence_kind: 'local_simulation' };
  assert.equal(C.caseResult(record), 'PASS');
  assert.equal(C.acceptanceResult(item, record), 'NOT_RUN');
  const engagement = { settings: { role: 'evaluation' }, cases: { 'ONB-04': record } };
  assert.deepEqual(C.acceptance(model, engagement).simulation_only, ['ONB-04']);
});

test('exclusions reduce only the agreed denominator', async () => {
  const C = await core('compute.mjs');
  const engagement = {
    settings: { role: 'evaluation' },
    steps: {},
    cases: {
      'ONB-01': phases('PASS', 'PASS'),
      'ONB-02': { exclusion: { reason: 'Approved scope change.', approved_by: 'reviewer', approved_date: '2026-10-01' } }
    },
    notes: []
  };
  const result = C.acceptance(model, engagement);
  assert.equal(result.live_set.denominator, 36);
  assert.equal(result.agreed.denominator, 35);
  assert.equal(result.agreed.passed, 1);
  assert.equal(result.original_required.denominator, 40);
  assert.equal(result.original_required.passed, 1);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.achieved, false);
});

test('step numbers and statistics follow the included scopes', async () => {
  const C = await core('compute.mjs');
  const evaluation = { settings: { role: 'evaluation' }, steps: { 'G01.1.01': { status: 'done' }, 'G01.1.02': { status: 'skipped' } } };
  const numbers = C.stepNumbers(model, evaluation);
  assert.equal(numbers.size, model.totals.steps.live);
  assert.equal(numbers.get('G01.1.01'), 1);
  assert.equal(numbers.has('G10.2.01'), false);
  const stats = C.stepStats(C.includedSteps(model, evaluation), evaluation);
  assert.equal(stats.done, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.applicable, model.totals.steps.live - 1);
  const demonstration = { settings: { role: 'demonstration' }, steps: {} };
  assert.equal(C.includedSteps(model, demonstration).length, model.totals.steps.all);
  assert.equal(C.includedCases(model, demonstration).length, model.cases.length);
});

test('plan days use calendar or working days', async () => {
  const C = await core('compute.mjs');
  const engagement = { settings: { start_date: '2026-09-29', calendar: 'calendar' } };
  assert.equal(C.formatDate(C.planDayDate(engagement, 14)), '2026-10-12');
  assert.equal(C.planDay(engagement, new Date('2026-09-28T12:00:00')), 0);
  assert.equal(C.planDay(engagement, new Date('2026-10-01T12:00:00')), 3);
  assert.equal(C.currentBucket(model, engagement, new Date('2026-10-01T12:00:00')), 'B2');
  engagement.settings.calendar = 'working';
  assert.equal(C.formatDate(C.planDayDate(engagement, 5)), '2026-10-05');
  assert.equal(C.planDay(engagement, new Date('2026-10-05T12:00:00')), 5);
  assert.equal(C.formatDate(C.planDayDate(engagement, 14)), '2026-10-16');
});

test('tenant hints are added only to supported portal links', async () => {
  const C = await core('compute.mjs');
  const engagement = { settings: { tenant: { domain: 'contoso.onmicrosoft.com', tenant_id: '11111111-2222-3333-4444-555555555555' } } };
  assert.equal(C.tenantUrl(model.areas.azure, engagement), 'https://portal.azure.com/#@contoso.onmicrosoft.com');
  assert.equal(C.tenantUrl(model.areas.defender, engagement), 'https://security.microsoft.com/?tid=11111111-2222-3333-4444-555555555555');
  assert.equal(C.tenantUrl(model.areas.entra, engagement), 'https://entra.microsoft.com');
  assert.equal(C.tenantUrl(model.areas.governance, engagement), '');
});

test('reports include shareable content only and escape HTML', async () => {
  const R = await core('report.mjs');
  const engagement = {
    id: 'contoso',
    settings: { name: 'Contoso evaluation', customer: 'Contoso', role: 'evaluation', tenant: { name: 'Contoso' }, start_date: '2026-09-29', report: { status: 'at_risk', key_messages: 'Licensing is the main dependency.' } },
    steps: { 'G01.1.03': { status: 'blocked', note: 'Trial seats pending.', updated_at: '2026-09-30T10:00:00Z' }, 'G01.1.01': { status: 'done', done_at: '2026-09-30T09:00:00Z', updated_at: '2026-09-30T09:00:00Z' } },
    cases: { 'ONB-01': { ...phases('PASS', 'PASS'), customer_summary: 'Registry identity verified.', internal_notes: 'SECRET-INTERNAL', completed_at: '2026-09-30T11:00:00Z' } },
    notes: [
      { id: 'N-1', date: '2026-09-30', category: 'decision', title: 'Use synthetic data <script>alert(1)</script>', body: 'Agreed.', shareable: true, resolved: false },
      { id: 'N-2', date: '2026-09-30', category: 'observation', title: 'INTERNAL-ONLY note', body: 'Do not share.', shareable: false, resolved: false },
      { id: 'N-3', date: '2026-09-30', category: 'risk', title: 'Trial expiry', body: '', shareable: true, resolved: false, owner: 'PoC lead' }
    ],
    inventory: {}, custom_inventory: [], measurements: {}, history: {}
  };
  const options = { now: '2026-10-01T12:00:00', from: '2026-09-29', to: '2026-10-01' };
  const progress = R.buildReport(model, engagement, { ...options, type: 'progress' });
  const markdown = R.renderMarkdown(progress);
  assert.match(markdown, /Progress report/);
  assert.match(markdown, /Registry identity verified\./);
  assert.match(markdown, /Trial seats pending\./);
  assert.match(markdown, /Licensing is the main dependency\./);
  assert.match(markdown, /Trial expiry/);
  assert.match(markdown, /1 configuration steps completed in this period\./);
  assert.match(markdown, /ONB-01 Onboard an authenticated Copilot Studio agent: Pass\./);
  assert.doesNotMatch(markdown, /SECRET-INTERNAL|INTERNAL-ONLY/);
  const html = R.renderHtml(progress);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  const final = R.buildReport(model, engagement, { ...options, type: 'final' });
  const finalMarkdown = R.renderMarkdown(final);
  assert.match(finalMarkdown, /Final report/);
  assert.match(finalMarkdown, /Agreed live-proofed set \| 1 \| 36/);
  assert.match(finalMarkdown, /Original catalogue, required cases \| 1 \| 40/);
  assert.match(finalMarkdown, /Native OpenAI Connected platforms connector/);
  assert.doesNotMatch(finalMarkdown, /SECRET-INTERNAL|INTERNAL-ONLY/);
  assert.equal(final.filename, 'Agent365-PoC-contoso-final-report-2026-10-01');
});
