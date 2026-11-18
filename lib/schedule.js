const { DateTime } = require('luxon');

// A reminder repeats in one of three ways:
//   run_date set        -> one-time, only on that local date
//   weekday NULL        -> daily
//   weekday 1-7         -> weekly on that weekday
// (For one-time reminders, weekday also holds the weekday of run_date.)

const runDateOf = (reminder) =>
  reminder.run_date ? String(reminder.run_date).slice(0, 10) : null;

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
  const runDate = runDateOf(reminder);
  const daily = reminder.weekday === null || reminder.weekday === undefined;

  for (const daysAgo of [0, 1]) {
    const scheduled = localNow
      .minus({ days: daysAgo })
      .set({ hour, minute, second: 0, millisecond: 0 });

    if (runDate) {
      if (scheduled.toISODate() !== runDate) continue; // one-time: that date only
    } else if (!daily && scheduled.weekday !== Number(reminder.weekday)) {
      continue; // weekly: that weekday only
    }

    const lateMinutes = localNow.diff(scheduled, 'minutes').minutes;
    if (lateMinutes >= 0 && lateMinutes < windowMinutes) {
      return { scheduled, localDate: scheduled.toISODate() };
    }
  }
  return null;
}

/**
 * True for a one-time reminder whose moment (plus the catch-up window) has
 * passed. Such a reminder can never fire again and should be deactivated.
 */
function isExpiredOnce(reminder, nowUtc, windowMinutes) {
  const runDate = runDateOf(reminder);
  if (!runDate) return false;
  const [hour, minute] = String(reminder.reminder_time).split(':').map(Number);
  const scheduled = DateTime.fromISO(runDate, { zone: reminder.timezone }).set({ hour, minute });
  if (!scheduled.isValid) return false;
  return nowUtc > scheduled.plus({ minutes: windowMinutes });
}

/** "2026-11-19" or "19 November 2026" -> "2026-11-19", or null if invalid. */
function parseDateInput(input) {
  const s = String(input || '').trim().replace(/\s+/g, ' ');
  const candidates = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) candidates.push(DateTime.fromISO(s, { zone: 'utc' }));
  for (const fmt of ['d MMMM yyyy', 'd MMM yyyy']) {
    candidates.push(DateTime.fromFormat(s, fmt, { zone: 'utc', locale: 'en' }));
  }
  const ok = candidates.find((d) => d.isValid);
  return ok ? ok.toISODate() : null;
}

const weekdayName = (weekday) =>
  DateTime.fromObject({ weekday: Number(weekday) }).setLocale('en').toFormat('cccc');

/**
 * Turn the command's weekday choice (+ optional date) into what gets stored.
 *   no date, "daily"   -> { weekday: null, run_date: null }   every day
 *   no date, 1-7       -> { weekday: n,    run_date: null }   every week
 *   date given         -> { weekday: <weekday of date>, run_date }  one time
 *   neither            -> error (the repeat mode is unknown)
 * With a date the weekday is optional; if one is chosen anyway it must match
 * that date (catches typos such as "Friday" + 2026-11-19). The moment must not
 * be in the past.
 * Returns { weekday, run_date } or { error }.
 */
function resolveRecurrence(choice, dateInput, time, timezone, nowUtc = DateTime.utc()) {
  const hasChoice = choice !== undefined && choice !== null && choice !== '';

  if (dateInput === undefined || dateInput === null || String(dateInput).trim() === '') {
    if (!hasChoice) {
      return {
        error:
          'Choose how this repeats: set a weekday (weekly), "Every day" (daily), ' +
          'or give a date (one-time).',
      };
    }
    return { weekday: choice === 'daily' ? null : Number(choice), run_date: null };
  }

  const date = parseDateInput(dateInput);
  if (!date) {
    return { error: 'Invalid date. Use YYYY-MM-DD, e.g. 2026-11-19 (or "19 November 2026").' };
  }

  const [hour, minute] = time.split(':').map(Number);
  const scheduled = DateTime.fromISO(date, { zone: timezone }).set({ hour, minute });
  if (!scheduled.isValid) return { error: `Invalid date or timezone: ${date} ${timezone}.` };

  if (hasChoice && (choice === 'daily' || Number(choice) !== scheduled.weekday)) {
    const actual = weekdayName(scheduled.weekday);
    return {
      error:
        `${date} is a ${actual} in ${timezone}. For a one-time reminder on that date, ` +
        `choose weekday ${actual} (or leave out the date for a repeating reminder).`,
    };
  }
  if (scheduled <= nowUtc) {
    return { error: `That date and time (${date} ${time} ${timezone}) has already passed.` };
  }
  return { weekday: scheduled.weekday, run_date: date };
}

module.exports = {
  dueOccurrence,
  isExpiredOnce,
  parseDateInput,
  resolveRecurrence,
  DateTime,
};
