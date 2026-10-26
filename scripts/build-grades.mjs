#!/usr/bin/env node
// Splits grades.json (UNC Charlotte's public grade distributions) into one small file per subject so the site
// only downloads the grade history for subjects you actually add.
//
//   node scripts/build-grades.mjs path/to/grades.json

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('Usage: node scripts/build-grades.mjs <grades.json>');
  process.exit(1);
}
const OUT = path.resolve(process.env.OUT_DIR || 'data', 'grades');

const grades = JSON.parse(await readFile(src, 'utf8'));
const bySubject = {};
for (const [key, profs] of Object.entries(grades)) {
  const subj = key.split('-')[0];
  (bySubject[subj] ||= {})[key] = profs;
}

await mkdir(OUT, { recursive: true });
for (const f of await readdir(OUT)) if (f.endsWith('.json')) await rm(path.join(OUT, f));
let total = 0;
for (const [subj, courses] of Object.entries(bySubject)) {
  const body = JSON.stringify(courses);
  total += body.length;
  await writeFile(path.join(OUT, `${subj}.json`), body);
}
await writeFile(
  path.join(OUT, 'index.json'),
  JSON.stringify({ built: new Date().toISOString(), subjects: Object.keys(bySubject).sort() }),
);
console.log(`${Object.keys(bySubject).length} subjects, ${Object.keys(grades).length} courses, ${(total / 1e6).toFixed(1)} MB`);
