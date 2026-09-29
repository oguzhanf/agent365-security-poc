import * as C from '../core/compute.mjs';
import { h, pageHead, card, selectEl, field, btn, badge, scopeBadge, guideChip, caseChip, confirmDialog, modal, toast, debounce } from '../ui.js';

const STATUS_TONE = { planned: 'st-NOT_RUN', created: 'st-IN_PROGRESS', verified: 'st-IN_PROGRESS', restored: 'st-PASS', removed: 'st-PASS', residual: 'st-BLOCKED', 'pre-existing': 'st-NOT_APPLICABLE', 'not-needed': 'st-NOT_APPLICABLE' };

export function inventoryView(ctx) {
  const { model, route } = ctx;
  const eng = ctx.current();
  const scopes = C.stepScopes(eng);
  const statusOptions = Object.entries(model.inventory_statuses);
  const filters = { type: route.query.get('type') || '', status: route.query.get('status') || '', text: '' };
  const items = C.inventoryItems(model, eng).filter(item => item.custom || scopes.has(item.scope));
  const stats = C.inventoryStats(model, eng);

  const save = async (id, patch, stateEl) => {
    stateEl.textContent = 'Saving...';
    try {
      await ctx.mutate('PUT', `/inventory/${encodeURIComponent(id)}`, patch, { rerender: false });
      stateEl.textContent = 'Saved';
      stateEl.className = 'save-state ok';
    } catch {
      stateEl.textContent = 'Not saved';
      stateEl.className = 'save-state err';
    }
  };

  const rows = items.map(item => {
    const record = item.record;
    const stateEl = h('span', { class: 'save-state' });
    const status = selectEl(statusOptions, item.status, value => { statusBadge.className = `badge ${STATUS_TONE[value]}`; statusBadge.textContent = model.inventory_statuses[value]; save(item.id, { status: value }, stateEl); }, { 'aria-label': `Status of ${item.name}` });
    const statusBadge = h('span', { class: `badge ${STATUS_TONE[item.status]}` }, model.inventory_statuses[item.status]);
    const input = (key, placeholder) => {
      const el = h('input', { type: 'text', value: record[key] || '', placeholder, 'aria-label': `${key} for ${item.name}` });
      el.addEventListener('change', () => save(item.id, { [key]: el.value }, stateEl));
      return el;
    };
    const tr = h('tr', {},
      h('td', {},
        h('div', { style: { fontWeight: '600' } }, item.name, ' ', item.scope === 'demo' ? scopeBadge('demo') : null, item.custom ? badge('Added') : null),
        h('div', { class: 'muted small' }, item.purpose),
        h('div', { class: 'chips', style: { marginTop: '4px' } }, (item.guides || []).map(id => guideChip(model, id)), (item.cases || []).slice(0, 5).map(id => caseChip(model, eng, id)))),
      h('td', { style: { minWidth: '170px' } }, status, h('div', { style: { marginTop: '4px' } }, statusBadge)),
      h('td', { style: { minWidth: '200px' } }, input('actual_name', 'Actual name or object ID'), h('div', { style: { marginTop: '6px' } }, input('owner', 'Owner'))),
      h('td', { style: { minWidth: '220px' } }, input('note', 'Note'), h('div', { class: 'faint small', style: { marginTop: '4px' } }, `Cleanup: ${item.cleanup || 'Record the cleanup action.'}`), stateEl,
        item.custom ? btn('Delete', async () => {
          if (await confirmDialog('Delete tenant object', `Delete "${item.name}" from this build sheet? This does not change the tenant.`, 'Delete', 'danger')) ctx.mutate('DELETE', `/inventory/${encodeURIComponent(item.id)}`).catch(() => {});
        }, 'small danger') : null));
    return { item, tr };
  });

  const apply = () => {
    for (const { item, tr } of rows) {
      const current = C.inventoryItems(model, ctx.current()).find(entry => entry.id === item.id);
      const text = `${item.name} ${item.purpose} ${current?.record.actual_name || ''} ${current?.record.note || ''}`.toLowerCase();
      const show = (!filters.type || item.type === filters.type) && (!filters.status || current?.status === filters.status) && (!filters.text || text.includes(filters.text.toLowerCase()));
      tr.classList.toggle('hidden', !show);
    }
    for (const section of sections) section.el.classList.toggle('hidden', section.rows.every(row => row.tr.classList.contains('hidden')));
  };

  const sections = model.inventory_types.map(type => {
    const typeRows = rows.filter(row => row.item.type === type.id);
    const el = card({
      title: `${type.name} (${typeRows.length})`,
      flush: true,
      body: typeRows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Object'), h('th', {}, 'Status'), h('th', {}, 'Name and owner'), h('th', {}, 'Notes and cleanup'))),
        h('tbody', {}, typeRows.map(row => row.tr)))) : h('p', { class: 'muted', style: { padding: '12px 16px' } }, 'No object of this type in scope.'),
      cls: 'mb'
    });
    return { el, rows: typeRows };
  });

  const addObject = () => {
    const type = selectEl(model.inventory_types.map(entry => [entry.id, entry.name]), 'policies');
    const name = h('input', { type: 'text', placeholder: 'Object name' });
    const purpose = h('textarea', { rows: 2, placeholder: 'Why it exists in this PoC' });
    const scope = selectEl([['live', 'Live-proofed'], ['demo', 'Demonstration only']], 'live');
    const cleanup = h('textarea', { rows: 2, placeholder: 'How to remove or restore it' });
    modal({
      title: 'Add a tenant object',
      body: h('div', { class: 'form-grid' }, field('Type', type), field('Scope', scope), h('div', { class: 'full' }, field('Name', name)), h('div', { class: 'full' }, field('Purpose', purpose)), h('div', { class: 'full' }, field('Cleanup', cleanup))),
      actions: [
        { label: 'Cancel', run: close => close() },
        { label: 'Add', cls: 'primary', run: async close => {
          try {
            await ctx.mutate('POST', '/inventory', { type: type.value, name: name.value, purpose: purpose.value, scope: scope.value, cleanup: cleanup.value });
            close();
            toast('Tenant object added.', 'ok');
          } catch { /* toast shown */ }
        } }
      ]
    });
  };

  const search = h('input', { type: 'search', placeholder: 'Search objects', 'aria-label': 'Search objects' });
  search.addEventListener('input', debounce(() => { filters.text = search.value.trim(); apply(); }, 150));
  const root = h('div', {},
    pageHead({
      title: 'Tenant build sheet',
      sub: 'Every object the PoC creates or changes in this tenant: test identities, devices, agents, policies, and connectors. Record the actual names as you create them. Cleanup uses this list; residual objects keep an owner rather than being claimed removed.',
      actions: [btn('Add object', addObject, 'primary')]
    }),
    h('div', { class: 'grid grid-4', style: { marginBottom: '14px' } },
      card({ title: 'Objects in scope', body: h('div', { class: 'kpi-value' }, String(stats.total)) }),
      card({ title: 'Created or verified', body: h('div', { class: 'kpi-value' }, String((stats.counts.created || 0) + (stats.counts.verified || 0))) }),
      card({ title: 'Removed or restored', body: h('div', { class: 'kpi-value' }, String((stats.counts.removed || 0) + (stats.counts.restored || 0))) }),
      card({ title: 'Pre-existing or residual', body: h('div', { class: 'kpi-value' }, `${stats.counts['pre-existing'] || 0} / ${stats.residual}`) })),
    h('div', { class: 'filters' },
      selectEl([['', 'All types'], ...model.inventory_types.map(entry => [entry.id, entry.name])], filters.type, value => { filters.type = value; apply(); }, { 'aria-label': 'Type' }),
      selectEl([['', 'Any status'], ...statusOptions], filters.status, value => { filters.status = value; apply(); }, { 'aria-label': 'Status' }),
      search,
      h('div', { class: 'spacer' }),
      stats.outstanding_cleanup ? badge(`${stats.outstanding_cleanup} created object(s) still to remove or restore`, 'st-BLOCKED') : badge('No outstanding cleanup', 'st-PASS')),
    sections.map(section => section.el));
  apply();
  return root;
}
