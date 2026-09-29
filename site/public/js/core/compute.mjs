// Shared PoC computations. Loaded by the browser as an ES module and by the
// Node server through dynamic import(). Keep this file free of DOM and Node APIs.

export const STEP_STATUSES = ['todo', 'in_progress', 'done', 'blocked', 'skipped'];
export const STEP_LABELS = { todo: 'To do', in_progress: 'In progress', done: 'Done', blocked: 'Blocked', skipped: 'Not applicable' };
export const PHASES = ['positive', 'negative', 'control'];
export const RESULTS = ['NOT_RUN', 'PASS', 'FAIL', 'BLOCKED', 'NOT_APPLICABLE'];
export const RESULT_LABELS = { NOT_RUN: 'Not run', PASS: 'Pass', FAIL: 'Fail', BLOCKED: 'Blocked', NOT_APPLICABLE: 'Not applicable', IN_PROGRESS: 'In progress' };
// Status precedence from evidence-format.txt: FAIL, BLOCKED, NOT_APPLICABLE, NOT_RUN, PASS.
export const PRECEDENCE = ['FAIL', 'BLOCKED', 'NOT_APPLICABLE', 'NOT_RUN', 'PASS'];
export const FINAL_RESULTS = ['PASS', 'FAIL', 'BLOCKED', 'NOT_APPLICABLE'];
export const EVIDENCE_KINDS = ['live_product', 'local_simulation'];
export const DEMO_STATUSES = ['NOT_SCHEDULED', 'PREPARED', 'SCHEDULED', 'DEMONSTRATED', 'DEFERRED'];
export const DEMO_LABELS = { NOT_SCHEDULED: 'Not scheduled', PREPARED: 'Prepared', SCHEDULED: 'Scheduled', DEMONSTRATED: 'Demonstrated', DEFERRED: 'Deferred to follow-up' };
export const NOTE_CATEGORIES = ['meeting', 'decision', 'risk', 'issue', 'action', 'observation', 'general'];
export const NOTE_LABELS = { meeting: 'Meeting', decision: 'Decision', risk: 'Risk', issue: 'Issue', action: 'Action', observation: 'Observation', general: 'General' };
export const RAG = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', complete: 'Complete' };
export const ROLES = { evaluation: 'Customer evaluation tenant', demonstration: 'Demonstration tenant' };
export const SCOPE_LABELS = { live: 'Live-proofed', optional: 'Optional', demo: 'Demonstration only', unscheduled: 'Unscheduled optional' };
export const PLAN_DAYS = 14;

export function defaultScopes(role) {
  return role === 'demonstration'
    ? { live: true, optional: true, demo: true }
    : { live: true, optional: false, demo: false };
}

export function stepScopes(engagement) {
  const scopes = engagement?.settings?.scopes || defaultScopes(engagement?.settings?.role);
  return new Set(['live', 'optional', 'demo'].filter(name => scopes[name]));
}

export function caseScopes(engagement) {
  const scopes = stepScopes(engagement);
  const result = new Set(['live']);
  if (scopes.has('demo')) result.add('demo');
  if (scopes.has('optional')) result.add('unscheduled');
  return result;
}

export function stepStatus(engagement, stepId) {
  return engagement?.steps?.[stepId]?.status || 'todo';
}

export function phaseResult(record, phase) {
  return record?.phases?.[phase]?.result || 'NOT_RUN';
}

// Aggregate case result under the evidence recorder's rules: both required
// phases must pass; an optional control phase can only prevent a pass.
export function caseResult(record) {
  const statuses = [phaseResult(record, 'positive'), phaseResult(record, 'negative')];
  const control = phaseResult(record, 'control');
  if (control !== 'NOT_RUN' && control !== 'PASS') statuses.push(control);
  for (const status of PRECEDENCE) if (statuses.includes(status)) return status;
  return 'NOT_RUN';
}

// Result that counts toward acceptance. Local simulation evidence cannot
// satisfy a live_product case.
export function acceptanceResult(caseModel, record) {
  const kind = record?.evidence_kind || 'live_product';
  if ((caseModel?.validation_kind || 'live_product') === 'live_product' && kind !== 'live_product') return 'NOT_RUN';
  return caseResult(record);
}

export function hasCaseActivity(record) {
  if (!record) return false;
  if (PHASES.some(phase => phaseResult(record, phase) !== 'NOT_RUN')) return true;
  return Object.values(record.checklist || {}).some(Boolean);
}

export function caseDisplayStatus(caseModel, record) {
  const result = acceptanceResult(caseModel, record);
  if (result === 'NOT_RUN' && hasCaseActivity(record)) return 'IN_PROGRESS';
  return result;
}

export function demoStatus(record) {
  return record?.demo?.status || 'NOT_SCHEDULED';
}

export function isExcluded(record) {
  return Boolean(record?.exclusion && record.exclusion.reason && record.exclusion.approved_by && record.exclusion.approved_date);
}

export function includedSteps(model, engagement) {
  const scopes = stepScopes(engagement);
  return model.steps.filter(step => scopes.has(step.scope));
}

export function includedCases(model, engagement) {
  const scopes = caseScopes(engagement);
  return model.cases.filter(item => scopes.has(item.scope));
}

// Display numbers follow plan order across the included scopes.
export function stepNumbers(model, engagement) {
  const numbers = new Map();
  includedSteps(model, engagement).forEach((step, index) => numbers.set(step.id, index + 1));
  return numbers;
}

export function stepStats(steps, engagement) {
  const stats = { total: steps.length, todo: 0, in_progress: 0, done: 0, blocked: 0, skipped: 0 };
  for (const step of steps) stats[stepStatus(engagement, step.id)] += 1;
  stats.applicable = stats.total - stats.skipped;
  stats.pct = stats.applicable ? Math.round((stats.done / stats.applicable) * 1000) / 10 : 0;
  stats.complete = stats.total > 0 && stats.done === stats.applicable;
  return stats;
}

export function emptyCounts() {
  return { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_APPLICABLE: 0, NOT_RUN: 0, IN_PROGRESS: 0 };
}

export function caseStats(cases, engagement) {
  const counts = emptyCounts();
  for (const item of cases) {
    const record = engagement?.cases?.[item.id];
    const result = acceptanceResult(item, record);
    counts[result] += 1;
    if (result === 'NOT_RUN' && hasCaseActivity(record)) counts.IN_PROGRESS += 1;
  }
  const total = cases.length;
  const final = counts.PASS + counts.FAIL + counts.BLOCKED + counts.NOT_APPLICABLE;
  return { total, counts, passed: counts.PASS, final, pct: total ? Math.round((counts.PASS / total) * 1000) / 10 : 0 };
}

function summaryOf(cases, engagement) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_APPLICABLE: 0, NOT_RUN: 0 };
  for (const item of cases) counts[acceptanceResult(item, engagement?.cases?.[item.id])] += 1;
  const denominator = cases.length;
  let status = null;
  if (denominator) for (const candidate of PRECEDENCE) if (counts[candidate]) { status = candidate; break; }
  return {
    passed: counts.PASS,
    denominator,
    status_counts: counts,
    status,
    achieved: denominator > 0 && counts.PASS === denominator
  };
}

export function acceptance(model, engagement) {
  const live = model.cases.filter(item => item.scope === 'live');
  const excluded = live.filter(item => isExcluded(engagement?.cases?.[item.id]));
  const agreed = live.filter(item => !excluded.includes(item));
  const required = model.cases.filter(item => item.required);
  const optional = model.cases.filter(item => !item.required);
  const simulated = model.cases.filter(item => {
    const record = engagement?.cases?.[item.id];
    return record && record.evidence_kind === 'local_simulation' && caseResult(record) === 'PASS';
  });
  return {
    live_set: summaryOf(live, engagement),
    agreed: summaryOf(agreed, engagement),
    original_required: summaryOf(required, engagement),
    optional: summaryOf(optional, engagement),
    excluded: excluded.map(item => ({ id: item.id, title: item.title, ...engagement.cases[item.id].exclusion })),
    simulation_only: simulated.map(item => item.id),
    achieved: agreed.length > 0 && summaryOf(agreed, engagement).achieved
  };
}

export function demoStats(cases, engagement) {
  const counts = Object.fromEntries(DEMO_STATUSES.map(status => [status, 0]));
  for (const item of cases) counts[demoStatus(engagement?.cases?.[item.id])] += 1;
  return { total: cases.length, counts, delivered: counts.DEMONSTRATED };
}

// Calendar helpers work on YYYY-MM-DD strings in UTC to avoid time-zone drift.
export function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(date) {
  return date ? date.toISOString().slice(0, 10) : '';
}

export function todayString(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

const isWeekend = date => date.getUTCDay() === 0 || date.getUTCDay() === 6;

export function planDayDate(engagement, day) {
  const start = parseDate(engagement?.settings?.start_date);
  if (!start || !day) return null;
  const date = new Date(start);
  if ((engagement.settings.calendar || 'calendar') === 'working') {
    while (isWeekend(date)) date.setUTCDate(date.getUTCDate() + 1);
    let remaining = day - 1;
    while (remaining > 0) {
      date.setUTCDate(date.getUTCDate() + 1);
      if (!isWeekend(date)) remaining -= 1;
    }
    return date;
  }
  date.setUTCDate(date.getUTCDate() + day - 1);
  return date;
}

export function planDay(engagement, now = new Date()) {
  const start = parseDate(engagement?.settings?.start_date);
  const today = parseDate(todayString(now));
  if (!start || !today) return null;
  if (today < start) return 0;
  if ((engagement.settings.calendar || 'calendar') === 'working') {
    const cursor = new Date(start);
    while (isWeekend(cursor)) cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (today < cursor) return 0;
    let day = 1;
    while (cursor < today) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (!isWeekend(cursor) && cursor <= today) day += 1;
    }
    return day;
  }
  return Math.floor((today - start) / 86400000) + 1;
}

export function currentBucket(model, engagement, now = new Date()) {
  const day = planDay(engagement, now);
  if (day === null) return null;
  if (day <= 0) return model.buckets[0].id;
  const match = model.buckets.find(bucket => bucket.first_day && day >= bucket.first_day && day <= bucket.last_day);
  if (match) return match.id;
  return model.buckets[model.buckets.length - 1].id;
}

export function bucketSummaries(model, engagement, now = new Date()) {
  const steps = includedSteps(model, engagement);
  const cases = includedCases(model, engagement);
  const current = currentBucket(model, engagement, now);
  return model.buckets.map(bucket => {
    const bucketSteps = steps.filter(step => step.bucket === bucket.id);
    const liveCases = cases.filter(item => item.bucket === bucket.id && item.scope !== 'demo');
    const demoCases = cases.filter(item => item.bucket === bucket.id && item.scope === 'demo');
    const stepSummary = stepStats(bucketSteps, engagement);
    const caseSummary = caseStats(liveCases, engagement);
    const demoSummary = demoStats(demoCases, engagement);
    const demoFinal = demoSummary.counts.DEMONSTRATED + demoSummary.counts.DEFERRED;
    const hasWork = bucketSteps.length + liveCases.length + demoCases.length > 0;
    const complete = hasWork && stepSummary.done === stepSummary.applicable &&
      caseSummary.final === liveCases.length && demoFinal === demoCases.length;
    const started = stepSummary.done + stepSummary.in_progress + stepSummary.blocked + stepSummary.skipped +
      caseSummary.final + caseSummary.counts.IN_PROGRESS + demoSummary.total - demoSummary.counts.NOT_SCHEDULED > 0;
    const first = planDayDate(engagement, bucket.first_day);
    const last = planDayDate(engagement, bucket.last_day);
    return {
      ...bucket,
      start: formatDate(first),
      end: formatDate(last),
      steps: stepSummary,
      cases: caseSummary,
      demos: demoSummary,
      case_ids: liveCases.map(item => item.id),
      demo_ids: demoCases.map(item => item.id),
      has_work: hasWork,
      blocked: stepSummary.blocked + caseSummary.counts.BLOCKED,
      state: !hasWork ? 'empty' : complete ? 'complete' : started ? 'in_progress' : 'not_started',
      current: bucket.id === current
    };
  });
}

export function groupStats(items, keyOf, statsOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, ...statsOf(list) }));
}

export function noteStats(engagement) {
  const notes = engagement?.notes || [];
  const open = category => notes.filter(note => note.category === category && !note.resolved).length;
  return {
    total: notes.length,
    shareable: notes.filter(note => note.shareable).length,
    open_actions: open('action'),
    open_risks: open('risk'),
    open_issues: open('issue'),
    decisions: notes.filter(note => note.category === 'decision').length
  };
}

export function inventoryItems(model, engagement) {
  const custom = engagement?.custom_inventory || [];
  return [...model.inventory_template, ...custom].map(item => ({
    ...item,
    record: engagement?.inventory?.[item.id] || {},
    status: engagement?.inventory?.[item.id]?.status || 'planned'
  }));
}

export function inventoryStats(model, engagement) {
  const scopes = stepScopes(engagement);
  const items = inventoryItems(model, engagement).filter(item => item.custom || scopes.has(item.scope));
  const counts = Object.fromEntries(Object.keys(model.inventory_statuses).map(status => [status, 0]));
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  const outstanding = items.filter(item => ['created', 'verified'].includes(item.status));
  return { total: items.length, counts, outstanding_cleanup: outstanding.length, residual: counts.residual || 0 };
}

export function blockedItems(model, engagement) {
  const steps = includedSteps(model, engagement)
    .filter(step => stepStatus(engagement, step.id) === 'blocked')
    .map(step => ({ kind: 'step', id: step.id, title: step.text, reason: engagement.steps[step.id].note || '', since: engagement.steps[step.id].updated_at || '' }));
  const cases = includedCases(model, engagement)
    .filter(item => acceptanceResult(item, engagement?.cases?.[item.id]) === 'BLOCKED')
    .map(item => {
      const record = engagement.cases[item.id];
      const reasons = PHASES.map(phase => record.phases?.[phase]).filter(phase => phase && phase.result === 'BLOCKED' && phase.reason).map(phase => phase.reason);
      return { kind: 'case', id: item.id, title: item.title, reason: reasons.join(' ') || record.customer_summary || '', since: record.updated_at || '' };
    });
  return [...cases, ...steps];
}

export function nextSteps(model, engagement, limit = 8) {
  return includedSteps(model, engagement)
    .filter(step => !['done', 'skipped'].includes(stepStatus(engagement, step.id)))
    .slice(0, limit);
}

export function summary(model, engagement, now = new Date()) {
  const steps = includedSteps(model, engagement);
  const cases = includedCases(model, engagement);
  const live = cases.filter(item => item.scope === 'live');
  const demo = model.cases.filter(item => item.scope === 'demo');
  return {
    steps: stepStats(steps, engagement),
    live_cases: caseStats(live, engagement),
    all_cases: caseStats(cases, engagement),
    demos: demoStats(demo, engagement),
    acceptance: acceptance(model, engagement),
    buckets: bucketSummaries(model, engagement, now),
    day: planDay(engagement, now),
    current_bucket: currentBucket(model, engagement, now),
    notes: noteStats(engagement),
    inventory: inventoryStats(model, engagement),
    blocked: blockedItems(model, engagement).length
  };
}

// Compact daily snapshot used for the burn-up chart.
export function snapshot(model, engagement) {
  const steps = stepStats(includedSteps(model, engagement), engagement);
  const live = caseStats(model.cases.filter(item => item.scope === 'live'), engagement);
  const demos = demoStats(model.cases.filter(item => item.scope === 'demo'), engagement);
  return { steps_done: steps.done, steps_applicable: steps.applicable, cases_passed: live.passed, cases_final: live.final, demos_delivered: demos.delivered };
}

export function tenantUrl(area, engagement) {
  if (!area || !area.url) return '';
  const tenant = engagement?.settings?.tenant || {};
  if (area.tenant_param && /^[0-9a-f-]{36}$/i.test(tenant.tenant_id || '')) {
    return `${area.url}/?${area.tenant_param}=${encodeURIComponent(tenant.tenant_id)}`;
  }
  if (area.tenant_hash && tenant.domain && /^[A-Za-z0-9.-]+$/.test(tenant.domain)) {
    return `${area.url}/#@${tenant.domain}`;
  }
  return area.url;
}

export function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
