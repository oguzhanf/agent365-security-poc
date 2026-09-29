import * as C from '../core/compute.mjs';
import { h, pageHead, card, caseChip, guideChip, badge, scopeBadge, linkBtn, resultBadge, demoBadge } from '../ui.js';

export function scopeView(ctx) {
  const { model } = ctx;
  const eng = ctx.current();
  const doc = model.document;
  const areaCard = area => h('div', { class: 'card', style: { padding: '12px 14px' } },
    h('div', { class: 'row' }, h('h3', { style: { fontSize: '14px' } }, area.title), h('div', { class: 'spacer' }), h('div', { class: 'chips' }, area.guides.map(id => guideChip(model, id)))),
    h('p', { class: 'muted', style: { margin: '6px 0 8px', fontSize: '13px' } }, area.summary),
    h('div', { class: 'chips' }, area.cases.map(id => caseChip(model, eng, id))));

  const groups = [...new Set(model.live_areas.map(area => area.group))];
  const counts = model.totals.cases;
  const documents = ctx.health?.documents || {};

  return h('div', {},
    pageHead({
      title: 'PoC scope and acceptance',
      sub: `${doc.title}. ${doc.subtitle}. Revision ${doc.revision}.`,
      crumbs: 'Customer-facing scope document',
      actions: [
        documents.scope_docx ? linkBtn('Scope document (DOCX)', '/api/docs/scope.docx') : null,
        documents.runbook_pdf ? linkBtn('Full runbook (PDF)', '/api/docs/runbook.pdf') : null,
        linkBtn('Reference pack (ZIP)', '/api/reference-pack.zip'),
        linkBtn('\u25B6 Present scope', '#/present?set=live', 'primary')
      ].filter(Boolean)
    }),
    h('div', { class: 'grid grid-3', style: { marginBottom: '16px' } },
      card({ title: 'What this PoC is', body: h('div', {}, model.overview.purpose.map(text => h('p', {}, text)), h('p', { class: 'muted' }, model.overview.control_plane)) }),
      card({ title: 'Two delivery modes', body: h('div', { class: 'stack' }, model.overview.modes.map(mode => h('div', {},
        h('div', { class: 'row' }, scopeBadge(mode.id), h('strong', {}, mode.name)),
        h('p', { class: 'muted', style: { marginTop: '4px' } }, mode.text)))) }),
      card({ title: 'Scope in numbers', body: h('div', { class: 'stack' },
        h('div', { class: 'row' }, badge(String(counts.live), 'lg sc-live'), 'live-proofed use cases form the acceptance denominator.'),
        h('div', { class: 'row' }, badge(String(counts.demo), 'lg sc-demo'), 'demonstration-only use cases are shown as walkthroughs.'),
        h('div', { class: 'row' }, badge(String(counts.unscheduled), 'lg sc-unscheduled'), 'optional cases are not scheduled.'),
        h('div', { class: 'row' }, badge(String(model.totals.steps.live), 'lg'), `live configuration steps across ${model.totals.guides} guides.`),
        h('p', { class: 'muted small' }, model.overview.deferred_required)) })),
    groups.map(group => card({
      title: `Live scope: ${group.toLowerCase()}`,
      body: h('div', { class: 'grid grid-2' }, model.live_areas.filter(area => area.group === group).map(areaCard)),
      cls: 'mb'
    })),
    card({
      title: 'Demonstration-only scope',
      body: h('div', {},
        h('p', { class: 'muted' }, 'Each item was deferred to a demonstration because of the two-week time constraint. None of these deferrals states that the capability does not work. Any of them can be scheduled as a follow-up live phase.'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Use cases'), h('th', {}, 'Guides'), h('th', {}, 'Reason'))),
          h('tbody', {}, model.demo_items.map(item => h('tr', {},
            h('td', { style: { fontWeight: '600' } }, item.title),
            h('td', {}, h('div', { class: 'chips' }, item.cases.map(id => caseChip(model, eng, id)))),
            h('td', {}, h('div', { class: 'chips' }, item.guides.map(id => guideChip(model, id)))),
            h('td', { class: 'muted' }, item.reason))))))),
      cls: 'mb'
    }),
    h('div', { class: 'grid grid-2', style: { marginBottom: '16px' } },
      card({
        title: 'Required demonstrations',
        body: h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Requested group'), h('th', {}, 'Test instance'), h('th', {}, 'Primary proof'), h('th', {}, 'Status'))),
          h('tbody', {}, model.required_demonstrations.map(row => {
            const ids = row.cases;
            const status = eng ? (row.scope === 'demo'
              ? demoBadge(ids.every(id => C.demoStatus(eng.cases?.[id]) === 'DEMONSTRATED') ? 'DEMONSTRATED' : C.demoStatus(eng.cases?.[ids[0]]))
              : resultBadge(C.caseDisplayStatus(model.cases.find(item => item.id === ids[0]), eng.cases?.[ids[0]]))) : null;
            return h('tr', {}, h('td', {}, row.group), h('td', { style: { fontWeight: '600' } }, row.instance, ' ', scopeBadge(row.scope)), h('td', { class: 'muted' }, row.proof), h('td', {}, status));
          }))))
      }),
      card({
        title: 'Test environment and stop conditions',
        body: h('div', {},
          h('ul', {}, model.environment.map(text => h('li', {}, text))),
          h('div', { class: 'kpi-label', style: { margin: '8px 0 4px' } }, 'Stop a test when'),
          h('ul', {}, model.stop_conditions.map(text => h('li', {}, text))))
      })),
    h('div', { class: 'grid grid-2' },
      card({
        title: 'Acceptance rules',
        body: h('div', {},
          h('ul', {}, model.acceptance.rules.map(text => h('li', {}, text))),
          h('div', { class: 'callout warn' }, h('ul', { style: { margin: 0 } }, model.acceptance.cautions.map(text => h('li', {}, text)))),
          h('p', { class: 'muted', style: { marginTop: '10px' } }, model.acceptance.demonstrations))
      }),
      card({
        title: 'Evidence and cleanup',
        body: h('div', {}, model.acceptance.evidence.map(text => h('p', {}, text)), h('p', { class: 'muted' }, model.cleanup))
      })));
}
