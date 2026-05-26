const chatService = require('../services/chatService');

// Fallback timezone when no user timezone is available
const FALLBACK_TZ = 'America/Chicago';

/**
 * Format an ISO timestamp to the user's timezone in 12h format.
 */
function formatToUserTz(dateTimeStr, tz) {
  if (!dateTimeStr) return null;
  const date = new Date(dateTimeStr);
  if (isNaN(date.getTime())) return dateTimeStr;
  const timeZone = tz?.iana || FALLBACK_TZ;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * GET /api/chat/read-status
 * Returns read status (last_read_at) for all orders the user has read.
 */
async function getReadStatus(req, res) {
  try {
    const userId = req.user.id;
    const tz = req.user?.timezone || null;
    const data = await chatService.getReadStatus(userId);

    const formatted = (data || []).map(row => ({
      ...row,
      last_read_at: formatToUserTz(row.last_read_at, tz),
    }));

    return res.status(200).json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    console.error('[ChatController] getReadStatus error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch read status',
      error_code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * GET /api/chat/unread-counts
 * Returns unread message counts per order for the current user.
 * Query params: order_ids (comma-separated, optional)
 */
async function getUnreadCounts(req, res) {
  try {
    const userId = req.user.id;
    const orderIdsParam = req.query.order_ids;
    const orderIds = orderIdsParam
      ? orderIdsParam.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id))
      : null;

    const data = await chatService.getUnreadCounts(userId, orderIds);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('[ChatController] getUnreadCounts error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch unread counts',
      error_code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * POST /api/chat/mark-read
 * Marks an order's chat as read for the current user.
 * Body: { order_id: number }
 */
async function markAsRead(req, res) {
  try {
    const userId = req.user.id;
    const { order_id } = req.body;

    if (!order_id) {
      return res.status(400).json({
        success: false,
        message: 'order_id is required',
        error_code: 'VALIDATION_ERROR',
      });
    }

    const tz = req.user?.timezone || null;
    const data = await chatService.markAsRead(userId, order_id);

    return res.status(200).json({
      success: true,
      message: 'Marked as read',
      data: data ? { ...data, last_read_at: formatToUserTz(data.last_read_at, tz) } : data,
    });
  } catch (error) {
    console.error('[ChatController] markAsRead error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark as read',
      error_code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * POST /api/chat/notify
 * Internal endpoint called by tenant frontends after a chat message is inserted.
 * Authenticated via x-internal-token (see middleware/internalAuth).
 * Body:
 *   {
 *     order_id, order_code, chat_id,
 *     sender_id, sender_name,
 *     message_preview,
 *     tenant_subdomain,
 *     recipient_user_ids: string[]
 *   }
 */
async function notifyChatMessage(req, res) {
  try {
    const {
      order_id,
      order_code,
      chat_id,
      sender_id,
      sender_name,
      message_preview,
      tenant_subdomain,
      recipient_user_ids,
    } = req.body || {};

    if (!order_id || !sender_id) {
      return res.status(400).json({
        success: false,
        error_code: 'VALIDATION_ERROR',
        message: 'order_id and sender_id are required',
      });
    }

    const result = await chatService.notifyChatMessage({
      order_id,
      order_code,
      chat_id,
      sender_id,
      sender_name,
      message_preview,
      tenant_subdomain,
      recipient_user_ids: Array.isArray(recipient_user_ids)
        ? recipient_user_ids
        : [],
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('[ChatController] notifyChatMessage error:', error);
    return res.status(500).json({
      success: false,
      error_code: 'INTERNAL_ERROR',
      message: error.message || 'Failed to send chat notifications',
    });
  }
}

module.exports = {
  getReadStatus,
  getUnreadCounts,
  markAsRead,
  notifyChatMessage,
};
