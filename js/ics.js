// .ics export for Google Calendar, Apple Calendar, Outlook,
// with UTC-correct UNTIL, escaping, CRNs and instructors in the event notes.
import { DAY_LETTERS } from './engine.js';
import { roomText } from './util.js';

const ICS_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function escText(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function hhmmss(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}${String(min % 60).padStart(2, '0')}00`;
}

function parseISO(d) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day);
}

function ymd(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

/** First date on/after `start` that falls on one of the meeting's weekdays (0 = Monday) */
function firstOccurrence(start, dayIdx) {
  const d = new Date(start);
  for (let i = 0; i < 7; i++) {
    const mondayBased = (d.getDay() + 6) % 7;
    if (dayIdx.includes(mondayBased)) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

// Wrap long lines at 75 octets as RFC 5545 asks
function fold(line) {
  if (line.length <= 74) return line;
  const parts = [];
  for (let i = 0; i < line.length; i += 73) parts.push((i ? ' ' : '') + line.slice(i, i + 73));
  return parts.join('\r\n');
}

export function buildICS(sections, termDesc = '') {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ninersoftware//Niner Scheduler//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escText(termDesc ? `Classes – ${termDesc}` : 'Classes')}`,
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'BEGIN:STANDARD',
    'DTSTART:19671029T020000',
    'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'TZNAME:EST',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:19870405T020000',
    'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'TZNAME:EDT',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
  ];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  let n = 0;
  for (const s of sections) {
    for (const m of s.mt || []) {
      if (!m.d || m.s == null || !m.sd || !m.ed) continue;
      const dayIdx = [...m.d].map((ch) => DAY_LETTERS.indexOf(ch)).filter((i) => i >= 0);
      const first = firstOccurrence(parseISO(m.sd), dayIdx);
      const until = parseISO(m.ed);
      until.setDate(until.getDate() + 1); // end of the last day in Eastern time, expressed in UTC
      const where = roomText(m);
      const notes = [
        `CRN ${s.crn} · Section ${s.seq} · ${s.type}`,
        s.inst?.length ? `Instructor: ${s.inst.join(', ')}` : '',
        `${s.cr} credit${s.cr === 1 ? '' : 's'}`,
      ]
        .filter(Boolean)
        .join('\n');
      lines.push(
        'BEGIN:VEVENT',
        `UID:${s.crn}-${n++}@niner-scheduler`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=America/New_York:${ymd(first)}T${hhmmss(m.s)}`,
        `DTEND;TZID=America/New_York:${ymd(first)}T${hhmmss(m.e)}`,
        `RRULE:FREQ=WEEKLY;BYDAY=${dayIdx.map((i) => ICS_DAYS[i]).join(',')};UNTIL=${ymd(until)}T045959Z`,
        `SUMMARY:${escText(`${s.subj} ${s.num} – ${s.title}`)}`,
        where ? `LOCATION:${escText(where)}` : '',
        `DESCRIPTION:${escText(notes)}`,
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).map(fold).join('\r\n');
}
