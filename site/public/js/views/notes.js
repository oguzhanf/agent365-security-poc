import * as C from '../core/compute.mjs';
import { h, pageHead, card, btn, selectEl, field, badge, modal, confirmDialog, toast, debounce, fmtDate, relTime } from '../ui.js';

function noteEditor(ctx, note, presetCategory) {
  const value = note || { date: C.todayString(), category: presetCategory || 'meeting', title: '', body: '', shareable: true, related: '', owner: '', due: '', resolved: false };
  const date = h('input', { type: 'date', value: value.date || '' });
  const category = selectEl(C.NOTE_CATEGORIES.map(key => [key, C.NOTE_LABELS[key]]), value.category);
  const title = h('input', { type: 'text', value: value.title, placeholder: 'Short title' });
  const body = h('textarea', { rows: 7, placeholder: 'Details. For meetings: attendees, decisions, and follow-ups.' });
  body.value = value.body || '';
  const shareable = h('input', { type: 'checkbox', checked: value.shareable });
  const related = h('input', { type: 'text', value: value.related || '', placeholder: 'ONB-01, G08, INV-U-ALLOW' });
  const owner = h('input', { type: 'text', value: value.owner || '', placeholder: 'Owner' });
  const due = h('input', { type: 'date', value: value.due || '' });
  const resolved = h('input', { type: 'checkbox', checked: value.resolved });
  modal({
    title: note ? 'Edit note' : 'Add note',
    wide: true,
    body: h('div', { class: 'form-grid' },
      field('Date', date), field('Type', category),
      h('div', { class: 'full' }, field('Title', title)),
      h('div', { class: 'full' }, field('Details', body)),
      field('Related items', related, 'Use case, guide, or tenant object IDs.'), field('Owner', owner),
      field('Due date', due, 'For actions, risks, and issues.'),
      h('div', { class: 'stack', style: { justifyContent: 'flex-end' } },
        h('label', { class: 'check' }, shareable, 'Share with the customer (included in reports)'),
        h('label', { class: 'check' }, resolved, 'Resolved or closed'))),
    actions: [
      { label: 'Cancel', run: close => close() },
      { label: note ? 'Save' : 'Add note', cls: 'primary', run: async close => {
        const payload = { date: date.value, category: category.value, title: title.value, body: body.value, shareable: shareable.checked, related: related.value, owner: owner.value, due: due.value, resolved: resolved.checked };
        try {
          if (note) await ctx.mutate('PUT', `/notes/${note.id}`, payload);
          else await ctx.mutate('POST', '/notes', payload);
          close();
          toast(note ? 'Note saved.' : 'Note added.', 'ok');
        } catch { /* toast shown */ }
      } }
    ]
  });
}

export function notesView(ctx) {
  const { route } = ctx;
  const eng = ctx.current();
  const notes = [...(eng.notes || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.created_at).localeCompare(String(a.created_at)));
  const stats = C.noteStats(eng);
  const filters = { category: route.query.get('category') || '', visibility: '', state: '', text: '' };
  const list = h('div', { class: 'stack' });

  const noteCard = note => {
    const raid = ['risk', 'issue', 'action'].includes(note.category);
    const el = h('div', { class: `card note-card cat-${note.category}${note.resolved ? ' resolved' : ''}` },
      h('div', { class: 'row' },
        badge(C.NOTE_LABELS[note.category], 'role'),
        h('h3', {}, note.title),
        note.shareable ? badge('Shared in reports', 'st-PASS') : badge('Internal', 'st-NOT_RUN'),
        raid ? badge(note.resolved ? 'Closed' : 'Open', note.resolved ? 'st-NOT_APPLICABLE' : note.category === 'action' ? 'st-IN_PROGRESS' : 'st-BLOCKED') : null,
        h('div', { class: 'spacer' }),
        h('span', { class: 'muted small' }, fmtDate(note.date)),
        raid ? btn(note.resolved ? 'Reopen' : 'Close', () => ctx.mutate('PUT', `/notes/${note.id}`, { resolved: !note.resolved }).catch(() => {}), 'small') : null,
        btn('Edit', () => noteEditor(ctx, note), 'small'),
        btn('Delete', async () => {
          if (await confirmDialog('Delete note', `Delete "${note.title}"?`, 'Delete', 'danger')) ctx.mutate('DELETE', `/notes/${note.id}`).catch(() => {});
        }, 'small danger')),
      note.body ? h('div', { class: 'note-body' }, note.body) : null,
      h('div', { class: 'row small muted', style: { marginTop: '6px' } },
        note.owner ? h('span', {}, `Owner: ${note.owner}`) : null,
        note.due ? h('span', {}, `Due: ${fmtDate(note.due)}`) : null,
        note.related ? h('span', {}, `Related: ${note.related}`) : null,
        h('span', { class: 'faint' }, `Updated ${relTime(note.updated_at)}`)));
    el.dataset.search = `${note.title} ${note.body} ${note.related} ${note.owner}`.toLowerCase();
    return { note, el };
  };
  const cards = notes.map(noteCard);
  list.append(...cards.map(entry => entry.el));
  const empty = h('div', { class: 'empty' }, h('h2', {}, 'No notes yet.'), h('p', {}, 'Record meetings, decisions, risks, issues, and actions. Mark notes as shared to include them in customer reports.'));
  const apply = () => {
    let shown = 0;
    for (const { note, el } of cards) {
      const show = (!filters.category || note.category === filters.category) &&
        (!filters.visibility || (filters.visibility === 'shared' ? note.shareable : !note.shareable)) &&
        (!filters.state || (filters.state === 'open' ? !note.resolved : note.resolved)) &&
        (!filters.text || el.dataset.search.includes(filters.text.toLowerCase()));
      el.classList.toggle('hidden', !show);
      if (show) shown += 1;
    }
    empty.classList.toggle('hidden', shown > 0);
  };
  const search = h('input', { type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes' });
  search.addEventListener('input', debounce(() => { filters.text = search.value.trim(); apply(); }, 150));

  const root = h('div', {},
    pageHead({
      title: 'Notes and RAID log',
      sub: 'Meetings, decisions, risks, issues, and actions for this engagement. Notes marked as shared appear in progress and final reports; internal notes never leave this site.',
      actions: [
        btn('Add meeting note', () => noteEditor(ctx, null, 'meeting')),
        btn('Add action', () => noteEditor(ctx, null, 'action')),
        btn('Add note', () => noteEditor(ctx, null, filters.category || 'general'), 'primary')
      ]
    }),
    h('div', { class: 'grid grid-4', style: { marginBottom: '14px' } },
      card({ title: 'Open actions', body: h('div', { class: 'kpi-value' }, String(stats.open_actions)) }),
      card({ title: 'Open risks', body: h('div', { class: 'kpi-value' }, String(stats.open_risks)) }),
      card({ title: 'Open issues', body: h('div', { class: 'kpi-value' }, String(stats.open_issues)) }),
      card({ title: 'Shared with the customer', body: h('div', { class: 'kpi-value' }, `${stats.shareable} / ${stats.total}`) })),
    h('div', { class: 'filters' },
      selectEl([['', 'All types'], ...C.NOTE_CATEGORIES.map(key => [key, C.NOTE_LABELS[key]])], filters.category, value => { filters.category = value; apply(); }, { 'aria-label': 'Type' }),
      selectEl([['', 'Shared and internal'], ['shared', 'Shared only'], ['internal', 'Internal only']], '', value => { filters.visibility = value; apply(); }, { 'aria-label': 'Visibility' }),
      selectEl([['', 'Open and closed'], ['open', 'Open only'], ['resolved', 'Closed only']], '', value => { filters.state = value; apply(); }, { 'aria-label': 'State' }),
      search),
    list,
    empty);
  apply();
  return root;
}
