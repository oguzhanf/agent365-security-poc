'use strict';

// Writes the reference pack cited by the scope document:
// INDEX.md, TABLES.md, guides/NN_GUIDE_*.md, and test-procedures/<ID>_*.md.
// Usage: node tools/build-reference-pack.cjs [output-folder] [--force]

const fs = require('node:fs');
const path = require('node:path');
const { buildModel } = require('../site/lib/model.cjs');
const { referencePackFiles } = require('../site/lib/exports.cjs');

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const target = args.find(arg => !arg.startsWith('--'));
  const output = path.resolve(target || path.join(__dirname, '..', 'reference-pack'));
  if (fs.existsSync(output) && fs.readdirSync(output).length && !force) {
    console.error(`The output folder is not empty: ${output}. Use --force to replace the pack files.`);
    process.exitCode = 1;
    return;
  }
  const files = referencePackFiles(buildModel());
  for (const file of files) {
    const destination = path.join(output, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content, 'utf8');
  }
  const guides = files.filter(file => file.path.startsWith('guides/')).length;
  const procedures = files.filter(file => file.path.startsWith('test-procedures/')).length;
  console.log(`Wrote the reference pack to ${output}: ${guides} guides, ${procedures} test procedures, INDEX.md, and TABLES.md.`);
}

main();
