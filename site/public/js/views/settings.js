import * as C from '../core/compute.mjs';
import { h, pageHead, card, field, selectEl, btn, toast, modal } from '../ui.js';

const OWNER_LABELS = {
  poc_lead: 'PoC lead', identity: 'Identity', microsoft_365: 'Microsoft 365', purview: 'Purview',
  defender: 'Defender', azure: 'Azure', endpoint: 'Endpoint', evidence_reviewer: 'Evidence reviewer'
};

export function settingsView(ctx) {
  const eng = ctx.current();
  const settings = JSON.parse(JSON.stringify(eng.settings));
  const inputs = [];
  const input = (path, attrs = {}) => {
    const value = path.reduce((node, key) => (node ? node[key] : undefined), settings);
    const el = h('input', { type: 'text', value: value ?? '', ...attrs });
    inputs.push({ path, el, kind: 'value' });
    return el;
  };
  const area = (path, rows = 3) => {
    const el = h('textarea', { rows });
    el.value = path.reduce((node, key) => (node ? node[key] : undefined), settings) || '';
    inputs.push({ path, el, kind: 'value' });
    return el;
  };
  const select = (path, options) => {
    const el = selectEl(options, path.reduce((node, key) => node[key], settings));
    inputs.push({ path, el, kind: 'value' });
    return el;
  };
  const checkbox = (path, disabled = false) => {
    const el = h('input', { type: 'checkbox', checked: Boolean(path.reduce((node, key) => node[key], settings)), disabled });
    inputs.push({ path, el, kind: 'checked' });
    return el;
  };

  const collect = () => {
    const patch = {};
    for (const { path, el, kind } of inputs) {
      let node = patch;
      path.slice(0, -1).forEach(key => { node[key] = node[key] || {}; node = node[key]; });
      node[path[path.length - 1]] = kind === 'checked' ? el.checked : el.value;
    }
    patch.scopes.live = true;
    return patch;
  };
  const saveState = h('span', { class: 'save-state' });
  const save = async () => {
    saveState.textContent = 'Saving...';
    try {
      await ctx.mutate('PUT', '/settings', collect(), { rerender: false });
      await ctx.reloadEngagements();
      saveState.textContent = 'Saved';
      saveState.className = 'save-state ok';
      toast('Settings saved.', 'ok');
    } catch {
      saveState.textContent = 'Not saved';
      saveState.className = 'save-state err';
    }
  };

  const remove = () => {
    const confirmInput = h('input', { type: 'text', placeholder: eng.id });
    modal({
      title: 'Delete engagement',
      body: h('div', { class: 'stack' },
        h('p', {}, `The engagement file moves to the trash folder in the data directory. It is not shared or uploaded. Type ${eng.id} to confirm.`),
        confirmInput),
      actions: [
        { label: 'Cancel', run: close => close() },
        { label: 'Delete', cls: 'danger', run: async close => {
          if (confirmInput.value !== eng.id) { toast('The ID does not match.', 'err'); return; }
          try {
            await ctx.api.send('DELETE', `/api/engagements/${eng.id}`);
            close();
            localStorage.removeItem('a365-poc-site.engagement');
            window.location.hash = '#/dashboard';
            window.location.reload();
          } catch (error) {
            toast(error.message, 'err');
          }
        } }
      ]
    });
  };

  const scopeHelp = h('div', { class: 'callout small' },
    'Live-proofed steps and use cases are always tracked. Add optional steps for alternative paths. Add demonstration-only content when this tenant is the demonstration environment that hosts the deferred items. ',
    `The full pack has ${ctx.model.totals.steps.live} live, ${ctx.model.totals.steps.optional} optional, and ${ctx.model.totals.steps.demo} demonstration-only steps.`);

  return h('div', {},
    pageHead({
      title: 'Engagement settings',
      sub: `Stored in ${ctx.health?.data_dir || 'the data directory'}, outside the source repository.`,
      actions: [saveState, btn('Save settings', save, 'primary')]
    }),
    h('div', { class: 'grid grid-2' },
      card({ title: 'Engagement', body: h('div', { class: 'form-grid' },
        h('div', { class: 'full' }, field('Name', input(['name']))),
        field('Customer', input(['customer'])),
        field('Role', select(['role'], Object.entries(C.ROLES)), 'Changing the role does not change the scope below.'),
        h('div', { class: 'full' }, field('Prepared by', input(['prepared_by']), 'Shown on reports.'))) }),
      card({ title: 'Tenant', body: h('div', { class: 'form-grid' },
        field('Display name', input(['tenant', 'name'])),
        field('Primary domain', input(['tenant', 'domain'], { placeholder: 'contoso.onmicrosoft.com' }), 'Adds a tenant hint to Azure portal links.'),
        field('Tenant ID', input(['tenant', 'tenant_id'], { placeholder: '00000000-0000-0000-0000-000000000000' }), 'Adds a tenant hint to Defender and Purview links.'),
        field('Cloud', input(['tenant', 'cloud'])),
        h('div', { class: 'full' }, field('Region', input(['tenant', 'region'])))) }),
      card({ title: 'Schedule', body: h('div', { class: 'form-grid' },
        field('Start date (Day 1)', input(['start_date'], { type: 'date' })),
        field('End date', input(['end_date'], { type: 'date' }), 'Leave empty to use Day 14.'),
        h('div', { class: 'full' }, field('Plan days', select(['calendar'], [['calendar', 'Calendar days (Days 1-14 are consecutive)'], ['working', 'Working days (skip weekends)']])))) }),
      card({ title: 'Scope tracked in this engagement', body: h('div', { class: 'stack' },
        h('label', { class: 'check' }, checkbox(['scopes', 'live'], true), 'Live-proofed steps and use cases'),
        h('label', { class: 'check' }, checkbox(['scopes', 'optional']), 'Optional and alternative steps, and unscheduled optional use cases'),
        h('label', { class: 'check' }, checkbox(['scopes', 'demo']), 'Demonstration-only steps (demonstration environment build)'),
        scopeHelp) }),
      card({ title: 'Owners', body: h('div', { class: 'form-grid' }, Object.entries(OWNER_LABELS).map(([key, label]) => field(label, input(['owners', key])))) }),
      card({ title: 'Test bed', body: h('div', { class: 'form-grid' },
        h('div', { class: 'full' }, field('Test users', input(['test_bed', 'users']))),
        h('div', { class: 'full' }, field('Test devices', input(['test_bed', 'devices']))),
        field('Power Platform environment', input(['test_bed', 'power_platform_environment'])),
        field('Azure subscription', input(['test_bed', 'azure_subscription'])),
        h('div', { class: 'full' }, field('Resource group', input(['test_bed', 'resource_group']))),
        h('div', { class: 'full' }, field('Notes', area(['test_bed', 'notes'], 4)))) }),
      card({ title: 'Governance', body: h('div', { class: 'form-grid' },
        h('div', { class: 'full' }, field('Customer approval reference', input(['approval_reference']))),
        h('div', { class: 'full' }, field('Evidence location', input(['evidence_location'], { placeholder: 'C:\\Users\\name\\Agent365-Evidence\\run-01' }), 'Absolute path outside the repository. Used by the evidence recorder commands.')),
        field('Budget currency', input(['budget', 'currency'])),
        field('Approved limit', input(['budget', 'approved_limit']))) }),
      card({ title: 'Danger zone', body: h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Export the engagement from Reports before deleting it.'),
        btn('Delete this engagement', remove, 'danger')) })));
}

export function newEngagementView(ctx) {
  const name = h('input', { type: 'text', placeholder: 'Contoso evaluation tenant' });
  const customer = h('input', { type: 'text', placeholder: 'Contoso' });
  const tenant = h('input', { type: 'text', placeholder: 'Tenant display name' });
  const start = h('input', { type: 'date' });
  const role = selectEl([['evaluation', 'Customer evaluation tenant (live-proofed scope)'], ['demonstration', 'Demonstration tenant (live, optional, and demonstration-only content)']], 'evaluation');
  const create = async () => {
    try {
      const created = await ctx.api.send('POST', '/api/engagements', {
        preset: role.value,
        settings: { name: name.value || (role.value === 'demonstration' ? 'Demonstration tenant' : 'Customer evaluation tenant'), customer: customer.value, tenant: { name: tenant.value }, start_date: start.value }
      });
      await ctx.reloadEngagements(created.id);
      toast('Engagement created.', 'ok');
      ctx.navigate('#/dashboard');
    } catch (error) {
      toast(error.message, 'err');
    }
  };
  return h('div', {},
    pageHead({
      title: 'New engagement',
      sub: 'An engagement tracks one tenant. Use one for the customer evaluation tenant and another for the demonstration tenant where you build and rehearse the content.'
    }),
    h('div', { class: 'grid grid-2' },
      card({ title: 'Details', body: h('div', { class: 'form-grid' },
        h('div', { class: 'full' }, field('Name', name)),
        field('Customer', customer),
        field('Tenant display name', tenant),
        field('Type', role),
        field('Start date (Day 1)', start),
        h('div', { class: 'full row' }, btn('Create engagement', create, 'primary'))) }),
      card({ title: 'Which type?', body: h('div', { class: 'stack' },
        h('p', {}, h('strong', {}, 'Customer evaluation tenant. '), 'Tracks the live-proofed configuration steps and the 36 live use cases that form acceptance. Demonstration-only items are recorded as demonstrations.'),
        h('p', {}, h('strong', {}, 'Demonstration tenant. '), 'Tracks every step, including optional paths and the demonstration-only items, so you can build and rehearse all content before customer sessions.'),
        h('p', { class: 'muted small' }, 'Engagement data stays in the local data directory outside the repository.')) })));
}
