const { DateTime, IANAZone } = require('luxon');
const {
  verifySignature,
  getRawBody,
  editOriginalResponse,
} = require('../lib/discord');
const {
  addReminder,
  listReminders,
  deleteReminder,
  getReminder,
  updateMaintenanceTime,
} = require('../lib/db');
const { findSchedule, parseUtcTime } = require('../lib/maintenance');
const { resolveRecurrence } = require('../lib/schedule');
const { runInBackground } = require('../lib/background');

const EPHEMERAL = 64; // MessageFlags.Ephemeral
const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// How a reminder repeats: run_date set = one-time, weekday NULL = daily,
// weekday 1-7 = weekly (see lib/schedule.js).
const fullDay = (weekday) =>
  DateTime.fromObject({ weekday: Number(weekday) }).setLocale('en').toFormat('cccc');
const isDaily = (r) => (r.weekday === null || r.weekday === undefined) && !r.run_date;
const dayLabel = (r) =>
  r.run_date
    ? `${fullDay(r.weekday)} ${String(r.run_date).slice(0, 10)} (one-time)`
    : isDaily(r)
      ? 'Every day'
      : `Every ${fullDay(r.weekday)}`;
const DEFAULT_MAINTENANCE_MESSAGE = '🔧 Maintenance schedule reminder';

function reply(content) {
  return { type: 4, data: { content, flags: EPHEMERAL } };
}

function optionsMap(options = []) {
  const map = {};
  for (const o of options) map[o.name] = o.value;
  return map;
}

async function handleReminder(interaction) {
  const defaultTimezone = process.env.DEFAULT_TIMEZONE || 'Asia/Jakarta';

  if (!interaction.guild_id) {
    return reply('This command can only be used in a server.');
  }

  const sub = interaction.data.options && interaction.data.options[0];
  if (!sub) return reply('Unknown command.');
  const opts = optionsMap(sub.options);
  const guildId = interaction.guild_id;
  const userId =
    (interaction.member && interaction.member.user && interaction.member.user.id) ||
    (interaction.user && interaction.user.id);

  if (sub.name === 'add') {
    const time = opts.time;
    const timezone = opts.timezone || defaultTimezone;
    const mention = opts.mention === true;

    if (!TIME_RE.test(time || '')) {
      return reply('Invalid time. Use 24-hour HH:mm, e.g. 02:00 or 18:30.');
    }
    if (!IANAZone.isValidZone(timezone)) {
      return reply(`Invalid timezone: ${timezone}. Example: Asia/Jakarta`);
    }
    const recurrence = resolveRecurrence(opts.weekday, opts.date, time, timezone);
    if (recurrence.error) return reply(recurrence.error);

    const inserted = await addReminder({
      guild_id: guildId,
      channel_id: opts.channel,
      user_id: mention ? userId : null,
      role_id: opts.role || null,
      message: opts.message,
      weekday: recurrence.weekday,
      run_date: recurrence.run_date,
      time,
      timezone,
    });

    return reply(
      `Reminder **#${inserted[0].id}** created: **${dayLabel(recurrence)} ${time}** (${timezone}) in <#${opts.channel}>` +
        `${opts.role ? `, mentioning <@&${opts.role}>` : ''}` +
        `${mention ? ', mentioning you' : ''}.`,
    );
  }

  if (sub.name === 'list') {
    const rows = await listReminders(guildId);
    if (!rows.length) return reply('No active reminders in this server yet.');

    const lines = rows.map(
      (r) =>
        `**#${r.id}**${r.kind === 'maintenance' ? ' 🔧' : ''} · ${r.run_date ? `${DAY_NAMES[Number(r.weekday)]} ${String(r.run_date).slice(0, 10)} (once)` : isDaily(r) ? 'Daily' : `Every ${DAY_NAMES[Number(r.weekday)]}`} ${r.reminder_time} · ${r.timezone} · <#${r.channel_id}>` +
        `${r.role_id ? ` · role <@&${r.role_id}>` : ''}` +
        `${r.user_id ? ' · mention enabled' : ''}\n└ ${r.message}`,
    );

    return {
      type: 4,
      data: {
        flags: EPHEMERAL,
        embeds: [
          {
            title: 'Reminders',
            description: lines.join('\n\n').slice(0, 4000),
            color: 0x7652d4,
          },
        ],
        allowed_mentions: { parse: [] },
      },
    };
  }

  if (sub.name === 'delete') {
    const id = opts.id;
    const deleted = await deleteReminder(id, guildId);
    return reply(
      deleted
        ? `Reminder **#${id}** deleted.`
        : `Reminder **#${id}** was not found in this server.`,
    );
  }

  if (sub.name === 'timezone') {
    return reply(
      `Default timezone for new reminders: **${defaultTimezone}**. For WIB (UTC+7), use **Asia/Jakarta**.`,
    );
  }

  return reply('Unknown subcommand.');
}

// /find_schedule: reading the notice site can take longer than Discord's 3s
// limit, so answer with a "thinking..." placeholder (type 5) and replace it
// with the result once the lookup finishes.
function handleFindSchedule(interaction) {
  runInBackground(
    (async () => {
      let content;
      try {
        const result = await findSchedule();
        if (!result.found) {
          content = 'No article with a parsable "Maintenance Schedule" was found.';
        } else {
          const { item } = result;
          content = `**${result.hour}**\n└ ${item.title} (${item.status})`;
        }
      } catch (error) {
        console.error('find_schedule failed:', error);
        content = `Could not fetch the maintenance schedule: ${error.message}`.slice(0, 1900);
      }
      try {
        await editOriginalResponse(interaction.application_id, interaction.token, {
          content,
          allowed_mentions: { parse: [] },
        });
      } catch (error) {
        console.error('Could not send find_schedule result:', error.message);
      }
    })(),
  );
  return { type: 5, data: { flags: EPHEMERAL } };
}

async function handleMaintenanceSchedule(interaction) {
  if (!interaction.guild_id) {
    return reply('This command can only be used in a server.');
  }
  const opts = optionsMap(interaction.data.options);
  const userId =
    (interaction.member && interaction.member.user && interaction.member.user.id) ||
    (interaction.user && interaction.user.id);

  const time = parseUtcTime(opts.time);
  if (!time) {
    return reply('Invalid time. Use 24-hour UTC HH:mm, e.g. 09:00 or 09:00 UTC.');
  }
  const mention = opts.mention === true;

  // Maintenance schedules never repeat weekly (that is /reminder add). With a
  // date they fire only on that day; without one they fire every day.
  const hasDate = opts.date !== undefined && opts.date !== null && String(opts.date).trim() !== '';
  const recurrence = resolveRecurrence(hasDate ? undefined : 'daily', opts.date, time, 'UTC');
  if (recurrence.error) return reply(recurrence.error);

  const inserted = await addReminder({
    guild_id: interaction.guild_id,
    channel_id: opts.channel,
    user_id: mention ? userId : null,
    role_id: opts.role || null,
    message: opts.message || DEFAULT_MAINTENANCE_MESSAGE,
    weekday: recurrence.weekday,
    run_date: recurrence.run_date,
    time,
    timezone: 'UTC',
    kind: 'maintenance',
  });

  return reply(
    `Maintenance schedule **#${inserted[0].id}** created: **${dayLabel(recurrence)} ${time} UTC** in <#${opts.channel}>` +
      `${opts.role ? `, mentioning <@&${opts.role}>` : ''}` +
      `${mention ? ', mentioning you' : ''}.\n` +
      `Change the time later with \`/maintenance_schedule_update id:${inserted[0].id}\`.`,
  );
}

async function handleMaintenanceScheduleUpdate(interaction) {
  if (!interaction.guild_id) {
    return reply('This command can only be used in a server.');
  }
  const opts = optionsMap(interaction.data.options);
  const id = opts.id;

  const time = parseUtcTime(opts.time);
  if (!time) {
    return reply('Invalid time. Use 24-hour UTC HH:mm, e.g. 09:00 or 09:00 UTC.');
  }

  const rows = await getReminder(id, interaction.guild_id);
  const existing = rows[0];
  if (!existing) {
    return reply(`Maintenance schedule **#${id}** was not found in this server.`);
  }
  if (existing.kind !== 'maintenance') {
    return reply(
      `**#${id}** is a regular reminder, not a maintenance schedule. Create one with \`/maintenance_schedule\`.`,
    );
  }

  if (existing.run_date) {
    if (existing.is_active === false) {
      return reply(
        `Maintenance schedule **#${id}** is one-time and was already sent or has passed, so it can't be changed. ` +
          'Create a new one with `/maintenance_schedule`.',
      );
    }
    const [hour, minute] = time.split(':').map(Number);
    const moment = DateTime.fromISO(String(existing.run_date).slice(0, 10), { zone: 'UTC' }).set({ hour, minute });
    if (moment <= DateTime.utc()) {
      return reply(`${String(existing.run_date).slice(0, 10)} ${time} UTC has already passed. Choose a later time.`);
    }
  }

  const updated = await updateMaintenanceTime(id, interaction.guild_id, time);
  if (!updated) {
    return reply(`Maintenance schedule **#${id}** was not found in this server.`);
  }
  return reply(
    `Maintenance schedule **#${id}** updated: **${dayLabel(existing)} ${time} UTC** ` +
      `(was ${existing.reminder_time} ${existing.timezone}).`,
  );
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    return res.end('Method Not Allowed');
  }

  const rawBody = await getRawBody(req);
  const ok = verifySignature(
    rawBody,
    req.headers['x-signature-ed25519'],
    req.headers['x-signature-timestamp'],
    process.env.DISCORD_PUBLIC_KEY,
  );
  if (!ok) {
    res.statusCode = 401;
    return res.end('invalid request signature');
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.statusCode = 400;
    return res.end('bad request');
  }

  let payload;
  try {
    if (interaction.type === 1) {
      payload = { type: 1 }; // PING
    } else if (
      interaction.type === 2 &&
      interaction.data &&
      interaction.data.name === 'reminder'
    ) {
      payload = await handleReminder(interaction);
    } else if (
      interaction.type === 2 &&
      interaction.data &&
      interaction.data.name === 'find_schedule'
    ) {
      payload = handleFindSchedule(interaction);
    } else if (
      interaction.type === 2 &&
      interaction.data &&
      interaction.data.name === 'maintenance_schedule'
    ) {
      payload = await handleMaintenanceSchedule(interaction);
    } else if (
      interaction.type === 2 &&
      interaction.data &&
      interaction.data.name === 'maintenance_schedule_update'
    ) {
      payload = await handleMaintenanceScheduleUpdate(interaction);
    } else {
      payload = reply('Unsupported interaction.');
    }
  } catch (error) {
    console.error('Interaction failed:', error);
    payload = reply('Something went wrong. Check the Vercel function logs.');
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};
