const { DateTime, IANAZone } = require('luxon');
const { verifySignature, getRawBody } = require('../lib/discord');
const { addReminder, listReminders, deleteReminder } = require('../lib/db');

const EPHEMERAL = 64; // MessageFlags.Ephemeral
const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    const weekday = Number(opts.weekday);
    const time = opts.time;
    const timezone = opts.timezone || defaultTimezone;
    const mention = opts.mention === true;

    if (!TIME_RE.test(time || '')) {
      return reply('Invalid time. Use 24-hour HH:mm, e.g. 02:00 or 18:30.');
    }
    if (!IANAZone.isValidZone(timezone)) {
      return reply(`Invalid timezone: ${timezone}. Example: Asia/Jakarta`);
    }

    const inserted = await addReminder({
      guild_id: guildId,
      channel_id: opts.channel,
      user_id: mention ? userId : null,
      role_id: opts.role || null,
      message: opts.message,
      weekday,
      time,
      timezone,
    });

    const weekdayName = DateTime.fromObject({ weekday })
      .setLocale('en')
      .toFormat('cccc');
    return reply(
      `Reminder **#${inserted[0].id}** created: **${weekdayName} ${time}** (${timezone}) in <#${opts.channel}>` +
        `${opts.role ? `, mentioning <@&${opts.role}>` : ''}` +
        `${mention ? ', mentioning you' : ''}.`,
    );
  }

  if (sub.name === 'list') {
    const rows = await listReminders(guildId);
    if (!rows.length) return reply('No active reminders in this server yet.');

    const lines = rows.map(
      (r) =>
        `**#${r.id}** · ${DAY_NAMES[Number(r.weekday)]} ${r.reminder_time} · ${r.timezone} · <#${r.channel_id}>` +
        `${r.role_id ? ` · role <@&${r.role_id}>` : ''}` +
        `${r.user_id ? ' · mention enabled' : ''}\n└ ${r.message}`,
    );

    return {
      type: 4,
      data: {
        flags: EPHEMERAL,
        embeds: [
          {
            title: 'Weekly reminders',
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
