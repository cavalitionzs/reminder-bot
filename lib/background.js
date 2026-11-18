// Runs work after the HTTP response has been sent (Discord needs an answer
// within 3s; the real work finishes later via a follow-up message).
// On Vercel, waitUntil keeps the function alive until the promise settles.
let vercelWaitUntil = null;
try {
  ({ waitUntil: vercelWaitUntil } = require('@vercel/functions'));
} catch {
  /* running locally / in tests */
}

const pending = new Set();

function runInBackground(promise) {
  const task = Promise.resolve(promise)
    .catch((err) => console.error('Background task failed:', err))
    .finally(() => pending.delete(task));
  pending.add(task);
  try {
    if (vercelWaitUntil) vercelWaitUntil(task);
  } catch {
    /* no request context available */
  }
  return task;
}

// Mainly for tests: resolves when every background task has finished.
async function idle() {
  while (pending.size) await Promise.all([...pending]);
}

module.exports = { runInBackground, idle };
