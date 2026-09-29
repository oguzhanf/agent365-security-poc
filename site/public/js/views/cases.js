import * as C from '../core/compute.mjs';
import {
  h, clear, pageHead, card, bar, badge, resultBadge, scopeBadge, demoBadge, selectEl, field, btn, linkBtn,
  guideChip, richText, fmtDateTime, debounce, toast, confirmDialog
} from '../ui.js';

const DISPLAY_STATUSES = ['NOT_RUN', 'IN_PROGRESS', 'PASS', 'FAIL', 'BLOCKED', 'NOT_APPLICABLE'];

function bucketLabel(model, id) {
  const bucket = model.buckets.find(item => item.id === id);
  return bucket ? bucket.label : 'Not scheduled';
}

export function casesView(ctx) {
  const { model, route } = ctx;
  const eng = ctx.current();
  const q = route.query;
  const filters = {
    scope: q.get('scope') || '',
    bucket: q.get('bucket') || '',
    layer: q.get('layer') || '',
    family: q.get('family') || '',
    status: q.get('status') || '',
    text: q.get('q') || ''
  };
  const live = model.cases.filter(item => item.scope === 'live');
  const demo = model.cases.filter(item => item.scope === 'demo');
  const liveStats = C.caseStats(live, eng);
  const demoStats = C.demoStats(demo, eng);

  const statusOf = item => {
    const record = eng.cases?.[item.id];
    return item.scope === 'demo' ? C.demoStatus(record) : C.caseDisplayStatus(item, record);
  };
  const rows = model.cases.map(item => {
    const record = eng.cases?.[item.id];
    const positive = C.phaseResult(record, 'positive');
    const negative = C.phaseResult(record, 'negative');
    const tr = h('tr', { class: 'clickable', on: { click: () => ctx.navigate(`#/cases/${item.id}`) } },
      h('td', { class: 'id' }, h('a', { href: `#/cases/${item.id}` }, item.id)),
      h('td', {}, h('div', { style: { fontWeight: '600' } }, item.title), h('div', { class: 'muted small' }, item.family_label)),
      h('td', {}, item.layer_label),
      h('td', { class: 'nowrap' }, bucketLabel(model, item.bucket)),
      h('td', {}, scopeBadge(item.scope), item.required ? null : h('div', { class: 'faint small' }, 'Optional')),
      h('td', {}, item.scope === 'demo' ? null : resultBadge(positive)),
      h('td', {}, item.scope === 'demo' ? null : resultBadge(negative)),
      h('td', {}, item.scope === 'demo' ? demoBadge(C.demoStatus(record)) : resultBadge(C.caseDisplayStatus(item, record)),
        C.isExcluded(record) ? h('div', { class: 'faint small' }, 'Excluded') : null));
    return { item, tr };
  });

  const matches = item => {
    if (filters.scope && item.scope !== filters.scope) return false;
    if (filters.bucket && item.bucket !== filters.bucket) return false;
    if (filters.layer && item.layer !== filters.layer) return false;
    if (filters.family && item.family !== filters.family) return false;
    if (filters.status && statusOf(item) !== filters.status) return false;
    if (filters.text) {
      const haystack = `${item.id} ${item.title} ${item.family_label} ${item.layer_label} ${eng.cases?.[item.id]?.customer_summary || ''}`.toLowerCase();
      if (!haystack.includes(filters.text.toLowerCase())) return false;
    }
    return true;
  };
  const shown = h('span', { class: 'muted small' });
  const apply = () => {
    let count = 0;
    for (const { item, tr } of rows) {
      const show = matches(item);
      tr.classList.toggle('hidden', !show);
      if (show) count += 1;
    }
    shown.textContent = `${count} shown`;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key === 'text' ? 'q' : key, value);
    history.replaceState(null, '', `#/cases${params.toString() ? `?${params}` : ''}`);
  };
  const set = key => value => { filters[key] = value; apply(); };
  const layers = [...new Set(model.cases.map(item => item.layer))];
  const families = [...new Set(model.cases.map(item => item.family))];
  const search = h('input', { type: 'search', placeholder: 'Search use cases', value: filters.text, 'aria-label': 'Search use cases' });
  search.addEventListener('input', debounce(() => { filters.text = search.value.trim(); apply(); }, 150));
  const present = btn('\u25B6 Present shown', () => {
    const ids = rows.filter(({ tr }) => !tr.classList.contains('hidden')).map(({ item }) => item.id);
    if (!ids.length) { toast('No use case is shown.'); return; }
    ctx.navigate(`#/present?ids=${ids.join(',')}`);
  }, 'primary small');

  const root = h('div', {},
    pageHead({
      title: 'Use cases',
      sub: `${model.cases.length} test procedures from the catalogue. ${live.length} are live-proofed and form the acceptance denominator; ${demo.length} are demonstration only; ${model.cases.length - live.length - demo.length} optional cases are not scheduled.`,
      actions: [linkBtn('Coverage matrix', '#/coverage')]
    }),
    h('div', { class: 'grid grid-2', style: { marginBottom: '14px' } },
      card({ title: `Live-proofed: ${liveStats.passed} of ${live.length} passed`, body: h('div', {},
        h('div', { class: 'bar lg' }, ...['PASS', 'FAIL', 'BLOCKED', 'NOT_APPLICABLE', 'IN_PROGRESS'].map(key => h('span', { class: { PASS: 'pass', FAIL: 'fail', BLOCKED: 'blocked', NOT_APPLICABLE: 'na', IN_PROGRESS: 'progress' }[key], style: { width: `${(liveStats.counts[key] / live.length) * 100}%` } }))),
        h('div', { class: 'chips', style: { marginTop: '8px' } }, DISPLAY_STATUSES.map(key => h('span', { class: `badge st-${key}` }, `${C.RESULT_LABELS[key]}: ${key === 'NOT_RUN' ? liveStats.counts.NOT_RUN - liveStats.counts.IN_PROGRESS : liveStats.counts[key]}`)))) }),
      card({ title: `Demonstration only: ${demoStats.delivered} of ${demo.length} demonstrated`, body: h('div', {},
        bar(demo.length ? (demoStats.delivered / demo.length) * 100 : 0, 'lg'),
        h('div', { class: 'chips', style: { marginTop: '8px' } }, C.DEMO_STATUSES.map(key => h('span', { class: `badge dm-${key}` }, `${C.DEMO_LABELS[key]}: ${demoStats.counts[key]}`)))) })),
    h('div', { class: 'filters' },
      selectEl([['', 'All scopes'], ['live', 'Live-proofed'], ['demo', 'Demonstration only'], ['unscheduled', 'Unscheduled optional']], filters.scope, set('scope'), { 'aria-label': 'Scope' }),
      selectEl([['', 'All plan windows'], ...model.buckets.filter(bucket => model.cases.some(item => item.bucket === bucket.id)).map(bucket => [bucket.id, `${bucket.label}: ${bucket.title}`])], filters.bucket, set('bucket'), { 'aria-label': 'Plan window' }),
      selectEl([['', 'All security areas'], ...layers.map(layer => [layer, model.labels.layers[layer] || layer])], filters.layer, set('layer'), { 'aria-label': 'Security area' }),
      selectEl([['', 'All agent groups'], ...families.map(family => [family, model.labels.families[family] || family])], filters.family, set('family'), { 'aria-label': 'Agent group' }),
      selectEl([['', 'Any status'], ...DISPLAY_STATUSES.map(key => [key, C.RESULT_LABELS[key]]), ...C.DEMO_STATUSES.map(key => [key, `Demo: ${C.DEMO_LABELS[key]}`])], filters.status, set('status'), { 'aria-label': 'Status' }),
      search, h('div', { class: 'spacer' }), shown, present),
    h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Case', 'Use case', 'Security area', 'Window', 'Scope', 'Positive', 'Negative', 'Result'].map(label => h('th', {}, label)))),
      h('tbody', {}, rows.map(({ tr }) => tr))))));
  apply();
  return root;
}

export function controlBoundaries(model, item) {
  const layer = model.labels.layer_to_matrix[item.layer];
  if (!layer) return [];
  const familyIds = model.labels.family_to_matrix[item.family] || [];
  const families = familyIds.length ? model.matrix.families.filter(family => familyIds.includes(family.id)) : model.matrix.families;
  return families.map(family => ({ family, control: family.controls.find(control => control.layer === layer) })).filter(entry => entry.control);
}

function boundaryBlock(model, entries, compact) {
  if (!entries.length) return h('p', { class: 'muted' }, 'The support matrix has no single control layer for this case. Use the pass criteria and the guides.');
  if (compact || entries.length > 2) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Agent group'), h('th', {}, 'State'), h('th', {}, 'Control boundary'))),
      h('tbody', {}, entries.map(({ family, control }) => h('tr', {},
        h('td', { style: { fontWeight: '600' } }, family.name),
        h('td', {}, h('span', { class: `badge ms-${control.state}` }, control.state)),
        h('td', { class: 'small' }, richText(`${control.enforcementBoundary} [${control.sourceIds.join(', ')}]`, model)))))));
  }
  return h('div', { class: 'stack' }, entries.map(({ family, control }) => h('div', { class: `boundary state-${control.state}` },
    h('div', { class: 'row' }, h('strong', {}, family.name), h('span', { class: `badge ms-${control.state}` }, control.state)),
    h('p', { style: { margin: '6px 0 4px' } }, richText(`${control.enforcementBoundary} [${control.sourceIds.join(', ')}]`, model)),
    control.prerequisites?.length ? h('div', { class: 'small muted' }, `Prerequisites: ${control.prerequisites.join('; ')}`) : null)));
}

export function caseView(ctx) {
  const { model, route } = ctx;
  const item = ctx.maps.case.get(route.params[0]);
  if (!item) return h('div', { class: 'callout warn' }, 'Use case not found.');
  const index = model.cases.indexOf(item);
  const prev = model.cases[index - 1];
  const next = model.cases[index + 1];
  const record = () => ctx.current().cases?.[item.id] || {};
  const saveState = h('span', { class: 'save-state' });
  const hero = h('div', { class: 'result-hero' });

  const drawHero = () => {
    const current = record();
    const display = C.caseDisplayStatus(item, current);
    const counts = item.scope === 'live' && !C.isExcluded(current);
    let note = counts ? 'Counts toward the agreed live acceptance.' : item.scope === 'demo' ? 'Demonstration only. Outside the live acceptance denominator.' : item.scope === 'unscheduled' ? 'Unscheduled optional case. Reported separately.' : 'Excluded by an approved scope change.';
    if ((current.evidence_kind || 'live_product') === 'local_simulation') note += ' Local simulation evidence cannot pass a live product case.';
    hero.replaceChildren(...[
      item.scope === 'demo' ? demoBadge(C.demoStatus(current)) : resultBadge(display, true),
      item.scope === 'demo' && C.caseResult(current) !== 'NOT_RUN' ? resultBadge(C.caseDisplayStatus(item, current)) : null,
      h('div', { class: 'small muted grow' }, note)
    ].filter(Boolean));
  };

  const save = async patch => {
    saveState.textContent = 'Saving...';
    saveState.className = 'save-state';
    try {
      await ctx.mutate('PUT', `/cases/${item.id}`, patch, { rerender: false });
      saveState.textContent = 'Saved';
      saveState.className = 'save-state ok';
      drawHero();
      drawTimes();
    } catch (error) {
      saveState.textContent = 'Not saved';
      saveState.className = 'save-state err';
    }
  };

  const checklist = (key, values) => h('ol', { class: 'proc-list' }, values.map((text, idx) => {
    const itemKey = `${key}.${idx + 1}`;
    const done = Boolean(record().checklist?.[itemKey]);
    const box = h('input', { type: 'checkbox', checked: done, 'aria-label': `Done: ${text}` });
    const li = h('li', { class: `proc-item${done ? ' done' : ''}` }, box, h('span', {}, richText(text, model)));
    box.addEventListener('change', () => { li.classList.toggle('done', box.checked); save({ checklist: { [itemKey]: box.checked } }); });
    return li;
  }));
  const list = values => h('ul', {}, (Array.isArray(values) ? values : [values]).map(text => h('li', {}, richText(text, model))));
  const block = (title, content) => h('div', { class: 'doc-section' }, h('h3', {}, title), content);

  const procedure = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Test procedure'), h('span', { class: 'muted small' }, 'Tick each step as you run it. Ticks are saved with the use case.')),
    block('Prerequisites', list(item.prerequisites)),
    block('Prepare the test', checklist('setup', item.setup)),
    block('Positive phase', checklist('positive', item.positive_steps)),
    block('Negative phase', checklist('negative', item.negative_steps)),
    block('Expected result', list(item.expected)),
    block('Evidence to capture', list(item.evidence)),
    block('Pass criteria', list(item.pass_criteria)),
    block('Measured value', list(item.value)),
    block('Restore the test state', checklist('cleanup', item.cleanup)));

  const related = item.step_ids.map(id => ctx.maps.step.get(id)).filter(step => C.stepScopes(ctx.current()).has(step.scope));
  const relatedStats = C.stepStats(related, ctx.current());
  const relatedCard = card({
    title: 'Related configuration',
    actions: related.length ? [linkBtn(`Open ${related.length} steps`, `#/steps?case=${item.id}`, 'small')] : [],
    body: h('div', { class: 'stack' },
      related.length ? h('div', {}, h('div', { class: 'bar-label' }, h('span', {}, 'Steps done'), h('span', {}, `${relatedStats.done}/${relatedStats.applicable}`)), bar(relatedStats.pct)) : h('p', { class: 'muted small' }, 'No configuration step is linked in this engagement scope.'),
      h('div', { class: 'chips' }, item.guides.map(id => guideChip(model, id))))
  });

  const sources = (item.sources || []).map(id => model.sources[id]).filter(Boolean);
  const sourcesCard = card({ title: 'Sources', body: h('ul', { class: 'list-plain small' }, (item.sources || []).map(id => {
    const source = model.sources[id];
    return source ? h('li', {}, h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, `[${id}] ${source.title}`), h('div', { class: 'faint' }, source.note)) : null;
  })) });

  // Tracker panel.
  const current = record();
  const phaseRow = (phase, label) => {
    const value = current.phases?.[phase] || {};
    const select = selectEl(C.RESULTS.map(key => [key, C.RESULT_LABELS[key]]), value.result || 'NOT_RUN', result => save({ phases: { [phase]: { result } } }), { 'aria-label': `${label} result` });
    const reason = h('input', { type: 'text', value: value.reason || '', placeholder: 'Reason or observed decision', 'aria-label': `${label} reason` });
    reason.addEventListener('change', () => save({ phases: { [phase]: { reason: reason.value } } }));
    return h('div', { class: 'phase-row' }, h('span', { class: 'phase-name' }, label), select, reason);
  };
  const textField = (label, key, { rows = 3, placeholder = '', hint } = {}) => {
    const area = h('textarea', { rows, placeholder });
    area.value = current[key] || '';
    area.addEventListener('change', () => save({ [key]: area.value }));
    return field(label, area, hint);
  };
  const inputField = (label, key, placeholder, hint) => {
    const input = h('input', { type: 'text', value: current[key] || '', placeholder });
    input.addEventListener('change', () => save({ [key]: input.value }));
    return field(label, input, hint);
  };
  const refs = h('textarea', { rows: 3, placeholder: 'onb-01\\positive-registry.png' });
  refs.value = (current.evidence_refs || []).join('\n');
  refs.addEventListener('change', () => save({ evidence_refs: refs.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) }));
  const times = h('div', { class: 'small faint' });
  const drawTimes = () => {
    const now = record();
    times.textContent = [now.started_at ? `Started ${fmtDateTime(now.started_at)}` : '', now.completed_at ? `Completed ${fmtDateTime(now.completed_at)}` : '', now.updated_at ? `Updated ${fmtDateTime(now.updated_at)}` : ''].filter(Boolean).join(' \u00B7 ');
  };
  drawHero();
  drawTimes();

  const resultCard = card({
    title: 'Result',
    actions: [saveState],
    body: h('div', { class: 'stack' },
      hero,
      h('div', {}, phaseRow('positive', 'Positive'), phaseRow('negative', 'Negative'), phaseRow('control', 'Control')),
      h('div', { class: 'form-grid' },
        field('Evidence kind', selectEl([['live_product', 'Live product'], ['local_simulation', 'Local simulation']], current.evidence_kind || 'live_product', value => save({ evidence_kind: value }))),
        inputField('Agent or test-set alias', 'agent', item.default_agent || 'comparison-set-01'),
        h('div', { class: 'full' }, inputField('Correlation ID', 'correlation_id', 'Non-secret session or trace ID')),
        h('div', { class: 'full' }, field('Evidence references', refs, 'One path per line, relative to the protected evidence store. Never paste secrets.'))),
      textField('Customer summary', 'customer_summary', { placeholder: 'What was shown and the observed decision. Appears in customer reports.', hint: 'Shared in progress and final reports.' }),
      textField('Internal notes', 'internal_notes', { placeholder: 'Working notes for the delivery team.', hint: 'Never included in reports.' }),
      times)
  });

  const demo = current.demo || {};
  const demoField = (label, key, type = 'text') => {
    const input = type === 'textarea' ? h('textarea', { rows: 2 }) : h('input', { type });
    input.value = demo[key] || '';
    input.addEventListener('change', () => save({ demo: { [key]: input.value } }));
    return field(label, input);
  };
  const followUp = h('input', { type: 'checkbox', checked: Boolean(demo.follow_up) });
  followUp.addEventListener('change', () => save({ demo: { follow_up: followUp.checked } }));
  const demoBody = h('div', { class: 'stack' },
    item.scope === 'demo' ? h('div', { class: 'callout demo' }, `Demonstration only. ${item.demo_reason}`) : h('p', { class: 'muted small' }, 'Optional: record a walkthrough of this case, for example a rehearsal in the demonstration tenant.'),
    h('div', { class: 'form-grid' },
      field('Status', selectEl(C.DEMO_STATUSES.map(key => [key, C.DEMO_LABELS[key]]), C.demoStatus(current), value => save({ demo: { status: value } }))),
      demoField('Date', 'date', 'date'),
      demoField('Audience', 'audience'),
      demoField('Environment', 'environment'),
      h('div', { class: 'full' }, demoField('What was shown', 'shown', 'textarea')),
      h('div', { class: 'full' }, demoField('Customer feedback', 'feedback', 'textarea'))),
    h('label', { class: 'check' }, followUp, 'Customer wants this in a follow-up live phase'));
  const demoCard = item.scope === 'demo'
    ? card({ title: 'Demonstration record', body: demoBody })
    : h('details', { class: 'card' }, h('summary', { class: 'card-head', style: { cursor: 'pointer' } }, h('h2', {}, 'Demonstration record')), h('div', { class: 'card-body' }, demoBody));

  let exclusionCard = null;
  if (item.scope === 'live') {
    const exclusion = current.exclusion;
    const body = exclusion
      ? h('div', { class: 'stack' },
        h('div', { class: 'callout warn' }, `Excluded from the agreed denominator. Reason: ${exclusion.reason}. Approved by ${exclusion.approved_by} on ${exclusion.approved_date}.`),
        btn('Remove the exclusion', async () => {
          if (await confirmDialog('Remove exclusion', 'Return this case to the agreed denominator?', 'Remove')) await ctx.mutate('PUT', `/cases/${item.id}`, { exclusion: null });
        }, 'danger small'))
      : (() => {
        const reason = h('textarea', { rows: 2, placeholder: 'Why the agreed scope changed' });
        const approver = h('input', { type: 'text', placeholder: 'approver-alias' });
        const date = h('input', { type: 'date', value: C.todayString() });
        return h('div', { class: 'stack' },
          h('p', { class: 'muted small' }, 'An exclusion changes only the agreed denominator. The original denominator and the case status stay unchanged.'),
          field('Reason', reason), h('div', { class: 'form-grid' }, field('Approved by', approver), field('Approval date', date)),
          btn('Record the exclusion', () => ctx.mutate('PUT', `/cases/${item.id}`, { exclusion: { reason: reason.value, approved_by: approver.value, approved_date: date.value } }).catch(() => {}), 'small'));
      })();
    exclusionCard = h('details', { class: 'card', open: Boolean(exclusion) }, h('summary', { class: 'card-head', style: { cursor: 'pointer' } }, h('h2', {}, 'Approved scope change')), h('div', { class: 'card-body' }, body));
  }

  const presentSet = item.scope === 'live' ? item.bucket : item.scope === 'demo' ? 'demo' : 'all';
  return h('div', {},
    pageHead({
      crumbs: h('span', {}, h('a', { href: '#/cases' }, 'Use cases'), ` / ${item.id}`),
      title: `${item.id}: ${item.title}`,
      sub: `${item.family_label} \u00B7 ${item.layer_label} \u00B7 ${item.priority} \u00B7 ${bucketLabel(model, item.bucket)}. ${item.availability}`,
      actions: [
        prev ? linkBtn(`\u2190 ${prev.id}`, `#/cases/${prev.id}`) : null,
        next ? linkBtn(`${next.id} \u2192`, `#/cases/${next.id}`) : null,
        linkBtn('\u25B6 Present', `#/present?set=${presentSet}&id=${item.id}`, 'primary')
      ].filter(Boolean)
    }),
    h('div', { class: 'row', style: { marginBottom: '12px' } }, scopeBadge(item.scope), badge(item.required ? 'Required in the original catalogue' : 'Optional in the original catalogue'), badge(`Priority ${item.priority}`), item.default_agent ? badge(`Agent ${item.default_agent}`) : null),
    item.scope === 'unscheduled' ? h('div', { class: 'callout', style: { marginBottom: '12px' } }, item.unscheduled_reason) : null,
    h('div', { class: 'split' },
      h('div', { class: 'stack' },
        procedure,
        card({ title: 'Control boundary', body: boundaryBlock(model, controlBoundaries(model, item)) }),
        relatedCard,
        sources.length ? sourcesCard : null),
      h('div', { class: 'stack sticky' }, resultCard, demoCard, exclusionCard)));
}
