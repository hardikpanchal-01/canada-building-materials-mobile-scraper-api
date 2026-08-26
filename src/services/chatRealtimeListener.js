/**
 * Chat realtime listener
 *
 * Subscribes to `public.chat_messages` and `public.order_entity_messages` INSERT
 * events over Postgres LISTEN/NOTIFY (the `realtime_changes` channel), then fans
 * out FCM via chatService. This is the direct-Postgres replacement for the old
 * hosted realtime subscriptions.
 *
 * Requirements (runbook §5): the watched tables need an AFTER INSERT trigger
 * running `notify_realtime_change()`, and the LISTEN connection must be DIRECT
 * (not through a transaction pooler) — see src/db/realtimeListener.js.
 *
 * Kill switch: CHAT_REALTIME_DISABLED=true prevents the listener from starting.
 */

const chatService = require('./chatService');
const { makeClient } = require('../db/client');
const { getPool } = require('../services/database/postgresClient');
const { createRealtimeListener } = require('../db/realtimeListener');

let listener = null;

// A direct-Postgres data client for the lookups the handlers perform.
function dataClient() {
  return makeClient({ pool: getPool(), schema: 'public' });
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
    console.error('[ChatRealtime] failed to load recipients:', error.message);
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
    console.error('[ChatRealtime] failed to load order meta:', error.message);
    return null;
  }
  return data || null;
}

async function fetchOrderEntityMeta(db, orderEntityId) {
  const { data, error } = await db
    .from('order_entities')
    .select('id, job_name, company_name, on_job_date')
    .eq('id', orderEntityId)
    .maybeSingle();

  if (error) {
    console.error('[ChatRealtime] failed to load order_entity meta:', error.message);
    return null;
  }
  return data || null;
}

async function handleInsert(payload) {
  const row = payload && payload.new;
  if (!row) return;
  if (row.is_deleted === true) return;
  if (!row.sender_id || !row.order_id) return;

  try {
    const db = dataClient();
    const [recipients, orderMeta] = await Promise.all([
      fetchActiveRecipients(db, row.sender_id),
      fetchOrderMeta(db, row.order_id),
    ]);

    if (recipients.length === 0) {
      console.log(`[ChatRealtime] order=${row.order_id} sender=${row.sender_id} -> no recipients`);
      return;
    }

    const orderCode = (orderMeta && orderMeta.order_code) || String(row.order_id);

    const result = await chatService.notifyChatMessage({
      order_id: row.order_id,
      order_code: orderCode,
      chat_id: row.chat_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name || '',
      message_preview: buildPreview(row.message_text, row.attachments),
      tenant_subdomain: '',
      recipient_user_ids: recipients,
      order_date: (orderMeta && orderMeta.order_date) || '',
      customer_name: (orderMeta && orderMeta.customer_name) || '',
    });

    console.log(
      `[ChatRealtime] order=${orderCode} (id=${row.order_id}) -> ${result.successCount}/${result.tokenCount || 0} pushed (failures: ${result.failureCount}, recipients: ${result.recipientCount}, skipped: ${result.skipped || 'no'})`,
    );
  } catch (err) {
    console.error('[ChatRealtime] handler error:', err.message);
  }
}

async function handleOrderEntityInsert(payload) {
  const row = payload && payload.new;
  if (!row) return;
  if (!row.sender_id || !row.order_entity_id) return;

  try {
    const db = dataClient();
    const [recipients, meta] = await Promise.all([
      fetchActiveRecipients(db, row.sender_id),
      fetchOrderEntityMeta(db, row.order_entity_id),
    ]);

    if (recipients.length === 0) {
      console.log(`[ChatRealtime] order_entity=${row.order_entity_id} sender=${row.sender_id} -> no recipients`);
      return;
    }

    const result = await chatService.notifyOrderEntityMessage({
      order_entity_id: row.order_entity_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name || '',
      message_preview: buildPreview(row.message_text, null),
      tenant_subdomain: '',
      recipient_user_ids: recipients,
      job_name: (meta && meta.job_name) || '',
      company_name: (meta && meta.company_name) || '',
      on_job_date: (meta && meta.on_job_date) || '',
    });

    console.log(
      `[ChatRealtime] order_request=${row.order_entity_id} -> ${result.successCount}/${result.tokenCount || 0} pushed (failures: ${result.failureCount}, recipients: ${result.recipientCount}, skipped: ${result.skipped || 'no'})`,
    );
  } catch (err) {
    console.error('[ChatRealtime] order entity handler error:', err.message);
  }
}

function startChatRealtimeListener() {
  // Kill switch — set CHAT_REALTIME_DISABLED=true on whichever backend you
  // don't want firing FCM to avoid double-pushes.
  if (
    process.env.CHAT_REALTIME_DISABLED === 'true' ||
    process.env.CHAT_REALTIME_DISABLED === '1'
  ) {
    console.log('[ChatRealtime] CHAT_REALTIME_DISABLED is set — listener will not start');
    return;
  }

  listener = createRealtimeListener();
  listener.on('chat_messages', 'INSERT', handleInsert);
  listener.on('order_entity_messages', 'INSERT', handleOrderEntityInsert);

  console.log('[ChatRealtime] starting Postgres LISTEN/NOTIFY listener');
  listener.start().catch((err) => {
    console.error('[ChatRealtime] failed to start listener:', err.message);
  });
}

async function stopChatRealtimeListener() {
  console.log('[ChatRealtime] stopping listener…');
  if (listener) {
    await listener.stop();
    listener = null;
  }
}

module.exports = {
  startChatRealtimeListener,
  stopChatRealtimeListener,
};
