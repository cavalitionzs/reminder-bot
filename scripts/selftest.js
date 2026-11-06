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
    getActiveReminders: async () => store.reminders.map((r) => ({ ...r })),
    addReminder: async (r) => {
      const row = { id: String(store.nextId++), user_id: null, role_id: null, last_sent_date: null, ...r, reminder_time: r.time };
      store.reminders.push(row);
      return [{ id: row.id }];
    },
    listReminders: async (g) => store.reminders.filter((r) => r.guild_id === g),
    deleteReminder: async (id, g) => {
      const n = store.reminders.length;
      store.reminders = store.reminders.filter((r) => !(r.id === String(id) && r.guild_id === g));
      return n - store.reminders.length;
    },
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

const { verifySignature } = require('../lib/discord');
const { dueOccurrence } = require('../lib/schedule');
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
    assert.strictEqual(out.data.embeds[0].title, 'Weekly reminders');
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

  console.log(`\nAll ${passed} checks passed.`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
