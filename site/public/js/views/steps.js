import * as C from '../core/compute.mjs';
import {
  h, clear, pageHead, btn, selectEl, scopeBadge, areaLink, caseChip, guideChip, relTime, richText, bar,
  docTable, codeBox, confirmDialog, toast, debounce
} from '../ui.js';

// One trackable procedure step. Updates itself in place after a change.
export function stepRow(ctx, step, number, options = {}) {
  const { model } = ctx;
  const row = h('div', { class: 'step', dataset: { id: step.id } });
  let editing = false;

  const update = async patch => {
    try {
      await ctx.mutate('PUT', `/steps/${encodeURIComponent(step.id)}`, patch, { rerender: false });
      draw();
      if (options.onChange) options.onChange(step);
    } catch {
      draw();
    }
  };

  const editor = () => {
    const record = ctx.current().steps[step.id] || {};
    const area = h('textarea', {
      rows: 3,
      placeholder: record.status === 'blocked'
        ? 'Why is this step blocked? Blocking reasons appear in customer reports.'
        : 'Operator note, for example the object name created or the evidence reference.'
    });
    area.value = record.note || '';
    const save = async () => { editing = false; await update({ note: area.value }); };
    area.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) save();
      if (event.key === 'Escape') { editing = false; draw(); }
    });
    setTimeout(() => area.focus(), 20);
    return h('div', { class: 'step-note-editor' }, area,
      h('div', { class: 'row' }, btn('Save note', save, 'primary small'), btn('Cancel', () => { editing = false; draw(); }, 'small'),
        h('span', { class: 'faint small' }, 'Ctrl+Enter saves.')));
  };

  function draw() {
    const eng = ctx.current();
    const record = eng.steps[step.id] || {};
    const status = record.status || 'todo';
    row.className = `step st-${status}`;
    clear(row);
    const check = h('button', {
      type: 'button', class: 'step-check', 'aria-pressed': String(status === 'done'),
      title: status === 'done' ? 'Mark as to do' : 'Mark as done',
      'aria-label': `${status === 'done' ? 'Mark as to do' : 'Mark as done'}: ${step.id}`
    }, status === 'done' ? '\u2713' : status === 'blocked' ? '!' : status === 'skipped' ? '\u2013' : '');
    check.addEventListener('click', () => update({ status: status === 'done' ? 'todo' : 'done' }));
    const statusSelect = selectEl(C.STEP_STATUSES.map(value => [value, C.STEP_LABELS[value]]), status, value => {
      if (value === 'blocked' && !record.note) editing = true;
      update({ status: value });
    }, { 'aria-label': `Status of ${step.id}` });
    const meta = h('div', { class: 'step-meta' },
      h('span', { class: 'step-id' }, step.id),
      step.scope !== 'live' ? scopeBadge(step.scope) : null,
      areaLink(model, eng, step.area),
      options.showGuide ? guideChip(model, step.guide) : null,
      step.cases.slice(0, 6).map(id => caseChip(model, eng, id)),
      record.updated_at ? h('span', { class: 'faint small', title: new Date(record.updated_at).toLocaleString() }, relTime(record.updated_at)) : null,
      record.hash && record.hash !== step.hash ? h('span', { class: 'step-changed', title: 'The procedure text changed after this step was recorded. Recheck it.' }, 'Text changed') : null);
    row.append(...[
      check,
      h('div', { class: 'step-num' }, number ? `#${number}` : ''),
      h('div', { class: 'step-body' },
        h('div', { class: 'step-text' }, richText(step.text, model)),
        meta,
        record.note && !editing ? h('div', { class: `step-note${status === 'blocked' ? '' : ' plain'}` }, record.note) : null,
        editing ? editor() : null),
      options.compact ? null : h('div', { class: 'step-actions' },
        btn(record.note ? 'Edit note' : 'Note', () => { editing = !editing; draw(); }, 'small ghost'),
        statusSelect)
    ].filter(Boolean));
  }

  draw();
  return row;
}

function sectionDetails(model, section) {
  const hasDetails = section.paragraphs.length || section.table || section.items.length || section.code || section.notes.length;
  if (!hasDetails) return null;
  return h('div', { class: 'section-details hidden' },
    section.paragraphs.map(text => h('p', {}, richText(text, model))),
    section.table ? docTable(section.table, model) : null,
    section.items.length ? h('ul', {}, section.items.map(item => h('li', {}, richText(item, model)))) : null,
    section.code ? codeBox(section.code) : null,
    section.notes.map(note => h('div', { class: 'note' }, richText(note, model))));
}

export function stepsView(ctx) {
  const { model, route } = ctx;
  const eng = ctx.current();
  const included = C.includedSteps(model, eng);
  const numbers = C.stepNumbers(model, eng);
  const q = route.query;
  const filters = {
    bucket: q.get('bucket') || '',
    guide: q.get('guide') || '',
    area: q.get('area') || '',
    status: q.get('status') || '',
    scope: q.get('scope') || '',
    case: q.get('case') || '',
    text: q.get('q') || '',
    hideDone: q.get('hide') === 'done'
  };
  const stats = () => C.stepStats(included, ctx.current());
  const guideById = ctx.maps.guide;
  const sectionById = new Map(model.guides.flatMap(guide => guide.sections.map(section => [section.id, section])));
  const rows = new Map();

  const summaryHolder = h('div', { class: 'card', style: { marginBottom: '14px' } });
  const drawSummary = () => {
    const current = stats();
    clear(summaryHolder);
    const chip = (key, label) => {
      const active = filters.status === key;
      const el = h('button', { type: 'button', class: `chip${active ? ' active' : ''}`, title: `Show ${label.toLowerCase()} steps` },
        h('span', { class: `dot st-${{ todo: 'NOT_RUN', in_progress: 'IN_PROGRESS', done: 'PASS', blocked: 'BLOCKED', skipped: 'NOT_APPLICABLE' }[key]}` }), `${label}: ${current[key]}`);
      el.addEventListener('click', () => { filters.status = active ? '' : key; statusSelect.value = filters.status; applyFilters(); });
      return el;
    };
    summaryHolder.append(h('div', { class: 'card-body' },
      h('div', { class: 'bar-label' },
        h('strong', {}, `${current.done} of ${current.applicable} applicable steps done (${current.pct}%)`),
        h('span', {}, `${current.total} steps in this engagement's scope`)),
      bar(current.pct, 'lg'),
      h('div', { class: 'chips', style: { marginTop: '10px' } },
        chip('todo', 'To do'), chip('in_progress', 'In progress'), chip('done', 'Done'), chip('blocked', 'Blocked'), chip('skipped', 'Not applicable'))));
  };

  const bucketOptions = [['', 'All plan windows'], ...model.buckets.filter(bucket => included.some(step => step.bucket === bucket.id)).map(bucket => [bucket.id, `${bucket.label}: ${bucket.title}`])];
  const guideOptions = [['', 'All guides'], ...model.guides.filter(guide => included.some(step => step.guide === guide.id)).map(guide => [guide.id, `${String(guide.number).padStart(2, '0')} ${guide.title}`])];
  const usedAreas = [...new Set(included.map(step => step.area))];
  const areaOptions = [['', 'All portals and tools'], ...usedAreas.map(id => [id, model.areas[id].name]).sort((a, b) => a[1].localeCompare(b[1]))];
  const scopes = C.stepScopes(eng);
  const scopeOptions = [['', 'All included scopes'], ...['live', 'optional', 'demo'].filter(name => scopes.has(name)).map(name => [name, C.SCOPE_LABELS[name]])];

  const syncUrl = () => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ bucket: filters.bucket, guide: filters.guide, area: filters.area, status: filters.status, scope: filters.scope, case: filters.case, q: filters.text })) {
      if (value) params.set(key, value);
    }
    if (filters.hideDone) params.set('hide', 'done');
    const query = params.toString();
    history.replaceState(null, '', `#/steps${query ? `?${query}` : ''}`);
  };

  const bucketSelect = selectEl(bucketOptions, filters.bucket, value => { filters.bucket = value; applyFilters(); }, { 'aria-label': 'Plan window' });
  const guideSelect = selectEl(guideOptions, filters.guide, value => { filters.guide = value; applyFilters(); }, { 'aria-label': 'Guide' });
  const areaSelect = selectEl(areaOptions, filters.area, value => { filters.area = value; applyFilters(); }, { 'aria-label': 'Portal or tool' });
  const statusSelect = selectEl([['', 'Any status'], ...C.STEP_STATUSES.map(value => [value, C.STEP_LABELS[value]])], filters.status, value => { filters.status = value; applyFilters(); }, { 'aria-label': 'Status' });
  const scopeSelect = selectEl(scopeOptions, filters.scope, value => { filters.scope = value; applyFilters(); }, { 'aria-label': 'Scope' });
  const search = h('input', { type: 'search', placeholder: 'Search steps, IDs, or cases', value: filters.text, 'aria-label': 'Search steps' });
  search.addEventListener('input', debounce(() => { filters.text = search.value.trim(); applyFilters(); }, 200));
  const hideDone = h('input', { type: 'checkbox', checked: filters.hideDone });
  hideDone.addEventListener('change', () => { filters.hideDone = hideDone.checked; applyFilters(); });
  const caseFilter = filters.case ? h('span', { class: 'chip' }, `Use case ${filters.case}`, h('button', { type: 'button', class: 'btn ghost small', on: { click: () => { filters.case = ''; caseFilter.remove(); applyFilters(); } } }, '\u00D7')) : null;
  const visibleCount = h('span', { class: 'muted small' });

  const matches = step => {
    const status = C.stepStatus(ctx.current(), step.id);
    if (filters.bucket && step.bucket !== filters.bucket) return false;
    if (filters.guide && step.guide !== filters.guide) return false;
    if (filters.area && step.area !== filters.area) return false;
    if (filters.status && status !== filters.status) return false;
    if (filters.scope && step.scope !== filters.scope) return false;
    if (filters.case && !step.cases.includes(filters.case)) return false;
    if (filters.hideDone && (status === 'done' || status === 'skipped')) return false;
    if (filters.text) {
      const needle = filters.text.toLowerCase();
      const note = (ctx.current().steps[step.id]?.note || '').toLowerCase();
      const haystack = `${step.id} ${step.text} ${step.cases.join(' ')} ${guideById.get(step.guide).title} ${note}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  };

  const list = h('div', {});
  const groups = [];
  for (const bucket of model.buckets) {
    const bucketSteps = included.filter(step => step.bucket === bucket.id);
    if (!bucketSteps.length) continue;
    const headStats = h('span', { class: 'muted small' });
    const headBar = h('div', { class: 'bar' });
    const group = h('section', { class: 'group', id: `bucket-${bucket.id}` },
      h('div', { class: 'group-head' },
        h('div', { class: 'grow' }, h('h2', {}, `${bucket.label}: ${bucket.title}`), h('div', { class: 'muted small' }, bucket.summary)),
        headStats, headBar));
    const guideBlocks = [];
    const byGuide = new Map();
    for (const step of bucketSteps) {
      if (!byGuide.has(step.guide)) byGuide.set(step.guide, []);
      byGuide.get(step.guide).push(step);
    }
    for (const [guideId, guideSteps] of byGuide) {
      const guide = guideById.get(guideId);
      const guideStats = h('span', { class: 'muted small' });
      const block = h('div', { class: 'guide-block' },
        h('div', { class: 'guide-block-head' },
          h('h3', {}, h('a', { href: `#/guides/${guideId}` }, `Guide ${String(guide.number).padStart(2, '0')}: ${guide.title}`)),
          guideStats));
      const sections = [];
      const bySection = new Map();
      for (const step of guideSteps) {
        if (!bySection.has(step.section)) bySection.set(step.section, []);
        bySection.get(step.section).push(step);
      }
      for (const [sectionId, sectionSteps] of bySection) {
        const section = sectionById.get(sectionId);
        const details = sectionDetails(model, section);
        const detailsBtn = details ? btn('Details', () => { details.classList.toggle('hidden'); detailsBtn.textContent = details.classList.contains('hidden') ? 'Details' : 'Hide details'; }, 'small ghost') : null;
        const doneBtn = btn('Mark section done', async () => {
          const ids = sectionSteps.filter(step => !['done', 'skipped'].includes(C.stepStatus(ctx.current(), step.id))).map(step => step.id);
          if (!ids.length) { toast('Every step in this section is already done.'); return; }
          await ctx.mutate('POST', '/steps', { ids, status: 'done' }, { rerender: false });
          for (const id of ids) rows.get(id)?.redraw();
          refreshAll();
        }, 'small');
        const sectionEl = h('div', { class: 'section' },
          h('div', { class: 'section-head' },
            h('h4', {}, `${section.index}. ${section.title}`),
            section.scope !== 'live' ? scopeBadge(section.scope) : null,
            h('div', { class: 'spacer' }), detailsBtn, doneBtn),
          details);
        for (const step of sectionSteps) {
          let rowEl;
          const make = () => stepRow(ctx, step, numbers.get(step.id), { onChange: () => refreshAll() });
          rowEl = make();
          rows.set(step.id, { el: rowEl, step, redraw: () => { const fresh = make(); rowEl.replaceWith(fresh); rowEl = fresh; rows.get(step.id).el = fresh; } });
          sectionEl.append(rowEl);
        }
        sections.push({ el: sectionEl, steps: sectionSteps });
        block.append(sectionEl);
      }
      guideBlocks.push({ el: block, steps: guideSteps, statsEl: guideStats });
      group.append(block);
    }
    groups.push({ el: group, steps: bucketSteps, blocks: guideBlocks, statsEl: headStats, barEl: headBar });
    list.append(group);
  }

  function refreshCounts() {
    const eng = ctx.current();
    for (const group of groups) {
      const stat = C.stepStats(group.steps, eng);
      group.statsEl.textContent = `${stat.done}/${stat.applicable} done`;
      clear(group.barEl);
      group.barEl.append(h('span', { class: 'pass', style: { width: `${stat.pct}%` } }));
      for (const block of group.blocks) {
        const blockStat = C.stepStats(block.steps, eng);
        block.statsEl.textContent = `${blockStat.done}/${blockStat.applicable} done${blockStat.blocked ? `, ${blockStat.blocked} blocked` : ''}`;
      }
    }
  }

  function applyFilters() {
    let visible = 0;
    for (const { el, step } of rows.values()) {
      const show = matches(step);
      el.classList.toggle('hidden', !show);
      if (show) visible += 1;
    }
    for (const group of groups) {
      let groupVisible = false;
      for (const block of group.blocks) {
        let blockVisible = false;
        for (const sectionEl of block.el.querySelectorAll('.section')) {
          const any = [...sectionEl.querySelectorAll('.step')].some(el => !el.classList.contains('hidden'));
          sectionEl.classList.toggle('hidden', !any);
          blockVisible = blockVisible || any;
        }
        block.el.classList.toggle('hidden', !blockVisible);
        groupVisible = groupVisible || blockVisible;
      }
      group.el.classList.toggle('hidden', !groupVisible);
    }
    visibleCount.textContent = `${visible} shown`;
    empty.classList.toggle('hidden', visible > 0);
    syncUrl();
  }

  function refreshAll() {
    drawSummary();
    refreshCounts();
  }

  const empty = h('div', { class: 'empty hidden' }, h('h2', {}, 'No step matches these filters.'), h('p', {}, 'Clear a filter or search term.'));

  const markVisible = btn('Mark shown as done', async () => {
    const ids = [...rows.values()].filter(({ el, step }) => !el.classList.contains('hidden') && !['done', 'skipped'].includes(C.stepStatus(ctx.current(), step.id))).map(({ step }) => step.id);
    if (!ids.length) { toast('No open step is shown.'); return; }
    if (!(await confirmDialog('Mark shown steps as done', `Mark ${ids.length} shown step(s) as done?`, 'Mark done'))) return;
    await ctx.mutate('POST', '/steps', { ids, status: 'done' }, { rerender: false });
    for (const id of ids) rows.get(id)?.redraw();
    refreshAll();
    applyFilters();
  }, 'small');

  const totals = model.totals.steps;
  const root = h('div', {},
    pageHead({
      title: 'Configuration steps',
      sub: `Every step from the scope document's guides, in two-week plan order. This engagement tracks ${included.length} steps (${['live', 'optional', 'demo'].filter(name => scopes.has(name)).map(name => `${included.filter(step => step.scope === name).length} ${C.SCOPE_LABELS[name].toLowerCase()}`).join(', ')}). The full pack has ${totals.all}: ${totals.live} live, ${totals.optional} optional, and ${totals.demo} demonstration only.`,
      actions: [h('a', { class: 'btn', href: '#/settings' }, 'Change scope'), h('a', { class: 'btn', href: '/api/reference-pack.zip' }, 'Download reference pack')]
    }),
    summaryHolder,
    h('div', { class: 'filters' }, bucketSelect, guideSelect, areaSelect, statusSelect, scopeSelect, search,
      h('label', { class: 'check' }, hideDone, 'Hide done'), caseFilter, h('div', { class: 'spacer' }), visibleCount, markVisible),
    list,
    empty);
  refreshAll();
  applyFilters();
  if (filters.bucket) setTimeout(() => document.getElementById(`bucket-${filters.bucket}`)?.scrollIntoView({ block: 'start' }), 30);
  return root;
}
