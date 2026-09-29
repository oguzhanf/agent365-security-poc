import * as C from '../core/compute.mjs';
import {
  h, pageHead, card, bar, caseChip, badge, scopeBadge, richText, docTable, codeBox, linkBtn, debounce
} from '../ui.js';
import { stepRow } from './steps.js';

const pad2 = value => String(value).padStart(2, '0');
const SOURCE_REF = /\[([A-Z][A-Z0-9]*\d(?:,\s*[A-Z][A-Z0-9]*\d)*)\]/g;

function bucketLabels(model, guide) {
  return guide.buckets.map(id => model.buckets.find(bucket => bucket.id === id)?.label).filter(Boolean).join(', ');
}

export function guidesView(ctx) {
  const { model } = ctx;
  const eng = ctx.current();
  const scopes = eng ? C.stepScopes(eng) : new Set(['live', 'optional', 'demo']);
  const search = h('input', { type: 'search', placeholder: 'Search guides', 'aria-label': 'Search guides' });
  const grid = h('div', { class: 'grid grid-3' });
  const cards = model.guides.map(guide => {
    const steps = model.steps.filter(step => step.guide === guide.id && scopes.has(step.scope));
    const stats = eng ? C.stepStats(steps, eng) : null;
    const counts = guide.step_counts;
    const el = h('a', { class: 'card guide-card', href: `#/guides/${guide.id}`, style: { color: 'inherit', textDecoration: 'none' } },
      h('div', { class: 'row' }, h('span', { class: 'guide-num' }, `GUIDE ${pad2(guide.number)}`), h('div', { class: 'spacer' }),
        counts.demo && !counts.live ? scopeBadge('demo') : null, guide.origin === 'scope' ? badge('Scope document', 'sc-live') : null),
      h('h3', {}, guide.title),
      h('div', { class: 'muted small' }, `${bucketLabels(model, guide)} \u00B7 ${counts.total ? `${counts.live} live, ${counts.optional} optional, ${counts.demo} demo-only steps` : 'Reference reading, no steps'}`),
      stats && stats.total ? h('div', {}, h('div', { class: 'bar-label' }, h('span', {}, 'In this engagement'), h('span', {}, `${stats.done}/${stats.applicable}`)), bar(stats.pct)) : null,
      guide.cases.length ? h('div', { class: 'chips' }, guide.cases.slice(0, 8).map(id => caseChip(model, eng, id))) : null);
    el.dataset.search = `${pad2(guide.number)} ${guide.title} ${guide.cases.join(' ')}`.toLowerCase();
    return el;
  });
  grid.append(...cards);
  search.addEventListener('input', debounce(() => {
    const needle = search.value.trim().toLowerCase();
    for (const el of cards) el.classList.toggle('hidden', Boolean(needle) && !el.dataset.search.includes(needle));
  }, 150));
  return h('div', {},
    pageHead({
      title: 'Guides',
      sub: `The reference pack: ${model.guides.length} deployment and configuration guides, numbered in execution order as cited by the scope document. Guide 45 is the close-out guide from the scope document.`,
      actions: [linkBtn('Download reference pack', '/api/reference-pack.zip', 'primary')]
    }),
    h('div', { class: 'filters' }, search),
    grid);
}

export function guideView(ctx) {
  const { model, route } = ctx;
  const eng = ctx.current();
  const guide = ctx.maps.guide.get(route.params[0]);
  if (!guide) return h('div', { class: 'callout warn' }, 'Guide not found.');
  const index = model.guides.indexOf(guide);
  const prev = model.guides[index - 1];
  const next = model.guides[index + 1];
  const numbers = eng ? C.stepNumbers(model, eng) : new Map();
  const scopes = eng ? C.stepScopes(eng) : new Set();
  const stepById = ctx.maps.step;
  const ownSteps = guide.step_ids.map(id => stepById.get(id));
  const inScope = ownSteps.filter(step => scopes.has(step.scope));
  const progress = h('div', {});
  const drawProgress = () => {
    progress.replaceChildren();
    if (!eng || !inScope.length) return;
    const stats = C.stepStats(inScope, ctx.current());
    progress.append(h('div', { class: 'bar-label' }, h('span', {}, `${stats.done} of ${stats.applicable} steps in scope done`), h('span', {}, `${stats.pct}%`)), bar(stats.pct));
  };
  drawProgress();

  const cited = new Set();
  for (const match of JSON.stringify(guide).matchAll(SOURCE_REF)) match[1].split(/,\s*/).forEach(id => cited.add(id));
  const sources = [...cited].filter(id => model.sources[id]);

  const sectionEls = guide.sections.map(section => h('div', { class: 'doc-section', id: `section-${section.id}` },
    h('div', { class: 'row' }, h('h3', {}, `${section.index}. ${section.title}`), section.scope !== 'live' ? scopeBadge(section.scope) : null,
      section.cases.length ? h('div', { class: 'chips' }, section.cases.map(id => caseChip(model, eng, id))) : null),
    section.paragraphs.map(text => h('p', {}, richText(text, model))),
    section.table ? docTable(section.table, model) : null,
    section.step_ids.length ? h('div', { style: { margin: '6px -16px' } }, section.step_ids.map(id => {
      const step = stepById.get(id);
      if (!eng) return h('div', { class: 'step' }, h('span'), h('div', { class: 'step-num' }), h('div', { class: 'step-body' }, h('div', { class: 'step-text' }, richText(step.text, model)), h('div', { class: 'step-meta' }, h('span', { class: 'step-id' }, step.id))), h('span'));
      const row = stepRow(ctx, step, numbers.get(step.id), { onChange: drawProgress });
      if (!scopes.has(step.scope)) row.title = 'Outside this engagement scope. Change the scope in Settings to count it.';
      return row;
    })) : null,
    section.items.length ? h('ul', {}, section.items.map(item => h('li', {}, richText(item, model)))) : null,
    section.code ? codeBox(section.code) : null,
    section.notes.map(note => h('div', { class: 'callout', style: { margin: '6px 0' } }, richText(note, model)))));

  return h('div', {},
    pageHead({
      crumbs: h('span', {}, h('a', { href: '#/guides' }, 'Guides'), ` / Guide ${pad2(guide.number)}`),
      title: `Guide ${pad2(guide.number)}: ${guide.title}`,
      sub: `${bucketLabels(model, guide)} \u00B7 ${guide.step_counts.live} live, ${guide.step_counts.optional} optional, ${guide.step_counts.demo} demonstration-only steps${guide.origin_note ? ` \u00B7 ${guide.origin_note}` : ''}`,
      actions: [
        prev ? linkBtn(`\u2190 Guide ${pad2(prev.number)}`, `#/guides/${prev.id}`) : null,
        next ? linkBtn(`Guide ${pad2(next.number)} \u2192`, `#/guides/${next.id}`) : null
      ].filter(Boolean)
    }),
    h('div', { class: 'split' },
      h('section', { class: 'card' },
        guide.paragraphs.length ? h('div', { class: 'doc-section' }, guide.paragraphs.map(text => h('p', {}, richText(text, model)))) : null,
        sectionEls),
      h('div', { class: 'stack sticky' },
        card({ title: 'Progress', body: eng ? progress : h('p', { class: 'muted' }, 'Select an engagement to track steps.') }),
        guide.cases.length ? card({ title: 'Use cases', body: h('div', { class: 'chips' }, guide.cases.map(id => caseChip(model, eng, id))) }) : null,
        card({ title: 'Sections', body: h('ol', { style: { margin: 0 } }, guide.sections.map(section => h('li', {}, h('a', { href: `#/guides/${guide.id}`, on: { click: event => { event.preventDefault(); document.getElementById(`section-${section.id}`)?.scrollIntoView({ behavior: 'smooth' }); } } }, section.title)))) }),
        sources.length ? card({ title: 'Sources', body: h('ul', { class: 'list-plain small' }, sources.map(id => h('li', {}, h('a', { href: model.sources[id].url, target: '_blank', rel: 'noopener noreferrer' }, `[${id}] ${model.sources[id].title}`)))) }) : null)));
}
