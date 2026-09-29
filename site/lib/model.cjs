'use strict';

// Builds the PoC model served to the site from the kit's own sources:
// docs/runbook.json (guides), catalogue/scenarios.json (use cases),
// catalogue/support-matrix.json, docs/sources.json, the config templates,
// and site/scope/poc-scope.json (the customer scope document overlay).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCOPES = ['live', 'optional', 'demo'];
const CASE_SCOPES = ['live', 'demo', 'unscheduled'];

const pad2 = value => String(value).padStart(2, '0');
const textHash = value => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12);

function expandSteps(spec) {
  const result = [];
  for (const part of String(spec).split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!match) throw new Error(`Invalid step range: ${spec}`);
    const first = Number(match[1]);
    const last = match[2] ? Number(match[2]) : first;
    if (last < first) throw new Error(`Invalid step range: ${spec}`);
    for (let index = first; index <= last; index++) result.push(index);
  }
  return result;
}

function sectionId(guideId, index) {
  return `${guideId}.${index}`;
}

function stepId(guideId, sectionIndex, stepIndex) {
  return `${guideId}.${sectionIndex}.${pad2(stepIndex)}`;
}

function buildModel(options = {}) {
  const root = options.root || REPO_ROOT;
  const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  const book = readJson('docs/runbook.json');
  const catalogue = readJson('catalogue/scenarios.json');
  const matrix = readJson('catalogue/support-matrix.json');
  const sourceRegister = readJson('docs/sources.json');
  const measurementTemplate = readJson('config/measurement-template.json');
  const planTemplate = readJson('config/poc-plan.example.json');
  const scope = options.scope || readJson('site/scope/poc-scope.json');
  const prompts = readJson('fixtures/test-prompts.json');

  const bucketIds = scope.buckets.map(bucket => bucket.id);
  const bucketOrder = new Map(bucketIds.map((id, index) => [id, index]));
  const caseIds = new Set(catalogue.scenarios.map(item => item.id));
  const areaRules = scope.area_rules.map(rule => ({ area: rule.area, pattern: new RegExp(rule.pattern) }));
  const problems = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  for (const rule of Object.values(scope.guide_rules)) {
    check(SCOPES.includes(rule.scope), `Unknown guide scope ${rule.scope}`);
    check(bucketOrder.has(rule.bucket), `Unknown guide bucket ${rule.bucket}`);
    check(Object.hasOwn(scope.areas, rule.area), `Unknown guide area ${rule.area}`);
  }

  const detectArea = (text, fallback) => {
    for (const rule of areaRules) if (rule.pattern.test(text)) return rule.area;
    return fallback;
  };

  // Index the step rules by section and step number. Later rules win.
  const stepRules = new Map();
  for (const rule of scope.step_rules || []) {
    for (const index of expandSteps(rule.steps)) {
      const key = `${rule.section}.${pad2(index)}`;
      stepRules.set(key, { ...(stepRules.get(key) || {}), ...rule });
    }
  }

  const rawGuides = book.chapters.map((chapter, index) => ({ ...chapter, number: index + 1, origin: 'runbook' }));
  for (const extra of scope.extra_guides || []) {
    check(extra.number === rawGuides.length + 1, `Extra guide ${extra.number} must follow guide ${rawGuides.length}`);
    rawGuides.push({ ...extra, origin: 'scope', origin_note: extra.origin });
  }

  const guides = [];
  const steps = [];
  const usedSectionRules = new Set();
  const usedStepRules = new Set();

  for (const chapter of rawGuides) {
    const id = `G${pad2(chapter.number)}`;
    const guideRule = scope.guide_rules[id];
    check(Boolean(guideRule), `Missing guide rule for ${id}`);
    const guide = {
      id,
      number: chapter.number,
      title: chapter.title,
      origin: chapter.origin,
      origin_note: chapter.origin_note || '',
      paragraphs: chapter.paragraphs || [],
      scope: guideRule.scope,
      bucket: guideRule.bucket,
      area: guideRule.area,
      cases: [...(guideRule.cases || [])],
      sections: [],
      step_ids: []
    };
    (chapter.sections || []).forEach((section, sectionIndexZero) => {
      const sectionIndex = sectionIndexZero + 1;
      const sid = sectionId(id, sectionIndex);
      const sectionRule = scope.section_rules[sid] || {};
      if (scope.section_rules[sid]) usedSectionRules.add(sid);
      const sectionDefaults = {
        scope: sectionRule.scope || guideRule.scope,
        bucket: sectionRule.bucket || guideRule.bucket,
        area: sectionRule.area || guideRule.area,
        cases: sectionRule.cases || guideRule.cases || []
      };
      const sectionModel = {
        id: sid,
        index: sectionIndex,
        title: section.title,
        paragraphs: section.paragraphs || [],
        table: section.table || null,
        items: section.items || [],
        code: section.code || '',
        notes: section.notes || [],
        scope: sectionDefaults.scope,
        bucket: sectionDefaults.bucket,
        cases: [...sectionDefaults.cases],
        step_ids: []
      };
      (section.steps || []).forEach((text, stepIndexZero) => {
        const stepIndex = stepIndexZero + 1;
        const key = `${sid}.${pad2(stepIndex)}`;
        const rule = stepRules.get(key) || {};
        if (stepRules.has(key)) usedStepRules.add(key);
        const step = {
          id: stepId(id, sectionIndex, stepIndex),
          guide: id,
          section: sid,
          index: stepIndex,
          text,
          hash: textHash(text),
          scope: rule.scope || sectionDefaults.scope,
          bucket: rule.bucket || sectionDefaults.bucket,
          area: detectArea(text, sectionDefaults.area),
          cases: [...(rule.cases || sectionDefaults.cases)]
        };
        check(SCOPES.includes(step.scope), `${step.id}: unknown scope ${step.scope}`);
        check(bucketOrder.has(step.bucket), `${step.id}: unknown bucket ${step.bucket}`);
        for (const caseId of step.cases) check(caseIds.has(caseId), `${step.id}: unknown case ${caseId}`);
        steps.push(step);
        sectionModel.step_ids.push(step.id);
        guide.step_ids.push(step.id);
      });
      guide.sections.push(sectionModel);
    });
    guides.push(guide);
  }

  for (const key of Object.keys(scope.section_rules)) check(usedSectionRules.has(key), `Section rule matches no section: ${key}`);
  for (const key of stepRules.keys()) check(usedStepRules.has(key), `Step rule matches no step: ${key}`);

  // Plan order: bucket, then guide number, then section, then step.
  const guideNumber = new Map(guides.map(guide => [guide.id, guide.number]));
  steps.sort((a, b) =>
    (bucketOrder.get(a.bucket) - bucketOrder.get(b.bucket)) ||
    (guideNumber.get(a.guide) - guideNumber.get(b.guide)) ||
    (Number(a.section.split('.')[1]) - Number(b.section.split('.')[1])) ||
    (a.index - b.index));
  steps.forEach((step, index) => { step.order = index + 1; });

  // Each guide lists the plan buckets that contain its steps.
  const stepsByGuide = new Map();
  for (const step of steps) {
    if (!stepsByGuide.has(step.guide)) stepsByGuide.set(step.guide, []);
    stepsByGuide.get(step.guide).push(step);
  }
  for (const guide of guides) {
    const own = stepsByGuide.get(guide.id) || [];
    const count = scopeName => own.filter(step => step.scope === scopeName).length;
    guide.step_counts = { live: count('live'), optional: count('optional'), demo: count('demo'), total: own.length };
    guide.buckets = [...new Set(own.map(step => step.bucket))].sort((a, b) => bucketOrder.get(a) - bucketOrder.get(b));
    if (!guide.buckets.length) guide.buckets = [guide.bucket];
  }

  // Use cases.
  const liveBucketOf = new Map();
  for (const [bucket, ids] of Object.entries(scope.live_case_buckets)) {
    for (const caseId of ids) {
      check(!liveBucketOf.has(caseId), `Case ${caseId} is in two plan buckets`);
      liveBucketOf.set(caseId, bucket);
    }
  }
  const demoItemOf = new Map();
  for (const item of scope.demo_items) {
    for (const caseId of item.cases) {
      check(!demoItemOf.has(caseId), `Case ${caseId} is in two demonstration items`);
      demoItemOf.set(caseId, item);
    }
  }
  const unscheduled = scope.unscheduled_cases || {};
  const liveAreaOf = new Map();
  for (const area of scope.live_areas) {
    for (const caseId of area.cases) if (!liveAreaOf.has(caseId)) liveAreaOf.set(caseId, area.id);
  }
  const cases = catalogue.scenarios.map(scenario => {
    const inLive = liveBucketOf.has(scenario.id);
    const demoItem = demoItemOf.get(scenario.id);
    const isUnscheduled = Object.hasOwn(unscheduled, scenario.id);
    check([inLive, Boolean(demoItem), isUnscheduled].filter(Boolean).length === 1,
      `Case ${scenario.id} must have exactly one scope classification`);
    const caseScope = inLive ? 'live' : demoItem ? 'demo' : 'unscheduled';
    const guideIds = scope.case_guides[scenario.id] || [];
    check(guideIds.length > 0, `Case ${scenario.id} has no guide mapping`);
    for (const guideId of guideIds) check(guideNumber.has(guideId), `Case ${scenario.id}: unknown guide ${guideId}`);
    return {
      ...scenario,
      scope: caseScope,
      bucket: inLive ? liveBucketOf.get(scenario.id) : caseScope === 'demo' ? 'B8' : null,
      guides: guideIds,
      default_agent: scope.family_agents[scenario.family] || '',
      demo_item: demoItem ? demoItem.id : null,
      demo_reason: demoItem ? demoItem.reason : null,
      unscheduled_reason: isUnscheduled ? unscheduled[scenario.id] : null,
      live_area: liveAreaOf.get(scenario.id) || null,
      family_label: scope.labels.families[scenario.family] || scenario.family,
      layer_label: scope.labels.layers[scenario.layer] || scenario.layer,
      step_ids: steps.filter(step => step.cases.includes(scenario.id)).map(step => step.id)
    };
  });
  for (const caseId of liveBucketOf.keys()) check(caseIds.has(caseId), `Unknown live case ${caseId}`);
  for (const caseId of demoItemOf.keys()) check(caseIds.has(caseId), `Unknown demonstration case ${caseId}`);
  for (const caseId of Object.keys(unscheduled)) check(caseIds.has(caseId), `Unknown unscheduled case ${caseId}`);
  for (const area of [...scope.live_areas, ...scope.demo_items]) {
    for (const guideId of area.guides) check(guideNumber.has(guideId), `${area.id}: unknown guide ${guideId}`);
  }

  const sources = {};
  for (const source of sourceRegister.sources) {
    sources[source.id] = { title: source.title, url: source.url, retrieved: source.retrieved, note: source.note };
  }

  const fixtures = [
    { id: 'public-procedure', title: 'Public procedure', marker: 'POC-APPROVAL-6142', formats: ['txt', 'docx'], use: 'Approved synthetic knowledge for the Studio agent and runtime.' },
    { id: 'restricted-record', title: 'Restricted record', marker: 'POC-RESTRICTED-4826', formats: ['txt', 'docx'], use: 'Apply the test sensitivity label before the data protection tests.' },
    { id: 'untrusted-instruction', title: 'Untrusted instruction', marker: 'POC_UNTRUSTED_OK', formats: ['txt'], use: 'Isolated prompt-injection test data only. Do not follow its instruction.' }
  ].map(fixture => ({
    ...fixture,
    text: fs.readFileSync(path.join(root, 'fixtures', `${fixture.id}.txt`), 'utf8')
  }));

  const counts = list => Object.fromEntries(SCOPES.map(name => [name, list.filter(item => item.scope === name).length]));
  const caseCounts = Object.fromEntries(CASE_SCOPES.map(name => [name, cases.filter(item => item.scope === name).length]));

  const queries = [];
  for (const [folder, platform] of [['defender', 'Defender Advanced Hunting'], ['sentinel', 'Microsoft Sentinel']]) {
    const directory = path.join(root, 'queries', folder);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).filter(file => file.endsWith('.kql')).sort()) {
      queries.push({
        id: `${folder}/${name.slice(0, -4)}`,
        platform,
        file: `queries/${folder}/${name}`,
        text: fs.readFileSync(path.join(directory, name), 'utf8')
      });
    }
  }
  const queryGuidePath = path.join(root, 'queries', 'query-guide.txt');

  const model = {
    schema_version: 1,
    document: scope.document,
    runbook: { title: book.title, subtitle: book.subtitle, revision: book.revision },
    overview: scope.overview,
    environment: scope.environment,
    stop_conditions: scope.stop_conditions,
    required_demonstrations: scope.required_demonstrations,
    acceptance: scope.acceptance,
    cleanup: scope.cleanup,
    live_areas: scope.live_areas,
    demo_items: scope.demo_items,
    buckets: scope.buckets,
    areas: scope.areas,
    labels: scope.labels,
    agents: planTemplate.agents.map(agent => ({ alias: agent.alias, group: agent.group, platform: agent.platform })),
    known_gaps: planTemplate.known_gaps,
    plan_template: planTemplate,
    guides,
    steps,
    cases,
    matrix: {
      as_of: matrix.asOf,
      evidence_status: matrix.evidenceStatus,
      availability_date_meaning: matrix.availabilityDateMeaning,
      states: matrix.states,
      layers: matrix.controlLayers,
      families: matrix.families
    },
    sources,
    measurements: measurementTemplate.measurements,
    fixtures,
    test_prompts: prompts.prompts,
    queries,
    query_guide: fs.existsSync(queryGuidePath) ? fs.readFileSync(queryGuidePath, 'utf8') : '',
    inventory_types: scope.inventory_types,
    inventory_template: scope.inventory_template,
    inventory_statuses: scope.inventory_statuses,
    totals: {
      guides: guides.length,
      steps: { ...counts(steps), all: steps.length },
      cases: { ...caseCounts, all: cases.length, required_original: cases.filter(item => item.required).length }
    }
  };
  if (problems.length) {
    const error = new Error(`The PoC model is inconsistent:\n- ${problems.join('\n- ')}`);
    error.problems = problems;
    throw error;
  }
  return model;
}

module.exports = { buildModel, expandSteps, textHash, REPO_ROOT, SCOPES, CASE_SCOPES };
