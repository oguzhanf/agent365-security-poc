// Agent 365 Security PoC demonstrator and tracker: application shell.

import * as C from './core/compute.mjs';
import { h, clear, toast, btn } from './ui.js';
import { dashboardView } from './views/dashboard.js';
import { scopeView } from './views/scope.js';
import { planView } from './views/plan.js';
import { stepsView } from './views/steps.js';
import { guidesView, guideView } from './views/guides.js';
import { casesView, caseView } from './views/cases.js';
import { presentView } from './views/present.js';
import { coverageView } from './views/coverage.js';
import { inventoryView } from './views/inventory.js';
import { contentView } from './views/content.js';
import { notesView } from './views/notes.js';
import { measureView } from './views/measure.js';
import { reportsView } from './views/reports.js';
import { settingsView, newEngagementView } from './views/settings.js';

const STORAGE_KEY = 'a365-poc-site.engagement';
const state = { model: null, engagements: [], eng: null, health: null, cleanups: [], lastRoute: '' };

async function parse(response) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!response.ok) throw new Error(data?.error || `${response.status} ${response.statusText}`);
  return data;
}

export const api = {
  get: path => fetch(path, { headers: { accept: 'application/json' } }).then(parse),
  send: (method, path, body) => fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-a365-site': '1' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(parse)
};

const NAV = [
  { group: 'Overview', items: [
    { route: 'dashboard', label: 'Dashboard', icon: '\u25A6' },
    { route: 'scope', label: 'PoC scope', icon: '\u2691' },
    { route: 'plan', label: 'Two-week plan', icon: '\u25B8' }
  ] },
  { group: 'Execute', items: [
    { route: 'steps', label: 'Configuration steps', icon: '\u2714', count: 'steps' },
    { route: 'guides', label: 'Guides', icon: '\u2261' },
    { route: 'cases', label: 'Use cases', icon: '\u25C9', count: 'cases' },
    { route: 'inventory', label: 'Tenant build', icon: '\u2692' }
  ] },
  { group: 'Demonstrate', items: [
    { route: 'present', label: 'Presenter mode', icon: '\u25B6' },
    { route: 'coverage', label: 'Coverage matrix', icon: '\u25A4' },
    { route: 'content', label: 'Synthetic content', icon: '\u2709' }
  ] },
  { group: 'Report', items: [
    { route: 'notes', label: 'Notes and RAID', icon: '\u270E', count: 'notes' },
    { route: 'measure', label: 'Measured value', icon: '\u23F1' },
    { route: 'reports', label: 'Reports', icon: '\u2399' }
  ] },
  { group: 'Engagement', items: [
    { route: 'settings', label: 'Settings', icon: '\u2699' },
    { route: 'new', label: 'New engagement', icon: '\u002B' }
  ] }
];

function parseRoute() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'dashboard', params: parts.slice(1), query: new URLSearchParams(queryPart), raw };
}

function buildShell() {
  const app = document.getElementById('app');
  clear(app);
  const nav = h('nav', { class: 'nav', 'aria-label': 'Sections' },
    NAV.map(group => h('div', { class: 'nav-group' },
      h('div', { class: 'nav-label' }, group.group),
      group.items.map(item => h('a', { href: `#/${item.route}`, dataset: { route: item.route } },
        h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, item.icon),
        h('span', {}, item.label),
        item.count ? h('span', { class: 'nav-count', dataset: { count: item.count } }) : null)))));
  const engSelect = h('select', { id: 'eng-select', 'aria-label': 'Engagement' });
  engSelect.addEventListener('change', () => selectEngagement(engSelect.value));
  app.append(h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' },
        h('div', { class: 'brand-mark', 'aria-hidden': 'true', id: 'brand-mark' }),
        h('div', {}, h('div', { class: 'brand-title' }, 'Agent 365 Security PoC'), h('div', { class: 'brand-sub' }, 'Demonstrator and tracker'))),
      nav,
      h('div', { class: 'sidebar-foot', id: 'sidebar-foot' })),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        h('div', { class: 'eng-switch' }, engSelect, h('span', { id: 'eng-role' })),
        h('span', { class: 'day-pill', id: 'day-pill' }),
        h('div', { class: 'spacer' }),
        h('a', { class: 'btn', href: '#/present' }, '\u25B6 Present'),
        h('a', { class: 'btn', href: '#/reports' }, 'Reports')),
      h('main', { class: 'view', id: 'view', tabindex: '-1' }))));
  const mark = document.getElementById('brand-mark');
  mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3l7 3v5c0 4.4-3 8.1-7 9.6C8 19.1 5 15.4 5 11V6l7-3z"/><path d="M9 11.8l2.1 2.1L15.2 9.8"/></svg>';
}

function updateChrome() {
  const { model, eng } = state;
  const select = document.getElementById('eng-select');
  if (!select) return;
  clear(select);
  for (const item of state.engagements) {
    select.append(h('option', { value: item.id, selected: eng && item.id === eng.id }, `${item.name}${item.tenant && item.tenant !== item.name ? ` (${item.tenant})` : ''}`));
  }
  const role = document.getElementById('eng-role');
  clear(role);
  const pill = document.getElementById('day-pill');
  if (eng) {
    role.append(h('span', { class: 'badge role' }, C.ROLES[eng.settings.role] || eng.settings.role));
    const day = C.planDay(eng);
    const bucket = model.buckets.find(item => item.id === C.currentBucket(model, eng));
    pill.textContent = day === null ? 'Set a start date' : day <= 0 ? `Starts ${eng.settings.start_date}` : day > C.PLAN_DAYS ? `Day ${day} (after the two-week window)` : `Day ${day} of ${C.PLAN_DAYS}${bucket ? ` \u00B7 ${bucket.title}` : ''}`;
    pill.classList.remove('hidden');
    const steps = C.stepStats(C.includedSteps(model, eng), eng);
    const live = C.caseStats(model.cases.filter(item => item.scope === 'live'), eng);
    const notes = C.noteStats(eng);
    const counts = { steps: `${steps.done}/${steps.applicable}`, cases: `${live.passed}/${live.total}`, notes: String(notes.open_actions + notes.open_risks + notes.open_issues) };
    document.querySelectorAll('[data-count]').forEach(el => { el.textContent = counts[el.dataset.count] || ''; });
  } else {
    pill.classList.add('hidden');
    document.querySelectorAll('[data-count]').forEach(el => { el.textContent = ''; });
  }
  const foot = document.getElementById('sidebar-foot');
  clear(foot);
  foot.append(h('div', {}, `Scope document ${model.document.revision.split(' - ')[0]}`), h('div', {}, `${model.totals.steps.all} steps \u00B7 ${model.totals.cases.all} use cases`));
  if (state.health?.data_dir) foot.append(h('div', { title: 'Engagement data is stored outside the repository.' }, `Data: ${state.health.data_dir}`));
}

function highlightNav(route) {
  document.querySelectorAll('.nav a').forEach(link => link.classList.toggle('active', link.dataset.route === route.name));
}

async function selectEngagement(id) {
  try {
    state.eng = await api.get(`/api/engagements/${encodeURIComponent(id)}`);
    localStorage.setItem(STORAGE_KEY, id);
    updateChrome();
    render();
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function refreshEngagements() {
  state.engagements = await api.get('/api/engagements');
}

function context(route) {
  return {
    model: state.model,
    eng: state.eng,
    engagements: state.engagements,
    health: state.health,
    route,
    api,
    maps: state.maps,
    navigate(hash) { window.location.hash = hash; },
    rerender: () => render({ keepScroll: true }),
    onCleanup(fn) { state.cleanups.push(fn); },
    async mutate(method, path, body, { rerender = true } = {}) {
      try {
        const eng = await api.send(method, `/api/engagements/${encodeURIComponent(state.eng.id)}${path}`, body);
        state.eng = eng;
        updateChrome();
        if (rerender) render({ keepScroll: true });
        return eng;
      } catch (error) {
        toast(error.message, 'err');
        throw error;
      }
    },
    current: () => state.eng,
    async reloadEngagements(selectId) {
      await refreshEngagements();
      if (selectId) await selectEngagement(selectId);
      else updateChrome();
    }
  };
}

const VIEWS = {
  dashboard: dashboardView,
  scope: scopeView,
  plan: planView,
  steps: stepsView,
  guides: ctx => (ctx.route.params[0] ? guideView(ctx) : guidesView(ctx)),
  cases: ctx => (ctx.route.params[0] ? caseView(ctx) : casesView(ctx)),
  present: presentView,
  coverage: coverageView,
  inventory: inventoryView,
  content: contentView,
  notes: notesView,
  measure: measureView,
  reports: reportsView,
  settings: settingsView,
  new: newEngagementView
};

function render({ keepScroll = false } = {}) {
  const view = document.getElementById('view');
  if (!view) return;
  for (const cleanup of state.cleanups.splice(0)) {
    try { cleanup(); } catch { /* ignore */ }
  }
  const route = parseRoute();
  const needsEngagement = !['new', 'scope', 'coverage', 'content', 'guides'].includes(route.name);
  document.body.classList.toggle('presenting', route.name === 'present' && Boolean(state.eng));
  highlightNav(route);
  const scrollY = window.scrollY;
  clear(view);
  if (!state.eng && needsEngagement) {
    view.append(newEngagementView(context({ ...route, name: 'new' })));
    return;
  }
  const factory = VIEWS[route.name] || dashboardView;
  try {
    const node = factory(context(route));
    if (node) view.append(node);
  } catch (error) {
    console.error(error);
    view.append(h('div', { class: 'callout warn' }, `This page could not be displayed: ${error.message}`));
  }
  if (keepScroll) window.scrollTo(0, scrollY);
  else if (state.lastRoute !== route.raw) window.scrollTo(0, 0);
  state.lastRoute = route.raw;
}

async function boot() {
  try {
    const [model, health] = await Promise.all([api.get('/api/model'), api.get('/api/health')]);
    state.model = model;
    state.health = health;
    state.maps = {
      step: new Map(model.steps.map(step => [step.id, step])),
      case: new Map(model.cases.map(item => [item.id, item])),
      guide: new Map(model.guides.map(guide => [guide.id, guide]))
    };
    await refreshEngagements();
    buildShell();
    const stored = localStorage.getItem(STORAGE_KEY);
    const initial = state.engagements.find(item => item.id === stored) || state.engagements[0];
    if (initial) state.eng = await api.get(`/api/engagements/${encodeURIComponent(initial.id)}`);
    updateChrome();
    window.addEventListener('hashchange', () => render());
    render();
  } catch (error) {
    const app = document.getElementById('app');
    clear(app);
    app.append(h('div', { class: 'loading' }, h('h2', {}, 'The site could not start.'), h('p', {}, error.message), btn('Retry', () => window.location.reload(), 'primary')));
  }
}

boot();
