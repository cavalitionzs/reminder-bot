# Discord Reminder Bot, Serverless version (Vercel + external cron)

A weekly reminder bot that runs **entirely on Vercel**, with no server or always-on process.

## How it works

| Part | Endpoint | Purpose |
|---|---|---|
| Slash commands | `POST /api/interactions` | Discord sends a webhook for every `/reminder ...` command. The signature is verified with the **Public Key**. |
| Reminder delivery | `GET /api/cron` | Called **every minute** by a free external cron service (cron-job.org). It checks which reminders are due and sends them through the Discord REST API. |
| Database | PostgreSQL (Vercel/Prisma/Neon, etc.) | Same as before. |

There is no Gateway connection, so the bot shows as **offline** in the member list, but slash commands and reminders work normally.

Why an external cron: the built-in Vercel cron on the Hobby plan may only run once a day, which is not suitable for precisely timed reminders.

## Differences from the old version

- No `client.login()`, `node-cron`, or PM2.
- **Catch-up window (`CATCHUP_MINUTES`, default 5):** if a cron call is late or skipped for a minute, the reminder is still sent as long as it is within the window. A 23:59 reminder is still sent if the call only arrives after midnight.
- **Atomic anti-duplicate:** a reminder is "claimed" in the database before it is sent, so two overlapping cron calls can never send it twice. If sending fails, the claim is released and retried on the next minute.
- The timestamp in the message uses the **actual scheduled time**, not the time the message was sent.
- `/reminder list` now also shows the mentioned role.

## Maintenance Schedule feature

Three additional slash commands (registered together with `/reminder` by `npm run deploy-commands`):

| Command | Purpose |
|---|---|
| `/find_schedule` | Reads the Notices tab of The Seven Deadly Sins: Origin using the logic in `lib/maintenance_checker.js`, finds the **Maintenance Schedule** article, and replies with the hour the maintenance **ends**, e.g. `09:00 UTC`. The reply is a "thinking..." message that is replaced by the result, because reading the site can take longer than Discord's 3-second limit. |
| `/maintenance_schedule` | Adds a weekly reminder for a maintenance schedule. Options: `weekday`, `time` (**UTC**, e.g. `09:00`; `09:00 UTC` is also accepted), `channel`, then optional `message`, `role`, `mention`. |
| `/maintenance_schedule_update` | Changes the time (UTC) of an existing maintenance schedule. Options: `id` and `time`. Only works for schedules created with `/maintenance_schedule`, not for regular reminders. |

Notes:
- Maintenance schedules are stored in the `reminders` table with the column `kind = 'maintenance'` and timezone `UTC`, so they are delivered by the same `/api/cron`. Their IDs appear in `/reminder list` (marked with 🔧) and they can be removed with `/reminder delete`.
- When the time is changed, the "already sent today" marker is reset so the new time can still fire on the same day.
- `vercel.json` gives `api/interactions.js` a 60-second duration limit for `/find_schedule`.
- **After updating: run `npm install`, `npm run setup-db` (adds the `kind` column), then `npm run deploy-commands`, and redeploy.** Without `setup-db`, `/reminder list` and `/maintenance_schedule` will fail because the `kind` column does not exist yet.
- If `/find_schedule` returns `Access Denied`, the site's server is rejecting requests from Vercel's IPs; see the message in `lib/maintenance_checker.js`. The `DETAIL_URL_TEMPLATE` environment variable is still supported.

## Setup steps

### 1. Prepare the database
On your computer (needs `.env`, see step 2):
```bash
npm install
npm run setup-db
```
This creates the `reminders` table (including `role_id` and `kind`). It is safe to run again, and it also adds the `role_id` and `kind` columns to an older table.

### 2. Fill in the local `.env`
Copy `.env.example` to `.env` and fill it in. Generate `CRON_SECRET` with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
`DISCORD_PUBLIC_KEY` is in the Developer Portal under **General Information → Public Key**.

### 3. Deploy to Vercel
1. Put the whole contents of this folder in the GitHub repository connected to your Vercel project (replacing the old contents). **Do not commit `.env`.**
2. In Vercel: **Project → Settings → Environment Variables**, add:
   `DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DATABASE_URL`, `CRON_SECRET`, `CATCHUP_MINUTES` (optional), `DEFAULT_TIMEZONE`.
   (`CLIENT_ID` and `GUILD_ID` are only used locally to register commands.)
3. Make sure **Framework Preset = Other** and the Root Directory points to this folder.
4. Redeploy after saving the environment variables.

### 4. Connect Discord to Vercel
1. Developer Portal → your application → **General Information** → **Interactions Endpoint URL**.
2. Enter `https://YOUR-PROJECT.vercel.app/api/interactions` and click **Save Changes**.
3. Discord immediately sends a test (PING). If a success message appears, the endpoint is correct.

Register the commands (only once, or whenever `lib/commands.js` changes):
```bash
npm run deploy-commands
```

> Once the Interactions Endpoint URL is set, Discord no longer sends interactions through the Gateway. **Turn off the old bot** (PM2 or `npm start` on a PC) so there are not two processes.

### 5. Set up the external cron (free)
Example with https://cron-job.org (free, minimum interval of one minute, supports custom headers):

1. Create an account, then **Create cronjob**.
2. **URL:** `https://YOUR-PROJECT.vercel.app/api/cron`
3. **Schedule:** every 1 minute.
4. Tab **Advanced → Headers**, add: `Authorization` = `Bearer YOUR_CRON_SECRET`
5. Method **GET**, save, then click **Test run**. A correct result looks like:
   ```json
   {"checked":9,"sent":[],"skipped":0,"errors":[]}
   ```
   (`sent` is only filled when a reminder is due.)

If your service does not support custom headers, use `https://.../api/cron?secret=YOUR_CRON_SECRET`. The header is safer because URLs may be written to logs.

## Testing

```bash
npm test
```
Runs 32 offline checks (no database and no Discord): signature verification, command parsing, schedule logic (including past midnight and timezones), cron authentication, anti-duplicate, retry, and the maintenance schedule commands.

Manual test of the cron endpoint from a terminal:
```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://YOUR-PROJECT.vercel.app/api/cron
```

## Troubleshooting

| Symptom | Cause and solution |
|---|---|
| Discord rejects the Interactions Endpoint URL | `DISCORD_PUBLIC_KEY` is not set or you have not redeployed. Or Vercel's **Deployment Protection** is blocking the request: open Settings → Deployment Protection and turn off Vercel Authentication for production. Check with `curl -X POST https://.../api/interactions`; the result must be `invalid request signature`, not an HTML login page. |
| `The application did not respond` | Discord needs a reply within 3 seconds. Check **Vercel → Logs**. Usually `DATABASE_URL` is wrong or the database is slow on a cold start. Try again; the second request is usually faster. |
| `/reminder` does not appear | Run `npm run deploy-commands`, then restart Discord (Ctrl+R). |
| `/find_schedule` stays on "thinking..." or returns an error | Check **Vercel → Logs**. `Access Denied` means the notice site rejected the request. A timeout means the site was too slow (the lookup is cut off after 45 seconds). |
| Cron test run returns 401 | The `Authorization` header is wrong or `CRON_SECRET` on Vercel is different. Redeploy after changing an environment variable. |
| Cron returns 500 `CRON_SECRET is not configured` | The environment variable is not set on Vercel. |
| `errors` contains `Discord API 403` | The bot lacks **View Channel** and **Send Messages** permission in that channel. |
| `errors` contains `Discord API 404` | The channel was deleted or the ID is wrong. |
| A role does not trigger a notification | Enable **Allow anyone to @mention this role** on that role, or give the bot's role the **Mention @everyone, @here, and All Roles** permission. |
| Reminder is a few minutes late | Accuracy depends on the external cron service. The message still shows the correct scheduled time. Increase `CATCHUP_MINUTES` if reminders are often missed. |

## Notes

- Vercel Hobby is for non-commercial use only.
- cron-job.org limits each request to a 30-second timeout; this function finishes well within that.
- One thing remains outside our control: if the external cron service is down for longer than `CATCHUP_MINUTES`, reminders in that period are missed and are not sent afterwards.
- **Security:** do not commit `.env`. If the bot token or connection string was ever shared (for example uploaded to a chat or a public repo), reset it immediately.
