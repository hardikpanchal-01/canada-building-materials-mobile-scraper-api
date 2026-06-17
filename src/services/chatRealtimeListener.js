/**
 * Chat realtime listener
 *
 * Subscribes to `public.chat_messages` INSERT events on every distinct tenant
 * Supabase project, then fans out FCM via chatService.notifyChatMessage.
 *
 * Tenants are configured by env in TENANT_SUPABASES (JSON array). The shared
 * SUPABASE_URL/SUPABASE_SERVICE_KEY pair is auto-included as a fallback so
 * single-project deployments work with no extra config.
 *
 * Example TENANT_SUPABASES value:
 *   [
 *     {"label":"shared","url":"https://lwplbyltqsfmfvsgmrjq.supabase.co","service_key":"...","subdomains":["dolese","hercules","preferredmaterials","sws"]},
 *     {"label":"concretesupply","url":"https://dqyhmnqrudybmkewwbku.supabase.co","service_key":"...","subdomains":["concretesupply"]},
 *     {"label":"delta","url":"https://etsemwbkyzwfhfktkndy.supabase.co","service_key":"...","subdomains":["delta"]},
 *     {"label":"sunrise","url":"https://ibziwfnjfwizjazfxntv.supabase.co","service_key":"...","subdomains":["sunrise"]}
 *   ]
 *
 * The "subdomains" field is informational only — the listener does not need
 * to resolve a per-message subdomain since the mobile tenant-switch is opt-in.
 */

const { createClient } = require('@supabase/supabase-js');
const chatService = require('./chatService');

const channels = [];
const clients = [];

function loadTenantConfigs() {
  const configs = [];

  if (process.env.TENANT_SUPABASES) {
    try {
      const parsed = JSON.parse(process.env.TENANT_SUPABASES);
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
      console.error('[ChatRealtime] TENANT_SUPABASES parse error:', err.message);
    }
  }

  // Auto-include the primary SUPABASE_URL if not already present
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const exists = configs.find((c) => c.url === process.env.SUPABASE_URL);
    if (!exists) {
      configs.push({
        label: 'primary',
        url: process.env.SUPABASE_URL,
        service_key: process.env.SUPABASE_SERVICE_KEY,
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

async function fetchActiveRecipients(supabase, senderId) {
  const { data, error } = await supabase
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

async function fetchOrderMeta(supabase, orderId) {
  const { data, error } = await supabase
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
    const supabase = createClient(config.url, config.service_key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const [recipients, orderMeta] = await Promise.all([
      fetchActiveRecipients(supabase, row.sender_id),
      fetchOrderMeta(supabase, row.order_id),
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

async function fetchOrderEntityMeta(supabase, orderEntityId) {
  const { data, error } = await supabase
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
    const supabase = createClient(config.url, config.service_key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const [recipients, meta] = await Promise.all([
      fetchActiveRecipients(supabase, row.sender_id),
      fetchOrderEntityMeta(supabase, row.order_entity_id),
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
  const client = createClient(config.url, config.service_key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  clients.push(client);

  // Order chat (chat_messages → orders)
  const chatChannel = client
    .channel(`chat-messages-watcher-${config.label}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'chat_messages' },
      (payload) => handleInsert(config, payload),
    )
    .subscribe((status, err) => {
      if (err) {
        console.error(
          `[ChatRealtime][${config.label}] chat_messages subscribe error:`,
          err.message || err,
        );
      } else {
        console.log(
          `[ChatRealtime][${config.label}] chat_messages: ${status}`,
        );
      }
    });
  channels.push(chatChannel);

  // Order Request chat (order_entity_messages → order_entities)
  const reqChannel = client
    .channel(`order-entity-messages-watcher-${config.label}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'order_entity_messages' },
      (payload) => handleOrderEntityInsert(config, payload),
    )
    .subscribe((status, err) => {
      if (err) {
        console.error(
          `[ChatRealtime][${config.label}] order_entity_messages subscribe error:`,
          err.message || err,
        );
      } else {
        console.log(
          `[ChatRealtime][${config.label}] order_entity_messages: ${status}`,
        );
      }
    });
  channels.push(reqChannel);
}

function startChatRealtimeListener() {
  // Kill switch — set CHAT_REALTIME_DISABLED=true on whichever backend you
  // don't want firing FCM (e.g. disable on production while testing locally,
  // or vice versa) to avoid double-pushes when prod + local share a Supabase.
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
      '[ChatRealtime] no Supabase configs found — listener disabled',
    );
    return;
  }

  // Per-project disable — comma-separated list of labels (e.g. "primary,sunrise")
  // matching the `label` field in TENANT_SUPABASES (auto-included primary uses
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
    `[ChatRealtime] starting listener for ${configs.length} tenant Supabase project(s)`,
  );
  for (const cfg of configs) {
    subscribeOne(cfg);
  }
}

async function stopChatRealtimeListener() {
  console.log('[ChatRealtime] stopping listener…');
  await Promise.allSettled(
    channels.map((ch) =>
      ch.unsubscribe().catch((err) =>
        console.error('[ChatRealtime] unsubscribe error:', err.message),
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
