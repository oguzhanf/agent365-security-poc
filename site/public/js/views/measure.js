import { h, pageHead, card, field, selectEl, badge } from '../ui.js';

const TITLES = {
  discovery_minutes: 'Discovery time',
  revocation_minutes: 'Revocation time',
  alert_minutes: 'Alert time',
  investigation_minutes: 'Investigation time'
};
const SUGGESTED_CASES = {
  discovery_minutes: 'ONB-01',
  revocation_minutes: 'ENTRA-06',
  alert_minutes: 'SENT-03',
  investigation_minutes: 'COP-01'
};

export function measureView(ctx) {
  const { model } = ctx;
  const eng = ctx.current();
  const cards = model.measurements.map(metric => {
    const record = eng.measurements?.[metric.metric] || {};
    const state = h('span', { class: 'save-state' });
    const verdict = h('div', {});
    const drawVerdict = () => {
      const current = ctx.current().measurements?.[metric.metric] || {};
      const measured = current.measured_minutes;
      const target = current.target_minutes;
      verdict.replaceChildren(
        h('div', { class: 'kpi-value' }, measured === null || measured === undefined ? '\u2013' : `${measured} min`),
        target === null || target === undefined ? h('div', { class: 'muted small' }, 'No target set. Set targets before execution.')
          : measured === null || measured === undefined ? h('div', { class: 'muted small' }, `Target ${target} min`)
            : badge(measured <= target ? `Within the ${target} min target` : `Over the ${target} min target`, measured <= target ? 'st-PASS' : 'st-FAIL'));
    };
    const save = async patch => {
      state.textContent = 'Saving...';
      state.className = 'save-state';
      try {
        await ctx.mutate('PUT', `/measurements/${metric.metric}`, patch, { rerender: false });
        state.textContent = 'Saved';
        state.className = 'save-state ok';
        const current = ctx.current().measurements?.[metric.metric] || {};
        if (current.measured_minutes !== undefined && current.measured_minutes !== null) measuredInput.value = current.measured_minutes;
        drawVerdict();
      } catch {
        state.textContent = 'Not saved';
        state.className = 'save-state err';
      }
    };
    const input = (key, type, attrs = {}) => {
      const el = h('input', { type, value: record[key] ?? '', ...attrs });
      el.addEventListener('change', () => save({ [key]: type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value }));
      return el;
    };
    const measuredInput = input('measured_minutes', 'number', { min: 0, step: '0.1' });
    const caseSelect = selectEl([['', 'Select a use case'], ...model.cases.map(item => [item.id, `${item.id} ${item.title}`])], record.case || '', value => save({ case: value }), { 'aria-label': 'Use case' });
    caseSelect.style.width = '100%';
    drawVerdict();
    return card({
      title: TITLES[metric.metric] || metric.metric,
      actions: [state],
      body: h('div', { class: 'stack' },
        h('div', { class: 'small muted' }, h('strong', {}, 'Starts: '), metric.start_event, h('br'), h('strong', {}, 'Ends: '), metric.end_event),
        verdict,
        h('div', { class: 'form-grid' },
          field('Target (minutes)', input('target_minutes', 'number', { min: 0, step: '1' }), 'Set before execution.'),
          field('Measured (minutes)', measuredInput, 'Calculated from the times, or enter it.'),
          field('Start (UTC)', input('start_utc', 'datetime-local')),
          field('End (UTC)', input('end_utc', 'datetime-local')),
          h('div', { class: 'full' }, field('Use case', caseSelect, `Suggested: ${SUGGESTED_CASES[metric.metric]}.`)),
          h('div', { class: 'full' }, field('Evidence reference', input('evidence', 'text', { placeholder: 'Path in the protected evidence store' }))),
          h('div', { class: 'full' }, field('Notes', input('notes', 'text')))))
    });
  });
  return h('div', {},
    pageHead({
      title: 'Measured security value',
      sub: 'Elapsed-time measurements from the measurement template. Set each target before execution; do not use measured times as retrospective targets. Enter times in UTC.'
    }),
    h('div', { class: 'grid grid-2' }, cards));
}
