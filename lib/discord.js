const crypto = require('crypto');

// Wraps a raw 32-byte Ed25519 public key (hex) in the SPKI DER prefix so
// Node's built-in crypto can use it. No extra dependency needed.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifySignature(rawBody, signature, timestamp, publicKeyHex) {
  try {
    if (!signature || !timestamp || !publicKeyHex) return false;
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]),
      key,
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

// Reads the raw request body. Needed because the signature is computed over
// the exact bytes Discord sent, not over re-serialized JSON.
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks);
  if (raw.length) return raw;
  // Fallback if a platform already consumed the stream.
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return Buffer.from('');
}

async function sendChannelMessage(channelId, payload) {
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (reminder-bot, 2.0.0)',
      },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Discord API ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

module.exports = { verifySignature, getRawBody, sendChannelMessage };
