import * as C from '../core/compute.mjs';
import { buildReport, renderHtml, renderMarkdown } from '../core/report.mjs';
import { h, pageHead, card, field, selectEl, btn, linkBtn, toast, copyText, debounce } from '../ui.js';

export function reportsView(ctx) {
  const { model, route } = ctx;
  const eng = ctx.current();
  const report = eng.settings.report || {};
  let type = route.query.get('type') === 'final' ? 'final' : 'progress';
  const today = C.todayString();
  const start = eng.settings.start_date;
  const defaultFrom = (() => {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 6);
    const from = date.toISOString().slice(0, 10);
    return start && start > from && start <= today ? start : from;
  })();
  const from = h('input', { type: 'date', value: route.query.get('from') || defaultFrom });
  const to = h('input', { type: 'date', value: route.query.get('to') || today });
  const preview = h('div', { class: 'card-body' });
  const saveState = h('span', { class: 'save-state' });

  const query = () => {
    const params = new URLSearchParams({ type });
    if (type === 'progress') {
      if (from.value) params.set('from', from.value);
      if (to.value) params.set('to', to.value);
    }
    return params.toString();
  };
  const drawPreview = () => {
    const built = buildReport(model, ctx.current(), { type, from: from.value, to: to.value });
    preview.innerHTML = renderHtml(built);
    wordLink.href = `/api/engagements/${eng.id}/report.docx?${query()}`;
    mdLink.href = `/api/engagements/${eng.id}/report.md?${query()}`;
    printLink.href = `/api/engagements/${eng.id}/report.html?${query()}&autoprint=1`;
    history.replaceState(null, '', `#/reports?${query()}`);
  };
  const saveReport = async patch => {
    saveState.textContent = 'Saving...';
    saveState.className = 'save-state';
    try {
      await ctx.mutate('PUT', '/settings', { report: patch }, { rerender: false });
      saveState.textContent = 'Saved';
      saveState.className = 'save-state ok';
      drawPreview();
    } catch {
      saveState.textContent = 'Not saved';
      saveState.className = 'save-state err';
    }
  };
  const text = (label, key, hint, rows = 4) => {
    const area = h('textarea', { rows });
    area.value = report[key] || '';
    area.addEventListener('change', () => saveReport({ [key]: area.value }));
    return field(label, area, hint);
  };

  const wordLink = linkBtn('Download Word (.docx)', '#', 'primary');
  const mdLink = linkBtn('Markdown (.md)', '#');
  const printLink = linkBtn('Print or save as PDF', '#', '', { target: '_blank', rel: 'noopener' });
  const copyMd = btn('Copy as Markdown', () => copyText(renderMarkdown(buildReport(model, ctx.current(), { type, from: from.value, to: to.value }))));
  from.addEventListener('change', drawPreview);
  to.addEventListener('change', drawPreview);

  const progressFields = h('div', { class: 'stack' },
    h('div', { class: 'form-grid' }, field('From', from), field('To', to)),
    text('Key messages', 'key_messages', 'One message per line. Shown under the summary.'));
  const finalFields = h('div', { class: 'stack' },
    text('Executive summary', 'executive_summary', 'Leave empty to use the generated summary.', 6),
    text('Recommendations', 'recommendations', 'One paragraph per line.', 5));
  const typeButtons = h('div', { class: 'row' });
  const drawType = () => {
    typeButtons.replaceChildren(
      btn('Progress report', () => { type = 'progress'; drawType(); drawPreview(); }, type === 'progress' ? 'primary' : ''),
      btn('Final report', () => { type = 'final'; drawType(); drawPreview(); }, type === 'final' ? 'primary' : ''));
    progressFields.classList.toggle('hidden', type !== 'progress');
    finalFields.classList.toggle('hidden', type !== 'final');
  };
  drawType();

  const importInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const result = await ctx.api.send('POST', '/api/engagements/import', data);
      await ctx.reloadEngagements(result.id);
      toast(`Imported as ${result.id}.${result.skipped ? ` ${result.skipped} unknown item(s) skipped.` : ''}`, 'ok');
      ctx.navigate('#/dashboard');
    } catch (error) {
      toast(`Import failed: ${error.message}`, 'err');
    }
    importInput.value = '';
  });

  const controls = h('div', { class: 'stack sticky' },
    card({
      title: 'Report',
      actions: [saveState],
      body: h('div', { class: 'stack' },
        typeButtons,
        field('Overall status', selectEl(Object.entries(C.RAG), report.status || 'on_track', value => saveReport({ status: value }))),
        text('Status comment', 'status_comment', 'Why the status is what it is.', 2),
        progressFields,
        finalFields,
        text('Next steps', 'next_steps', 'One item per line.', 3),
        h('div', { class: 'callout small' }, 'Reports include use case customer summaries, notes marked as shared, and blocked-step reasons. Internal notes are never included.'),
        h('div', { class: 'row' }, wordLink, mdLink),
        h('div', { class: 'row' }, printLink, copyMd))
    }),
    card({
      title: 'Data and exports',
      body: h('div', { class: 'stack' },
        h('div', { class: 'row' },
          linkBtn('Export engagement (JSON)', `/api/engagements/${eng.id}/export`),
          btn('Import engagement', () => importInput.click()), importInput),
        h('div', { class: 'row' },
          linkBtn('poc-plan.json', `/api/engagements/${eng.id}/poc-plan.json`),
          linkBtn('Evidence recorder commands', `/api/engagements/${eng.id}/evidence-commands.ps1`)),
        h('div', { class: 'row' }, linkBtn('Reference pack (ZIP)', '/api/reference-pack.zip')),
        h('p', { class: 'muted small' }, 'poc-plan.json fills config/poc-plan.example.json from Settings and Tenant build. The evidence commands replay recorded phases into the kit recorder (python -m poc_evidence). Review them before running.'))
    }));

  const root = h('div', {},
    pageHead({
      title: 'Reports',
      sub: 'Generate a progress report during the PoC and the final report at the end. The preview updates as you edit. Downloads go to your browser download folder.'
    }),
    h('div', { class: 'split', style: { gridTemplateColumns: 'minmax(0, 1fr) 400px' } },
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Preview')), preview),
      controls));
  drawPreview();
  return root;
}
