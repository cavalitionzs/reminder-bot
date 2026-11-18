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
  -- 1-7 = weekly on that weekday, NULL = daily (run_date set = one-time)
  weekday SMALLINT CHECK (weekday BETWEEN 1 AND 7),
  reminder_time CHAR(5) NOT NULL
    CHECK (reminder_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- For tables created by the older version of this project:
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS role_id VARCHAR(30);

-- Daily reminders store weekday as NULL (also upgrades older tables).
ALTER TABLE reminders ALTER COLUMN weekday DROP NOT NULL;

-- One-time reminders store their date here (NULL = repeating).
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS run_date DATE;

-- 'reminder' = /reminder add, 'maintenance' = /maintenance_schedule
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'reminder';

CREATE INDEX IF NOT EXISTS idx_reminders_active
  ON reminders (is_active, guild_id, weekday, reminder_time);
`;

pool
  .query(sql)
  .then(() => console.log('Table "reminders" is ready (with role_id, kind, run_date, and nullable weekday).'))
  .catch((e) => {
    console.error('Failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
