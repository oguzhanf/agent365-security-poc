import * as C from '../core/compute.mjs';
import {
  h, pageHead, card, kpi, donut, bar, stackedBar, badge, relTime, burnup, caseChip, linkBtn, fmtDate
} from '../ui.js';
import { stepRow } from './steps.js';

export function timeline(ctx, summary) {
  return h('div', { class: 'timeline' }, summary.buckets.filter(bucket => bucket.has_work).map(bucket => {
    const dates = bucket.start ? (bucket.start === bucket.end ? fmtDate(bucket.start) : `${fmtDate(bucket.start)} to ${fmtDate(bucket.end)}`) : 'Before Days 13-14';
    const item = h('a', { class: `tl-item ${bucket.current ? 'current' : ''} ${bucket.state === 'complete' ? 'complete' : ''}`, href: `#/plan?bucket=${bucket.id}` },
      bucket.current ? h('span', { class: 'tl-now' }, 'Now') : null,
      h('div', { class: 'tl-label' }, bucket.label),
      h('div', { class: 'tl-title' }, bucket.title),
      h('div', { class: 'tl-dates' }, dates),
      bar(bucket.steps.pct),
      h('div', { class: 'tl-meta' },
        h('span', {}, bucket.steps.total ? `${bucket.steps.done}/${bucket.steps.applicable} steps` : 'No steps'),
        h('span', {}, bucket.case_ids.length ? `${bucket.cases.passed}/${bucket.case_ids.length} pass` : bucket.demo_ids.length ? `${bucket.demos.delivered}/${bucket.demo_ids.length} demos` : '')),
      bucket.blocked ? h('div', { class: 'small', style: { color: 'var(--blocked)', fontWeight: '600' } }, `${bucket.blocked} blocked`) : null);
    return item;
  }));
}

export function dashboardView(ctx) {
  const { model } = ctx;
  const eng = ctx.current();
  const s = C.summary(model, eng);
  const settings = eng.settings;
  const status = settings.report?.status || 'on_track';
  const agreed = s.acceptance.agreed;
  const openRaid = s.notes.open_actions + s.notes.open_risks + s.notes.open_issues;
  const started = s.steps.done + s.steps.in_progress + s.all_cases.final + s.all_cases.counts.IN_PROGRESS > 0;

  const root = h('div', {});
  root.append(pageHead({
    title: settings.name,
    sub: [settings.customer, settings.tenant?.name, settings.tenant?.domain].filter(Boolean).join(' \u00B7 ') || 'Set the customer and tenant in Settings.',
    actions: [
      badge(C.RAG[status], `lg rag-${status}`),
      linkBtn('Configuration steps', '#/steps?hide=done'),
      linkBtn('Progress report', '#/reports', 'primary')
    ]
  }));

  if (!settings.start_date || !started) {
    root.append(h('div', { class: 'callout', style: { marginBottom: '16px' } },
      h('strong', {}, 'Getting started. '),
      !settings.start_date ? [h('a', { href: '#/settings' }, 'Set the start date'), ' to place the two-week plan on the calendar. '] : null,
      'Begin with Days 1-2: guide 01 prerequisites, guide 02 scope approval, and guide 03 test environment. ',
      'Record every tenant object you create in ', h('a', { href: '#/inventory' }, 'Tenant build'), ' so cleanup and the final report stay accurate.'));
  }

  root.append(h('div', { class: 'grid grid-5', style: { marginBottom: '16px' } },
    kpi({ label: 'Configuration steps', value: `${s.steps.done} / ${s.steps.applicable}`, detail: `${s.steps.in_progress} in progress \u00B7 ${s.steps.blocked} blocked`, visual: donut(s.steps.pct) }),
    kpi({ label: 'Live use cases passed', value: `${agreed.passed} / ${agreed.denominator}`, detail: `${s.live_cases.counts.FAIL} fail \u00B7 ${s.live_cases.counts.BLOCKED} blocked \u00B7 ${s.live_cases.counts.IN_PROGRESS} running`, visual: donut(agreed.denominator ? (agreed.passed / agreed.denominator) * 100 : 0, 54, '#107c10'), tone: agreed.achieved ? 'good' : '' }),
    kpi({ label: 'Demonstrations delivered', value: `${s.demos.delivered} / ${s.demos.total}`, detail: `${s.demos.counts.PREPARED} prepared \u00B7 ${s.demos.counts.SCHEDULED} scheduled`, visual: donut(s.demos.total ? (s.demos.delivered / s.demos.total) * 100 : 0, 54, '#6b47b8') }),
    kpi({ label: 'Blocked items', value: String(s.blocked), detail: 'Steps and use cases with a blocking reason', tone: s.blocked ? 'warn' : '' }),
    kpi({ label: 'Open RAID items', value: String(openRaid), detail: `${s.notes.open_actions} actions \u00B7 ${s.notes.open_risks} risks \u00B7 ${s.notes.open_issues} issues`, tone: s.notes.open_issues ? 'bad' : '' })));

  root.append(card({
    title: 'Two-week plan',
    actions: [linkBtn('Plan detail', '#/plan', 'small')],
    body: timeline(ctx, s),
    cls: 'mb'
  }));

  const current = s.buckets.find(bucket => bucket.current) || s.buckets.find(bucket => bucket.has_work && bucket.state !== 'complete');
  const next = C.nextSteps(model, eng, 7);
  const numbers = C.stepNumbers(model, eng);
  const upNext = h('div', {}, next.length
    ? next.map(step => stepRow(ctx, step, numbers.get(step.id), { compact: true, showGuide: true, onChange: () => ctx.rerender() }))
    : h('div', { class: 'empty' }, h('h2', {}, 'Every step is complete.'), h('p', {}, 'Review acceptance and produce the final report.')));

  const windowCases = current ? [...current.case_ids, ...current.demo_ids] : [];
  const windowCard = card({
    title: current ? `${current.label}: ${current.title}` : 'Current plan window',
    actions: current ? [linkBtn('Steps', `#/steps?bucket=${current.id}&hide=done`, 'small'), linkBtn('\u25B6 Present', `#/present?set=${current.id}`, 'small')] : [],
    body: current ? h('div', { class: 'stack' },
      h('p', { class: 'muted' }, current.summary),
      h('div', {}, h('div', { class: 'bar-label' }, h('span', {}, 'Configuration'), h('span', {}, `${current.steps.done}/${current.steps.applicable}`)), bar(current.steps.pct)),
      windowCases.length ? h('div', {}, h('div', { class: 'kpi-label', style: { marginBottom: '6px' } }, 'Use cases in this window'),
        h('div', { class: 'chips' }, windowCases.map(id => caseChip(model, eng, id)))) : h('p', { class: 'muted' }, 'No use case is scheduled in this window.')) : h('p', { class: 'muted' }, 'Set a start date to follow the plan.')
  });

  root.append(h('div', { class: 'grid grid-2', style: { margin: '16px 0' } },
    card({ title: 'Up next', actions: [linkBtn('All open steps', '#/steps?hide=done', 'small')], body: upNext, flush: true }),
    windowCard));

  const liveCases = model.cases.filter(item => item.scope === 'live');
  const layers = C.groupStats(liveCases, item => item.layer_label, list => C.caseStats(list, eng));
  const layerBody = h('div', { class: 'stack' }, layers.map(layer => h('div', {},
    h('div', { class: 'bar-label' }, h('span', {}, layer.key), h('span', {}, `${layer.passed}/${layer.total} pass`)),
    stackedBar(layer.counts, layer.total))));

  const history = eng.history || {};
  const chart = h('div', {},
    burnup(history),
    h('div', { class: 'legend', style: { marginTop: '6px' } },
      h('span', {}, h('span', { class: 'sw', style: { background: '#0f6cbd' } }), 'Configuration steps done'),
      h('span', {}, h('span', { class: 'sw', style: { background: '#107c10' } }), 'Live use cases passed (scaled)')),
    Object.keys(history).length < 2 ? h('p', { class: 'muted small', style: { marginTop: '6px' } }, 'The chart adds one point per day with activity.') : null);

  root.append(h('div', { class: 'grid grid-2' },
    card({ title: 'Live results by security area', actions: [linkBtn('Use cases', '#/cases?scope=live', 'small')], body: layerBody }),
    h('div', { class: 'stack' },
      card({ title: 'Progress over time', body: chart }),
      card({
        title: 'Recent activity',
        body: (eng.activity || []).length
          ? h('ul', { class: 'activity' }, eng.activity.slice(-10).reverse().map(entry => h('li', {},
            h('span', { class: 'when', title: new Date(entry.at).toLocaleString() }, relTime(entry.at)),
            h('span', {}, entry.text))))
          : h('p', { class: 'muted' }, 'No activity yet.')
      }))));
  return root;
}
