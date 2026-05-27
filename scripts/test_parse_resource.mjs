import { readFile } from 'fs/promises';
import { parseSarc } from './Sarc.js';

const file = process.argv[2] || 'Msg_EUfr.product.sarc';
const buf = await readFile(file);
const entries = await parseSarc(new Uint8Array(buf));
console.log(JSON.stringify(entries.slice(0, 5).map((entry) => ({
  name: entry.name,
  size: entry.data?.length ?? 0,
  preview: entry.text?.slice(0, 120) ?? '',
})), null, 2));
