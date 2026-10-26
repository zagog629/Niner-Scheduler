// Instructor-name matching between Banner, Rate My Professors and the grade history

// Banner name -> name as it appears on Rate My Professors / in the grade data
export const REPLACEMENTS = {
  'Ree Linker': 'Jeanne-Marie Linker',
  'Hamid Baradaran Shoraka': 'Hamid Shoraka',
  'Maria Guimaraes Biagini': 'Maria Guimaraes',
  'Dave Naylor': 'David Naylor',
  'Jay Wu': 'Jy Wu',
  'Dave Weggel': 'David Weggel',
  'Jeff Raquet': 'Jeffrey Raquet',
  'Garry Hodgins': 'Martin Hodgins',
  'Kosta Falaggis': 'Konstantinos Falaggis',
  'Jim Conrad': 'James Conrad',
  'Nigel Zheng': 'Naiquan Zheng',
  'Gary Teng': 'Teng Gary',
  'Sam Shue': 'Samuel Shue',
  'Zbyszek Ras': 'Zbigniew Ras',
  'Tom Moyer': 'Thomas Moyer',
  'Chao Wang': 'Wiechao Wang',
  'Carmen Soliz Urrutia': 'Maria Carmen Soliz Urrutia',
  'Katie Hogan': 'Kathleen Hogan',
  'Juan Meneses Naranjo': 'Juan Meneses',
  'Becky Roeder': 'Rebecca Roeder',
  'Pilar Blitvich': 'Maria Pilar Garces-Conejos Blitvich',
};

export function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/ /g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[-,.]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function namesMatch(searchName, firstName, lastName) {
  const fullRMP = normalize(`${firstName} ${lastName}`);
  const search = normalize(searchName);
  if (!search || !fullRMP) return false;
  if (search === fullRMP) return true;

  const searchParts = search.split(' ');
  const rmpParts = fullRMP.split(' ');
  const searchFirst = searchParts[0];
  const searchLast = searchParts[searchParts.length - 1];
  const rmpFirst = rmpParts[0];
  const rmpLast = rmpParts[rmpParts.length - 1];

  if (searchFirst === rmpLast && searchLast === rmpFirst) return true;

  const rmpLastParts = normalize(lastName).split(' ');
  if (!rmpLastParts.includes(searchLast)) return false;

  return (
    (rmpFirst.startsWith(searchFirst.slice(0, 3)) || searchFirst.startsWith(rmpFirst.slice(0, 3))) &&
    searchLast === rmpLast
  );
}

export function resolveName(name) {
  return REPLACEMENTS[name] || name;
}

/** Index RMP professors by every token of their names so lookups stay O(1)-ish */
export function buildRmpIndex(profs) {
  const index = new Map();
  const add = (token, p) => {
    if (!token) return;
    if (!index.has(token)) index.set(token, []);
    index.get(token).push(p);
  };
  for (const p of profs) {
    const tokens = new Set([...normalize(p.l).split(' '), normalize(p.f).split(' ')[0]]);
    for (const t of tokens) add(t, p);
  }
  return index;
}

export function findRmp(index, name) {
  if (!index || !name || name === 'Staff') return null;
  const resolved = resolveName(name);
  const parts = normalize(resolved).split(' ');
  const cands = new Set([...(index.get(parts[parts.length - 1]) || []), ...(index.get(parts[0]) || [])]);
  let best = null;
  for (const p of cands) {
    if (!namesMatch(resolved, p.f, p.l)) continue;
    if (!best || p.n > best.n) best = p;
  }
  return best;
}

/** Find an instructor's grade record inside one course's { "First Last": {...} } map */
export function findGrades(courseGrades, name) {
  if (!courseGrades || !name) return null;
  const target = normalize(resolveName(name));
  const entries = Object.entries(courseGrades);
  for (const [n, g] of entries) if (normalize(n) === target || normalize(n) === normalize(name)) return { name: n, ...g };
  for (const [n, g] of entries) {
    const parts = normalize(n).split(' ');
    if (namesMatch(name, parts[0], parts.slice(1).join(' '))) return { name: n, ...g };
  }
  // Last-name fallback only when it is unambiguous
  const last = target.split(' ').pop();
  const same = entries.filter(([n]) => normalize(n).split(' ').pop() === last);
  if (same.length === 1) return { name: same[0][0], ...same[0][1] };
  return null;
}

export function gpaOf(counts) {
  if (!counts) return null;
  const pts = { A: 4, B: 3, C: 2, D: 1, F: 0 };
  let total = 0;
  let n = 0;
  for (const [k, v] of Object.entries(pts)) {
    total += v * (counts[k] || 0);
    n += counts[k] || 0;
  }
  return n ? total / n : null;
}

export function gradeTotals(counts) {
  const graded = ['A', 'B', 'C', 'D', 'F'].reduce((t, k) => t + (counts?.[k] || 0), 0);
  const all = graded + (counts?.W || 0);
  return {
    graded,
    all,
    aRate: graded ? (counts.A || 0) / graded : null,
    wRate: all ? (counts.W || 0) / all : null,
  };
}

/** Merge every instructor's counts for a course */
export function courseTotals(courseGrades) {
  const sum = { A: 0, B: 0, C: 0, D: 0, F: 0, W: 0 };
  for (const g of Object.values(courseGrades || {})) for (const k of Object.keys(sum)) sum[k] += g.all?.[k] || 0;
  return sum;
}
