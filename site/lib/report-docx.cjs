'use strict';

// Renders a report block model (site/public/js/core/report.mjs) to DOCX.
// Styling follows tools/build-document.cjs so reports match the scope document.

const {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, Packer, PageNumber,
  Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType
} = require('docx');

const TEXT_WIDTH = 9360;
const NAVY = '18344D';
const MUTED = '546579';
const SHADES = {
  PASS: 'DFF6DD', FAIL: 'FDE7E9', BLOCKED: 'FFF4CE', NOT_RUN: 'F3F2F1', NOT_APPLICABLE: 'EDEBE9', IN_PROGRESS: 'DEECF9'
};

const cellText = value => (value && typeof value === 'object' ? String(value.text ?? '') : String(value ?? ''));
const cellStatus = value => (value && typeof value === 'object' ? value.status : '');

function runs(text, options = {}) {
  const parts = String(text ?? '').split(/\r?\n/);
  return parts.map((part, index) => new TextRun({ text: part, break: index > 0 ? 1 : 0, ...options }));
}

function paragraph(text, options = {}) {
  return new Paragraph({ children: runs(text, options.run), spacing: { after: 110 }, ...options.paragraph });
}

function widthsFor(block) {
  const count = block.headers.length;
  if (Array.isArray(block.widths) && block.widths.length === count) return block.widths;
  return Array(count).fill(Math.floor(TEXT_WIDTH / count));
}

function table(block) {
  const widths = widthsFor(block);
  const makeRow = (cells, header) => new TableRow({
    tableHeader: header,
    cantSplit: true,
    children: cells.map((value, index) => {
      const status = header ? '' : cellStatus(value);
      return new TableCell({
        width: { size: widths[index], type: WidthType.DXA },
        shading: header ? { type: ShadingType.CLEAR, fill: 'E8EEF5' } : status && SHADES[status] ? { type: ShadingType.CLEAR, fill: SHADES[status] } : undefined,
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        children: [new Paragraph({ children: runs(cellText(value), { bold: header, size: 17 }), spacing: { after: 0 } })]
      });
    })
  });
  return new Table({
    width: { size: TEXT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: [makeRow(block.headers, true), ...block.rows.map(row => makeRow(row, false))]
  });
}

function kpiTable(items) {
  const width = Math.floor(TEXT_WIDTH / items.length);
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'CCD5DE' };
  return new Table({
    width: { size: width * items.length, type: WidthType.DXA },
    columnWidths: items.map(() => width),
    rows: [new TableRow({
      cantSplit: true,
      children: items.map(item => new TableCell({
        width: { size: width, type: WidthType.DXA },
        margins: { top: 120, bottom: 120, left: 120, right: 120 },
        borders: { top: border, bottom: border, left: border, right: border },
        shading: { type: ShadingType.CLEAR, fill: 'F5F8FB' },
        children: [
          new Paragraph({ children: [new TextRun({ text: item.value, bold: true, size: 32, color: NAVY })], spacing: { after: 40 } }),
          new Paragraph({ children: [new TextRun({ text: item.label, bold: true, size: 17 })], spacing: { after: 20 } }),
          new Paragraph({ children: [new TextRun({ text: item.detail, size: 16, color: MUTED })], spacing: { after: 0 } })
        ]
      }))
    })]
  });
}

function renderBlocks(blocks) {
  const body = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'title':
        body.push(new Paragraph({ children: [new TextRun({ text: 'Microsoft Security | Agent 365', size: 18, color: MUTED })], spacing: { before: 200, after: 120 } }));
        body.push(new Paragraph({ text: block.text, heading: HeadingLevel.TITLE, spacing: { after: 160 } }));
        body.push(paragraph(block.subtitle, { run: { size: 26, color: NAVY }, paragraph: { spacing: { after: 240 } } }));
        if (block.meta.length) {
          body.push(table({
            headers: ['Item', 'Value'],
            widths: [2400, TEXT_WIDTH - 2400],
            rows: block.meta.map(([label, value]) => [label, value])
          }));
          body.push(paragraph(''));
        }
        break;
      case 'h1':
        body.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_1, keepNext: true, spacing: { before: 280, after: 120 } }));
        break;
      case 'h2':
        body.push(new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_2, keepNext: true, spacing: { before: 200, after: 100 } }));
        break;
      case 'p':
        body.push(paragraph(block.text));
        break;
      case 'bullets':
        for (const item of block.items) body.push(new Paragraph({ children: runs(item), bullet: { level: 0 }, spacing: { after: 60 } }));
        body.push(paragraph('', { paragraph: { spacing: { after: 60 } } }));
        break;
      case 'kpis':
        body.push(kpiTable(block.items));
        body.push(paragraph(''));
        break;
      case 'table':
        body.push(table(block));
        body.push(paragraph(''));
        break;
      case 'callout':
        body.push(new Paragraph({
          children: runs(block.text, { size: 19 }),
          shading: { type: ShadingType.CLEAR, fill: block.tone === 'warn' ? 'FFF4CE' : 'DEECF9' },
          border: { left: { style: BorderStyle.SINGLE, size: 18, color: block.tone === 'warn' ? 'C19C00' : '0F6CBD', space: 6 } },
          spacing: { before: 60, after: 160 }
        }));
        break;
      default:
        break;
    }
  }
  return body;
}

async function renderDocx(report, { author } = {}) {
  const document = new Document({
    creator: author || 'Agent 365 Security PoC site',
    title: report.title,
    subject: 'Agent 365 Security PoC report',
    description: `Generated ${report.generated}.`,
    styles: {
      default: {
        document: { run: { font: 'Aptos', size: 20 }, paragraph: { spacing: { line: 264 } } },
        title: { run: { font: 'Aptos Display', size: 44, color: NAVY } },
        heading1: { run: { font: 'Aptos Display', size: 30, color: NAVY } },
        heading2: { run: { font: 'Aptos', size: 24, color: NAVY } }
      }
    },
    sections: [{
      properties: {
        page: { size: { width: 12240, height: 15840 }, margin: { top: 1000, bottom: 1000, left: 1440, right: 1440 } }
      },
      headers: {
        default: new Header({ children: [new Paragraph({
          children: [new TextRun({ text: 'AGENT 365 SECURITY POC', size: 16, color: MUTED })],
          border: { bottom: { color: 'CCD5DE', size: 4, style: BorderStyle.SINGLE } }
        })] })
      },
      footers: {
        default: new Footer({ children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({ text: 'Page ', size: 16, color: MUTED }),
            new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED }),
            new TextRun({ text: ' of ', size: 16, color: MUTED }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: MUTED })
          ]
        })] })
      },
      children: renderBlocks(report.blocks)
    }]
  });
  return Packer.toBuffer(document);
}

module.exports = { renderDocx };
