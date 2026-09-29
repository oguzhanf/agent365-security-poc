// DOM helpers and small shared components. Text is always set through
// textContent or text nodes; no user content is parsed as HTML.

import * as C from './core/compute.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyAttrs(el, attrs) {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value);
    else if (key === 'text') el.textContent = value;
    else if (key === 'on') for (const [event, handler] of Object.entries(value)) el.addEventListener(event, handler);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'value' && 'value' in el) el.value = value;
    else if (key === 'checked') el.checked = Boolean(value);
    else if (key === 'selected') el.selected = Boolean(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs && (attrs instanceof Node || typeof attrs !== 'object' || Array.isArray(attrs))) {
    append(el, [attrs, ...children]);
  } else {
    applyAttrs(el, attrs);
    append(el, children);
  }
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const esc = value => String(value ?? '');

export function debounce(fn, ms = 400) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(value) {
  if (!value) return '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function relTime(iso) {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return '';
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return fmtDateTime(iso);
}

export function badge(text, cls = '') {
  return h('span', { class: `badge ${cls}` }, text);
}

export function resultBadge(status, large = false) {
  return h('span', { class: `badge st-${status}${large ? ' lg' : ''}` }, C.RESULT_LABELS[status] || status);
}

export function scopeBadge(scope) {
  return h('span', { class: `badge sc-${scope}` }, C.SCOPE_LABELS[scope] || scope);
}

export function demoBadge(status) {
  return h('span', { class: `badge dm-${status}` }, C.DEMO_LABELS[status] || status);
}

export function stepStatusBadge(status) {
  const map = { todo: 'NOT_RUN', in_progress: 'IN_PROGRESS', done: 'PASS', blocked: 'BLOCKED', skipped: 'NOT_APPLICABLE' };
  return h('span', { class: `badge st-${map[status]}` }, C.STEP_LABELS[status]);
}

export function bar(pct, cls = '') {
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  return h('div', { class: `bar ${cls}`, role: 'progressbar', 'aria-valuenow': value, 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('span', { style: { width: `${value}%` } }));
}

export function stackedBar(counts, total, cls = '') {
  const el = h('div', { class: `bar ${cls}` });
  if (!total) return el;
  const parts = [
    ['pass', counts.PASS || 0], ['fail', counts.FAIL || 0], ['blocked', counts.BLOCKED || 0],
    ['na', counts.NOT_APPLICABLE || 0], ['progress', counts.IN_PROGRESS || 0]
  ];
  for (const [name, count] of parts) if (count) el.append(h('span', { class: name, style: { width: `${(count / total) * 100}%` }, title: `${name}: ${count}` }));
  return el;
}

export function donut(pct, size = 54, color = '#0f6cbd') {
  const radius = size / 2 - 5;
  const circumference = 2 * Math.PI * radius;
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  return s('svg', { class: 'donut', width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': `${value}%` },
    s('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: '#e7ebf0', 'stroke-width': 7 }),
    s('circle', {
      cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: color, 'stroke-width': 7, 'stroke-linecap': 'round',
      'stroke-dasharray': `${(value / 100) * circumference} ${circumference}`, transform: `rotate(-90 ${size / 2} ${size / 2})`
    }),
    s('text', { x: '50%', y: '50%', 'dominant-baseline': 'central', 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#18344d' }, `${Math.round(value)}%`));
}

export function pageHead({ title, sub, crumbs, actions }) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'grow' },
      crumbs ? h('div', { class: 'crumbs' }, crumbs) : null,
      h('h1', {}, title),
      sub ? h('div', { class: 'sub' }, sub) : null),
    actions && actions.length ? h('div', { class: 'actions' }, actions) : null);
}

export function card({ title, actions, body, flush, cls = '' }) {
  return h('section', { class: `card ${cls}` },
    title ? h('div', { class: 'card-head' }, typeof title === 'string' ? h('h2', {}, title) : title, actions ? h('div', { class: 'actions' }, actions) : null) : null,
    h('div', { class: `card-body${flush ? ' flush' : ''}` }, body));
}

export function kpi({ label, value, detail, tone, visual }) {
  return h('div', { class: `card kpi${tone ? ` tone-${tone}` : ''}` },
    visual || null,
    h('div', {},
      h('div', { class: 'kpi-label' }, label),
      h('div', { class: 'kpi-value' }, value),
      detail ? h('div', { class: 'kpi-detail' }, detail) : null));
}

export function btn(label, onClick, cls = '', attrs = {}) {
  return h('button', { type: 'button', class: `btn ${cls}`, on: onClick ? { click: onClick } : undefined, ...attrs }, label);
}

export function linkBtn(label, href, cls = '', attrs = {}) {
  return h('a', { class: `btn ${cls}`, href, ...attrs }, label);
}

export function selectEl(options, value, onChange, attrs = {}) {
  const el = h('select', attrs, options.map(([optionValue, label]) => h('option', { value: optionValue, selected: optionValue === value }, label)));
  if (onChange) el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h2', {}, title), text ? h('p', {}, text) : null, action || null);
}

export function toast(message, kind = '') {
  const holder = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}` }, message);
  holder.append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 2600);
}

export function modal({ title, body, actions = [], wide = false }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = event => { if (event.key === 'Escape') close(); };
  const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: wide ? { width: 'min(980px, 100%)' } : undefined },
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('div', { class: 'spacer' }), btn('Close', close, 'ghost small')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions.map(action => btn(action.label, () => action.run(close), action.cls || ''))) : null);
  backdrop.append(dialog);
  backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  const focusable = dialog.querySelector('input, textarea, select');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { close, dialog };
}

export function confirmDialog(title, text, confirmLabel = 'Confirm', cls = 'primary') {
  return new Promise(resolve => {
    const m = modal({
      title,
      body: h('p', {}, text),
      actions: [
        { label: 'Cancel', run: close => { close(); resolve(false); } },
        { label: confirmLabel, cls, run: close => { close(); resolve(true); } }
      ]
    });
    m.dialog.querySelector('.modal-head .btn').addEventListener('click', () => resolve(false));
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to the clipboard.', 'ok');
  } catch {
    const area = h('textarea', { style: { position: 'fixed', left: '-9999px' } });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast('Copied to the clipboard.', 'ok');
  }
}

export function copyButton(text, label = 'Copy') {
  return btn(label, event => { event.stopPropagation(); copyText(typeof text === 'function' ? text() : text); }, 'small');
}

export function codeBox(code) {
  return h('div', { class: 'codebox' }, copyButton(code), h('pre', {}, code));
}

const SOURCE_REF = /\[([A-Z][A-Z0-9]*\d(?:,\s*[A-Z][A-Z0-9]*\d)*)\]/g;

// Renders text and turns [CM1, CE2] citations into source links.
export function richText(text, model) {
  const fragment = document.createDocumentFragment();
  const value = String(text ?? '');
  let last = 0;
  for (const match of value.matchAll(SOURCE_REF)) {
    const ids = match[1].split(/,\s*/);
    if (!ids.every(id => model.sources[id])) continue;
    fragment.append(value.slice(last, match.index));
    ids.forEach((id, index) => {
      const source = model.sources[id];
      if (index) fragment.append(' ');
      fragment.append(h('a', { class: 'src-ref', href: source.url, target: '_blank', rel: 'noopener noreferrer', title: `${source.title} (retrieved ${source.retrieved})` }, id));
    });
    last = match.index + match[0].length;
  }
  fragment.append(value.slice(last));
  return fragment;
}

export function docTable(table, model) {
  return h('div', { class: 'table-wrap' }, h('table', { class: 'doc-table' },
    h('thead', {}, h('tr', {}, table.headers.map(header => h('th', {}, header)))),
    h('tbody', {}, table.rows.map(row => h('tr', {}, row.map(value => h('td', {}, richText(value, model))))))));
}

export function areaLink(model, engagement, areaId, { label } = {}) {
  const area = model.areas[areaId];
  if (!area) return null;
  const url = C.tenantUrl(area, engagement);
  if (!url) return h('span', { class: 'area-link', title: area.name }, label || area.short);
  return h('a', { class: 'area-link', href: url, target: '_blank', rel: 'noopener noreferrer', title: `Open ${area.name}` }, label || area.short, h('span', { class: 'ext' }, '\u2197'));
}

export function caseChip(model, engagement, caseId) {
  const item = model.cases.find(entry => entry.id === caseId);
  if (!item) return null;
  const record = engagement?.cases?.[caseId];
  const status = item.scope === 'demo' && C.demoStatus(record) === 'DEMONSTRATED' ? 'PASS' : C.caseDisplayStatus(item, record);
  return h('a', { class: 'chip', href: `#/cases/${caseId}`, title: `${item.title} (${C.RESULT_LABELS[status]})` }, h('span', { class: `dot st-${status}` }), caseId);
}

export function guideChip(model, guideId) {
  const guide = model.guides.find(entry => entry.id === guideId);
  if (!guide) return null;
  return h('a', { class: 'chip', href: `#/guides/${guideId}`, title: guide.title }, `Guide ${String(guide.number).padStart(2, '0')}`);
}

export function burnup(history, { width = 560, height = 170 } = {}) {
  const days = Object.keys(history || {}).sort();
  const svg = s('svg', { width: '100%', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Progress over time' });
  if (days.length < 1) return svg;
  const pad = { l: 34, r: 12, t: 12, b: 24 };
  const points = days.map(day => history[day]);
  const maxSteps = Math.max(1, ...points.map(point => point.steps_applicable || point.steps_done || 0));
  const x = index => pad.l + (days.length === 1 ? (width - pad.l - pad.r) / 2 : (index / (days.length - 1)) * (width - pad.l - pad.r));
  const y = value => height - pad.b - (value / maxSteps) * (height - pad.t - pad.b);
  for (const fraction of [0, 0.5, 1]) {
    const yy = y(maxSteps * fraction);
    svg.append(s('line', { x1: pad.l, x2: width - pad.r, y1: yy, y2: yy, stroke: '#e7ebf0' }));
    svg.append(s('text', { x: pad.l - 6, y: yy + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#8a98a6' }, String(Math.round(maxSteps * fraction))));
  }
  const line = (key, color) => {
    const d = points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point[key] || 0).toFixed(1)}`).join(' ');
    svg.append(s('path', { d, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
    points.forEach((point, index) => svg.append(s('circle', { cx: x(index), cy: y(point[key] || 0), r: 3, fill: color })));
  };
  line('steps_done', '#0f6cbd');
  const scale = maxSteps / Math.max(1, ...points.map(point => point.cases_final || 0), 36);
  const scaled = points.map(point => ({ ...point, cases_scaled: (point.cases_passed || 0) * scale }));
  const d = scaled.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.cases_scaled).toFixed(1)}`).join(' ');
  svg.append(s('path', { d, fill: 'none', stroke: '#107c10', 'stroke-width': 2, 'stroke-dasharray': '5 4' }));
  const labelEvery = Math.max(1, Math.ceil(days.length / 8));
  days.forEach((day, index) => {
    if (index % labelEvery === 0 || index === days.length - 1) {
      svg.append(s('text', { x: x(index), y: height - 6, 'text-anchor': 'middle', 'font-size': 10, fill: '#8a98a6' }, day.slice(5)));
    }
  });
  return svg;
}
