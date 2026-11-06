const { Pool, types } = require('pg');

// DATE columns are returned as "YYYY-MM-DD" strings (not Date objects).
types.setTypeParser(1082, (value) => value);

let pool;

function getPool() {
  if (pool) return pool;
  const connectionString =
    process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error('Missing DATABASE_URL (or POSTGRES_URL).');
  }
  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
  pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    // Serverless: one connection per function instance is enough.
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
  });
  return pool;
}

async function query(text, params) {
  const result = await getPool().query(text, params);
  return result.rows;
}

function getActiveReminders() {
  return query(`
    SELECT id, guild_id, channel_id, user_id, role_id, message, weekday,
           reminder_time, timezone, last_sent_date
    FROM reminders
    WHERE is_active = TRUE
  `);
}

function addReminder(r) {
  return query(
    `INSERT INTO reminders
       (guild_id, channel_id, user_id, role_id, message, weekday, reminder_time, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [r.guild_id, r.channel_id, r.user_id, r.role_id, r.message, r.weekday, r.time, r.timezone],
  );
}

function listReminders(guildId) {
  return query(
    `SELECT id, channel_id, user_id, role_id, message, weekday, reminder_time,
            timezone, created_at
     FROM reminders
     WHERE guild_id = $1 AND is_active = TRUE
     ORDER BY weekday, reminder_time`,
    [guildId],
  );
}

async function deleteReminder(id, guildId) {
  const rows = await query(
    `DELETE FROM reminders WHERE id = $1 AND guild_id = $2 RETURNING id`,
    [id, guildId],
  );
  return rows.length;
}

// Atomically "claim" a reminder for a local date. Returns true only for the
// invocation that wins, so two overlapping cron calls can never both send.
async function claimReminder(id, localDate) {
  const rows = await query(
    `UPDATE reminders
        SET last_sent_date = $2
      WHERE id = $1 AND last_sent_date IS DISTINCT FROM $2::date
      RETURNING id`,
    [id, localDate],
  );
  return rows.length > 0;
}

// Undo a claim when sending failed, so the next cron call can retry.
async function releaseClaim(id, previousDate) {
  await query(`UPDATE reminders SET last_sent_date = $2 WHERE id = $1`, [
    id,
    previousDate || null,
  ]);
}

module.exports = {
  getActiveReminders,
  addReminder,
  listReminders,
  deleteReminder,
  claimReminder,
  releaseClaim,
};
