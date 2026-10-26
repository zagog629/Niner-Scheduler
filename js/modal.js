// Course details: description, prerequisites, every instructor's ratings and grade history
import { db, loadCatalog, loadGrades, rmpFor, courseGrades } from './data.js';
import { gpaOf, gradeTotals, courseTotals, findGrades } from './names.js';
import { esc, fmtRange, fmtNum, ratingClass, gpaClass, icons, timeAgo, roomText } from './util.js';
import { dayMask, meetingsOf } from './engine.js';

const LETTERS = ['A', 'B', 'C', 'D', 'F', 'W'];

const DAY_ABBR = ['M', 'Tu', 'W', 'Th', 'F', 'Sa', 'Su'];
const maskText = (mask) => DAY_ABBR.filter((_, i) => mask & (1 << i)).join('');
export function daysText(d) {
  return maskText(dayMask(d));
}

// Raw meeting rows minus one-off days (an orientation or final exam), using the engine's rule
function oneOffRows(sec) {
  return new Set(meetingsOf(sec).filter((m) => m.once).map((m) => m.ri));
}

export function meetingText(sec) {
  const skip = oneOffRows(sec);
  const timed = (sec.mt || []).filter((m, i) => m.d && m.s != null && m.e != null && !skip.has(i));
  if (!timed.length) return sec.method && /online/i.test(sec.method) ? 'Online, no set time' : 'Time to be announced';
  // One entry per time slot, so "MW" plus a few extra "M" weeks at the same time reads "MW 5:30–6:45 PM"
  const slots = new Map();
  for (const m of timed) {
    const k = `${m.s}|${m.e}`;
    slots.set(k, { s: m.s, e: m.e, days: (slots.get(k)?.days || 0) | dayMask(m.d) });
  }
  return [...slots.values()].map((x) => `${maskText(x.days)} ${fmtRange(x.s, x.e)}`).join('; ');
}

/** Building and room for each in-person meeting, or the campus / "Online" */
export function locationText(sec) {
  const rooms = [];
  const skip = oneOffRows(sec);
  for (const [i, m] of (sec.mt || []).entries()) {
    if (skip.has(i)) continue;
    const where = roomText(m);
    if (where && !rooms.includes(where)) rooms.push(where);
  }
  if (rooms.length) return rooms.join('; ');
  if (/online/i.test(sec.method || '') || /online/i.test(sec.campus || '')) return 'Online';
  return sec.campus || 'To be announced';
}

function seatsLabel(sec) {
  if (sec.seats == null) return '–';
  if (sec.seats > 0) return `${sec.seats} of ${sec.max ?? '?'} open`;
  const wl = (sec.wcap || 0) - (sec.wcnt || 0);
  return wl > 0 ? `Full, ${wl} waitlist` : 'Full';
}

const CHART_HINT = '<span class="gc-hint">Select a bar to see how many students got that grade.</span>';

/** Spells out one grade of a distribution: how many students, what share, and how it compares */
function gradeReadout(counts, k) {
  const total = LETTERS.reduce((t, l) => t + (counts[l] || 0), 0);
  const n = counts[k] || 0;
  const what = k === 'W' ? 'withdrew' : `got ${k === 'A' || k === 'F' ? 'an' : 'a'} ${k}`;
  const letter = `<span class="gc-r-letter${k === 'W' ? ' is-w' : ''}" aria-hidden="true">${k}</span>`;
  if (!n) return `${letter}<span><strong>No students</strong> ${what}<span class="gc-r-more">out of ${fmtNum(total)}</span></span>`;
  const pct = (n / total) * 100;
  const more = [`${pct.toFixed(1)}% of ${fmtNum(total)} students`];
  if (pct >= 95) more.push('almost everyone');
  else if (pct >= 45 && pct < 55) more.push('about half');
  else if (pct >= 30) more.push(`about ${Math.round(pct / 10)} in 10`);
  else more.push(pct < 1 ? 'fewer than 1 in 100' : `about 1 in ${Math.round(100 / pct)}`);
  if ('BCD'.includes(k)) {
    const upTo = LETTERS.slice(0, LETTERS.indexOf(k) + 1).reduce((t, l) => t + (counts[l] || 0), 0);
    more.push(`${Math.round((upTo / total) * 100)}% got a ${k} or better`);
  } else if (k === 'F' || k === 'W') {
    const dfw = (counts.D || 0) + (counts.F || 0) + (counts.W || 0);
    more.push(`${Math.round((dfw / total) * 100)}% got a D or F or withdrew`);
  }
  return `${letter}<span><strong>${fmtNum(n)} student${n === 1 ? '' : 's'}</strong> ${what}<span class="gc-r-more">${more.join(' · ')}</span></span>`;
}

/** Highlights grade k in a chart drawn by gradeChart and spells out its numbers; null clears it */
export function selectGrade(root, counts, k) {
  const fig = root.querySelector('.gc');
  if (!fig) return;
  fig.classList.toggle('has-sel', !!k);
  fig.querySelectorAll('[data-k]').forEach((el) => {
    const on = el.dataset.k === k;
    el.classList.toggle('is-sel', on);
    if (el.classList.contains('gc-bar')) el.setAttribute('aria-pressed', String(on));
  });
  fig.querySelector('.gc-readout').innerHTML = k ? gradeReadout(counts, k) : CHART_HINT;
}

/** Single-series column chart of a grade distribution; W is drawn in neutral gray. Bars are selectable (see selectGrade) */
export function gradeChart(counts, caption) {
  const total = LETTERS.reduce((t, k) => t + (counts[k] || 0), 0);
  if (!total) return '<p class="muted">No grades recorded for this selection.</p>';
  const pct = LETTERS.map((k) => ((counts[k] || 0) / total) * 100);
  const maxPct = Math.max(...pct);
  const step = maxPct > 50 ? 20 : maxPct > 25 ? 10 : 5;
  const top = Math.ceil(maxPct / step) * step || step;
  const W = 340;
  const H = 168;
  const padL = 34;
  const padB = 26;
  const padT = 18;
  const plotH = H - padB - padT;
  const band = (W - padL - 8) / LETTERS.length;
  const barW = Math.min(24, band - 2);
  const grid = [];
  for (let v = 0; v <= top; v += step) {
    const y = padT + plotH * (1 - v / top);
    grid.push(`<line class="gc-grid" x1="${padL}" x2="${W - 4}" y1="${y}" y2="${y}"/><text class="gc-tick" x="${padL - 6}" y="${y + 3.5}" text-anchor="end">${v}%</text>`);
  }
  const peak = pct.indexOf(maxPct);
  const bars = LETTERS.map((k, i) => {
    const h = (pct[i] / top) * plotH;
    const x = padL + i * band + (band - barW) / 2;
    const y = padT + plotH - h;
    const r = Math.min(4, h);
    const path = h > 0
      ? `M${x},${padT + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${padT + plotH} Z`
      : '';
    const tip = `${k}: ${fmtNum(counts[k] || 0)} students (${pct[i].toFixed(1)}%)`;
    return `<g class="gc-bar${k === 'W' ? ' is-w' : ''}" data-k="${k}" role="button" aria-pressed="false" tabindex="0" aria-label="${tip}">
      <title>${tip}</title>
      <rect class="gc-hit" x="${padL + i * band + 1}" y="${padT - 14}" width="${band - 2}" height="${plotH + padB + 14}" rx="6"/>
      ${path ? `<path d="${path}"/>` : ''}
      ${i === peak ? `<text class="gc-val" x="${x + barW / 2}" y="${y - 5}" text-anchor="middle">${pct[i].toFixed(0)}%</text>` : ''}
      <text class="gc-count" x="${x + barW / 2}" y="${y - 5}" text-anchor="middle">${fmtNum(counts[k] || 0)}</text>
      <text class="gc-letter" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${k}</text>
    </g>`;
  }).join('');
  const gpa = gpaOf(counts);
  const table = `<details class="gc-table"><summary>Show as table</summary><table><thead><tr><th>Grade</th><th>Students</th><th>Share</th></tr></thead><tbody>${LETTERS.map((k, i) => `<tr data-k="${k}"><td>${k}</td><td>${fmtNum(counts[k] || 0)}</td><td>${pct[i].toFixed(1)}%</td></tr>`).join('')}</tbody></table></details>`;
  return `<figure class="gc">
    <svg viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(caption)}: grade distribution">${grid.join('')}${bars}</svg>
    <div class="gc-readout" aria-live="polite">${CHART_HINT}</div>
    <figcaption>${gpa != null ? `Average GPA <strong>${gpa.toFixed(2)}</strong> from ` : ''}${fmtNum(total)} grades</figcaption>
    ${table}
  </figure>`;
}

function rmpCell(p, name) {
  if (!p) {
    const q = encodeURIComponent(name);
    const search = `<a href="https://www.ratemyprofessors.com/search/professors/1253?q=${q}" target="_blank" rel="noopener">look up</a>`;
    // No ratings file at all vs. this one instructor not being on RMP are different situations
    return db.rmp?.length
      ? `<td class="muted" colspan="3">No ratings found (${search})</td>`
      : `<td class="muted" colspan="3">Not available (${search})</td>`;
  }
  return `<td><a class="pill ${ratingClass(p.r)}" href="https://www.ratemyprofessors.com/professor/${p.id}" target="_blank" rel="noopener" title="${p.n} ratings on Rate My Professors">${p.r.toFixed(1)}</a><span class="small muted"> ${p.n} ratings${p.n < 10 ? ' (few)' : ''}</span></td>
    <td>${p.d != null ? `${p.d.toFixed(1)}<span class="muted">/5</span>` : '–'}</td>
    <td>${p.w != null ? `${p.w}%` : '–'}</td>`;
}

export async function openCourseModal(dialog, courseKey, { color = 0, focusName = null, focusCrn = null } = {}) {
  const course = db.courses.get(courseKey);
  if (!course) return;
  const [subj, num] = courseKey.split(' ');
  dialog.innerHTML = `<div class="modal-shell"><p class="muted">Loading ${esc(courseKey)}…</p></div>`;
  if (!dialog.open) dialog.showModal();
  const [catalog] = await Promise.all([loadCatalog(subj), loadGrades(subj)]);
  const info = catalog?.[courseKey];
  const grades = courseGrades(courseKey);

  // Instructors teaching it this term, with section counts
  const teaching = new Map();
  for (const s of course.sections) {
    const names = s.inst.length ? s.inst.slice(0, 1) : ['Staff'];
    for (const n of names) {
      if (!teaching.has(n)) teaching.set(n, []);
      teaching.get(n).push(s);
    }
  }
  const rows = [...teaching.entries()].map(([name, secs]) => {
    const g = findGrades(grades, name);
    return { name, secs, rmp: rmpFor(name), g, gpa: g ? gpaOf(g.all) : null, totals: g ? gradeTotals(g.all) : null };
  });
  rows.sort((a, b) => (b.g ? 1 : 0) - (a.g ? 1 : 0) || a.name.localeCompare(b.name));

  const options = [
    ...(grades ? [{ value: '__all', label: 'All instructors, all years' }] : []),
    ...Object.keys(grades || {}).sort().map((n) => ({ value: n, label: n })),
  ];
  const initial = (focusName && findGrades(grades, focusName)?.name) || rows.find((r) => r.g)?.g.name || (grades ? '__all' : null);

  const focus = focusCrn ? course.sections.find((s) => s.crn === focusCrn) : null;
  const sectionRows = course.sections
    .map(
      (s) => `<tr class="${s.crn === focusCrn ? 'is-focus' : ''}">
        <td><strong>${esc(s.seq)}</strong></td>
        <td class="num">${esc(s.crn)}</td>
        <td>${esc(meetingText(s))}</td>
        <td>${esc(locationText(s))}</td>
        <td>${esc(s.inst[0] || 'Staff')}</td>
        <td class="${s.seats != null && s.seats <= 0 ? 'is-full' : ''}">${esc(seatsLabel(s))}</td>
      </tr>`,
    )
    .join('');

  const prereq = info?.prereq?.length
    ? `<ul class="prereq">${info.prereq.map((g) => `<li>${g.map(esc).join(' <em>or</em> ')}</li>`).join('')}</ul>`
    : '<p class="muted">None listed.</p>';

  dialog.innerHTML = `
    <div class="modal-shell c${color}">
      <header class="modal-head">
        <div>
          <h2><span class="swatch"></span>${esc(courseKey)}</h2>
          <p class="modal-title">${esc(course.title)}</p>
          <p class="muted small">${course.crMin === course.crMax ? course.crMin : `${course.crMin}–${course.crMax}`} credits, ${course.sections.length} section${course.sections.length === 1 ? '' : 's'} in ${esc(db.term.desc)}</p>
          ${
            focus
              ? `<dl class="focus-sec">
            <div><dt>Section</dt><dd>${esc(focus.seq)}</dd></div>
            <div><dt>CRN</dt><dd>${esc(focus.crn)}</dd></div>
            <div><dt>When</dt><dd>${esc(meetingText(focus))}</dd></div>
            <div><dt>Where</dt><dd>${esc(locationText(focus))}</dd></div>
            <div><dt>Instructor</dt><dd>${esc(focus.inst.join(', ') || 'Staff')}</dd></div>
          </dl>`
              : ''
          }
        </div>
        <button class="icon-btn" data-close aria-label="Close">${icons.x}</button>
      </header>
      <div class="modal-body">
        <section>
          <h3>Description</h3>
          <p>${info?.desc ? esc(info.desc) : '<span class="muted">No description has been collected for this course yet.</span>'}</p>
          <h3>Prerequisites</h3>
          ${info ? prereq : '<p class="muted">Not collected yet. Check Banner before registering.</p>'}
        </section>
        <section>
          <h3>Sections this term</h3>
          <div class="table-scroll">
          <table class="inst-table sec-table">
            <thead><tr><th>Section</th><th>CRN</th><th>When</th><th>Where</th><th>Instructor</th><th>Seats</th></tr></thead>
            <tbody>${sectionRows}</tbody>
          </table>
          </div>
        </section>
        <section>
          <h3>Instructors this term</h3>
          <div class="table-scroll">
          <table class="inst-table">
            <thead><tr><th>Instructor</th><th>Rating</th><th>Difficulty</th><th>Would retake</th><th>Avg GPA</th><th>A rate</th><th>Withdraw</th></tr></thead>
            <tbody>
              ${rows
                .map(
                  (r) => `<tr${r.g ? ` data-grade="${esc(r.g.name)}" tabindex="0"` : ''}>
                <td><strong>${esc(r.name)}</strong><span class="small muted"> ${r.secs.length} section${r.secs.length === 1 ? '' : 's'}</span></td>
                ${r.name === 'Staff' ? '<td class="muted" colspan="3">Not assigned yet</td>' : rmpCell(r.rmp, r.name)}
                <td>${r.gpa != null ? `<span class="pill ${gpaClass(r.gpa)}">${r.gpa.toFixed(2)}</span>` : '<span class="muted">–</span>'}</td>
                <td>${r.totals?.aRate != null ? `${Math.round(r.totals.aRate * 100)}%` : '–'}</td>
                <td>${r.totals?.wRate != null ? `${Math.round(r.totals.wRate * 100)}%` : '–'}</td>
              </tr>`,
                )
                .join('')}
            </tbody>
          </table>
          </div>
          <p class="small muted">${db.rmp?.length ? `Ratings from Rate My Professors${db.rmpUpdated ? `, updated ${timeAgo(db.rmpUpdated)}` : ''}.` : "Rate My Professors ratings haven't been downloaded for this site yet."} Grade distributions come from UNC Charlotte's Office of the Registrar, back to Fall 2015. Select a row to see that instructor's grades.</p>
        </section>
        ${grades
          ? `<section>
          <div class="grade-head">
            <h3>Grade history</h3>
            <div class="grade-controls">
              <label><span class="sr-only">Instructor</span><select data-g-inst>${options.map((o) => `<option value="${esc(o.value)}"${o.value === initial ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
              <label><span class="sr-only">Semester</span><select data-g-sem></select></label>
            </div>
          </div>
          <div data-g-chart></div>
        </section>`
          : '<section><h3>Grade history</h3><p class="muted">No grade history for this course.</p></section>'}
      </div>
      <footer class="modal-foot">
        <a class="btn" href="https://www.coursicle.com/uncc/courses/${esc(subj)}/${esc(num)}/" target="_blank" rel="noopener">Coursicle</a>
        <a class="btn" href="https://www.ratemyprofessors.com/school/1253" target="_blank" rel="noopener">Rate My Professors</a>
      </footer>
    </div>`;

  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());

  if (grades) {
    const instSel = dialog.querySelector('[data-g-inst]');
    const semSel = dialog.querySelector('[data-g-sem]');
    const chart = dialog.querySelector('[data-g-chart]');
    const fillSems = () => {
      const v = instSel.value;
      const sems = v === '__all' ? [] : Object.keys(grades[v]?.semesters || {});
      semSel.innerHTML = `<option value="__all">All semesters</option>${sems.map((s) => `<option>${esc(s)}</option>`).join('')}`;
      semSel.disabled = !sems.length;
    };
    // The picked grade stays picked when the instructor or semester changes, so they're easy to compare
    let counts = {};
    let picked = null;
    const pick = (k) => {
      picked = k;
      selectGrade(chart, counts, picked);
    };
    const draw = () => {
      const v = instSel.value;
      if (v === '__all') counts = courseTotals(grades);
      else counts = (semSel.value === '__all' ? grades[v].all : grades[v].semesters[semSel.value]) || {};
      chart.innerHTML = gradeChart(counts, v === '__all' ? courseKey : v);
      selectGrade(chart, counts, picked);
    };
    chart.addEventListener('click', (e) => {
      const bar = e.target.closest('.gc-bar');
      if (bar) pick(picked === bar.dataset.k ? null : bar.dataset.k);
    });
    chart.addEventListener('keydown', (e) => {
      const bar = e.target.closest('.gc-bar');
      if (!bar) return;
      const k = bar.dataset.k;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(picked === k ? null : k);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const i = LETTERS.indexOf(k) + (e.key === 'ArrowRight' ? 1 : -1);
        const next = LETTERS[Math.max(0, Math.min(LETTERS.length - 1, i))];
        pick(next);
        chart.querySelector(`.gc-bar[data-k="${next}"]`)?.focus();
      }
    });
    instSel.addEventListener('change', () => {
      fillSems();
      draw();
    });
    semSel.addEventListener('change', draw);
    dialog.querySelectorAll('tr[data-grade]').forEach((tr) => {
      const go = () => {
        instSel.value = tr.dataset.grade;
        fillSems();
        draw();
        chart.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    });
    fillSems();
    draw();
  }
}