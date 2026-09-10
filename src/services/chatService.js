const { executeDirectSQL } = require('../utils/postgresExecutor');
const deviceService = require('./deviceService');
const { getMessaging } = require('../config/Firebase');

// Cross-path dedup: chat FCM is dispatched from two places — the database
// realtime listener (chatRealtimeListener.handleInsert) and the HTTP
// endpoint POST /api/chat/notify (chatController.notifyChatMessage).
// Both end up calling notifyChatMessage() with the same payload, so
// without dedup the recipient gets two banners. The realtime path has
// its own DB-backed claim (chat_notification_dedup + push_sent_at), but
// the HTTP path bypasses both. This in-process map catches whichever
// path arrives second within the window and drops it.
//
// Single-instance dedup only — if you run multiple backend processes
// where the HTTP request and the realtime INSERT land on different
// instances, the two paths can still race. That's the rarer setup and
// is bounded by the existing cross-instance dedup on the realtime side.
const recentChatNotifyClaims = new Map();
const CHAT_NOTIFY_DEDUP_TTL_MS = 10_000;

function gcChatNotifyClaims(now) {
  if (recentChatNotifyClaims.size < 64) return;
  for (const [k, t] of recentChatNotifyClaims) {
    if (now - t > CHAT_NOTIFY_DEDUP_TTL_MS) recentChatNotifyClaims.delete(k);
  }
}

function claimChatNotify(key) {
  if (!key) return true;
  const now = Date.now();
  gcChatNotifyClaims(now);
  const last = recentChatNotifyClaims.get(key);
  if (last != null && now - last <= CHAT_NOTIFY_DEDUP_TTL_MS) return false;
  recentChatNotifyClaims.set(key, now);
  return true;
}

/**
 * Get read status (last_read_at) for all orders the user has read.
 * markAsRead stores the tenant-local UUID (resolved via auth.users),
 * but the JWT carries the central-auth UUID. We resolve via email
 * to find the matching read status.
 */
async function getReadStatus(userId, userEmail) {
  try {
    let sql = 'SELECT order_id, last_read_at FROM chat_read_status WHERE user_id = $1';
    const params = [userId];

    if (userEmail) {
      sql += ' OR user_id = (SELECT id FROM users WHERE LOWER(email) = LOWER($2) LIMIT 1)';
      params.push(userEmail);
    }

    const result = await executeDirectSQL(sql, params);
    return result.data || [];
  } catch (error) {
    console.error('[ChatService] getReadStatus error:', error.message);
    return [];
  }
}

/**
 * Get unread message counts per order for the user.
 * Compares chat_messages.created_at against chat_read_status.last_read_at.
 */
async function getUnreadCounts(userId, orderIds, userEmail) {
  // Get user's read statuses
  const readStatuses = await getReadStatus(userId, userEmail);
  const readMap = {};
  readStatuses.forEach(rs => {
    readMap[rs.order_id] = rs.last_read_at;
  });

  // Build per-order unread counts
  const counts = {};

  // If specific orderIds provided, filter to those; otherwise get all
  let sql = `SELECT order_id, created_at FROM chat_messages
             WHERE is_deleted = false AND sender_id <> $1`;
  const params = [userId];

  if (orderIds && orderIds.length > 0) {
    sql += ' AND order_id = ANY($2)';
    params.push(orderIds);
  }

  sql += ' ORDER BY created_at DESC';

  let messages;
  try {
    const result = await executeDirectSQL(sql, params);
    messages = result.data;
  } catch (error) {
    console.error('[ChatService] getUnreadCounts error:', error.message);
    return { counts: {}, total_unread: 0 };
  }

  let totalUnread = 0;

  (messages || []).forEach(msg => {
    const lastRead = readMap[msg.order_id];
    // If no read status or message is newer than last read, it's unread
    if (!lastRead || new Date(msg.created_at) > new Date(lastRead)) {
      counts[msg.order_id] = (counts[msg.order_id] || 0) + 1;
      totalUnread++;
    }
  });

  return {
    counts,
    total_unread: totalUnread,
  };
}

/**
 * Mark an order's chat as read for a user.
 * Upserts into chat_read_status with current timestamp.
 */
async function markAsRead(userId, orderId, userEmail) {
  // Add 2-second buffer to catch in-flight messages
  const lastReadAt = new Date(Date.now() + 2000).toISOString();

  try {
    // Resolve userId to one that exists in auth.users (FK target) BEFORE inserting.
    // Single query: check if userId exists in auth.users, if not find the mapped one via email.
    let effectiveId = userId;
    try {
      const mapped = await executeDirectSQL(
        `SELECT COALESCE(
           (SELECT id FROM auth.users WHERE id = $1::uuid),
           (SELECT id FROM auth.users WHERE LOWER(email) = LOWER($2) LIMIT 1)
         ) as resolved_id`, [userId, userEmail || '']
      );
      if (mapped.data?.[0]?.resolved_id) {
        effectiveId = mapped.data[0].resolved_id;
      }
    } catch (e) {
      console.warn('[ChatService] userId resolve failed, using original:', e.message);
    }

    const result = await executeDirectSQL(
      `INSERT INTO chat_read_status (user_id, order_id, last_read_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, order_id)
       DO UPDATE SET last_read_at = EXCLUDED.last_read_at
       RETURNING *`,
      [effectiveId, orderId, lastReadAt]
    );
    return result.data && result.data.length > 0 ? result.data[0] : null;
  } catch (error) {
    console.error('[ChatService] markAsRead error:', error.message);
    throw new Error(`Failed to mark as read: ${error.message}`);
  }
}

function truncate(text, max = 120) {
  if (!text) return '';
  return text.length > max ? `${text.substring(0, max - 1)}…` : text;
}

async function sendChatPush(deviceTokens, payload) {
  const messaging = getMessaging();

  // title/body travel inside `data` so the mobile bg handler can render
  // the banner itself on Android — see the rationale below for why we
  // intentionally drop the top-level `notification` field.
  const data = Object.entries({
    ...payload.data,
    title: payload.title,
    body: payload.body,
  }).reduce((acc, [k, v]) => {
    acc[k] = v == null ? '' : String(v);
    return acc;
  }, {});

  const collapseTag = payload.collapseTag || null;

  // Include top-level `notification` field so Android auto-displays in
  // kill state. Data-only Android pushes are unreliable in kill mode —
  // OEM battery restrictions (Motorola, Xiaomi, Huawei, etc.) defer or
  // drop them and the headless JS task never runs to render via notifee.
  // Top-level `notification` is rendered by the OS directly and bypasses
  // those restrictions.
  //
  // Double-banner concern (the historical bug): handled mobile-side in
  // index.js — the bg handler skips its own displayNotification call
  // when `notification` is present (`if (!notification) display(...)`),
  // and the foreground path is single-rendered via the in-app dedup util.
  const message = {
    notification: { title: payload.title, body: payload.body },
    data,
    android: {
      priority: 'high',
      collapseKey: collapseTag || undefined,
      notification: {
        channelId: 'chat',
        sound: 'default',
        defaultSound: true,
        priority: 'high',
        tag: collapseTag || undefined,
      },
    },
    apns: {
      headers: {
        'apns-priority': '10',
        ...(collapseTag ? { 'apns-collapse-id': collapseTag } : {}),
      },
      payload: {
        aps: {
          alert: { title: payload.title, body: payload.body },
          sound: 'default',
          badge: 1,
          'mutable-content': 1,
          ...(collapseTag ? { 'thread-id': collapseTag } : {}),
        },
      },
    },
  };

  const response = await messaging.sendEachForMulticast({
    ...message,
    tokens: deviceTokens,
  });

  return {
    successCount: response.successCount,
    failureCount: response.failureCount,
    responses: response.responses.map((resp, idx) => ({
      token: deviceTokens[idx],
      success: resp.success,
      error: resp.error
        ? { code: resp.error.code, message: resp.error.message }
        : null,
    })),
  };
}

async function notifyChatMessage({
  message_id,
  order_id,
  order_code,
  chat_id,
  sender_id,
  sender_name,
  message_preview,
  tenant_subdomain,
  recipient_user_ids,
  order_date,
  customer_name,
}) {
  if (!order_id) throw new Error('order_id is required');
  if (!sender_id) throw new Error('sender_id is required');
  if (!Array.isArray(recipient_user_ids) || recipient_user_ids.length === 0) {
    return { successCount: 0, failureCount: 0, skipped: 'no_recipients' };
  }

  // Drop the second arrival from whichever of the two dispatch paths
  // (realtime listener vs POST /api/chat/notify) gets here later. Key is
  // derived from content so both paths produce the same string — the
  // HTTP path doesn't carry message_id, and earlier the keys didn't
  // collide, letting both FCMs through. Truncate the preview to 80
  // chars so trivial body variation (e.g. trailing whitespace from one
  // path) still dedups.
  const dedupKey = `chat:${order_id}:${sender_id}:${(message_preview || '').slice(0, 80)}`;
  if (!claimChatNotify(dedupKey)) {
    console.log(`[ChatNotify] DEDUPED duplicate path for ${dedupKey}`);
    return { successCount: 0, failureCount: 0, skipped: 'duplicate_path' };
  }

  const recipients = recipient_user_ids.filter(
    (uid) => uid && uid !== sender_id,
  );
  if (recipients.length === 0) {
    return { successCount: 0, failureCount: 0, skipped: 'sender_only' };
  }

  const tokenLists = await Promise.all(
    recipients.map((uid) =>
      deviceService.getUserDeviceTokens(uid).catch((err) => {
        console.error(
          `[ChatNotify] Failed to fetch tokens for user ${uid}:`,
          err.message,
        );
        return [];
      }),
    ),
  );
  const tokens = [...new Set(tokenLists.flat().filter(Boolean))];

  if (tokens.length === 0) {
    return { successCount: 0, failureCount: 0, skipped: 'no_tokens' };
  }

  const title = sender_name || 'New message';
  const body = truncate(message_preview || 'Sent an attachment');

  const result = await sendChatPush(tokens, {
    title,
    body,
    collapseTag: message_id ? `chat_msg_${message_id}` : undefined,
    data: {
      type: 'chat_message',
      event_code: 'CHAT_MESSAGE',
      message_id: message_id || '',
      order_id,
      order_code: order_code || String(order_id),
      chat_id: chat_id || '',
      room_id: String(order_id),
      room_name: order_code ? `Order #${order_code}` : `Order ${order_id}`,
      order_date: order_date || '',
      customer_name: customer_name || '',
      sender_id,
      sender_name: sender_name || '',
      tenant_subdomain: tenant_subdomain || '',
      tenant_slug: tenant_subdomain || '',
    },
  });

  // Log every failure so we can see WHY the push didn't deliver. Without
  // this, "0/N pushed" silently rolls up auth errors, mismatched-creds,
  // sender-id mismatches, etc. as if they were stale tokens.
  (result.responses || []).forEach((r) => {
    if (!r.success && r.error) {
      console.warn(
        `[ChatNotify] FAIL token=${(r.token || '').slice(0, 20)}… code=${r.error.code} msg=${r.error.message}`,
      );
    }
  });

  const invalidTokens = (result.responses || [])
    .filter(
      (r) =>
        !r.success &&
        r.error?.code &&
        [
          'messaging/invalid-registration-token',
          'messaging/registration-token-not-registered',
        ].includes(r.error.code),
    )
    .map((r) => r.token);

  if (invalidTokens.length > 0) {
    deviceService
      .batchDeactivateTokens(invalidTokens)
      .catch((err) =>
        console.error('[ChatNotify] Failed to deactivate tokens:', err.message),
      );
  }

  return {
    successCount: result.successCount,
    failureCount: result.failureCount,
    tokenCount: tokens.length,
    recipientCount: recipients.length,
  };
}

async function notifyOrderEntityMessage({
  message_id,
  order_entity_id,
  sender_id,
  sender_name,
  message_preview,
  tenant_subdomain,
  recipient_user_ids,
  job_name,
  company_name,
  on_job_date,
}) {
  if (!order_entity_id) throw new Error('order_entity_id is required');
  if (!sender_id) throw new Error('sender_id is required');
  if (!Array.isArray(recipient_user_ids) || recipient_user_ids.length === 0) {
    return { successCount: 0, failureCount: 0, skipped: 'no_recipients' };
  }

  const dedupKey = `oe-chat:${order_entity_id}:${sender_id}:${(message_preview || '').slice(0, 80)}`;
  if (!claimChatNotify(dedupKey)) {
    console.log(`[OrderEntityNotify] DEDUPED duplicate path for ${dedupKey}`);
    return { successCount: 0, failureCount: 0, skipped: 'duplicate_path' };
  }

  const recipients = recipient_user_ids.filter(
    (uid) => uid && uid !== sender_id,
  );
  if (recipients.length === 0) {
    return { successCount: 0, failureCount: 0, skipped: 'sender_only' };
  }

  const tokenLists = await Promise.all(
    recipients.map((uid) =>
      deviceService.getUserDeviceTokens(uid).catch((err) => {
        console.error(
          `[OrderEntityNotify] Failed to fetch tokens for user ${uid}:`,
          err.message,
        );
        return [];
      }),
    ),
  );
  const tokens = [...new Set(tokenLists.flat().filter(Boolean))];

  if (tokens.length === 0) {
    return { successCount: 0, failureCount: 0, skipped: 'no_tokens' };
  }

  const title = sender_name || 'New message';
  const body = truncate(message_preview || 'Sent a message');

  // Build a friendly room label: prefer job_name, then company, else fall back
  // to a short id slice (matches the web's display style: "OE-XXXXXX").
  const idSlice = String(order_entity_id).slice(0, 6).toUpperCase();
  const roomName =
    job_name || company_name || `Order Request - ${idSlice}`;

  const result = await sendChatPush(tokens, {
    title,
    body,
    collapseTag: message_id ? `oe_msg_${message_id}` : undefined,
    data: {
      type: 'order_request_message',
      event_code: 'ORDER_REQUEST_MESSAGE',
      message_id: message_id || '',
      order_entity_id,
      orderRequestId: order_entity_id,
      room_name: roomName,
      job_name: job_name || '',
      company_name: company_name || '',
      on_job_date: on_job_date || '',
      sender_id,
      sender_name: sender_name || '',
      tenant_subdomain: tenant_subdomain || '',
      tenant_slug: tenant_subdomain || '',
    },
  });

  (result.responses || []).forEach((r) => {
    if (!r.success && r.error) {
      console.warn(
        `[OrderEntityNotify] FAIL token=${(r.token || '').slice(0, 20)}… code=${r.error.code} msg=${r.error.message}`,
      );
    }
  });

  const invalidTokens = (result.responses || [])
    .filter(
      (r) =>
        !r.success &&
        r.error?.code &&
        [
          'messaging/invalid-registration-token',
          'messaging/registration-token-not-registered',
        ].includes(r.error.code),
    )
    .map((r) => r.token);

  if (invalidTokens.length > 0) {
    deviceService
      .batchDeactivateTokens(invalidTokens)
      .catch((err) =>
        console.error('[OrderEntityNotify] Failed to deactivate tokens:', err.message),
      );
  }

  return {
    successCount: result.successCount,
    failureCount: result.failureCount,
    tokenCount: tokens.length,
    recipientCount: recipients.length,
  };
}

module.exports = {
  getReadStatus,
  getUnreadCounts,
  markAsRead,
  notifyChatMessage,
  notifyOrderEntityMessage,
};
