'use strict';

// Downloads generated from the PoC model and an engagement:
// - the reference pack (INDEX.md, TABLES.md, guides/, test-procedures/),
// - a filled poc-plan.json in the config/poc-plan.example.json shape,
// - PowerShell commands for the kit's evidence recorder (poc_evidence),
// - unlabelled DOCX copies of the synthetic fixtures.

const { Document, Packer, Paragraph, TextRun } = require('docx');

const pad2 = value => String(value).padStart(2, '0');
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const mdCell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const SOURCE_REF = /\[([A-Z][A-Z0-9]*\d(?:,\s*[A-Z][A-Z0-9]*\d)*)\]/g;

function guideFile(guide) {
  return `guides/${pad2(guide.number)}_GUIDE_${slug(guide.title)}.md`;
}

function caseFile(item) {
  return `test-procedures/${item.id}_${slug(item.title)}.md`;
}

function citedSources(text) {
  const ids = new Set();
  for (const match of String(text).matchAll(SOURCE_REF)) {
    for (const id of match[1].split(/,\s*/)) ids.add(id.trim());
  }
  return [...ids];
}

function bucketLabel(model, id) {
  const bucket = model.buckets.find(item => item.id === id);
  return bucket ? `${bucket.label}: ${bucket.title}` : id;
}

function mdTable(headers, rows) {
  const out = [`| ${headers.map(mdCell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) out.push(`| ${row.map(mdCell).join(' | ')} |`);
  return out.join('\n');
}

function sourceLines(model, ids) {
  return ids.filter(id => model.sources[id]).map(id => `- [${id}] ${model.sources[id].title}: ${model.sources[id].url}`);
}

function renderGuide(model, guide) {
  const stepById = new Map(model.steps.map(step => [step.id, step]));
  const out = [`# Guide ${pad2(guide.number)}: ${guide.title}`, ''];
  const counts = guide.step_counts;
  out.push(`- Plan window: ${guide.buckets.map(id => bucketLabel(model, id)).join('; ')}`);
  out.push(`- Steps: ${counts.live} live, ${counts.optional} optional, ${counts.demo} demonstration only`);
  if (guide.cases.length) out.push(`- Use cases: ${guide.cases.join(', ')}`);
  if (guide.origin_note) out.push(`- Source: ${guide.origin_note}`);
  out.push('');
  for (const text of guide.paragraphs) out.push(text, '');
  for (const section of guide.sections) {
    out.push(`## ${section.index}. ${section.title}`, '');
    for (const text of section.paragraphs) out.push(text, '');
    if (section.table) out.push(mdTable(section.table.headers, section.table.rows), '');
    section.step_ids.forEach((id, index) => {
      const step = stepById.get(id);
      const tags = [];
      if (step.scope === 'demo') tags.push('demonstration only');
      if (step.scope === 'optional') tags.push('optional');
      if (step.bucket !== guide.bucket && step.scope !== 'demo') tags.push(bucketLabel(model, step.bucket));
      out.push(`${index + 1}. \`${id}\` ${step.text}${tags.length ? ` _(${tags.join('; ')})_` : ''}`);
    });
    if (section.step_ids.length) out.push('');
    for (const item of section.items) out.push(`- ${item}`);
    if (section.items.length) out.push('');
    if (section.code) out.push('```powershell', section.code, '```', '');
    for (const note of section.notes) out.push(`> ${note}`, '');
  }
  const sources = sourceLines(model, citedSources(JSON.stringify(guide)));
  if (sources.length) out.push('## Sources', '', ...sources, '');
  return out.join('\n').trimEnd() + '\n';
}

function renderCase(model, item) {
  const scopeText = item.scope === 'live'
    ? `Live-proofed (${bucketLabel(model, item.bucket)})`
    : item.scope === 'demo' ? `Demonstration only. ${item.demo_reason}` : `Unscheduled optional. ${item.unscheduled_reason}`;
  const guides = item.guides.map(id => {
    const guide = model.guides.find(entry => entry.id === id);
    return guide ? `Guide ${pad2(guide.number)}: ${guide.title}` : id;
  });
  const out = [`# ${item.id}: ${item.title}`, ''];
  out.push(mdTable(['Field', 'Value'], [
    ['Scope', scopeText],
    ['Agent group', item.family_label],
    ['Security layer', item.layer_label],
    ['Priority', item.priority],
    ['Required in the original catalogue', item.required ? 'Yes' : 'No'],
    ['Availability', item.availability],
    ['Default agent alias', item.default_agent || 'Choose a fixed test-set alias'],
    ['Guides', guides.join('; ')]
  ]), '');
  const sections = [
    ['Prerequisites', 'prerequisites', false], ['Prepare the test', 'setup', true], ['Positive phase', 'positive_steps', true],
    ['Negative phase', 'negative_steps', true], ['Expected result', 'expected', false], ['Evidence', 'evidence', false],
    ['Pass criteria', 'pass_criteria', false], ['Measured value', 'value', false], ['Restore the test state', 'cleanup', true]
  ];
  for (const [title, key, ordered] of sections) {
    const values = Array.isArray(item[key]) ? item[key] : item[key] ? [item[key]] : [];
    if (!values.length) continue;
    out.push(`## ${title}`, '');
    values.forEach((value, index) => out.push(ordered ? `${index + 1}. ${value}` : `- ${value}`));
    out.push('');
  }
  const sources = sourceLines(model, item.sources || []);
  if (sources.length) out.push('## Sources', '', ...sources, '');
  return out.join('\n').trimEnd() + '\n';
}

function renderTables(model) {
  const out = ['# Reference tables', ''];
  out.push('## Two-week plan', '');
  out.push(mdTable(['Plan window', 'Focus', 'Live use cases', 'Guides'], model.buckets.map(bucket => {
    const guides = [...new Set(model.steps.filter(step => step.bucket === bucket.id).map(step => step.guide))];
    const cases = model.cases.filter(item => item.bucket === bucket.id && item.scope === 'live').map(item => item.id);
    const demos = model.cases.filter(item => item.bucket === bucket.id && item.scope === 'demo').length;
    return [`${bucket.label}: ${bucket.title}`, bucket.summary, cases.join(', ') || (demos ? `${demos} demonstrations` : '-'), guides.join(', ')];
  })), '');
  out.push('## Required demonstrations', '');
  out.push(mdTable(['Requested group', 'Test instance', 'Primary proof', 'Scope'], model.required_demonstrations.map(row => [
    row.group, row.instance, row.proof, row.scope === 'live' ? 'Live-proofed' : 'Demonstration only'
  ])), '');
  out.push('## Demonstration-only scope', '');
  out.push(mdTable(['Item', 'Use cases', 'Guides', 'Reason'], model.demo_items.map(item => [item.title, item.cases.join(', '), item.guides.join(', '), item.reason])), '');
  out.push('## Test case catalogue', '');
  out.push(mdTable(['Case', 'Title', 'Agent group', 'Layer', 'Priority', 'Required', 'PoC scope'], model.cases.map(item => [
    item.id, item.title, item.family_label, item.layer_label, item.priority, item.required ? 'Required' : 'Optional',
    item.scope === 'live' ? 'Live-proofed' : item.scope === 'demo' ? 'Demonstration only' : 'Unscheduled'
  ])), '');
  out.push('## Control coverage by agent group', '');
  out.push(model.matrix.evidence_status, '', model.matrix.availability_date_meaning, '');
  out.push(mdTable(['State', 'Meaning'], Object.entries(model.matrix.states)), '');
  for (const family of model.matrix.families) {
    out.push(`### ${family.name}`, '');
    if (family.acceptanceRequirement) out.push(family.acceptanceRequirement, '');
    out.push(mdTable(['Layer', 'State', 'Control boundary'], family.controls.map(control => [
      model.labels.matrix_layers[control.layer] || control.layer, control.state, `${control.enforcementBoundary} [${control.sourceIds.join(', ')}]`
    ])), '');
  }
  return out.join('\n').trimEnd() + '\n';
}

function renderIndex(model, generated) {
  const out = [`# ${model.document.title}: reference pack`, ''];
  out.push(`Scope document revision ${model.document.revision}. Runbook revision ${model.runbook.revision}.`);
  out.push(`Generated on ${generated} from the kit sources. It contains procedures only and no tenant result.`, '');
  out.push('The reference pack accompanies the scope document for the delivery team. It is not required reading for the customer.', '');
  out.push('## Reading order', '');
  out.push('1. Read the scope document and TABLES.md.');
  out.push('2. Follow the guides in plan order. Each step carries a stable ID, for example `G08.2.03`.');
  out.push('3. Run each test procedure with a positive and a negative phase. Record evidence outside the repository.');
  out.push('4. Close out with guide 45.', '');
  out.push(`## Guides (${model.guides.length})`, '');
  out.push(mdTable(['Guide', 'Title', 'Plan window', 'Live', 'Optional', 'Demo only', 'File'], model.guides.map(guide => [
    pad2(guide.number), guide.title, guide.buckets.map(id => model.buckets.find(bucket => bucket.id === id).label).join(', '),
    String(guide.step_counts.live), String(guide.step_counts.optional), String(guide.step_counts.demo), guideFile(guide)
  ])), '');
  out.push(`Total steps: ${model.totals.steps.all} (${model.totals.steps.live} live, ${model.totals.steps.optional} optional, ${model.totals.steps.demo} demonstration only).`, '');
  out.push(`## Test procedures (${model.cases.length})`, '');
  out.push(mdTable(['Case', 'Title', 'PoC scope', 'Required', 'File'], model.cases.map(item => [
    item.id, item.title, item.scope === 'live' ? 'Live-proofed' : item.scope === 'demo' ? 'Demonstration only' : 'Unscheduled',
    item.required ? 'Yes' : 'No', caseFile(item)
  ])), '');
  return out.join('\n').trimEnd() + '\n';
}

function referencePackFiles(model, generated = new Date().toISOString().slice(0, 10)) {
  const files = [
    { path: 'INDEX.md', content: renderIndex(model, generated) },
    { path: 'TABLES.md', content: renderTables(model) }
  ];
  for (const guide of model.guides) files.push({ path: guideFile(guide), content: renderGuide(model, guide) });
  for (const item of model.cases) files.push({ path: caseFile(item), content: renderCase(model, item) });
  return files;
}

const AGENT_INVENTORY = {
  'CPS-01': 'INV-AGENT-CPS01', 'FDR-01': 'INV-AGENT-FDR01', 'SAS-01': 'INV-AGENT-SAS01', 'SDK-01': 'INV-AGENT-SDK01',
  'EXT-01': 'INV-AGENT-EXT01', 'EXT-02': 'INV-AGENT-EXT02', 'SHD-01': 'INV-AGENT-SHD01', 'SHD-02': 'INV-AGENT-SHD02', 'SHD-03': 'INV-AGENT-SHD03'
};
const AGENT_STATES = {
  planned: 'NOT_PROVISIONED', created: 'PROVISIONED', verified: 'VERIFIED', restored: 'RESTORED', removed: 'REMOVED',
  residual: 'RESIDUAL', 'pre-existing': 'PRE_EXISTING', 'not-needed': 'NOT_IN_SCOPE'
};

function pocPlan(model, engagement, compute, generated = new Date().toISOString().slice(0, 10)) {
  const plan = JSON.parse(JSON.stringify(model.plan_template));
  const settings = engagement.settings;
  const keep = (value, placeholder) => (value ? value : placeholder);
  const lastDay = compute.planDayDate(engagement, compute.PLAN_DAYS);
  plan.name = `Agent 365 security PoC: ${settings.customer || settings.name}`;
  plan.revision = generated;
  plan.scope_document_revision = model.document.revision;
  plan.tenant_alias = keep(settings.tenant?.name || settings.name, plan.tenant_alias);
  plan.customer_approval_reference = keep(settings.approval_reference, plan.customer_approval_reference);
  plan.start_utc = settings.start_date ? `${settings.start_date}T00:00:00Z` : plan.start_utc;
  const end = settings.end_date || (lastDay ? compute.formatDate(lastDay) : '');
  plan.end_utc = end ? `${end}T23:59:59Z` : plan.end_utc;
  for (const key of Object.keys(plan.owners)) plan.owners[key] = keep(settings.owners?.[key], plan.owners[key]);
  for (const agent of plan.agents) {
    const inventoryId = AGENT_INVENTORY[agent.alias];
    const record = engagement.inventory?.[inventoryId];
    agent.state = AGENT_STATES[record?.status || 'planned'] || 'NOT_PROVISIONED';
    const item = model.inventory_template.find(entry => entry.id === inventoryId);
    if (item) agent.poc_scope = item.scope === 'live' ? 'LIVE_PROOFED' : 'DEMONSTRATION_ONLY';
  }
  for (const gap of plan.known_gaps) {
    if (/^REPLACE_/.test(gap.scope_decision)) gap.scope_decision = 'Record the unsupported connector request. Use the separate SDK-enabled demonstration (ONB-04).';
  }
  plan.data.evidence_location = keep(settings.evidence_location, plan.data.evidence_location);
  plan.budget.currency = keep(settings.budget?.currency, plan.budget.currency);
  const limit = Number(settings.budget?.approved_limit);
  plan.budget.approved_limit = settings.budget?.approved_limit && Number.isFinite(limit) ? limit : plan.budget.approved_limit;
  plan.budget.owner = keep(settings.owners?.poc_lead, plan.budget.owner);
  for (const key of Object.keys(plan.acceptance.targets)) {
    const target = engagement.measurements?.[key]?.target_minutes;
    plan.acceptance.targets[key] = Number.isFinite(target) ? target : null;
  }
  plan.acceptance.agreed_scope = {
    live_proofed_cases: model.cases.filter(item => item.scope === 'live').map(item => item.id),
    demonstration_only_cases: model.cases.filter(item => item.scope === 'demo').map(item => item.id),
    approved_exclusions: model.cases.filter(item => compute.isExcluded(engagement.cases?.[item.id])).map(item => item.id)
  };
  return plan;
}

const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;
const SAFE_ARTIFACT = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.?(?:[\\/]|$))[^:*?"<>|\u0000-\u001f]+$/;
const SAFE_CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function evidenceCommands(model, engagement, compute, generated = new Date().toISOString()) {
  const settings = engagement.settings;
  const out = [
    '# Agent 365 Security PoC: evidence recorder commands',
    `# Generated by the PoC site on ${generated} for ${settings.name}.`,
    '# Review every command before running it. The recorder needs Python 3.9 or later.',
    '# Run from the repository root. Place sanitized artifacts in the evidence root first.',
    '# PASS needs at least one existing artifact. The recorder appends; run each command once.',
    '# Commands that cannot run as written are commented out with the reason.',
    '',
    "$ErrorActionPreference = 'Stop'",
    `$Evidence = ${psQuote(settings.evidence_location || 'REPLACE_WITH_ABSOLUTE_EVIDENCE_PATH')}`,
    "$Catalogue = '.\\catalogue\\scenarios.json'",
    "if (-not (Test-Path -LiteralPath (Join-Path $Evidence 'manifest.json'))) {",
    '    python -m poc_evidence init --catalogue $Catalogue --evidence-dir $Evidence',
    '}',
    ''
  ];
  let count = 0;
  for (const item of model.cases) {
    const record = engagement.cases?.[item.id];
    if (!record) continue;
    const lines = [];
    const phases = compute.PHASES.filter(phase => compute.phaseResult(record, phase) !== 'NOT_RUN');
    const agent = record.agent || item.default_agent;
    const kind = record.evidence_kind || 'live_product';
    const artifacts = (record.evidence_refs || []).filter(ref => SAFE_ARTIFACT.test(ref));
    const rejected = (record.evidence_refs || []).filter(ref => !SAFE_ARTIFACT.test(ref));
    for (const ref of rejected) lines.push(`# Skipped artifact (use a path relative to the evidence root): ${ref.replace(/[\r\n]/g, ' ')}`);
    for (const phase of phases) {
      const result = compute.phaseResult(record, phase);
      const reason = (record.phases[phase].reason || record.customer_summary || `${result} recorded in the PoC tracker.`).replace(/[\r\n]+/g, ' ').slice(0, 4096);
      const parts = [
        'python -m poc_evidence record --evidence-dir $Evidence --catalogue $Catalogue',
        `--scenario ${psQuote(item.id)}`,
        `--agent ${psQuote(agent || 'REPLACE_WITH_AGENT_ALIAS')}`,
        `--phase ${phase}`,
        `--result ${result}`,
        `--reason ${psQuote(reason)}`,
        `--evidence-kind ${kind}`
      ];
      for (const artifact of artifacts) parts.push(`--artifact ${psQuote(artifact)}`);
      if (record.correlation_id && SAFE_CORRELATION.test(record.correlation_id)) parts.push(`--correlation-id ${psQuote(record.correlation_id)}`);
      const command = parts.join(' ');
      if (!agent) lines.push('# Set a fixed agent or test-set alias before running the next command.', `# ${command}`);
      else if (result === 'PASS' && !artifacts.length) lines.push('# PASS needs at least one artifact. Add an evidence reference, then run:', `# ${command}`);
      else lines.push(command);
      count += 1;
    }
    if (compute.isExcluded(record)) {
      lines.push([
        'python -m poc_evidence record --evidence-dir $Evidence --catalogue $Catalogue',
        `--scenario ${psQuote(item.id)} --exclude`,
        `--reason ${psQuote(record.exclusion.reason.replace(/[\r\n]+/g, ' '))}`,
        `--approved-by ${psQuote(record.exclusion.approved_by)}`,
        `--approved-date ${record.exclusion.approved_date}`
      ].join(' '));
      count += 1;
    }
    if (lines.length) out.push(`# ${item.id}: ${item.title}`, ...lines, '');
  }
  if (!count) out.push('# No phase result or exclusion is recorded yet.', '');
  out.push('python -m poc_evidence report --evidence-dir $Evidence --catalogue $Catalogue --format text', '');
  return out.join('\r\n');
}

async function fixtureDocx(model, id) {
  const fixture = model.fixtures.find(item => item.id === id && item.formats.includes('docx'));
  if (!fixture) return null;
  const lines = fixture.text.trimEnd().split(/\r?\n/);
  const document = new Document({
    creator: 'Agent 365 Security PoC site',
    title: `Synthetic PoC fixture: ${id}`,
    sections: [{
      children: lines.map(line => new Paragraph({
        children: [new TextRun({ text: line, font: 'Aptos', size: 22 })],
        spacing: { after: 120 }
      }))
    }]
  });
  return Packer.toBuffer(document);
}

module.exports = { referencePackFiles, pocPlan, evidenceCommands, fixtureDocx, guideFile, caseFile, SAFE_ARTIFACT };
