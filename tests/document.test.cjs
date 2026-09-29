'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const requiredFields = [
  'id', 'title', 'family', 'layer', 'priority', 'required', 'availability',
  'prerequisites', 'setup', 'positive_steps', 'negative_steps', 'expected',
  'evidence', 'pass_criteria', 'value', 'cleanup', 'sources'
];

test('the test catalogue has complete procedures and source references', () => {
  const catalogue = read('catalogue/scenarios.json');
  const sources = read('docs/sources.json').sources;
  const knownSources = new Set(sources.map(item => item.id));
  assert.equal(catalogue.schema_version, 1);
  assert.ok(catalogue.scenarios.length >= 50, 'Include at least 50 test procedures.');
  const ids = new Set();
  for (const item of catalogue.scenarios) {
    for (const field of requiredFields) {
      assert.notEqual(item[field], undefined, `${item.id}: missing ${field}`);
      if (Array.isArray(item[field])) assert.ok(item[field].length > 0, `${item.id}: empty ${field}`);
    }
    assert.match(item.id, /^[A-Z][A-Z0-9]*-[0-9]{2,3}$/);
    assert.ok(!ids.has(item.id), `Duplicate case: ${item.id}`);
    ids.add(item.id);
    assert.equal(typeof item.required, 'boolean');
    assert.ok(item.positive_steps.length >= 2, `${item.id}: incomplete positive phase`);
    assert.ok(item.negative_steps.length >= 2, `${item.id}: incomplete negative phase`);
    for (const source of item.sources) assert.ok(knownSources.has(source), `${item.id}: unknown source ${source}`);
  }
  const groups = catalogue.scenarios.map(item => item.family).join(' ').toLowerCase();
  for (const group of ['copilot', 'foundry', 'partner', 'sdk', 'connected', 'shadow']) {
    assert.ok(groups.includes(group), `Missing agent group: ${group}`);
  }
});

test('the source register uses unique identifiers and HTTPS references', () => {
  const sources = read('docs/sources.json').sources;
  assert.ok(sources.length >= 15);
  const ids = new Set();
  for (const source of sources) {
    assert.ok(!ids.has(source.id));
    ids.add(source.id);
    assert.equal(new URL(source.url).protocol, 'https:');
    assert.match(source.retrieved, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(source.title && source.note);
  }
});

test('the runbook has deployment, evidence, boundary, and cleanup procedures', () => {
  const book = read('docs/runbook.json');
  assert.ok(book.title && book.subtitle && book.revision);
  assert.ok(book.chapters.length >= 10);
  for (const chapter of book.chapters) {
    assert.ok(chapter.title);
    assert.ok(chapter.sections && chapter.sections.length > 0);
    for (const section of chapter.sections) {
      assert.ok(section.title);
      if (section.table) {
        assert.ok(section.table.headers.length > 0);
        for (const row of section.table.rows) assert.equal(row.length, section.table.headers.length);
      }
    }
  }
  const content = JSON.stringify(book).toLowerCase();
  for (const term of ['prerequisite', 'evidence', 'cleanup', 'preview', 'blocked', 'licen', 'cost', 'consent']) {
    assert.ok(content.includes(term), `Missing topic: ${term}`);
  }
});

test('the package contains no saved product pass results', () => {
  const plan = read('config/poc-plan.example.json');
  assert.ok(plan.agents.every(agent => agent.state === 'NOT_PROVISIONED'));
  const measurements = read('config/measurement-template.json').measurements;
  assert.ok(measurements.every(item => item.measured_minutes === null));
});

test('each support matrix entry has a known source and a defined state', () => {
  const matrix = read('catalogue/support-matrix.json');
  const sources = new Set(read('docs/sources.json').sources.map(source => source.id));
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.families.length, 9);
  for (const family of matrix.families) {
    assert.equal(family.controls.length, matrix.controlLayers.length);
    assert.equal(new Set(family.controls.map(control => control.layer)).size, matrix.controlLayers.length);
    for (const control of family.controls) {
      assert.ok(Object.hasOwn(matrix.states, control.state), `${family.id}: unknown state`);
      assert.ok(matrix.controlLayers.includes(control.layer));
      assert.ok(control.enforcementBoundary && control.prerequisites.length > 0);
      for (const source of control.sourceIds) assert.ok(sources.has(source), `${family.id}: unknown source ${source}`);
    }
  }
});

test('requested connected platforms cannot be replaced by provider readiness', () => {
  const cases = read('catalogue/scenarios.json').scenarios;
  for (const id of ['ONB-01', 'ONB-02', 'ONB-03', 'ONB-04', 'ONB-06', 'ONB-07', 'ONB-09', 'ONB-10']) {
    assert.equal(cases.find(item => item.id === id).required, true, `${id}: required demonstration was removed`);
  }
  assert.match(cases.find(item => item.id === 'ONB-08').title, /unsupported OpenAI connector/);
  assert.match(cases.find(item => item.id === 'ONB-07').cleanup.join(' '), /[Aa]rchive/);
});

test('reference downloads use immutable revisions and approved source repositories', () => {
  const manifest = read('reference-samples.json');
  const names = new Set();
  for (const sample of manifest.samples) {
    assert.ok(!names.has(sample.name));
    names.add(sample.name);
    assert.match(sample.repository, /^https:\/\/github\.com\/(microsoft|microsoft-foundry)\/[\w.-]+\.git$/);
    assert.match(sample.commit, /^[a-f0-9]{40}$/);
    assert.ok(!sample.path.split(/[/\\]/).includes('..'));
    assert.ok(sample.limit);
  }
});

test('procedure sentences stay within the controlled-English length target', () => {
  const sentences = value => value.replace(/\[[A-Z0-9, ]+\]/g, '').split(/(?<=[.!?])\s+/);
  const check = (value, label) => {
    for (const sentence of sentences(value)) {
      const count = sentence.trim().split(/\s+/).filter(Boolean).length;
      assert.ok(count <= 20, `${label}: ${count} words: ${sentence}`);
    }
  };
  const book = read('docs/runbook.json');
  for (const chapter of book.chapters) {
    for (const section of chapter.sections) {
      for (const step of section.steps || []) check(step, section.title);
    }
  }
  for (const scenario of read('catalogue/scenarios.json').scenarios) {
    for (const field of ['setup', 'positive_steps', 'negative_steps', 'cleanup']) {
      for (const step of scenario[field]) check(step, `${scenario.id} ${field}`);
    }
  }
});
