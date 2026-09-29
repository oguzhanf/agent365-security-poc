import * as C from '../core/compute.mjs';
import { h, pageHead, card, bar, caseChip, guideChip, linkBtn, badge, fmtDate } from '../ui.js';
import { timeline } from './dashboard.js';

const STATE_LABELS = { complete: 'Complete', in_progress: 'In progress', not_started: 'Not started', empty: 'No work in scope' };
const STATE_CLASS = { complete: 'st-PASS', in_progress: 'st-IN_PROGRESS', not_started: 'st-NOT_RUN', empty: 'st-NOT_APPLICABLE' };

export function planView(ctx) {
  const { model, route } = ctx;
  const eng = ctx.current();
  const s = C.summary(model, eng);
  const included = C.includedSteps(model, eng);
  const focus = route.query.get('bucket');
  const calendar = eng.settings.calendar === 'working' ? 'working days (Monday to Friday)' : 'calendar days';

  const bucketCard = bucket => {
    const guides = [...new Set(included.filter(step => step.bucket === bucket.id).map(step => step.guide))];
    const dates = bucket.start ? (bucket.start === bucket.end ? fmtDate(bucket.start) : `${fmtDate(bucket.start)} to ${fmtDate(bucket.end)}`) : 'Before the Days 13-14 walkthroughs';
    const el = card({
      title: h('div', { class: 'row grow' },
        h('h2', {}, `${bucket.label}: ${bucket.title}`),
        bucket.current ? badge('Current window', 'st-IN_PROGRESS') : null,
        badge(STATE_LABELS[bucket.state], STATE_CLASS[bucket.state]),
        bucket.blocked ? badge(`${bucket.blocked} blocked`, 'st-BLOCKED') : null,
        h('span', { class: 'muted small' }, dates)),
      actions: [
        bucket.steps.total ? linkBtn('Open steps', `#/steps?bucket=${bucket.id}`, 'small') : null,
        bucket.case_ids.length || bucket.demo_ids.length ? linkBtn('\u25B6 Present', `#/present?set=${bucket.id}`, 'small') : null
      ].filter(Boolean),
      body: h('div', { class: 'grid grid-3' },
        h('div', { class: 'stack' },
          h('p', { class: 'muted' }, bucket.summary),
          bucket.steps.total ? h('div', {},
            h('div', { class: 'bar-label' }, h('span', {}, 'Configuration steps'), h('span', {}, `${bucket.steps.done} of ${bucket.steps.applicable} done`)),
            bar(bucket.steps.pct)) : h('p', { class: 'muted small' }, 'No configuration step in this engagement scope.'),
          guides.length ? h('div', { class: 'chips' }, guides.map(id => guideChip(model, id))) : null),
        h('div', {},
          h('div', { class: 'kpi-label', style: { marginBottom: '6px' } }, 'Live-proofed use cases'),
          bucket.case_ids.length ? h('ul', { class: 'list-plain' }, bucket.case_ids.map(id => {
            const item = ctx.maps.case.get(id);
            return h('li', { class: 'row' }, caseChip(model, eng, id), h('span', { class: 'small' }, item.title));
          })) : h('p', { class: 'muted small' }, 'None in this window.')),
        h('div', {},
          h('div', { class: 'kpi-label', style: { marginBottom: '6px' } }, bucket.demo_ids.length ? 'Demonstrations' : 'Notes'),
          bucket.demo_ids.length ? h('div', { class: 'chips' }, bucket.demo_ids.map(id => caseChip(model, eng, id))) : null,
          bucket.id === 'B6' ? h('p', { class: 'muted small' }, 'PUR-11 and PUR-12 start here. Their retention and eDiscovery wait periods can complete after the window.') : null,
          bucket.id === 'B2' ? h('p', { class: 'muted small' }, 'Start Defender discovery on the test device early so its latency overlaps other work.') : null,
          bucket.id === 'BD' ? h('p', { class: 'muted small' }, 'Build these items in the demonstration tenant. They stay outside the live acceptance denominator.') : null,
          bucket.id === 'B8' ? h('p', { class: 'muted small' }, 'Run guide 45 for acceptance review, the customer result, and close-out.') : null))
    });
    el.id = `plan-${bucket.id}`;
    el.classList.add('mb');
    if (bucket.current) el.style.boxShadow = '0 0 0 2px rgba(15,108,189,.35)';
    return el;
  };

  const root = h('div', {},
    pageHead({
      title: 'Two-week plan',
      sub: `Indicative plan for one delivery engineer plus the customer operators. Latency-bound items (discovery, audit ingestion, policy propagation) start early so their wait periods overlap other work. Dates use ${calendar} from the start date${eng.settings.start_date ? ` ${eng.settings.start_date}` : ''}.`,
      actions: [linkBtn('Set dates', '#/settings')]
    }),
    card({ title: 'Timeline', body: timeline(ctx, s), cls: 'mb' }),
    s.buckets.filter(bucket => bucket.has_work).map(bucketCard));
  if (focus) setTimeout(() => document.getElementById(`plan-${focus}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 40);
  return root;
}
