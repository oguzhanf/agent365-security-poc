import { h, pageHead, card, linkBtn, copyButton, codeBox, badge } from '../ui.js';

export function contentView(ctx) {
  const { model } = ctx;
  return h('div', {},
    pageHead({
      title: 'Synthetic content',
      sub: 'The only data this PoC uses. Upload these files to the approved test locations, then apply the test sensitivity label through the supported product procedure. The DOCX copies are generated on download without any sensitivity label.',
      actions: [linkBtn('Test prompts (JSON)', '/api/fixtures/test-prompts.json')]
    }),
    h('div', { class: 'grid grid-3', style: { marginBottom: '16px' } }, model.fixtures.map(fixture => card({
      title: fixture.title,
      actions: fixture.formats.map(format => linkBtn(format.toUpperCase(), `/api/fixtures/${fixture.id}.${format}`, 'small')),
      body: h('div', { class: 'stack' },
        h('div', { class: 'row' }, badge(fixture.marker, 'role'), copyButton(fixture.marker, 'Copy marker')),
        h('p', { class: 'muted small' }, fixture.use),
        h('pre', { class: 'mono', style: { background: 'var(--surface-2)', border: '1px solid var(--border)', padding: '10px', borderRadius: '8px', whiteSpace: 'pre-wrap', margin: 0 } }, fixture.text))
    }))),
    card({
      title: 'Test prompts',
      body: h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Prompt'), h('th', {}, 'Expected'), h('th', {}, ''))),
        h('tbody', {}, model.test_prompts.map(prompt => h('tr', {},
          h('td', { class: 'id' }, prompt.id),
          h('td', {}, prompt.input),
          h('td', { class: 'muted' }, prompt.expected),
          h('td', {}, copyButton(prompt.input))))))),
      cls: 'mb'
    }),
    card({
      title: 'Hunting queries',
      body: h('div', { class: 'stack' },
        model.query_guide ? h('p', { class: 'muted pre small' }, model.query_guide.trim()) : null,
        model.queries.map(query => h('div', {},
          h('div', { class: 'row' }, h('strong', {}, query.file), badge(query.platform, 'role'), h('div', { class: 'spacer' }), linkBtn('Download', `/api/queries/${query.id}.kql`, 'small')),
          codeBox(query.text.trim()))))
    }));
}
