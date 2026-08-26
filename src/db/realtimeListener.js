/**
 * Postgres LISTEN/NOTIFY realtime bus — the direct-Postgres replacement for the
 * old hosted realtime (`postgres_changes`) subscriptions.
 *
 * A dedicated (non-pooled) client holds a persistent connection and `LISTEN`s on
 * the `realtime_changes` channel. Per-table triggers running
 * `notify_realtime_change()` emit a JSON payload:
 *     { table, schema, type: 'INSERT'|'UPDATE'|'DELETE', new, old }
 * which is fanned out to registered handlers, matching the old subscription
 * filters (table + event).
 *
 * NOTE (runbook §5.1): LISTEN must run on a DIRECT connection, never through a
 * transaction-mode pooler, or NOTIFY is silently dropped. Pass a direct URL via
 * REALTIME_DATABASE_URL; otherwise DATABASE_URL is used with any `-pooler` host
 * rewritten to its direct form.
 */

const { Client } = require('pg');

const CHANNEL = 'realtime_changes';

function resolveDirectUrl() {
  const direct = process.env.REALTIME_DATABASE_URL;
  if (direct) return direct;
  const base = process.env.DATABASE_URL || process.env.DB_POOL_URL;
  if (!base) return null;
  // Rewrite a CNPG pooler host to its direct counterpart.
  return base.replace(/-rw-pooler\./, '-rw.');
}

function createRealtimeListener() {
  const handlers = []; // { table, event, cb }
  let client = null;
  let stopped = false;
  let reconnectTimer = null;

  async function connect() {
    const url = resolveDirectUrl();
    if (!url) {
      console.warn('[Realtime] no DATABASE_URL/REALTIME_DATABASE_URL — bus disabled');
      return;
    }
    client = new Client({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    });

    client.on('error', (err) => {
      console.error('[Realtime] client error:', err.message);
    });

    client.on('end', () => {
      if (!stopped) scheduleReconnect();
    });

    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      let payload;
      try {
        payload = JSON.parse(msg.payload);
      } catch (e) {
        return;
      }
      const table = payload.table;
      const type = payload.type;
      for (const h of handlers) {
        if (h.table === table && (!h.event || h.event === type)) {
          Promise.resolve()
            .then(() => h.cb(payload))
            .catch((e) => console.error('[Realtime] handler error:', e.message));
        }
      }
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    console.log(`[Realtime] LISTEN ${CHANNEL} established`);
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await connect();
      } catch (e) {
        console.error('[Realtime] reconnect failed:', e.message);
        scheduleReconnect();
      }
    }, 5000);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  return {
    /** Register a handler for `table` + optional `event` (INSERT/UPDATE/DELETE). */
    on(table, event, cb) {
      handlers.push({ table, event, cb });
      return this;
    },
    async start() {
      stopped = false;
      await connect();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (client) {
        try {
          await client.end();
        } catch (e) {
          /* ignore */
        }
        client = null;
      }
    },
  };
}

module.exports = { createRealtimeListener };
