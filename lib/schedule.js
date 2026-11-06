const { DateTime } = require('luxon');

/**
 * Decide whether a reminder is due right now.
 *
 * An external cron may call a few seconds late, skip a minute, or run slow,
 * so instead of requiring an exact-minute match we accept a catch-up window:
 * the reminder is due if its scheduled moment was within the last
 * `windowMinutes` minutes. Today AND yesterday are checked so a reminder at
 * 23:59 is still sent when the cron call lands after midnight.
 *
 * Returns { scheduled, localDate } or null.
 */
function dueOccurrence(reminder, nowUtc, windowMinutes) {
  const localNow = nowUtc.setZone(reminder.timezone);
  if (!localNow.isValid) return null;

  const [hour, minute] = String(reminder.reminder_time).split(':').map(Number);

  for (const daysAgo of [0, 1]) {
    const scheduled = localNow
      .minus({ days: daysAgo })
      .set({ hour, minute, second: 0, millisecond: 0 });

    if (scheduled.weekday !== Number(reminder.weekday)) continue;

    const lateMinutes = localNow.diff(scheduled, 'minutes').minutes;
    if (lateMinutes >= 0 && lateMinutes < windowMinutes) {
      return { scheduled, localDate: scheduled.toISODate() };
    }
  }
  return null;
}

module.exports = { dueOccurrence, DateTime };
