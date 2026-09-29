import * as C from '../core/compute.mjs';
import { h, pageHead, card, richText, caseChip, badge } from '../ui.js';

const STATE_ORDER = ['supported', 'conditional', 'preview', 'not-established', 'not-supported', 'not-applicable'];

function casesForCell(model, familyId, layerId) {
  const catalogueFamilies = Object.entries(model.labels.family_to_matrix).filter(([, ids]) => ids.includes(familyId)).map(([family]) => family);
  const catalogueLayers = Object.entries(model.labels.layer_to_matrix).filter(([, id]) => id === layerId).map(([layer]) => layer);
  return model.cases.filter(item => catalogueLayers.includes(item.layer) && (catalogueFamilies.includes(item.family) || item.family === 'cross_platform'));
}

export function coverageView(ctx) {
  const { model, route } = ctx;
  const eng = ctx.current();
  const matrix = model.matrix;
  let selected = route.query.get('cell') || `${matrix.families[0].id}:${matrix.layers[0]}`;
  let overlay = route.query.get('overlay') !== '0';
  const detail = h('div', {});
  const table = h('table', { class: 'matrix' });

  const drawDetail = () => {
    const [familyId, layerId] = selected.split(':');
    const family = matrix.families.find(item => item.id === familyId);
    const control = family?.controls.find(item => item.layer === layerId);
    if (!family || !control) { detail.replaceChildren(); return; }
    const cases = casesForCell(model, familyId, layerId);
    detail.replaceChildren(card({
      title: `${family.name} \u00B7 ${model.labels.matrix_layers[layerId] || layerId}`,
      actions: [h('span', { class: `badge lg ms-${control.state}` }, control.state)],
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted' }, matrix.states[control.state]),
        h('div', { class: `boundary state-${control.state}` }, richText(`${control.enforcementBoundary} [${control.sourceIds.join(', ')}]`, model)),
        control.prerequisites?.length ? h('div', {}, h('div', { class: 'kpi-label' }, 'Prerequisites'), h('ul', {}, control.prerequisites.map(text => h('li', {}, text)))) : null,
        family.acceptanceRequirement ? h('div', { class: 'callout warn' }, family.acceptanceRequirement) : null,
        cases.length ? h('div', {}, h('div', { class: 'kpi-label', style: { marginBottom: '6px' } }, 'Use cases that exercise this cell'), h('div', { class: 'chips' }, cases.map(item => caseChip(model, eng, item.id)))) : h('p', { class: 'muted small' }, 'No catalogue use case maps directly to this cell.'),
        h('div', { class: 'faint small' }, `Availability date: ${control.availabilityDate || matrix.as_of}. ${matrix.availability_date_meaning}`))
    }));
  };

  const drawTable = () => {
    table.replaceChildren(
      h('thead', {}, h('tr', {}, h('th', { class: 'fam' }, 'Agent group'), matrix.layers.map(layer => h('th', {}, model.labels.matrix_layers[layer] || layer)))),
      h('tbody', {}, matrix.families.map(family => h('tr', {},
        h('th', { class: 'fam' }, family.name),
        matrix.layers.map(layer => {
          const control = family.controls.find(item => item.layer === layer);
          const key = `${family.id}:${layer}`;
          const cases = overlay && eng ? casesForCell(model, family.id, layer).filter(item => item.family !== 'cross_platform') : [];
          const td = h('td', { class: `ms-${control.state}${key === selected ? ' sel' : ''}`, title: `${family.name}: ${model.labels.matrix_layers[layer]} is ${control.state}`, tabindex: '0' },
            control.state.replace('not-', 'not '),
            cases.length ? h('div', { class: 'dots' }, cases.slice(0, 6).map(item => {
              const status = item.scope === 'demo' && C.demoStatus(eng.cases?.[item.id]) === 'DEMONSTRATED' ? 'PASS' : C.caseDisplayStatus(item, eng.cases?.[item.id]);
              return h('span', { class: `dot st-${status}`, title: `${item.id}: ${C.RESULT_LABELS[status]}` });
            })) : null);
          const choose = () => {
            selected = key;
            history.replaceState(null, '', `#/coverage?cell=${encodeURIComponent(key)}${overlay ? '' : '&overlay=0'}`);
            drawTable();
            drawDetail();
          };
          td.addEventListener('click', choose);
          td.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
          return td;
        })))));
  };

  const overlayBox = h('input', { type: 'checkbox', checked: overlay });
  overlayBox.addEventListener('change', () => { overlay = overlayBox.checked; drawTable(); });
  drawTable();
  drawDetail();

  const counts = {};
  for (const family of matrix.families) for (const control of family.controls) counts[control.state] = (counts[control.state] || 0) + 1;

  return h('div', {},
    pageHead({
      title: 'Control coverage by agent group',
      sub: `${matrix.evidence_status} Select a cell to see the documented control boundary, prerequisites, sources, and the use cases that exercise it.`
    }),
    h('div', { class: 'filters' },
      h('div', { class: 'legend' }, STATE_ORDER.map(state => h('span', { title: matrix.states[state] }, h('span', { class: `sw ms-${state}` }), `${state} (${counts[state] || 0})`))),
      h('div', { class: 'spacer' }),
      eng ? h('label', { class: 'check' }, overlayBox, 'Overlay use case results') : null),
    h('section', { class: 'card', style: { marginBottom: '16px' } }, h('div', { class: 'card-body table-wrap' }, table)),
    detail,
    h('p', { class: 'faint small', style: { marginTop: '10px' } }, `Support matrix as of ${matrix.as_of}. `, badge('Registry presence does not prove identity integration, content inspection, or runtime blocking.')));
}
