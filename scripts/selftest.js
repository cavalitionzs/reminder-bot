// Offline self-test: no database, no Discord. Run with `npm test`.
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');
const { DateTime } = require('luxon');

// ---- Ed25519 keypair standing in for Discord's key ----
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
process.env.DISCORD_PUBLIC_KEY = pubHex;
process.env.CRON_SECRET = 'test-secret';
process.env.DISCORD_TOKEN = 'fake-token';

// ---- In-memory fake of lib/db.js ----
const store = { reminders: [], nextId: 1 };
const dbPath = require.resolve('../lib/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    getActiveReminders: async () => store.reminders.filter((r) => r.is_active !== false).map((r) => ({ ...r })),
    addReminder: async (r) => {
      const row = { id: String(store.nextId++), user_id: null, role_id: null, last_sent_date: null, kind: 'reminder', run_date: null, is_active: true, ...r, reminder_time: r.time };
      store.reminders.push(row);
      return [{ id: row.id }];
    },
    listReminders: async (g) => store.reminders.filter((r) => r.guild_id === g && r.is_active !== false),
    deleteReminder: async (id, g) => {
      const n = store.reminders.length;
      store.reminders = store.reminders.filter((r) => !(r.id === String(id) && r.guild_id === g));
      return n - store.reminders.length;
    },
    getReminder: async (id, g) => store.reminders.filter((r) => r.id === String(id) && r.guild_id === g).map((r) => ({ ...r })),
    updateMaintenanceTime: async (id, g, time) => {
      const r = store.reminders.find((x) => x.id === String(id) && x.guild_id === g && x.kind === 'maintenance' && x.is_active !== false);
      if (!r) return 0;
      r.reminder_time = time; r.timezone = 'UTC'; r.last_sent_date = null; return 1;
    },
    deactivateReminder: async (id) => { store.reminders.find((x) => x.id === String(id)).is_active = false; },
    claimReminder: async (id, d) => {
      const r = store.reminders.find((x) => x.id === String(id));
      if (!r || r.last_sent_date === d) return false;
      r.last_sent_date = d; return true;
    },
    releaseClaim: async (id, prev) => {
      store.reminders.find((x) => x.id === String(id)).last_sent_date = prev;
    },
  },
};

// ---- Fake Discord REST ----
const sentMessages = [];
let failNextSend = false;
global.fetch = async (url, init) => {
  if (failNextSend) { failNextSend = false; return { ok: false, status: 500, text: async () => 'boom' }; }
  sentMessages.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, json: async () => ({ id: '1' }) };
};

let lookup = async () => ({ found: false });
const maintPath = require.resolve('../lib/maintenance');
const realMaint = require('../lib/maintenance');
require.cache[maintPath].exports = { ...realMaint, findSchedule: (...a) => lookup(...a) };
const background = require('../lib/background');

const { verifySignature } = require('../lib/discord');
const { dueOccurrence, isExpiredOnce, parseDateInput } = require('../lib/schedule');
const interactions = require('../api/interactions');
const cron = require('../api/cron');

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b || ''; this.done = true; },
  };
}
function signed(body, { tamper = false } = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify(body);
  const sig = crypto.sign(null, Buffer.from(ts + raw), privateKey).toString('hex');
  const req = Readable.from([Buffer.from(tamper ? raw + ' ' : raw)]);
  req.method = 'POST';
  req.headers = { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts };
  return req;
}
const cmd = (name, options) => ({
  type: 2, guild_id: 'G1', member: { user: { id: 'U1' } },
  data: { name: 'reminder', options: [{ name, type: 1, options }] },
});

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok  -', name); }

(async () => {
  console.log('Signature');
  await t('valid signature accepted', async () => {
    const ts = '123'; const raw = '{"a":1}';
    const sig = crypto.sign(null, Buffer.from(ts + raw), privateKey).toString('hex');
    assert.ok(verifySignature(Buffer.from(raw), sig, ts, pubHex));
  });
  await t('tampered body rejected', async () => {
    const ts = '123';
    const sig = crypto.sign(null, Buffer.from(ts + '{"a":1}'), privateKey).toString('hex');
    assert.ok(!verifySignature(Buffer.from('{"a":2}'), sig, ts, pubHex));
  });
  await t('garbage input rejected (no throw)', async () => {
    assert.ok(!verifySignature(Buffer.from('x'), 'zz', '1', pubHex));
    assert.ok(!verifySignature(Buffer.from('x'), undefined, undefined, undefined));
  });

  console.log('Interactions endpoint');
  await t('PING answered with type 1', async () => {
    const res = mockRes(); await interactions(signed({ type: 1 }), res);
    assert.strictEqual(res.statusCode, 200); assert.deepStrictEqual(JSON.parse(res.body), { type: 1 });
  });
  await t('bad signature gets 401', async () => {
    const res = mockRes(); await interactions(signed({ type: 1 }, { tamper: true }), res);
    assert.strictEqual(res.statusCode, 401);
  });
  await t('/reminder add stores role + timezone', async () => {
    const res = mockRes();
    await interactions(signed(cmd('add', [
      { name: 'weekday', type: 3, value: '1' }, { name: 'time', type: 3, value: '02:00' },
      { name: 'channel', type: 7, value: 'C1' }, { name: 'message', type: 3, value: "Don't forget the raid!" },
      { name: 'timezone', type: 3, value: 'UTC' }, { name: 'role', type: 8, value: 'R1' },
    ])), res);
    const out = JSON.parse(res.body);
    assert.ok(out.data.content.includes('created'), out.data.content);
    assert.strictEqual(store.reminders[0].role_id, 'R1');
    assert.strictEqual(store.reminders[0].timezone, 'UTC');
  });
  await t('invalid time rejected', async () => {
    const res = mockRes();
    await interactions(signed(cmd('add', [
      { name: 'weekday', type: 3, value: '1' }, { name: 'time', type: 3, value: '25:99' },
      { name: 'channel', type: 7, value: 'C1' }, { name: 'message', type: 3, value: 'x' },
    ])), res);
    assert.ok(JSON.parse(res.body).data.content.startsWith('Invalid time'));
  });
  await t('invalid timezone rejected', async () => {
    const res = mockRes();
    await interactions(signed(cmd('add', [
      { name: 'weekday', type: 3, value: '1' }, { name: 'time', type: 3, value: '02:00' },
      { name: 'channel', type: 7, value: 'C1' }, { name: 'message', type: 3, value: 'x' },
      { name: 'timezone', type: 3, value: 'Mars/Base' },
    ])), res);
    assert.ok(JSON.parse(res.body).data.content.startsWith('Invalid timezone'));
  });
  await t('/reminder list returns an embed', async () => {
    const res = mockRes(); await interactions(signed(cmd('list', [])), res);
    const out = JSON.parse(res.body);
    assert.strictEqual(out.data.embeds[0].title, 'Reminders');
    assert.ok(out.data.embeds[0].description.includes('Mon 02:00'));
  });

  console.log('Schedule logic');
  const base = { weekday: 1, reminder_time: '02:00', timezone: 'UTC' };
  await t('due exactly on the minute', async () => {
    assert.ok(dueOccurrence(base, DateTime.fromISO('2026-11-09T02:00:00Z'), 5));
  });
  await t('still due 3 minutes late (cron delay)', async () => {
    assert.ok(dueOccurrence(base, DateTime.fromISO('2026-11-09T02:03:30Z'), 5));
  });
  await t('not due before, or after the window', async () => {
    assert.strictEqual(dueOccurrence(base, DateTime.fromISO('2026-11-09T01:59:59Z'), 5), null);
    assert.strictEqual(dueOccurrence(base, DateTime.fromISO('2026-11-09T02:05:00Z'), 5), null);
  });
  await t('wrong weekday not due', async () => {
    assert.strictEqual(dueOccurrence(base, DateTime.fromISO('2026-11-10T02:00:00Z'), 5), null);
  });
  await t('late-night reminder caught after midnight', async () => {
    const r = { weekday: 7, reminder_time: '23:59', timezone: 'UTC' }; // Sunday 23:59
    const due = dueOccurrence(r, DateTime.fromISO('2026-11-09T00:01:00Z'), 5); // Monday 00:01
    assert.ok(due); assert.strictEqual(due.localDate, '2026-11-08');
  });
  await t('timezone respected (Mon 02:00 UTC = Mon 09:00 WIB)', async () => {
    const wib = { weekday: 1, reminder_time: '09:00', timezone: 'Asia/Jakarta' };
    assert.ok(dueOccurrence(wib, DateTime.fromISO('2026-11-09T02:00:00Z'), 5));
  });

  console.log('Cron endpoint');
  const cronReq = (headers = {}, url = '/api/cron') => ({ method: 'GET', headers, url });
  RealDate = Date;
  const freeze = (iso) => { const t0 = new RealDate(iso).getTime(); Date.now = () => t0; };
  freeze('2026-11-09T02:00:20Z'); // Monday 02:00:20 UTC
  await t('no secret -> 401, nothing sent', async () => {
    const res = mockRes(); await cron(cronReq(), res);
    assert.strictEqual(res.statusCode, 401); assert.strictEqual(sentMessages.length, 0);
  });
  await t('wrong secret -> 401', async () => {
    const res = mockRes(); await cron(cronReq({ authorization: 'Bearer nope' }), res);
    assert.strictEqual(res.statusCode, 401);
  });
  await t('failed send releases claim, next call retries', async () => {
    failNextSend = true;
    const res = mockRes(); await cron(cronReq({ authorization: 'Bearer test-secret' }), res);
    assert.strictEqual(JSON.parse(res.body).errors.length, 1);
    assert.strictEqual(store.reminders[0].last_sent_date, null);
  });
  await t('correct secret sends once with role mention + timestamp', async () => {
    const res = mockRes(); await cron(cronReq({ authorization: 'Bearer test-secret' }), res);
    assert.deepStrictEqual(JSON.parse(res.body).sent, ['1']);
    const m = sentMessages[0];
    assert.ok(m.url.endsWith('/channels/C1/messages'));
    assert.ok(m.body.content.startsWith('<@&R1> '));
    const expected = Date.parse('2026-11-09T02:00:00Z') / 1000;
    assert.ok(m.body.content.includes(`<t:${expected}:F>`), m.body.content);
    assert.deepStrictEqual(m.body.allowed_mentions, { parse: [], roles: ['R1'], users: [] });
  });
  await t('second call in same window does NOT send again', async () => {
    const res = mockRes(); await cron(cronReq({}, '/api/cron?secret=test-secret'), res);
    assert.strictEqual(res.statusCode, 200); assert.strictEqual(sentMessages.length, 1);
  });
  await t('/reminder delete removes it', async () => {
    const res = mockRes();
    await interactions(signed(cmd('delete', [{ name: 'id', type: 4, value: 1 }])), res);
    assert.ok(JSON.parse(res.body).data.content.includes('deleted'));
  });

  console.log('Maintenance schedule feature');
  sentMessages.length = 0;
  const mcmd = (name, options, extra = {}) => ({
    type: 2, guild_id: 'G1', application_id: 'APP1', token: 'TOK1', member: { user: { id: 'U1' } },
    data: { name, options }, ...extra,
  });
  const run = async (body) => { const res = mockRes(); await interactions(signed(body), res); return JSON.parse(res.body); };

  await t('checker parses article text into end hour "09:00 UTC"', async () => {
    const checker = require('../lib/maintenance_checker');
    const text = checker.htmlToText('<p>✦ Maintenance Schedule</p><p>- November 19 (Thu) 01:00 - 09:00 (UTC) (8 hours)</p>');
    const parsed = checker.parseSchedule(text, new Date('2026-11-18T05:00:00Z'));
    assert.strictEqual(parsed.end.toISOString(), '2026-11-19T09:00:00.000Z');
    assert.strictEqual(realMaint.formatUtcHour(parsed.end.toISOString()), '09:00 UTC');
  });
  await t('parseUtcTime accepts 9:00, "09:00 UTC", ISO; rejects junk', async () => {
    assert.strictEqual(realMaint.parseUtcTime('9:00'), '09:00');
    assert.strictEqual(realMaint.parseUtcTime('09:00 UTC'), '09:00');
    assert.strictEqual(realMaint.parseUtcTime('2026-11-19T09:00:00.000Z'), '09:00');
    assert.strictEqual(realMaint.parseUtcTime('24:00'), null);
    assert.strictEqual(realMaint.parseUtcTime('abc'), null);
  });
  await t('/find_schedule defers (type 5) then edits the reply with "09:00 UTC"', async () => {
    lookup = async () => ({ found: true, hour: '09:00 UTC', item: { title: 'Maintenance Notice (Version 1.2)', status: 'upcoming' } });
    const out = await run(mcmd('find_schedule', []));
    assert.strictEqual(out.type, 5);
    await background.idle();
    const m = sentMessages[sentMessages.length - 1];
    assert.ok(m.url.endsWith('/webhooks/APP1/TOK1/messages/@original'), m.url);
    assert.ok(m.body.content.startsWith('**09:00 UTC**'), m.body.content);
  });
  await t('/find_schedule reports when nothing is found', async () => {
    lookup = async () => ({ found: false });
    await run(mcmd('find_schedule', [])); await background.idle();
    assert.ok(sentMessages[sentMessages.length - 1].body.content.includes('No article'));
  });
  await t('/find_schedule reports lookup errors instead of hanging', async () => {
    lookup = async () => { throw new Error('Access Denied'); };
    const out = await run(mcmd('find_schedule', [])); await background.idle();
    assert.strictEqual(out.type, 5);
    assert.ok(sentMessages[sentMessages.length - 1].body.content.includes('Access Denied'));
  });
  await t('/maintenance_schedule creates a UTC maintenance row', async () => {
    store.reminders = [];
    const out = await run(mcmd('maintenance_schedule', [
      { name: 'time', type: 3, value: '9:00 UTC' },
      { name: 'channel', type: 7, value: 'C9' }, { name: 'role', type: 8, value: 'R9' },
    ]));
    assert.ok(out.data.content.includes('Every day 09:00 UTC'), out.data.content);
    const row = store.reminders[0];
    assert.strictEqual(row.weekday, null); assert.strictEqual(row.run_date, null);
    assert.strictEqual(row.kind, 'maintenance'); assert.strictEqual(row.timezone, 'UTC');
    assert.strictEqual(row.reminder_time, '09:00'); assert.ok(row.message.length > 0);
  });
  await t('/maintenance_schedule rejects invalid time', async () => {
    const out = await run(mcmd('maintenance_schedule', [
      { name: 'time', type: 3, value: '99:00' },
      { name: 'channel', type: 7, value: 'C9' },
    ]));
    assert.ok(out.data.content.startsWith('Invalid time'));
  });
  await t('/maintenance_schedule_update changes the UTC time by id', async () => {
    const id = Number(store.reminders[0].id);
    store.reminders[0].last_sent_date = '2026-11-19';
    const out = await run(mcmd('maintenance_schedule_update', [
      { name: 'id', type: 4, value: id }, { name: 'time', type: 3, value: '10:30' },
    ]));
    assert.ok(out.data.content.includes('Every day 10:30 UTC') && out.data.content.includes('was 09:00'), out.data.content);
    assert.strictEqual(store.reminders[0].reminder_time, '10:30');
    assert.strictEqual(store.reminders[0].last_sent_date, null);
  });
  await t('update: unknown id, invalid time, and regular reminder are refused', async () => {
    let out = await run(mcmd('maintenance_schedule_update', [{ name: 'id', type: 4, value: 999 }, { name: 'time', type: 3, value: '10:00' }]));
    assert.ok(out.data.content.includes('not found'));
    out = await run(mcmd('maintenance_schedule_update', [{ name: 'id', type: 4, value: 1 }, { name: 'time', type: 3, value: 'xx' }]));
    assert.ok(out.data.content.startsWith('Invalid time'));
    store.reminders.push({ id: '50', guild_id: 'G1', kind: 'reminder', weekday: 1, reminder_time: '02:00', timezone: 'UTC' });
    out = await run(mcmd('maintenance_schedule_update', [{ name: 'id', type: 4, value: 50 }, { name: 'time', type: 3, value: '10:00' }]));
    assert.ok(out.data.content.includes('regular reminder'));
    assert.strictEqual(store.reminders.find((r) => r.id === '50').reminder_time, '02:00');
  });
  await t('update cannot touch another server\'s schedule', async () => {
    const id = Number(store.reminders[0].id);
    const body = mcmd('maintenance_schedule_update', [{ name: 'id', type: 4, value: id }, { name: 'time', type: 3, value: '01:00' }], { guild_id: 'OTHER' });
    const out = await run(body);
    assert.ok(out.data.content.includes('not found'));
    assert.strictEqual(store.reminders[0].reminder_time, '10:30');
  });
  await t('cron fires the maintenance schedule at its UTC time', async () => {
    store.reminders = store.reminders.filter((r) => r.kind === 'maintenance');
    store.reminders[0].reminder_time = '09:00';
    sentMessages.length = 0;
    freeze('2026-11-19T09:00:10Z'); // Thursday
    const res = mockRes(); await cron(cronReq({ authorization: 'Bearer test-secret' }), res);
    assert.strictEqual(JSON.parse(res.body).sent.length, 1);
    assert.ok(sentMessages[0].body.content.startsWith('<@&R9> '));
  });

  console.log('Daily recurrence');
  await t('daily reminder (weekday null) is due on every weekday, not only one', async () => {
    const daily = { weekday: null, reminder_time: '09:00', timezone: 'UTC' };
    for (const day of ['09', '10', '11', '12', '13', '14', '15']) { // Mon..Sun
      assert.ok(dueOccurrence(daily, DateTime.fromISO(`2026-11-${day}T09:00:10Z`), 5), `day ${day}`);
    }
    assert.strictEqual(dueOccurrence(daily, DateTime.fromISO('2026-11-09T09:06:00Z'), 5), null);
  });
  await t('daily reminder at 23:59 is still caught after midnight', async () => {
    const daily = { weekday: null, reminder_time: '23:59', timezone: 'UTC' };
    const due = dueOccurrence(daily, DateTime.fromISO('2026-11-10T00:01:00Z'), 5);
    assert.ok(due); assert.strictEqual(due.localDate, '2026-11-09');
  });
  await t('weekly reminders are unchanged (still only their weekday)', async () => {
    const weekly = { weekday: 4, reminder_time: '09:00', timezone: 'UTC' }; // Thursday
    assert.ok(dueOccurrence(weekly, DateTime.fromISO('2026-11-19T09:00:10Z'), 5));
    assert.strictEqual(dueOccurrence(weekly, DateTime.fromISO('2026-11-20T09:00:10Z'), 5), null);
  });
  await t('/reminder add with "Every day" stores weekday null', async () => {
    store.reminders = [];
    const out = await run(mcmd('reminder', [{ name: 'add', type: 1, options: [
      { name: 'weekday', type: 3, value: 'daily' }, { name: 'time', type: 3, value: '08:00' },
      { name: 'channel', type: 7, value: 'C1' }, { name: 'message', type: 3, value: 'Standup' },
      { name: 'timezone', type: 3, value: 'UTC' },
    ] }]));
    assert.ok(out.data.content.includes('Every day 08:00'), out.data.content);
    assert.strictEqual(store.reminders[0].weekday, null);
  });
  await t('/reminder list shows daily reminders as "Daily"', async () => {
    const out = await run(mcmd('reminder', [{ name: 'list', type: 1, options: [] }]));
    assert.ok(out.data.embeds[0].description.includes('Daily 08:00'), out.data.embeds[0].description);
  });
  await t('/maintenance_schedule without a date is daily; update keeps it daily', async () => {
    store.reminders = [];
    let out = await run(mcmd('maintenance_schedule', [
      { name: 'time', type: 3, value: '09:00' },
      { name: 'channel', type: 7, value: 'C9' },
    ]));
    assert.ok(out.data.content.includes('Every day 09:00 UTC'), out.data.content);
    assert.strictEqual(store.reminders[0].weekday, null); assert.strictEqual(store.reminders[0].kind, 'maintenance');
    out = await run(mcmd('maintenance_schedule_update', [
      { name: 'id', type: 4, value: Number(store.reminders[0].id) }, { name: 'time', type: 3, value: '10:15' },
    ]));
    assert.ok(out.data.content.includes('Every day 10:15 UTC') && out.data.content.includes('was 09:00'), out.data.content);
    assert.strictEqual(store.reminders[0].weekday, null);
  });
  await t('cron sends a daily maintenance schedule on two different weekdays, once each', async () => {
    store.reminders[0].reminder_time = '09:00'; store.reminders[0].last_sent_date = null;
    sentMessages.length = 0;
    for (const iso of ['2026-11-17T09:00:10Z', '2026-11-17T09:01:10Z', '2026-11-20T09:00:10Z']) { // Tue, Tue again, Fri
      freeze(iso);
      const res = mockRes(); await cron(cronReq({ authorization: 'Bearer test-secret' }), res);
    }
    assert.strictEqual(sentMessages.length, 2); // Tue once (no duplicate), Fri once
  });

  console.log('One-time reminders');
  const addOpts = (o) => Object.entries(o).map(([name, value]) => ({ name, type: 3, value }));
  const remAdd = (o) => run(mcmd('reminder', [{ name: 'add', type: 1, options: addOpts(o) }]));
  freeze('2026-11-18T10:00:00Z'); // Wednesday

  await t('parseDateInput accepts ISO and "19 November 2026"; rejects junk', async () => {
    assert.strictEqual(parseDateInput('2026-11-19'), '2026-11-19');
    assert.strictEqual(parseDateInput('19 November 2026'), '2026-11-19');
    assert.strictEqual(parseDateInput('19 Nov 2026'), '2026-11-19');
    assert.strictEqual(parseDateInput('2026-02-30'), null);
    assert.strictEqual(parseDateInput('soon'), null);
  });
  await t('one-time reminder is due on its date only, not the next week', async () => {
    const once = { weekday: 4, run_date: '2026-11-19', reminder_time: '09:00', timezone: 'UTC' };
    assert.ok(dueOccurrence(once, DateTime.fromISO('2026-11-19T09:00:10Z'), 5));
    assert.strictEqual(dueOccurrence(once, DateTime.fromISO('2026-11-26T09:00:10Z'), 5), null);
    assert.strictEqual(dueOccurrence(once, DateTime.fromISO('2026-11-12T09:00:10Z'), 5), null);
  });
  await t('isExpiredOnce: only for one-time reminders past their window', async () => {
    const once = { weekday: 4, run_date: '2026-11-19', reminder_time: '09:00', timezone: 'UTC' };
    assert.ok(!isExpiredOnce(once, DateTime.fromISO('2026-11-19T09:03:00Z'), 5));
    assert.ok(isExpiredOnce(once, DateTime.fromISO('2026-11-19T09:06:00Z'), 5));
    assert.ok(!isExpiredOnce({ weekday: 4, run_date: null, reminder_time: '09:00', timezone: 'UTC' }, DateTime.fromISO('2030-01-01T00:00:00Z'), 5));
  });
  await t('/reminder add weekday:Friday (no date) stays weekly', async () => {
    store.reminders = [];
    const out = await remAdd({ weekday: '5', time: '07:35', channel: 'C1', message: 'testing', timezone: 'UTC' });
    assert.ok(out.data.content.includes('Every Friday 07:35'), out.data.content);
    assert.strictEqual(store.reminders[0].weekday, 5); assert.strictEqual(store.reminders[0].run_date, null);
  });
  await t('/reminder add with a date is one-time', async () => {
    const out = await remAdd({ weekday: '4', time: '09:00', channel: 'C1', message: 'once', timezone: 'UTC', date: '2026-11-19' });
    assert.ok(out.data.content.includes('Thursday 2026-11-19 (one-time) 09:00'), out.data.content);
    const row = store.reminders[1];
    assert.strictEqual(row.run_date, '2026-11-19'); assert.strictEqual(row.weekday, 4);
  });
  await t('date with the wrong weekday / Every day / past date / bad date are refused', async () => {
    const base = { time: '09:00', channel: 'C1', message: 'x', timezone: 'UTC' };
    let out = await remAdd({ ...base, weekday: '5', date: '2026-11-19' });
    assert.ok(out.data.content.includes('is a Thursday'), out.data.content);
    out = await remAdd({ ...base, weekday: 'daily', date: '2026-11-19' });
    assert.ok(out.data.content.includes('is a Thursday'), out.data.content);
    out = await remAdd({ ...base, weekday: '2', date: '2026-11-10' });
    assert.ok(out.data.content.includes('already passed'), out.data.content);
    out = await remAdd({ ...base, weekday: '4', date: 'soon' });
    assert.ok(out.data.content.startsWith('Invalid date'), out.data.content);
    assert.strictEqual(store.reminders.length, 2); // nothing extra was stored
  });
  await t('/reminder list labels weekly, and one-time entries', async () => {
    const out = await run(mcmd('reminder', [{ name: 'list', type: 1, options: [] }]));
    const d = out.data.embeds[0].description;
    assert.ok(d.includes('Every Fri 07:35') && d.includes('Thu 2026-11-19 (once) 09:00'), d);
  });
  await t('/maintenance_schedule one-time (user example: Thursday 19 November 2026 09:00 UTC)', async () => {
    store.reminders = [];
    const out = await run(mcmd('maintenance_schedule', addOpts({
      date: '19 November 2026', time: '09:00', channel: 'C9', message: 'Maintenance Update Complete!',
    })));
    assert.ok(out.data.content.includes('Thursday 2026-11-19 (one-time) 09:00 UTC'), out.data.content);
    const row = store.reminders[0];
    assert.strictEqual(row.run_date, '2026-11-19'); assert.strictEqual(row.timezone, 'UTC');
    assert.strictEqual(row.kind, 'maintenance'); assert.strictEqual(row.message, 'Maintenance Update Complete!');
  });
  await t('update of a one-time schedule: time changes, a past moment is refused', async () => {
    const id = Number(store.reminders[0].id);
    let out = await run(mcmd('maintenance_schedule_update', [{ name: 'id', type: 4, value: id }, { name: 'time', type: 3, value: '10:00' }]));
    assert.ok(out.data.content.includes('Thursday 2026-11-19 (one-time) 10:00 UTC'), out.data.content);
    freeze('2026-11-19T09:30:00Z');
    out = await run(mcmd('maintenance_schedule_update', [{ name: 'id', type: 4, value: id }, { name: 'time', type: 3, value: '08:00' }]));
    assert.ok(out.data.content.includes('already passed'), out.data.content);
    assert.strictEqual(store.reminders[0].reminder_time, '10:00');
    store.reminders[0].reminder_time = '09:00';
  });
  await t('cron sends the one-time reminder once, deactivates it, and never repeats next Thursday', async () => {
    sentMessages.length = 0;
    freeze('2026-11-19T09:00:10Z');
    let res = mockRes(); await cron(cronReq({ authorization: 'Bearer test-secret' }), res);
    assert.strictEqual(JSON.parse(res.body).sent.length, 1);
    assert.ok(sentMessages[0].body.content.startsWith('Maintenance Update Complete!'));
    assert.strictEqual(store.reminders[0].is_active, false);
    freeze('2026-11-26T09:00:10Z'); // next Thursday
    res = mockRes(); await cron(cronReq({ authorization: 'Bearer test-secret' }), res);
    assert.strictEqual(JSON.parse(res.body).sent.length, 0); assert.strictEqual(sentMessages.length, 1);
    const list = await run(mcmd('reminder', [{ name: 'list', type: 1, options: [] }]));
    assert.ok(list.data.content.startsWith('No active'), JSON.stringify(list));
  });
  await t('update refuses a one-time schedule that was already sent', async () => {
    const id = Number(store.reminders[0].id);
    const out = await run(mcmd('maintenance_schedule_update', [{ name: 'id', type: 4, value: id }, { name: 'time', type: 3, value: '11:00' }]));
    assert.ok(out.data.content.includes('already sent'), out.data.content);
  });
  await t('a missed one-time reminder is deactivated by cron instead of lingering', async () => {
    store.reminders = [{ id: '70', guild_id: 'G1', channel_id: 'C1', user_id: null, role_id: null, message: 'm', weekday: 4,
      run_date: '2026-11-19', reminder_time: '09:00', timezone: 'UTC', kind: 'reminder', is_active: true, last_sent_date: null }];
    sentMessages.length = 0;
    freeze('2026-11-19T12:00:00Z');
    const res = mockRes(); await cron(cronReq({ authorization: 'Bearer test-secret' }), res);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body.sent, []); assert.deepStrictEqual(body.expired, ['70']);
    assert.strictEqual(store.reminders[0].is_active, false); assert.strictEqual(sentMessages.length, 0);
  });

  console.log('Weekday optional when a date is given');
  freeze('2026-11-18T04:00:00Z'); // Wednesday
  await t('/maintenance_schedule date:2026-11-18 time:04:17 mention:True, no weekday (user example)', async () => {
    store.reminders = []; sentMessages.length = 0;
    const out = await run(mcmd('maintenance_schedule', [
      { name: 'date', type: 3, value: '2026-11-18' }, { name: 'time', type: 3, value: '04:17' },
      { name: 'channel', type: 7, value: 'C9' }, { name: 'message', type: 3, value: 'Testing' },
      { name: 'mention', type: 5, value: true },
    ]));
    assert.ok(out.data.content.includes('Wednesday 2026-11-18 (one-time) 04:17 UTC'), out.data.content);
    const row = store.reminders[0];
    assert.strictEqual(row.weekday, 3); assert.strictEqual(row.run_date, '2026-11-18');
    assert.strictEqual(row.user_id, 'U1'); assert.strictEqual(row.timezone, 'UTC');
  });
  await t('cron sends it at 04:17 UTC with the mention, then switches it off', async () => {
    freeze('2026-11-18T04:17:10Z');
    const res = mockRes(); await cron(cronReq({ authorization: 'Bearer test-secret' }), res);
    assert.strictEqual(JSON.parse(res.body).sent.length, 1);
    assert.ok(sentMessages[0].body.content.startsWith('<@U1> Testing'), sentMessages[0].body.content);
    assert.strictEqual(store.reminders[0].is_active, false);
  });
  await t('/reminder add also works with a date and no weekday', async () => {
    freeze('2026-11-18T04:00:00Z'); store.reminders = [];
    const out = await run(mcmd('reminder', [{ name: 'add', type: 1, options: addOpts({
      date: '2026-11-19', time: '09:00', channel: 'C1', message: 'x', timezone: 'UTC' }) }]));
    assert.ok(out.data.content.includes('Thursday 2026-11-19 (one-time)'), out.data.content);
    assert.strictEqual(store.reminders[0].weekday, 4);
  });
  await t('/reminder add with neither weekday nor date is refused with a clear message', async () => {
    store.reminders = [];
    const out = await run(mcmd('reminder', [{ name: 'add', type: 1, options: addOpts({ time: '09:00', channel: 'C1', message: 'x' }) }]));
    assert.ok(out.data.content.startsWith('Choose how this repeats'), out.data.content);
    assert.strictEqual(store.reminders.length, 0);
  });
  await t('/reminder add: date + a wrong weekday is refused; date + the right weekday works', async () => {
    let out = await remAdd({ weekday: '5', date: '2026-11-19', time: '09:00', channel: 'C1', message: 'x', timezone: 'UTC' });
    assert.ok(out.data.content.includes('is a Thursday'), out.data.content);
    out = await remAdd({ weekday: '4', date: '2026-11-19', time: '09:00', channel: 'C1', message: 'x', timezone: 'UTC' });
    assert.ok(out.data.content.includes('created'), out.data.content);
  });
  await t('/maintenance_schedule has no weekly mode: no weekday option, a stale weekday value is ignored', async () => {
    const cmd = require('../lib/commands').find((c) => c.name === 'maintenance_schedule');
    assert.ok(!cmd.options.some((o) => o.name === 'weekday'));
    assert.ok(require('../lib/commands').find((c) => c.name === 'reminder').options[0].options.some((o) => o.name === 'weekday'));
    store.reminders = [];
    const out = await run(mcmd('maintenance_schedule', addOpts({ weekday: '5', time: '09:00', channel: 'C9' })));
    assert.ok(out.data.content.includes('Every day 09:00 UTC'), out.data.content);
    assert.strictEqual(store.reminders[0].weekday, null);
  });

  console.log(`\nAll ${passed} checks passed.`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
