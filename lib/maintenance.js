const checker = require('./maintenance_checker');

const LOOKUP_TIMEOUT_MS = 45000; // must stay below maxDuration in vercel.json

/** "2026-11-19T09:00:00.000Z" -> "09:00 UTC" */
function formatUtcHour(iso) {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

/**
 * Normalise a user-typed UTC time to "HH:mm", or null if invalid.
 * Accepts "9:00", "09:00", "09:00 UTC" (what /find_schedule prints) and a
 * full ISO string such as "2026-11-19T09:00:00.000Z".
 */
function parseUtcTime(input) {
  const s = String(input || '').trim();
  const m =
    s.match(/^(\d{1,2}):(\d{2})\s*(?:utc|z)?$/i) ||
    s.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?Z$/i);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Look up the relevant "Maintenance Schedule" article (ongoing/upcoming,
 * otherwise the latest) using the logic of maintenance_checker.js.
 * Resolves to { found: false } or { found: true, hour: "09:00 UTC", item }.
 * The hour is the END of the maintenance window, same as the checker.
 */
async function findSchedule() {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Timed out while reading the notice site.')),
      LOOKUP_TIMEOUT_MS,
    );
  });
  try {
    const found = await Promise.race([checker.findMaintenanceEnd(false), timeout]);
    if (!found.length) return { found: false };
    const item = found[0];
    return { found: true, hour: formatUtcHour(item.end_utc), item };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { findSchedule, formatUtcHour, parseUtcTime };
