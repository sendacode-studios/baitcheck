/**
 * One-shot maintenance script: guarantee the ANSI table in src/report.js uses
 * explicit  escapes rather than raw ESC bytes. Raw control characters in
 * source survive some editors and not others; the escape form always round
 * trips. Safe to re-run.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../src/report.js', import.meta.url);
const src = readFileSync(path, 'utf8');

const ESC = String.fromCharCode(27);
const before = src.match(/const COLOR = \{[\s\S]*?\};/);
if (!before) {
  console.error('COLOR block not found — nothing to do.');
  process.exit(1);
}

console.log('raw ESC bytes present:', before[0].includes(ESC));
console.log('escape sequences present:', before[0].includes('\\u001b'));

const replacement = `const COLOR = {
  reset: '\\u001b[0m',
  dim: '\\u001b[2m',
  bold: '\\u001b[1m',
  red: '\\u001b[31m',
  yellow: '\\u001b[33m',
  green: '\\u001b[32m',
  cyan: '\\u001b[36m',
};`;

const out = src.replace(before[0], replacement);
writeFileSync(path, out, 'utf8');
console.log('normalized ANSI table in src/report.js');
