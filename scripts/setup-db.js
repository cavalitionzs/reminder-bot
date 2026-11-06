require('dotenv').config();
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) throw new Error('Set DATABASE_URL in .env');

const pool = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
});

const sql = `
CREATE TABLE IF NOT EXISTS reminders (
  id BIGSERIAL PRIMARY KEY,
  guild_id VARCHAR(30) NOT NULL,
  channel_id VARCHAR(30) NOT NULL,
  user_id VARCHAR(30),
  role_id VARCHAR(30),
  message TEXT NOT NULL,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  reminder_time CHAR(5) NOT NULL
    CHECK (reminder_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- For tables created by the older version of this project:
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS role_id VARCHAR(30);

CREATE INDEX IF NOT EXISTS idx_reminders_active
  ON reminders (is_active, guild_id, weekday, reminder_time);
`;

pool
  .query(sql)
  .then(() => console.log('Table "reminders" is ready (with role_id).'))
  .catch((e) => {
    console.error('Failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
