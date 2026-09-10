/**
 * Chat message push listener (PostgreSQL polling)
 *
 * Polls `chat_messages` and `order_entity_messages` for new rows whose
 * `push_sent_at` is NULL, atomically claims them (first instance to flip
 * push_sent_at from NULL wins), then fans out FCM via chatService.
 *
 * This replaces the previous realtime websocket listener with a
 * direct-PostgreSQL implementation. The claim is race-safe across multiple
 * backend instances because the UPDATE ... WHERE push_sent_at IS NULL
 * RETURNING statement only succeeds on one instance per row.
 *
 * Env:
 *   CHAT_REALTIME_DISABLED=true       — kill switch, listener will not start
 *   CHAT_POLL_INTERVAL_MS=5000        — polling interval (default 5s)
 *   CHAT_POLL_LOOKBACK_MINUTES=10     — ignore unclaimed rows older than this
 *                                       (prevents blasting old backlog after deploy)
 */

const chatService = require('./chatService');
const { executeDirectSQL } = require('../utils/postgresExecutor');

const POLL_INTERVAL_MS = parseInt(process.env.CHAT_POLL_INTERVAL_MS, 10) || 5000;
const LOOKBACK_MINUTES = parseInt(process.env.CHAT_POLL_LOOKBACK_MINUTES, 10) || 10;

let pollTimer = null;
let polling = false;

// ─── Cross-instance deduplication ───────────────────────────────────
// The push_sent_at claim is already atomic, but the dedup table adds a
// second layer of protection (and preserves the audit trail the previous
// implementation kept in chat_notification_dedup).
// ────────────────────────────────────────────────────────────────────

const localDedup = new Map(); // messageId -> timestamp
const LOCAL_DEDUP_TTL_MS = 120_000; // 2 minutes

function cleanLocalDedup() {
  const now = Date.now();
  for (const [key, ts] of localDedup) {
    if (now - ts > LOCAL_DEDUP_TTL_MS) localDedup.delete(key);
  }
}

/**
 * Try to claim a message for notification processing.
 * Returns true if THIS instance should send the push, false if another
 * instance already handled it.
 */
async function claimMessage(tableName, messageId) {
  const dedupKey = `${tableName}:${messageId}`;

  // Local dedup first (cheap, covers same-process duplicates)
  cleanLocalDedup();
  if (localDedup.has(dedupKey)) return false;
  localDedup.set(dedupKey, Date.now());

  // DB-based dedup (covers cross-instance duplicates)
  try {
    const result = await executeDirectSQL(
      `INSERT INTO chat_notification_dedup (table_name, message_id, processed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (table_name, message_id) DO NOTHING
       RETURNING id`,
      [tableName, messageId]
    );

    if (result.data.length === 0) {
      // Another instance already claimed it
      localDedup.delete(dedupKey); // keep local cache consistent
      return false;
    }

    return true; // We claimed it
  } catch (err) {
    // 42P01 = table doesn't exist yet → fall through to local-only dedup
    if (err.code === '42P01') {
      console.warn('[ChatRealtime] chat_notification_dedup table not found — using local dedup only. Run the migration to enable cross-instance dedup.');
      return true;
    }
    console.error('[ChatRealtime] dedup error:', err.message);
    return true; // Fail open — send rather than silently drop
  }
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

async function fetchActiveRecipients(senderId) {
  try {
    const result = await executeDirectSQL(
      'SELECT id FROM users WHERE active = true',
      []
    );
    return result.data
      .map((u) => u.id)
      .filter((id) => id && id !== senderId);
  } catch (error) {
    console.error('[ChatRealtime] failed to load recipients:', error.message);
    return [];
  }
}

async function fetchOrderMeta(orderId) {
  try {
    const result = await executeDirectSQL(
      'SELECT order_id, order_code, order_date, customer_name FROM orders WHERE order_id = $1 LIMIT 1',
      [orderId]
    );
    return result.data[0] || null;
  } catch (error) {
    console.error('[ChatRealtime] failed to load order meta:', error.message);
    return null;
  }
}

async function fetchOrderEntityMeta(orderEntityId) {
  try {
    const result = await executeDirectSQL(
      'SELECT id, job_name, company_name, on_job_date::text FROM order_entities WHERE id = $1 LIMIT 1',
      [orderEntityId]
    );
    return result.data[0] || null;
  } catch (error) {
    console.error('[ChatRealtime] failed to load order_entity meta:', error.message);
    return null;
  }
}

async function handleChatMessage(row) {
  if (!row) return;
  if (row.is_deleted === true) return;
  if (!row.sender_id || !row.order_id || !row.id) return;

  // Dedup: only the first instance to claim this message sends FCM
  const claimed = await claimMessage('chat_messages', row.id);
  if (!claimed) {
    return;
  }

  try {
    const [recipients, orderMeta] = await Promise.all([
      fetchActiveRecipients(row.sender_id),
      fetchOrderMeta(row.order_id),
    ]);

    if (recipients.length === 0) {
      console.log(
        `[ChatRealtime] order=${row.order_id} sender=${row.sender_id} -> no recipients`,
      );
      return;
    }

    const orderCode = orderMeta?.order_code || String(row.order_id);

    const result = await chatService.notifyChatMessage({
      message_id: row.id,
      order_id: row.order_id,
      order_code: orderCode,
      chat_id: row.chat_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name || '',
      message_preview: buildPreview(row.message_text, row.attachments),
      tenant_subdomain: process.env.CONCRETEGO_SLUG || '',
      recipient_user_ids: recipients,
      order_date: orderMeta?.order_date || '',
      customer_name: orderMeta?.customer_name || '',
    });

    console.log(
      `[ChatRealtime] order=${orderCode} (id=${row.order_id}) -> ${result.successCount}/${result.tokenCount || 0} pushed (failures: ${result.failureCount}, recipients: ${result.recipientCount}, skipped: ${result.skipped || 'no'})`,
    );
  } catch (err) {
    console.error('[ChatRealtime] handler error:', err.message);
  }
}

async function handleOrderEntityMessage(row) {
  if (!row) return;
  if (!row.sender_id || !row.order_entity_id || !row.id) return;

  // Dedup: only the first instance to claim this message sends FCM
  const claimed = await claimMessage('order_entity_messages', row.id);
  if (!claimed) {
    return;
  }

  try {
    const [recipients, meta] = await Promise.all([
      fetchActiveRecipients(row.sender_id),
      fetchOrderEntityMeta(row.order_entity_id),
    ]);

    if (recipients.length === 0) {
      console.log(
        `[ChatRealtime] order_entity=${row.order_entity_id} sender=${row.sender_id} -> no recipients`,
      );
      return;
    }

    const result = await chatService.notifyOrderEntityMessage({
      message_id: row.id,
      order_entity_id: row.order_entity_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name || '',
      message_preview: buildPreview(row.message_text, null),
      tenant_subdomain: process.env.CONCRETEGO_SLUG || '',
      recipient_user_ids: recipients,
      job_name: meta?.job_name || '',
      company_name: meta?.company_name || '',
      on_job_date: meta?.on_job_date || '',
    });

    console.log(
      `[ChatRealtime] order_request=${row.order_entity_id} -> ${result.successCount}/${result.tokenCount || 0} pushed (failures: ${result.failureCount}, recipients: ${result.recipientCount}, skipped: ${result.skipped || 'no'})`,
    );
  } catch (err) {
    console.error('[ChatRealtime] order entity handler error:', err.message);
  }
}

/**
 * One poll cycle: atomically claim unpushed rows (push_sent_at IS NULL) in
 * both chat tables and fan out FCM for each claimed row.
 *
 * The lookback window prevents pushing an old backlog when the listener
 * starts for the first time (rows that predate the deployment stay unclaimed
 * until they age out of the window and are then ignored forever).
 */
async function pollOnce() {
  if (polling) return; // don't overlap slow cycles
  polling = true;

  try {
    // Order chat (chat_messages → orders)
    const chatResult = await executeDirectSQL(
      `UPDATE chat_messages
       SET push_sent_at = NOW()
       WHERE push_sent_at IS NULL
         AND created_at > NOW() - ($1 || ' minutes')::interval
         AND is_deleted IS NOT TRUE
       RETURNING *`,
      [String(LOOKBACK_MINUTES)]
    );

    for (const row of chatResult.data) {
      await handleChatMessage(row);
    }

    // Order Request chat (order_entity_messages → order_entities)
    const reqResult = await executeDirectSQL(
      `UPDATE order_entity_messages
       SET push_sent_at = NOW()
       WHERE push_sent_at IS NULL
         AND created_at > NOW() - ($1 || ' minutes')::interval
       RETURNING *`,
      [String(LOOKBACK_MINUTES)]
    );

    for (const row of reqResult.data) {
      await handleOrderEntityMessage(row);
    }
  } catch (err) {
    console.error('[ChatRealtime] poll error:', err.message);
  } finally {
    polling = false;
  }
}

function startChatRealtimeListener() {
  // Kill switch — set CHAT_REALTIME_DISABLED=true on whichever backend you
  // don't want firing FCM (e.g. disable on production while testing locally,
  // or vice versa) to avoid double-pushes when prod + local share a database.
  if (
    process.env.CHAT_REALTIME_DISABLED === 'true' ||
    process.env.CHAT_REALTIME_DISABLED === '1'
  ) {
    console.log(
      '[ChatRealtime] CHAT_REALTIME_DISABLED is set — listener will not start',
    );
    return;
  }

  if (!process.env.DATABASE_URL && !process.env.DB_POOL_URL) {
    console.warn('[ChatRealtime] DATABASE_URL not configured — listener disabled');
    return;
  }

  console.log(
    `[ChatRealtime] starting PostgreSQL polling listener (interval=${POLL_INTERVAL_MS}ms, lookback=${LOOKBACK_MINUTES}min)`,
  );

  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  if (pollTimer.unref) pollTimer.unref();

  // Run one cycle immediately so messages aren't delayed by a full interval
  pollOnce();
}

async function stopChatRealtimeListener() {
  console.log('[ChatRealtime] stopping listener…');
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  startChatRealtimeListener,
  stopChatRealtimeListener,
};
