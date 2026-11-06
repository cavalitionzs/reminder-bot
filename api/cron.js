const crypto = require('crypto');
const { DateTime } = require('luxon');
const {
  getActiveReminders,
  claimReminder,
  releaseClaim,
} = require('../lib/db');
const { sendChannelMessage } = require('../lib/discord');
const { dueOccurrence } = require('../lib/schedule');

function safeEqual(a, b) {
  // Hash first so both buffers have equal length for timingSafeEqual.
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getProvidedSecret(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.headers['x-cron-secret']) return String(req.headers['x-cron-secret']);
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('secret') || '';
  } catch {
    return '';
  }
}

module.exports = async (req, res) => {
  const send = (status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'GET' && req.method !== 'POST') {
    return send(405, { error: 'Method Not Allowed' });
  }

  // Fail closed: without a configured secret nobody may trigger sends.
  const secret = process.env.CRON_SECRET;
  if (!secret) return send(500, { error: 'CRON_SECRET is not configured' });
  if (!safeEqual(getProvidedSecret(req), secret)) {
    return send(401, { error: 'Unauthorized' });
  }

  const windowMinutes = Math.max(1, Number(process.env.CATCHUP_MINUTES) || 5);
  const nowUtc = DateTime.utc();
  const result = { checked: 0, sent: [], skipped: 0, errors: [] };

  try {
    const reminders = await getActiveReminders();
    result.checked = reminders.length;

    for (const reminder of reminders) {
      const due = dueOccurrence(reminder, nowUtc, windowMinutes);
      if (!due) continue;

      const previous = reminder.last_sent_date
        ? String(reminder.last_sent_date).slice(0, 10)
        : null;
      if (previous === due.localDate) {
        result.skipped++;
        continue;
      }

      // Win the claim first; only the winner sends (prevents duplicates).
      const claimed = await claimReminder(reminder.id, due.localDate);
      if (!claimed) {
        result.skipped++;
        continue;
      }

      try {
        const ts = Math.floor(due.scheduled.toSeconds());
        const base = `${reminder.message}\n🕒 <t:${ts}:F> (<t:${ts}:R>)`;
        const mentions = [];
        if (reminder.role_id) mentions.push(`<@&${reminder.role_id}>`);
        if (reminder.user_id) mentions.push(`<@${reminder.user_id}>`);
        const content = mentions.length ? `${mentions.join(' ')} ${base}` : base;

        await sendChannelMessage(reminder.channel_id, {
          content,
          allowed_mentions: {
            parse: [],
            roles: reminder.role_id ? [reminder.role_id] : [],
            users: reminder.user_id ? [reminder.user_id] : [],
          },
        });
        result.sent.push(reminder.id);
        console.log(`Sent reminder #${reminder.id} for ${due.scheduled.toISO()}`);
      } catch (error) {
        console.error(`Could not send reminder #${reminder.id}:`, error.message);
        result.errors.push({ id: reminder.id, error: error.message });
        // Give the claim back so the next cron call (within the window) retries.
        await releaseClaim(reminder.id, previous).catch(() => {});
      }
    }

    return send(200, result);
  } catch (error) {
    console.error('Cron run failed:', error);
    return send(500, { error: 'Cron run failed', detail: error.message });
  }
};
