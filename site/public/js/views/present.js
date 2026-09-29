import * as C from '../core/compute.mjs';
import { h, badge, resultBadge, scopeBadge, demoBadge, areaLink, richText, btn, toast } from '../ui.js';
import { controlBoundaries } from './cases.js';

function deckCases(model, eng, query) {
  const ids = query.get('ids');
  if (ids) {
    const wanted = ids.split(',').map(id => id.trim());
    return { label: 'Selected use cases', cases: wanted.map(id => model.cases.find(item => item.id === id)).filter(Boolean) };
  }
  const set = query.get('set') || C.currentBucket(model, eng) || 'live';
  if (set === 'all') return { label: 'All use cases', cases: model.cases };
  if (set === 'live') return { label: 'Live-proofed use cases', cases: model.cases.filter(item => item.scope === 'live') };
  if (set === 'demo') return { label: 'Demonstration-only use cases', cases: model.cases.filter(item => item.scope === 'demo') };
  const bucket = model.buckets.find(item => item.id === set);
  if (bucket) {
    const cases = model.cases.filter(item => item.bucket === bucket.id);
    return { label: `${bucket.label}: ${bucket.title}`, cases: cases.length ? cases : model.cases.filter(item => item.scope === 'live') };
  }
  return { label: 'Live-proofed use cases', cases: model.cases.filter(item => item.scope === 'live') };
}

function introSlide(model, eng, deck) {
  const settings = eng.settings;
  const totals = model.totals;
  return h('div', { class: 'slide' },
    h('div', { class: 'slide-kicker' }, 'Microsoft Security \u00B7 Agent 365'),
    h('div', { class: 'slide-hero' }, 'Agent 365 Security PoC'),
    h('div', { class: 'slide-lead' }, [settings.customer || settings.name, settings.tenant?.name].filter(Boolean).join(' \u00B7 ')),
    h('p', { class: 'slide-lead' }, model.overview.presentation_lead || model.overview.purpose[0]),
    h('div', { class: 'slide-stats' },
      h('div', { class: 'slide-stat' }, h('div', { class: 'v' }, String(totals.cases.live)), h('div', { class: 'l' }, 'live-proofed use cases')),
      h('div', { class: 'slide-stat' }, h('div', { class: 'v' }, String(totals.cases.demo)), h('div', { class: 'l' }, 'demonstration-only use cases')),
      h('div', { class: 'slide-stat' }, h('div', { class: 'v' }, String(totals.steps.live)), h('div', { class: 'l' }, 'live configuration steps')),
      h('div', { class: 'slide-stat' }, h('div', { class: 'v' }, '2'), h('div', { class: 'l' }, 'week execution window'))),
    h('div', { class: 'slide-cols' },
      model.overview.modes.map(mode => h('div', { class: 'slide-panel' }, h('h2', {}, mode.name), h('p', {}, mode.text)))),
    h('div', { class: 'slide-kicker' }, `This session: ${deck.label} (${deck.cases.length})`));
}

function outroSlide(model, eng) {
  const s = C.summary(model, eng);
  const agreed = s.acceptance.agreed;
  return h('div', { class: 'slide' },
    h('div', { class: 'slide-kicker' }, 'Where we are'),
    h('div', { class: 'slide-hero' }, 'Acceptance status'),
    h('div', { class: 'slide-stats' },
      h('div', { class: 'slide-stat' }, h('div', { class: 'v' }, `${agreed.passed}/${agreed.denominator}`), h('div', { class: 'l' }, 'live-proofed use cases passed')),
      h('div', { class: 'slide-stat' }, h('div', { class: 'v' }, `${s.demos.delivered}/${s.demos.total}`), h('div', { class: 'l' }, 'demonstrations delivered')),
      h('div', { class: 'slide-stat' }, h('div', { class: 'v' }, `${s.steps.pct}%`), h('div', { class: 'l' }, 'configuration complete')),
      h('div', { class: 'slide-stat' }, h('div', { class: 'v' }, String(s.blocked)), h('div', { class: 'l' }, 'blocked items'))),
    h('div', { class: 'slide-cols' },
      h('div', { class: 'slide-panel' }, h('h2', {}, 'How results are judged'), h('ul', {}, model.acceptance.rules.slice(0, 4).map(text => h('li', {}, text)))),
      h('div', { class: 'slide-panel' }, h('h2', {}, 'What does not count as proof'), h('ul', {}, model.acceptance.cautions.map(text => h('li', {}, text))))));
}

function caseSlide(ctx, item, position, total, showResults) {
  const { model } = ctx;
  const eng = ctx.current();
  const record = eng.cases?.[item.id];
  const bucket = model.buckets.find(entry => entry.id === item.bucket);
  const areas = [...new Set(item.step_ids.map(id => ctx.maps.step.get(id).area))].filter(id => model.areas[id]?.url).slice(0, 6);
  const boundaries = controlBoundaries(model, item).slice(0, 3);
  const display = C.caseDisplayStatus(item, record);
  const demoStatus = C.demoStatus(record);
  return h('div', { class: 'slide' },
    h('div', { class: 'slide-kicker' }, `Use case ${position} of ${total}${bucket ? ` \u00B7 ${bucket.label}: ${bucket.title}` : ''}`),
    h('h1', {}, h('span', { class: 'sid' }, item.id), item.title),
    h('div', { class: 'badges' },
      scopeBadge(item.scope),
      badge(item.family_label, 'role'),
      badge(item.layer_label, 'role'),
      item.default_agent ? badge(item.default_agent, 'role') : null,
      showResults ? (item.scope === 'demo' ? demoBadge(demoStatus) : resultBadge(display)) : null),
    item.scope === 'demo' ? h('div', { class: 'slide-panel' }, h('h2', {}, 'Why this is a demonstration'), h('p', {}, item.demo_reason)) : null,
    h('div', { class: 'slide-cols' },
      h('div', { class: 'stack' },
        h('div', { class: 'slide-panel' }, h('h2', {}, 'What this proves'), h('ul', {}, item.expected.map(text => h('li', {}, richText(text, model))))),
        h('div', { class: 'slide-panel pos' }, h('h2', {}, 'Positive phase'), h('ol', {}, item.positive_steps.map(text => h('li', {}, richText(text, model))))),
        h('div', { class: 'slide-panel neg' }, h('h2', {}, 'Negative phase'), h('ol', {}, item.negative_steps.map(text => h('li', {}, richText(text, model)))))),
      h('div', { class: 'stack' },
        h('div', { class: 'slide-panel' }, h('h2', {}, 'Evidence we capture'), h('ul', {}, item.evidence.map(text => h('li', {}, richText(text, model))))),
        h('div', { class: 'slide-panel' }, h('h2', {}, 'Pass criteria'), h('ul', {}, item.pass_criteria.map(text => h('li', {}, richText(text, model))))),
        boundaries.length ? h('div', { class: 'slide-panel' }, h('h2', {}, 'Control boundary'), boundaries.map(({ family, control }) => h('div', { class: `boundary state-${control.state}`, style: { marginBottom: '6px' } },
          h('strong', {}, `${family.name}: ${control.state}. `), control.enforcementBoundary))) : null,
        areas.length ? h('div', { class: 'slide-panel' }, h('h2', {}, 'Open in'), h('div', { class: 'row' }, areas.map(id => areaLink(model, eng, id, { label: model.areas[id].name })))) : null,
        showResults && record?.customer_summary ? h('div', { class: 'slide-panel' }, h('h2', {}, 'Observed result'), h('p', {}, record.customer_summary)) : null)));
}

export function presentView(ctx) {
  const { model, route } = ctx;
  const eng = ctx.current();
  const deck = deckCases(model, eng, route.query);
  const slides = ['intro', ...deck.cases.map(item => item.id), 'outro'];
  const indexParam = route.query.get('i');
  let index = indexParam === null ? Number.NaN : Number(indexParam);
  const startId = route.query.get('id');
  if (!Number.isInteger(index) || index < 0 || index >= slides.length) index = startId && slides.includes(startId) ? slides.indexOf(startId) : 0;
  let showResults = route.query.get('results') !== '0';

  const holder = h('div', { class: 'deck' });
  const go = next => {
    index = Math.max(0, Math.min(slides.length - 1, next));
    const params = new URLSearchParams(route.query);
    params.set('i', String(index));
    params.delete('id');
    history.replaceState(null, '', `#/present?${params}`);
    draw();
  };
  const exit = () => {
    const id = slides[index];
    ctx.navigate(id && id !== 'intro' && id !== 'outro' ? `#/cases/${id}` : '#/dashboard');
  };
  const markDemonstrated = async () => {
    const id = slides[index];
    const item = ctx.maps.case.get(id);
    if (!item) return;
    await ctx.mutate('PUT', `/cases/${id}`, { demo: { status: 'DEMONSTRATED', date: C.todayString(), environment: eng.settings.tenant?.name || eng.settings.name } }, { rerender: false });
    toast(`${id} recorded as demonstrated today.`, 'ok');
    draw();
  };

  function draw() {
    const id = slides[index];
    const item = ctx.maps.case.get(id);
    const slide = id === 'intro' ? introSlide(model, ctx.current(), deck) : id === 'outro' ? outroSlide(model, ctx.current()) : caseSlide(ctx, item, index, deck.cases.length, showResults);
    const resultsToggle = btn(showResults ? 'Hide results' : 'Show results', () => { showResults = !showResults; draw(); }, 'small');
    holder.replaceChildren(
      h('div', { class: 'deck-top' },
        h('strong', { style: { color: '#fff' } }, 'Agent 365 Security PoC'),
        h('span', {}, deck.label),
        h('div', { class: 'spacer' }),
        item ? btn('Record as demonstrated', markDemonstrated, 'small', { title: 'Records a demonstration today for this use case (D)' }) : null,
        item ? h('a', { class: 'btn small', href: `#/cases/${item.id}` }, 'Open tracker') : null,
        resultsToggle,
        btn('\u2190', () => go(index - 1), 'small', { 'aria-label': 'Previous slide' }),
        btn('\u2192', () => go(index + 1), 'small', { 'aria-label': 'Next slide' }),
        btn('Exit', exit, 'small')),
      slide,
      h('div', { class: 'slide-foot' },
        h('span', {}, `${index + 1} / ${slides.length}`),
        h('div', { class: 'bar' }, h('span', { style: { width: `${((index + 1) / slides.length) * 100}%` } })),
        h('span', {}, 'Arrow keys to move \u00B7 D to record a demonstration \u00B7 R to toggle results \u00B7 Esc to exit')));
  }

  const onKey = event => {
    if (event.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    if (['ArrowRight', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); go(index + 1); }
    else if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); go(index - 1); }
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(slides.length - 1);
    else if (event.key === 'Escape') exit();
    else if (event.key.toLowerCase() === 'r') { showResults = !showResults; draw(); }
    else if (event.key.toLowerCase() === 'd' && ctx.maps.case.get(slides[index])) markDemonstrated();
  };
  document.addEventListener('keydown', onKey);
  ctx.onCleanup(() => document.removeEventListener('keydown', onKey));
  draw();
  return holder;
}
