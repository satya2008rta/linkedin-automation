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

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

function isWithin8Hours(isoA, isoB) {
  if (!isoA || !isoB) return false;
  const timeA = new Date(isoA).getTime();
  const timeB = new Date(isoB).getTime();
  if (Number.isNaN(timeA) || Number.isNaN(timeB)) return false;
  return Math.abs(timeA - timeB) < EIGHT_HOURS_MS;
}

function autoSpaceTargetTime(targetIso, existingPostsOnSameDay, currentPostId = null) {
  if (!targetIso) return targetIso;
  const targetDate = new Date(targetIso);
  if (Number.isNaN(targetDate.getTime())) return targetIso;

  const otherPosts = (existingPostsOnSameDay || []).filter(
    (p) => String(p.id) !== String(currentPostId)
  );

  if (otherPosts.length === 0) return targetIso;

  const otherTimes = otherPosts
    .map((p) => new Date(p.scheduledFor || p.postedAt || p.createdAt).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);

  if (otherTimes.length === 0) return targetIso;

  let currentTargetTime = targetDate.getTime();
  let conflictFound = otherTimes.some((t) => Math.abs(currentTargetTime - t) < EIGHT_HOURS_MS);

  if (!conflictFound) return targetIso;

  const lastTime = otherTimes[otherTimes.length - 1];
  let candidateTime = lastTime + EIGHT_HOURS_MS;
  const candidateDate = new Date(candidateTime);
  if (candidateDate.getDate() === targetDate.getDate() && candidateDate.getMonth() === targetDate.getMonth()) {
    return candidateDate.toISOString();
  }

  const firstTime = otherTimes[0];
  let earlierTime = firstTime - EIGHT_HOURS_MS;
  const earlierDate = new Date(earlierTime);
  if (earlierDate.getDate() === targetDate.getDate() && earlierDate.getMonth() === targetDate.getMonth()) {
    return earlierDate.toISOString();
  }

  return candidateDate.toISOString();
}

module.exports = { localInputToIso, isoToLocalInput, friendly, isWithin8Hours, autoSpaceTargetTime, EIGHT_HOURS_MS };
