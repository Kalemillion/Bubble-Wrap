import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { parseSarc } from './Sarc.js';

async function main() {
  const file = process.argv[2] || 'Msg_EUfr.product.sarc';
  const buf = await readFile(file);
  try {
    const entries = await parseSarc(new Uint8Array(buf));
    console.log('entries:', entries.map(e => ({ name: e.name, size: e.data?.length || 0 })));
  } catch (err) {
    console.error('parse error:', err && err.message ? err.message : err);
    process.exit(2);
  }
}

main();
