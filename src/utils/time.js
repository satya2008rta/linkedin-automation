// Small helpers for moving between the browser's <input type="datetime-local"> value
// (no timezone, interpreted as the user's local time) and the UTC ISO strings stored in
// the DB, plus friendly display formatting. Deliberately dependency-light (date-fns is
// used where richer formatting is worth it, e.g. relative "in 2 hours" style text).
const { formatDistanceToNow, format } = require('date-fns');

// "2026-08-06T14:30" (local, from <input type="datetime-local">) -> ISO UTC string.
function localInputToIso(localValue) {
  if (!localValue) return null;
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ISO UTC string -> "2026-08-06T14:30" suitable for re-populating a datetime-local input.
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function friendly(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${format(d, 'MMM d, yyyy p')} (${formatDistanceToNow(d, { addSuffix: true })})`;
}

module.exports = { localInputToIso, isoToLocalInput, friendly };
