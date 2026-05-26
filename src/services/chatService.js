const { getSupabaseAdmin } = require('../config/database');
const deviceService = require('./deviceService');
const { getMessaging } = require('../config/Firebase');

/**
 * Get read status (last_read_at) for all orders the user has read
 */
async function getReadStatus(userId) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('chat_read_status')
    .select('order_id, last_read_at')
    .eq('user_id', userId);

  if (error) {
    console.error('[ChatService] getReadStatus error:', error.message);
    return [];
  }

  return data || [];
}

/**
 * Get unread message counts per order for the user.
 * Compares chat_messages.created_at against chat_read_status.last_read_at.
 */
async function getUnreadCounts(userId, orderIds) {
  const supabase = getSupabaseAdmin();

  // Get user's read statuses
  const readStatuses = await getReadStatus(userId);
  const readMap = {};
  readStatuses.forEach(rs => {
    readMap[rs.order_id] = rs.last_read_at;
  });

  // Build per-order unread counts
  const counts = {};

  // If specific orderIds provided, filter to those; otherwise get all
  let query = supabase
    .from('chat_messages')
    .select('order_id, created_at')
    .eq('is_deleted', false)
    .neq('sender_id', userId)
    .order('created_at', { ascending: false });

  if (orderIds && orderIds.length > 0) {
    query = query.in('order_id', orderIds);
  }

  const { data: messages, error } = await query;

  if (error) {
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
async function markAsRead(userId, orderId) {
  const supabase = getSupabaseAdmin();

  // Add 2-second buffer to catch in-flight messages
  const lastReadAt = new Date(Date.now() + 2000).toISOString();

  const { data, error } = await supabase
    .from('chat_read_status')
    .upsert(
      {
        user_id: userId,
        order_id: orderId,
        last_read_at: lastReadAt,
      },
      { onConflict: 'user_id,order_id' }
    )
    .select()
    .single();

  if (error) {
    console.error('[ChatService] markAsRead error:', error.message);
    throw new Error(`Failed to mark as read: ${error.message}`);
  }

  return data;
}

function truncate(text, max = 120) {
  if (!text) return '';
  return text.length > max ? `${text.substring(0, max - 1)}…` : text;
}

async function sendChatPush(deviceTokens, payload) {
  const messaging = getMessaging();

  const data = Object.entries(payload.data).reduce((acc, [k, v]) => {
    acc[k] = v == null ? '' : String(v);
    return acc;
  }, {});

  const message = {
    notification: { title: payload.title, body: payload.body },
    data,
    android: {
      priority: 'high',
      notification: {
        channelId: 'chat',
        sound: 'default',
        defaultSound: true,
        priority: 'high',
      },
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: {
        aps: {
          alert: { title: payload.title, body: payload.body },
          sound: 'default',
          badge: 1,
          'mutable-content': 1,
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
    data: {
      type: 'chat_message',
      event_code: 'CHAT_MESSAGE',
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
    data: {
      type: 'order_request_message',
      event_code: 'ORDER_REQUEST_MESSAGE',
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
