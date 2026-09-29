'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, 'docs', file), 'utf8'));
const core = read('core-chapters.json');
const controls = read('control-chapters.json').chapters;
const infrastructure = read('infra-chapters.json').chapters;
const book = {
  title: 'Agent 365 Security PoC',
  subtitle: 'Deployment procedures, control tests, and evidence requirements',
  revision: '1.0 - 18 September 2026',
  front_matter: [
    'Use a dedicated test environment and synthetic data.',
    'Approve costs, licences, policy scope, and data locations before execution.',
    'Product availability and preview access depend on the selected tenant.',
    'No live product result is included in this package.'
  ],
  chapters: [
    ...controls.slice(0, 1),
    ...core.front_chapters,
    ...infrastructure.slice(0, -1),
    ...read('platform-chapters.json').chapters,
    ...read('foundry-code-chapters.json').chapters,
    ...read('sdk-chapters.json').chapters,
    ...read('provider-chapters.json').chapters,
    ...controls.slice(1),
    ...core.back_chapters,
    ...infrastructure.slice(-1)
  ]
};
const sources = [];
const seen = new Set();
for (const filename of [
  'control-sources.json', 'platform-sources.json', 'sdk-sources.json',
  'provider-sources.json', 'infra-sources.json', 'query-sources.json', 'foundry-code-sources.json'
]) {
  for (const source of read(filename).sources) {
    if (seen.has(source.id)) throw new Error(`Duplicate source identifier: ${source.id}`);
    seen.add(source.id);
    sources.push(source);
  }
}
fs.writeFileSync(path.join(root, 'docs', 'runbook.json'), JSON.stringify(book, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(root, 'docs', 'sources.json'), JSON.stringify({ sources }, null, 2) + '\n', 'utf8');
