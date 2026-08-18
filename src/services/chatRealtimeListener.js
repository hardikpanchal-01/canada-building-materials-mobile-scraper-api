/**
 * Chat realtime listener
 *
 * Subscribes to `public.chat_messages` INSERT events on every distinct tenant
 * the database project, then fans out FCM via chatService.notifyChatMessage.
 *
 * Tenants are configured by env in TENANT_DB_CONFIGS (JSON array). The shared
 * DATABASE_URL/DATABASE_URL pair is auto-included as a fallback so
 * single-project deployments work with no extra config.
 *
 * Example TENANT_DB_CONFIGS value:
 *   [
 *     {"label":"shared","url":"https://lwplbyltqsfmfvsgmrjq.the database.co","service_key":"...","subdomains":["dolese","hercules","preferredmaterials","sws"]},
 *     {"label":"concretesupply","url":"https://dqyhmnqrudybmkewwbku.the database.co","service_key":"...","subdomains":["concretesupply"]},
 *     {"label":"delta","url":"https://etsemwbkyzwfhfktkndy.the database.co","service_key":"...","subdomains":["delta"]},
 *     {"label":"sunrise","url":"https://ibziwfnjfwizjazfxntv.the database.co","service_key":"...","subdomains":["sunrise"]}
 *   ]
 *
 * The "subdomains" field is informational only — the listener does not need
 * to resolve a per-message subdomain since the mobile tenant-switch is opt-in.
 */

const pg = require('pg');
const { getDb } = require('../config/database.js');
const chatService = require('./chatService');

const channels = [];
const clients = [];

function loadTenantConfigs() {
  const configs = [];

  if (process.env.TENANT_DB_CONFIGS) {
    try {
      const parsed = JSON.parse(process.env.TENANT_DB_CONFIGS);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && entry.url && entry.service_key) {
            configs.push({
              label: entry.label || entry.url,
              url: entry.url,
              service_key: entry.service_key,
              subdomains: Array.isArray(entry.subdomains) ? entry.subdomains : [],
            });
          }
        }
      }
    } catch (err) {
      console.error('[ChatRealtime] TENANT_DB_CONFIGS parse error:', err.message);
    }
  }

  // Auto-include the primary DATABASE_URL if not already present
  if (process.env.DATABASE_URL) {
    const exists = configs.find((c) => c.connectionString === process.env.DATABASE_URL);
    if (!exists) {
      configs.push({
        label: 'primary',
        connectionString: process.env.DATABASE_URL,
        subdomains: [],
      });
    }
  }

  return configs;
}

function buildPreview(text, attachments) {
  if (text && text.trim().length > 0) {
    return text.length > 120 ? `${text.substring(0, 119)}…` : text;
  }
  if (Array.isArray(attachments) && attachments.length > 0) {
    return 'Sent an attachment';
  }
  return '';
}

async function fetchActiveRecipients(db, senderId) {
  const { data, error } = await db
    .from('users')
    .select('id')
    .eq('active', true);

  if (error) {
    console.error(
      '[ChatRealtime] failed to load recipients:',
      error.message,
    );
    return [];
  }

  return (data || [])
    .map((u) => u.id)
    .filter((id) => id && id !== senderId);
}

async function fetchOrderMeta(db, orderId) {
  const { data, error } = await db
    .from('orders')
    .select('order_id, order_code, order_date, customer_name')
    .eq('order_id', orderId)
    .maybeSingle();

  if (error) {
    console.error(
      '[ChatRealtime] failed to load order meta:',
      error.message,
    );
    return null;
  }
  return data || null;
}

async function handleInsert(config, payload) {
  const row = payload?.new;
  if (!row) return;
  if (row.is_deleted === true) return;
  if (!row.sender_id || !row.order_id) return;

  try {
    const db = getDb();

    const [recipients, orderMeta] = await Promise.all([
      fetchActiveRecipients(db, row.sender_id),
      fetchOrderMeta(db, row.order_id),
    ]);

    if (recipients.length === 0) {
      console.log(
        `[ChatRealtime][${config.label}] order=${row.order_id} sender=${row.sender_id} -> no recipients`,
      );
      return;
    }

    const orderCode = orderMeta?.order_code || String(row.order_id);

    const result = await chatService.notifyChatMessage({
      order_id: row.order_id,
      order_code: orderCode,
      chat_id: row.chat_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name || '',
      message_preview: buildPreview(row.message_text, row.attachments),
      tenant_subdomain:
        config.subdomains && config.subdomains.length === 1
          ? config.subdomains[0]
          : '',
      recipient_user_ids: recipients,
      order_date: orderMeta?.order_date || '',
      customer_name: orderMeta?.customer_name || '',
    });

    console.log(
      `[ChatRealtime][${config.label}] order=${orderCode} (id=${row.order_id}) -> ${result.successCount}/${result.tokenCount || 0} pushed (failures: ${result.failureCount}, recipients: ${result.recipientCount}, skipped: ${result.skipped || 'no'})`,
    );
  } catch (err) {
    console.error(
      `[ChatRealtime][${config.label}] handler error:`,
      err.message,
    );
  }
}

async function fetchOrderEntityMeta(db, orderEntityId) {
  const { data, error } = await db
    .from('order_entities')
    .select('id, job_name, company_name, on_job_date')
    .eq('id', orderEntityId)
    .maybeSingle();

  if (error) {
    console.error(
      '[ChatRealtime] failed to load order_entity meta:',
      error.message,
    );
    return null;
  }
  return data || null;
}

async function handleOrderEntityInsert(config, payload) {
  const row = payload?.new;
  if (!row) return;
  if (!row.sender_id || !row.order_entity_id) return;

  try {
    const db = getDb();

    const [recipients, meta] = await Promise.all([
      fetchActiveRecipients(db, row.sender_id),
      fetchOrderEntityMeta(db, row.order_entity_id),
    ]);

    if (recipients.length === 0) {
      console.log(
        `[ChatRealtime][${config.label}] order_entity=${row.order_entity_id} sender=${row.sender_id} -> no recipients`,
      );
      return;
    }

    const result = await chatService.notifyOrderEntityMessage({
      order_entity_id: row.order_entity_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name || '',
      message_preview: buildPreview(row.message_text, null),
      tenant_subdomain:
        config.subdomains && config.subdomains.length === 1
          ? config.subdomains[0]
          : '',
      recipient_user_ids: recipients,
      job_name: meta?.job_name || '',
      company_name: meta?.company_name || '',
      on_job_date: meta?.on_job_date || '',
    });

    console.log(
      `[ChatRealtime][${config.label}] order_request=${row.order_entity_id} -> ${result.successCount}/${result.tokenCount || 0} pushed (failures: ${result.failureCount}, recipients: ${result.recipientCount}, skipped: ${result.skipped || 'no'})`,
    );
  } catch (err) {
    console.error(
      `[ChatRealtime][${config.label}] order entity handler error:`,
      err.message,
    );
  }
}

function subscribeOne(config) {
  // Transport: a dedicated Postgres LISTEN connection.
  //
  // This used to open a hosted realtime websocket per tenant project. Realtime
  // now arrives as LISTEN/NOTIFY on the `realtime_changes` channel, which a
  // trigger publishes to.
  //
  // NOTE: the trigger currently covers only some tables. Until one exists for
  // `chat_messages` and `order_entity_messages`, this connection stays open but
  // receives nothing — the same practical state as before, since the listener is
  // disabled by CHAT_REALTIME_DISABLED. Adding the trigger switches it on with
  // no code change here.
  const connectionString =
    config.connectionString || process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn(
      `[ChatRealtime][${config.label}] no DATABASE_URL — listener not started`,
    );
    return;
  }

  const client = new pg.Client({
    connectionString,
    ssl:
      process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  clients.push(client);

  const WATCHED = {
    chat_messages: (payload) => handleInsert(config, payload),
    order_entity_messages: (payload) => handleOrderEntityInsert(config, payload),
  };

  client
    .connect()
    .then(() => client.query("LISTEN realtime_changes"))
    .then(() => {
      console.log(`[ChatRealtime][${config.label}] listening on realtime_changes`);
    })
    .catch((err) => {
      console.error(
        `[ChatRealtime][${config.label}] LISTEN failed:`,
        err.message,
      );
    });

  client.on('notification', (msg) => {
    let event;
    try {
      event = JSON.parse(msg.payload);
    } catch {
      return;
    }
    if (event.type !== 'INSERT') return;
    const handler = WATCHED[event.table];
    if (!handler) return;
    // Match the payload shape the handlers already expect.
    handler({ new: event.new, old: event.old });
  });

  client.on('error', (err) => {
    console.error(`[ChatRealtime][${config.label}] connection error:`, err.message);
  });
}

function startChatRealtimeListener() {
  // Kill switch — set CHAT_REALTIME_DISABLED=true on whichever backend you
  // don't want firing FCM (e.g. disable on production while testing locally,
  // or vice versa) to avoid double-pushes when prod + local share a the database.
  if (
    process.env.CHAT_REALTIME_DISABLED === 'true' ||
    process.env.CHAT_REALTIME_DISABLED === '1'
  ) {
    console.log(
      '[ChatRealtime] CHAT_REALTIME_DISABLED is set — listener will not start',
    );
    return;
  }

  let configs = loadTenantConfigs();
  if (configs.length === 0) {
    console.warn(
      '[ChatRealtime] no database configs found — listener disabled',
    );
    return;
  }

  // Per-project disable — comma-separated list of labels (e.g. "primary,sunrise")
  // matching the `label` field in TENANT_DB_CONFIGS (auto-included primary uses
  // label "primary"). Use this when one tenant's prod backend already fires FCM
  // (so local should skip it) but other tenants' prod is down (local must fire).
  const disabledRaw = process.env.CHAT_REALTIME_DISABLED_PROJECTS;
  if (disabledRaw) {
    const disabledLabels = new Set(
      disabledRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const before = configs.length;
    configs = configs.filter((c) => !disabledLabels.has(c.label));
    const skipped = before - configs.length;
    if (skipped > 0) {
      console.log(
        `[ChatRealtime] CHAT_REALTIME_DISABLED_PROJECTS skipped ${skipped} project(s): ${[...disabledLabels].join(', ')}`,
      );
    }
  }

  if (configs.length === 0) {
    console.warn(
      '[ChatRealtime] all configured projects are disabled — listener will not start',
    );
    return;
  }

  console.log(
    `[ChatRealtime] starting listener for ${configs.length} tenant database(s)`,
  );
  for (const cfg of configs) {
    subscribeOne(cfg);
  }
}

async function stopChatRealtimeListener() {
  console.log('[ChatRealtime] stopping listener…');
  await Promise.allSettled(
    clients.map((c) =>
      c.end().catch((err) =>
        console.error('[ChatRealtime] disconnect error:', err.message),
      ),
    ),
  );
  channels.length = 0;
  clients.length = 0;
}

module.exports = {
  startChatRealtimeListener,
  stopChatRealtimeListener,
};
