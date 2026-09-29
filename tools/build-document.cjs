'use strict';

require('./assemble-runbook.cjs');
const fs = require('node:fs');
const path = require('node:path');
const {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel,
  PageNumber, Packer, Paragraph, Table, TableCell, TableRow, TextRun,
  WidthType, ExternalHyperlink, TableOfContents, ShadingType
} = require('docx');

const root = path.resolve(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const book = readJson('docs/runbook.json');
const catalogue = readJson('catalogue/scenarios.json');
const sources = readJson('docs/sources.json');
const support = readJson('catalogue/support-matrix.json');
const text = (value, options = {}) => new TextRun({ text: String(value), ...options });
const body = [];
const adoc = [`= ${book.title}`, ':toc: left', ':sectnums:', '', book.subtitle, '', `Revision: ${book.revision}`, ''];
const paragraph = (value, options = {}) => new Paragraph({
  children: [text(value)], spacing: { after: 110 }, ...options
});
const heading = (value, level) => {
  body.push(new Paragraph({ text: value, heading: level, keepNext: true, spacing: { before: 220, after: 120 } }));
  adoc.push(`${level === HeadingLevel.HEADING_1 ? '==' : '==='} ${value}`, '');
};
const addParagraphs = values => {
  for (const value of values || []) {
    body.push(paragraph(value));
    adoc.push(value, '');
  }
};
const addList = (values, ordered) => {
  for (let i = 0; i < (values || []).length; i++) {
    body.push(paragraph(`${ordered ? `${i + 1}.` : '-'} ${values[i]}`));
    adoc.push(`${ordered ? '.' : '*'} ${values[i]}`);
  }
  if (values && values.length) adoc.push('');
};
const addCode = value => {
  for (const line of value.split('\n')) {
    body.push(new Paragraph({
      children: [text(line, { font: 'Consolas', size: 17 })],
      spacing: { after: 0, line: 225 },
      shading: { type: ShadingType.CLEAR, fill: 'F2F4F7' }
    }));
  }
  body.push(paragraph(''));
  adoc.push('[source]', '----', value, '----', '');
};
const addTable = table => {
  const width = 9360;
  const columns = table.headers.length;
  const columnWidths = table.widths || Array(columns).fill(Math.floor(width / columns));
  const row = (cells, header) => new TableRow({
    tableHeader: header,
    cantSplit: true,
    children: cells.map((value, index) => new TableCell({
      width: { size: columnWidths[index], type: WidthType.DXA },
      shading: header ? { type: ShadingType.CLEAR, fill: 'E8EEF5' } : undefined,
      margins: { top: 80, bottom: 80, left: 90, right: 90 },
      children: [new Paragraph({ children: [text(value, { bold: header, size: 19 })], spacing: { after: 60 } })]
    }))
  });
  body.push(new Table({
    width: { size: width, type: WidthType.DXA },
    columnWidths,
    rows: [row(table.headers, true), ...table.rows.map(values => row(values, false))]
  }));
  body.push(paragraph(''));
  adoc.push('[options="header"]', '|===');
  for (const values of [table.headers, ...table.rows]) {
    adoc.push(values.map(value => `|${String(value).replace(/\|/g, '\\|').replace(/\n/g, ' +\n')}`).join(' '));
  }
  adoc.push('|===', '');
};

body.push(new Paragraph({ text: book.title, heading: HeadingLevel.TITLE, spacing: { before: 800, after: 280 } }));
body.push(paragraph(book.subtitle, { spacing: { after: 300 } }));
body.push(paragraph(`Revision: ${book.revision}`));
addParagraphs(book.front_matter);
body.push(new Paragraph({
  children: [text('Contents', { size: 32, color: '18344D' })],
  pageBreakBefore: true, keepNext: true, spacing: { after: 200 }
}));
body.push(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-1' }));

for (const chapter of book.chapters) {
  body.push(new Paragraph({ text: '', pageBreakBefore: true, spacing: { after: 0 } }));
  heading(chapter.title, HeadingLevel.HEADING_1);
  addParagraphs(chapter.paragraphs);
  for (const section of chapter.sections || []) {
    heading(section.title, HeadingLevel.HEADING_2);
    addParagraphs(section.paragraphs);
    if (section.table) addTable(section.table);
    addList(section.steps, true);
    addList(section.items, false);
    if (section.code) addCode(section.code);
    addParagraphs(section.notes);
  }
}

body.push(new Paragraph({ text: '', pageBreakBefore: true, spacing: { after: 0 } }));
heading('Control coverage by agent group', HeadingLevel.HEADING_1);
addParagraphs([support.evidenceStatus, support.availabilityDateMeaning]);
addTable({ headers: ['State', 'Meaning'], rows: Object.entries(support.states), widths: [2000, 7360] });
const layerNames = {
  governance: 'Microsoft 365',
  'entra-ca': 'Entra Conditional Access',
  observability: 'Observability',
  'defender-cloud-runtime': 'Defender runtime',
  purview: 'Purview',
  mde: 'Defender for Endpoint',
  'defender-for-cloud': 'Defender for Cloud',
  mdca: 'Defender for Cloud Apps',
  gsa: 'Global Secure Access',
  sentinel: 'Sentinel',
  'security-copilot': 'Security Copilot'
};
for (const family of support.families) {
  heading(family.name, HeadingLevel.HEADING_2);
  if (family.acceptanceRequirement) addParagraphs([family.acceptanceRequirement]);
  addTable({
    headers: ['Layer', 'State', 'Control boundary'],
    widths: [1800, 1600, 5960],
    rows: family.controls.map(control => [
      layerNames[control.layer] || control.layer,
      control.state,
      `${control.enforcementBoundary} [${control.sourceIds.join(', ')}]`
    ])
  });
}
body.push(new Paragraph({ text: '', pageBreakBefore: true, spacing: { after: 0 } }));
heading('Test procedures', HeadingLevel.HEADING_1);
addParagraphs([
  'Run each procedure on a separate test agent or test group.',
  'Run the positive and negative phases. Store evidence for both phases.',
  'Restore temporary policy settings after each case. Keep shared test objects until all dependent cases finish.',
  'Perform destructive cleanup only after the final approved use of the affected object.',
  'A blocked test remains blocked. Do not report a local simulation as a product result.'
]);
addTable({
  headers: ['Case', 'Procedure', 'Scope'],
  widths: [1200, 6760, 1400],
  rows: catalogue.scenarios.map(scenario => [
    scenario.id, scenario.title, scenario.required ? 'Required' : 'Optional'
  ])
});
for (const scenario of catalogue.scenarios) {
  heading(`${scenario.id}: ${scenario.title}`, HeadingLevel.HEADING_2);
  addParagraphs([
    `Agent group: ${scenario.family}. Security layer: ${scenario.layer}.`,
    `Priority: ${scenario.priority}. Required: ${scenario.required ? 'Yes' : 'No'}. Availability: ${scenario.availability}.`
  ]);
  for (const [label, key, ordered] of [
    ['Prerequisites', 'prerequisites', false], ['Prepare the test', 'setup', true],
    ['Positive phase', 'positive_steps', true], ['Negative phase', 'negative_steps', true],
    ['Expected result', 'expected', false], ['Evidence', 'evidence', false],
    ['Pass criteria', 'pass_criteria', false], ['Measured value', 'value', false],
    ['Restore the test state', 'cleanup', true]
  ]) {
    body.push(new Paragraph({ children: [text(label, { bold: true })], keepNext: true, spacing: { before: 100, after: 60 } }));
    adoc.push(`.${label}`);
    const value = scenario[key];
    addList(Array.isArray(value) ? value : value ? [value] : [], ordered);
  }
  addParagraphs([`Sources: ${(scenario.sources || []).join(', ')}.`]);
}
body.push(new Paragraph({ text: '', pageBreakBefore: true, spacing: { after: 0 } }));
heading('Source register', HeadingLevel.HEADING_1);
addParagraphs(['Open each source before execution. Service availability and portal labels can change.']);
for (const source of sources.sources) {
  heading(`${source.id}: ${source.title}`, HeadingLevel.HEADING_2);
  addParagraphs([source.note, `Retrieved: ${source.retrieved}.`]);
  body.push(new Paragraph({
    children: [new ExternalHyperlink({ children: [text(source.url, { style: 'Hyperlink', size: 18 })], link: source.url })],
    spacing: { after: 120 }
  }));
  adoc.push(source.url, '');
}

const document = new Document({
  creator: 'Oguzhan Filizlibay',
  title: book.title,
  subject: 'Agent 365 security proof of concept',
  description: 'Procedures, control boundaries, and evidence requirements.',
  features: { updateFields: true },
  styles: {
    default: {
      document: { run: { font: 'Aptos', size: 21 }, paragraph: { spacing: { line: 265 } } },
      heading1: { run: { font: 'Aptos Display', size: 32, color: '18344D' } },
      heading2: { run: { font: 'Aptos', size: 25, color: '18344D' } }
    }
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1000, bottom: 1000, left: 1440, right: 1440 }
      }
    },
    headers: { default: new Header({ children: [new Paragraph({
      children: [text('AGENT 365 SECURITY POC', { size: 16, color: '546579' })],
      border: { bottom: { color: 'CCD5DE', size: 4, style: BorderStyle.SINGLE } }
    })] }) },
    footers: { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [text('Page ', { size: 16 }), new TextRun({ children: [PageNumber.CURRENT], size: 16 })]
    })] }) },
    children: body
  }]
});

async function build() {
  const output = path.join(root, 'docs');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'Agent-365-Security-PoC.docx'), await Packer.toBuffer(document));
  fs.writeFileSync(path.join(output, 'POC.adoc'), adoc.join('\n').trimEnd() + '\n', 'utf8');
  console.log(`Built the runbook with ${catalogue.scenarios.length} test procedures.`);
}
build().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
