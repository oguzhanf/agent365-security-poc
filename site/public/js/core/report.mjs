// Report model shared by the browser preview and the server downloads.
// A report is a list of blocks. Renderers turn blocks into Markdown, HTML, or DOCX.
// Only customer-shareable content enters a report: case summaries, notes marked
// shareable, and blocked-step reasons. Internal notes never appear.

import * as C from './compute.mjs';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]);

const cell = (text, status) => (status ? { text: String(text ?? ''), status } : String(text ?? ''));
const cellText = value => (value && typeof value === 'object' ? value.text : String(value ?? ''));
const cellStatus = value => (value && typeof value === 'object' ? value.status : '');
const lines = value => String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);

function datePart(value) {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function addDays(dateString, days) {
  const date = C.parseDate(dateString);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return C.formatDate(date);
}

export function defaultPeriod(engagement, now = new Date()) {
  const to = C.todayString(now);
  let from = addDays(to, -6);
  const start = engagement?.settings?.start_date;
  if (C.parseDate(start) && start > from && start <= to) from = start;
  return { from, to };
}

function statusText(result) {
  return C.RESULT_LABELS[result] || result;
}

function engagementLabel(engagement) {
  const settings = engagement.settings || {};
  return settings.customer || settings.name || engagement.id;
}

class Builder {
  constructor() { this.blocks = []; }
  add(block) { this.blocks.push(block); return this; }
  h1(text) { return this.add({ type: 'h1', text }); }
  h2(text) { return this.add({ type: 'h2', text }); }
  p(text) { if (text) this.add({ type: 'p', text }); return this; }
  paragraphs(value) { for (const line of lines(value)) this.p(line); return this; }
  bullets(items) { if (items.length) this.add({ type: 'bullets', items }); return this; }
  kpis(items) { return this.add({ type: 'kpis', items }); }
  table(headers, rows, widths) { if (rows.length) this.add({ type: 'table', headers, rows, widths }); return this; }
  callout(text, tone = 'info') { return this.add({ type: 'callout', text, tone }); }
}

function titleBlock(model, engagement, kind, meta) {
  const settings = engagement.settings || {};
  const tenant = settings.tenant || {};
  const subtitleParts = [engagementLabel(engagement)];
  if (tenant.name && tenant.name !== subtitleParts[0]) subtitleParts.push(tenant.name);
  return {
    type: 'title',
    text: `${model.document.title}: ${kind}`,
    subtitle: subtitleParts.join(' | '),
    meta
  };
}

function kpiItems(model, engagement, s) {
  const agreed = s.acceptance.agreed;
  return [
    { label: 'Configuration steps', value: `${s.steps.done} / ${s.steps.applicable}`, detail: `${s.steps.pct}% complete` },
    { label: 'Live use cases passed', value: `${agreed.passed} / ${agreed.denominator}`, detail: `${s.live_cases.counts.FAIL} fail, ${s.live_cases.counts.BLOCKED} blocked` },
    { label: 'Demonstrations delivered', value: `${s.demos.delivered} / ${s.demos.total}`, detail: `${s.demos.counts.SCHEDULED} scheduled` },
    { label: 'Blocked items', value: String(s.blocked), detail: `${s.notes.open_risks} open risks, ${s.notes.open_issues} open issues` }
  ];
}

function planRows(s) {
  return s.buckets.filter(bucket => bucket.has_work).map(bucket => {
    const dates = bucket.start ? (bucket.start === bucket.end ? bucket.start : `${bucket.start} to ${bucket.end}`) : 'Before Days 13-14';
    const caseText = bucket.case_ids.length ? `${bucket.cases.passed} of ${bucket.case_ids.length} passed` : '';
    const demoText = bucket.demo_ids.length ? `${bucket.demos.delivered} of ${bucket.demo_ids.length} demonstrated` : '';
    const state = { complete: 'Complete', in_progress: 'In progress', not_started: 'Not started' }[bucket.state];
    return [
      `${bucket.label}: ${bucket.title}`,
      dates,
      bucket.steps.total ? `${bucket.steps.done} of ${bucket.steps.applicable}` : '-',
      [caseText, demoText].filter(Boolean).join('; ') || '-',
      cell(state + (bucket.blocked ? ` (${bucket.blocked} blocked)` : ''), bucket.state === 'complete' ? 'PASS' : bucket.blocked ? 'BLOCKED' : bucket.state === 'in_progress' ? 'IN_PROGRESS' : 'NOT_RUN')
    ];
  });
}

function liveCaseRows(model, engagement, includeSummary = true) {
  return model.cases.filter(item => item.scope === 'live').map(item => {
    const record = engagement.cases?.[item.id];
    const result = C.acceptanceResult(item, record);
    const display = C.caseDisplayStatus(item, record);
    const excluded = C.isExcluded(record);
    const row = [
      item.id,
      item.title,
      item.layer_label,
      cell(statusText(C.phaseResult(record, 'positive')), C.phaseResult(record, 'positive')),
      cell(statusText(C.phaseResult(record, 'negative')), C.phaseResult(record, 'negative')),
      cell(excluded ? `${statusText(display)} (excluded)` : statusText(display), display === 'IN_PROGRESS' ? 'IN_PROGRESS' : result)
    ];
    if (includeSummary) row.push(record?.customer_summary || '');
    return row;
  });
}

function demoRows(model, engagement, onlyRecorded) {
  return model.cases.filter(item => item.scope === 'demo')
    .filter(item => !onlyRecorded || C.demoStatus(engagement.cases?.[item.id]) !== 'NOT_SCHEDULED')
    .map(item => {
      const demo = engagement.cases?.[item.id]?.demo || {};
      const status = C.demoStatus(engagement.cases?.[item.id]);
      return [
        item.id,
        item.title,
        cell(C.DEMO_LABELS[status], status === 'DEMONSTRATED' ? 'PASS' : status === 'DEFERRED' ? 'NOT_APPLICABLE' : status === 'NOT_SCHEDULED' ? 'NOT_RUN' : 'IN_PROGRESS'),
        demo.date || '',
        demo.audience || '',
        demo.environment || '',
        demo.shown || ''
      ];
    });
}

function shareableNotes(engagement, filter) {
  return (engagement.notes || [])
    .filter(note => note.shareable)
    .filter(filter || (() => true))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

function blockedRows(model, engagement) {
  return C.blockedItems(model, engagement).map(item => [
    item.id,
    item.title,
    item.reason || 'Reason not recorded',
    datePart(item.since)
  ]);
}

function guideLabel(model, guideId) {
  const guide = model.guides.find(item => item.id === guideId);
  return guide ? `Guide ${String(guide.number).padStart(2, '0')}: ${guide.title}` : guideId;
}

function progressReport(model, engagement, s, options) {
  const { from, to, today } = options;
  const settings = engagement.settings || {};
  const report = settings.report || {};
  const inPeriod = value => {
    const date = datePart(value);
    return date && date >= from && date <= to;
  };
  const current = s.buckets.find(bucket => bucket.current);
  const b = new Builder();
  b.add(titleBlock(model, engagement, 'Progress report', [
    ['Report date', today],
    ['Reporting period', `${from} to ${to}`],
    ['Plan position', s.day === null ? 'Start date not set' : s.day <= 0 ? 'Not started' : `Day ${s.day} of ${C.PLAN_DAYS}${current ? ` (${current.label}: ${current.title})` : ''}`],
    ['Overall status', C.RAG[report.status] || C.RAG.on_track],
    ['Prepared by', settings.prepared_by || '']
  ].filter(([, value]) => value)));

  b.h1('Summary');
  b.kpis(kpiItems(model, engagement, s));
  b.paragraphs(report.status_comment);
  b.paragraphs(report.key_messages);

  b.h1('Plan status');
  b.table(['Plan window', 'Dates', 'Configuration steps', 'Use cases', 'Status'], planRows(s), [2600, 1500, 1300, 2200, 1760]);

  b.h1('Live-proofed use cases');
  b.p(`Acceptance for this PoC is assessed against the agreed live-proofed set of ${s.acceptance.agreed.denominator} use cases. Each case needs a passing positive and negative phase.`);
  b.table(['Case', 'Use case', 'Security area', 'Positive', 'Negative', 'Result', 'Summary'], liveCaseRows(model, engagement), [900, 2300, 1300, 900, 900, 1000, 2060]);

  const demos = demoRows(model, engagement, true);
  b.h1('Demonstrations');
  if (demos.length) {
    b.table(['Case', 'Use case', 'Status', 'Date', 'Audience', 'Environment', 'What was shown'], demos, [900, 2000, 1100, 1000, 1300, 1200, 1860]);
  } else {
    b.p('No demonstration has been scheduled or delivered yet. Demonstration-only items are planned for Days 13-14.');
  }

  b.h1(`Progress from ${from} to ${to}`);
  const doneSteps = C.includedSteps(model, engagement).filter(step => {
    const record = engagement.steps[step.id];
    return C.stepStatus(engagement, step.id) === 'done' && inPeriod(record.done_at || record.updated_at);
  });
  const byGuide = new Map();
  for (const step of doneSteps) byGuide.set(step.guide, (byGuide.get(step.guide) || 0) + 1);
  const progressItems = [];
  progressItems.push(`${doneSteps.length} configuration steps completed in this period.`);
  for (const [guideId, count] of byGuide) progressItems.push(`${guideLabel(model, guideId)}: ${count} step${count === 1 ? '' : 's'}.`);
  const completedCases = model.cases.filter(item => inPeriod(engagement.cases?.[item.id]?.completed_at));
  for (const item of completedCases) {
    progressItems.push(`${item.id} ${item.title}: ${statusText(C.acceptanceResult(item, engagement.cases[item.id]))}.`);
  }
  const deliveredDemos = model.cases.filter(item => C.demoStatus(engagement.cases?.[item.id]) === 'DEMONSTRATED' && inPeriod(engagement.cases[item.id].demo.date));
  for (const item of deliveredDemos) progressItems.push(`Demonstrated ${item.id} ${item.title}.`);
  b.bullets(progressItems);

  b.h1('Blocked items');
  const blocked = blockedRows(model, engagement);
  if (blocked.length) b.table(['Item', 'Description', 'Reason', 'Since'], blocked, [1100, 3900, 3200, 1160]);
  else b.p('No blocked items.');

  b.h1('Risks, issues, and actions');
  const raid = shareableNotes(engagement, note => ['risk', 'issue', 'action'].includes(note.category) && (!note.resolved || inPeriod(note.updated_at)));
  if (raid.length) {
    b.table(['Type', 'Title', 'Owner', 'Due', 'Status'], raid.map(note => [
      C.NOTE_LABELS[note.category], note.title, note.owner || '', note.due || '',
      cell(note.resolved ? 'Closed' : 'Open', note.resolved ? 'PASS' : note.category === 'risk' || note.category === 'issue' ? 'BLOCKED' : 'IN_PROGRESS')
    ]), [1100, 4300, 1600, 1100, 1260]);
  } else {
    b.p('No shared risks, issues, or actions are open.');
  }

  const shared = shareableNotes(engagement, note => !['risk', 'issue', 'action'].includes(note.category) && inPeriod(note.date || note.created_at));
  b.h1('Decisions and notes');
  if (shared.length) {
    b.table(['Date', 'Type', 'Title', 'Details'], shared.map(note => [note.date || datePart(note.created_at), C.NOTE_LABELS[note.category], note.title, note.body || '']), [1100, 1100, 2400, 4760]);
  } else {
    b.p('No shared notes in this period.');
  }

  b.h1('Next steps');
  const next = s.buckets.find(bucket => bucket.has_work && bucket.state !== 'complete');
  const nextItems = [];
  if (next) {
    const ids = [...next.case_ids, ...next.demo_ids];
    nextItems.push(`${next.label}: ${next.title}. ${next.summary}${ids.length ? ` Use cases: ${ids.join(', ')}.` : ''}`);
  }
  nextItems.push(...lines(report.next_steps));
  b.bullets(nextItems);
  return b.blocks;
}

function finalReport(model, engagement, s, options) {
  const { today } = options;
  const settings = engagement.settings || {};
  const report = settings.report || {};
  const acceptance = s.acceptance;
  const b = new Builder();
  const period = settings.start_date ? `${settings.start_date} to ${settings.end_date || C.formatDate(C.planDayDate(engagement, C.PLAN_DAYS))}` : '';
  b.add(titleBlock(model, engagement, 'Final report', [
    ['Report date', today],
    ['Execution window', period],
    ['Scope document', `Revision ${model.document.revision}`],
    ['Prepared by', settings.prepared_by || '']
  ].filter(([, value]) => value)));

  b.h1('Executive summary');
  if (lines(report.executive_summary).length) {
    b.paragraphs(report.executive_summary);
  } else {
    b.p(`The Agent 365 Security PoC tested agent onboarding and security controls across ${model.live_areas.length} live-proofed areas.`);
    b.p(`${acceptance.agreed.passed} of ${acceptance.agreed.denominator} agreed live-proofed use cases passed. ${s.demos.delivered} of ${s.demos.total} demonstration-only items were demonstrated.`);
  }
  b.kpis(kpiItems(model, engagement, s));

  b.h1('Scope and approach');
  b.p(`The scope document (revision ${model.document.revision}) defines what the PoC shows, how it is judged, and what runs live in the evaluation tenant.`);
  b.bullets(model.overview.modes.map(mode => `${mode.name}: ${mode.text}`));
  b.p(model.overview.deferred_required);
  if (acceptance.excluded.length) {
    b.h2('Approved scope changes');
    b.table(['Case', 'Use case', 'Reason', 'Approved by', 'Date'], acceptance.excluded.map(item => [item.id, item.title, item.reason, item.approved_by, item.approved_date]), [900, 2800, 3300, 1300, 1060]);
  }

  b.h1('Acceptance results');
  const verdict = summaryValue => cell(summaryValue.achieved ? 'Achieved' : 'Not achieved', summaryValue.achieved ? 'PASS' : summaryValue.status_counts.FAIL ? 'FAIL' : summaryValue.status_counts.BLOCKED ? 'BLOCKED' : 'NOT_RUN');
  b.table(['Measure', 'Passed', 'Denominator', 'Result'], [
    ['Agreed live-proofed set', String(acceptance.agreed.passed), String(acceptance.agreed.denominator), verdict(acceptance.agreed)],
    ['Original catalogue, required cases', String(acceptance.original_required.passed), String(acceptance.original_required.denominator), verdict(acceptance.original_required)],
    ['Optional cases (reported separately)', String(acceptance.optional.passed), String(acceptance.optional.denominator), 'Not part of acceptance']
  ], [3900, 1300, 1500, 2660]);
  if (acceptance.simulation_only.length) {
    b.callout(`Local simulation evidence does not count as a live product result: ${acceptance.simulation_only.join(', ')}.`, 'warn');
  }
  b.h2('Results by security area');
  const liveCases = model.cases.filter(item => item.scope === 'live');
  const layers = C.groupStats(liveCases, item => item.layer_label, list => C.caseStats(list, engagement));
  b.table(['Security area', 'Pass', 'Fail', 'Blocked', 'Not applicable', 'Not run'], layers.map(layer => [
    layer.key, String(layer.counts.PASS), String(layer.counts.FAIL), String(layer.counts.BLOCKED), String(layer.counts.NOT_APPLICABLE), String(layer.counts.NOT_RUN)
  ]), [3360, 1200, 1200, 1200, 1200, 1200]);
  b.h2('Use case results');
  b.table(['Case', 'Use case', 'Security area', 'Positive', 'Negative', 'Result', 'Summary'], liveCaseRows(model, engagement), [900, 2300, 1300, 900, 900, 1000, 2060]);

  b.h1('Demonstrations');
  b.p(model.acceptance.demonstrations);
  b.table(['Case', 'Use case', 'Status', 'Date', 'Audience', 'Environment', 'What was shown'], demoRows(model, engagement, false), [900, 2000, 1100, 1000, 1300, 1200, 1860]);

  b.h1('Measured security value');
  const measurements = model.measurements.map(metric => {
    const record = engagement.measurements?.[metric.metric] || {};
    const label = metric.metric.replace(/_minutes$/, '').replace(/_/g, ' ');
    return [
      label.charAt(0).toUpperCase() + label.slice(1),
      `${metric.start_event} ${metric.end_event}`,
      record.target_minutes === null || record.target_minutes === undefined || record.target_minutes === '' ? 'Not set' : String(record.target_minutes),
      record.measured_minutes === null || record.measured_minutes === undefined || record.measured_minutes === '' ? 'Not measured' : String(record.measured_minutes),
      record.case || ''
    ];
  });
  b.table(['Metric', 'Measured interval', 'Target (minutes)', 'Measured (minutes)', 'Case'], measurements, [1500, 4200, 1200, 1300, 1160]);

  b.h1('Coverage gaps and limitations');
  const gaps = [];
  for (const gap of model.known_gaps) gaps.push(`${gap.capability}: not listed in the reviewed support documentation as of ${gap.source_as_of}.`);
  for (const item of liveCases) {
    const record = engagement.cases?.[item.id];
    const result = C.acceptanceResult(item, record);
    if (['FAIL', 'BLOCKED', 'NOT_APPLICABLE'].includes(result)) {
      const reasons = C.PHASES.map(phase => record.phases?.[phase]?.reason).filter(Boolean).join(' ');
      gaps.push(`${item.id} ${item.title}: ${statusText(result)}.${reasons ? ` ${reasons}` : ''}`);
    }
  }
  for (const item of model.cases.filter(entry => entry.scope === 'unscheduled')) gaps.push(`${item.id} ${item.title}: not scheduled in this PoC.`);
  b.bullets(gaps);

  b.h1('Configuration completed');
  const included = C.includedSteps(model, engagement);
  const guideRows = model.guides.map(guide => {
    const own = included.filter(step => step.guide === guide.id);
    if (!own.length) return null;
    const stats = C.stepStats(own, engagement);
    return [`Guide ${String(guide.number).padStart(2, '0')}`, guide.title, String(stats.done), String(stats.applicable), cell(`${stats.pct}%`, stats.complete ? 'PASS' : stats.blocked ? 'BLOCKED' : stats.done ? 'IN_PROGRESS' : 'NOT_RUN')];
  }).filter(Boolean);
  b.table(['Guide', 'Title', 'Done', 'Applicable', 'Complete'], guideRows, [1000, 5000, 1000, 1200, 1160]);

  b.h1('Tenant content and cleanup');
  b.p(model.cleanup);
  const inventory = C.inventoryItems(model, engagement).filter(item => item.status !== 'planned' || item.custom);
  if (inventory.length) {
    b.table(['Object', 'Type', 'Status', 'Owner', 'Notes'], inventory.map(item => [
      item.record.actual_name || item.name,
      (model.inventory_types.find(type => type.id === item.type) || {}).name || item.type,
      cell(model.inventory_statuses[item.status] || item.status, item.status === 'removed' || item.status === 'restored' ? 'PASS' : item.status === 'residual' ? 'BLOCKED' : item.status === 'pre-existing' || item.status === 'not-needed' ? 'NOT_APPLICABLE' : 'IN_PROGRESS'),
      item.record.owner || '',
      item.record.note || ''
    ]), [2600, 1700, 1500, 1300, 2260]);
  }
  if (s.inventory.residual) b.callout(`${s.inventory.residual} residual object(s) remain with a recorded owner.`, 'warn');
  if (s.inventory.outstanding_cleanup) b.callout(`${s.inventory.outstanding_cleanup} created object(s) are not yet removed or restored.`, 'warn');

  b.h1('Decisions, risks, and notes');
  const notes = shareableNotes(engagement);
  if (notes.length) {
    b.table(['Date', 'Type', 'Title', 'Details', 'Status'], notes.map(note => [
      note.date || datePart(note.created_at), C.NOTE_LABELS[note.category], note.title, note.body || '',
      ['risk', 'issue', 'action'].includes(note.category) ? (note.resolved ? 'Closed' : 'Open') : ''
    ]), [1100, 1100, 2200, 4000, 960]);
  } else {
    b.p('No notes were marked for sharing.');
  }

  b.h1('Recommendations and next steps');
  b.paragraphs(report.recommendations);
  const followUps = model.demo_items.filter(item => item.cases.some(id => C.demoStatus(engagement.cases?.[id]) !== 'DEMONSTRATED' || engagement.cases?.[id]?.demo?.follow_up));
  b.bullets([
    ...followUps.map(item => `Consider a follow-up live phase for ${item.title} (${item.cases.join(', ')}).`),
    ...lines(report.next_steps)
  ]);

  b.h1('Evidence statement');
  for (const text of model.acceptance.evidence) b.p(text);
  b.bullets(model.acceptance.cautions);
  if (settings.evidence_location) b.p(`Evidence is held in the protected evidence store: ${settings.evidence_location}.`);
  return b.blocks;
}

export function buildReport(model, engagement, options = {}) {
  const type = options.type === 'final' ? 'final' : 'progress';
  const now = options.now ? new Date(options.now) : new Date();
  const today = C.todayString(now);
  const period = defaultPeriod(engagement, now);
  const from = C.parseDate(options.from) ? options.from : period.from;
  const to = C.parseDate(options.to) ? options.to : period.to;
  const s = C.summary(model, engagement, now);
  const blocks = type === 'final'
    ? finalReport(model, engagement, s, { today })
    : progressReport(model, engagement, s, { from, to, today });
  const name = C.slug(engagementLabel(engagement)) || 'engagement';
  return {
    type,
    title: blocks[0].text,
    generated: today,
    period: { from, to },
    filename: `Agent365-PoC-${name}-${type}-report-${today}`,
    blocks
  };
}

function mdEscape(value) {
  return cellText(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderMarkdown(report) {
  const out = [];
  for (const block of report.blocks) {
    switch (block.type) {
      case 'title':
        out.push(`# ${block.text}`, '', `**${block.subtitle}**`, '');
        for (const [label, value] of block.meta) out.push(`- **${label}:** ${value}`);
        out.push('');
        break;
      case 'h1': out.push(`## ${block.text}`, ''); break;
      case 'h2': out.push(`### ${block.text}`, ''); break;
      case 'p': out.push(block.text, ''); break;
      case 'bullets': for (const item of block.items) out.push(`- ${item}`); out.push(''); break;
      case 'kpis':
        out.push('| Measure | Value | Detail |', '| --- | --- | --- |');
        for (const item of block.items) out.push(`| ${mdEscape(item.label)} | ${mdEscape(item.value)} | ${mdEscape(item.detail)} |`);
        out.push('');
        break;
      case 'table':
        out.push(`| ${block.headers.map(mdEscape).join(' | ')} |`, `| ${block.headers.map(() => '---').join(' | ')} |`);
        for (const row of block.rows) out.push(`| ${row.map(mdEscape).join(' | ')} |`);
        out.push('');
        break;
      case 'callout': out.push(`> **Note:** ${block.text}`, ''); break;
      default: break;
    }
  }
  return out.join('\n').trimEnd() + '\n';
}

function htmlCell(value, tag) {
  const status = cellStatus(value);
  const text = escapeHtml(cellText(value));
  return status ? `<${tag}><span class="st st-${escapeHtml(status)}">${text}</span></${tag}>` : `<${tag}>${text}</${tag}>`;
}

export function renderHtml(report) {
  const out = ['<article class="report">'];
  for (const block of report.blocks) {
    switch (block.type) {
      case 'title':
        out.push('<header class="r-title">', `<div class="r-brand">Microsoft Security | Agent 365</div>`, `<h1>${escapeHtml(block.text)}</h1>`, `<p class="r-sub">${escapeHtml(block.subtitle)}</p>`, '<dl class="r-meta">');
        for (const [label, value] of block.meta) out.push(`<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`);
        out.push('</dl>', '</header>');
        break;
      case 'h1': out.push(`<h2 class="r-h1">${escapeHtml(block.text)}</h2>`); break;
      case 'h2': out.push(`<h3 class="r-h2">${escapeHtml(block.text)}</h3>`); break;
      case 'p': out.push(`<p>${escapeHtml(block.text)}</p>`); break;
      case 'bullets': out.push('<ul>', ...block.items.map(item => `<li>${escapeHtml(item)}</li>`), '</ul>'); break;
      case 'kpis':
        out.push('<div class="r-kpis">');
        for (const item of block.items) {
          out.push(`<div class="r-kpi"><div class="r-kpi-value">${escapeHtml(item.value)}</div><div class="r-kpi-label">${escapeHtml(item.label)}</div><div class="r-kpi-detail">${escapeHtml(item.detail)}</div></div>`);
        }
        out.push('</div>');
        break;
      case 'table':
        out.push('<div class="r-table-wrap"><table class="r-table"><thead><tr>', ...block.headers.map(header => htmlCell(header, 'th')), '</tr></thead><tbody>');
        for (const row of block.rows) out.push('<tr>', ...row.map(value => htmlCell(value, 'td')), '</tr>');
        out.push('</tbody></table></div>');
        break;
      case 'callout': out.push(`<div class="r-callout r-callout-${escapeHtml(block.tone)}">${escapeHtml(block.text)}</div>`); break;
      default: break;
    }
  }
  out.push('</article>');
  return out.join('\n');
}

export { cellText, cellStatus };
