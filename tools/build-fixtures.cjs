'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Document, Packer, Paragraph, TextRun } = require('docx');

async function build() {
  const folder = path.resolve(__dirname, '..', 'fixtures');
  for (const name of ['public-procedure', 'restricted-record']) {
    const lines = fs.readFileSync(path.join(folder, `${name}.txt`), 'utf8').trimEnd().split(/\r?\n/);
    const document = new Document({
      creator: 'Oguzhan Filizlibay',
      title: `Synthetic PoC fixture: ${name}`,
      sections: [{
        children: lines.map(line => new Paragraph({
          children: [new TextRun({ text: line, font: 'Aptos', size: 22 })],
          spacing: { after: 120 }
        }))
      }]
    });
    fs.writeFileSync(path.join(folder, `${name}.docx`), await Packer.toBuffer(document));
  }
  console.log('Built 2 synthetic Office fixtures. No sensitivity label is applied.');
}

build().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
