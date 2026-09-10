const { executeDirectSQL } = require('../utils/postgresExecutor');

/**
 * Get notifications for a user filtered by tenant with pagination.
 * Queries the notification_queue table via direct PostgreSQL.
 *
 * @param {string} userId - User UUID
 * @param {number} tenantId - Tenant ID
 * @param {number} page - Page number (1-based)
 * @param {number} limit - Results per page (default 50)
 * @returns {Object} { notifications, total, page, limit, totalPages }
 */
async function getNotifications(userId, tenantId, page = 1, limit = 50) {
  const offset = (page - 1) * limit;

  const countParams = [userId];
  let countWhere = 'WHERE user_id = $1';
  if (tenantId) {
    countParams.push(tenantId);
    countWhere += ` AND tenant_id = $${countParams.length}`;
  }

  const countResult = await executeDirectSQL(
    `SELECT COUNT(*) AS total FROM notification_queue ${countWhere}`,
    countParams
  );
  const total = parseInt(countResult.data[0]?.total || '0', 10);

  const dataParams = [...countParams, limit, offset];
  const dataResult = await executeDirectSQL(
    `SELECT * FROM notification_queue ${countWhere}
     ORDER BY created_at DESC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  return {
    notifications: dataResult.data || [],
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  };
}

/**
 * Mark a single notification as read by queue_uuid
 */
async function markAsRead(queueUuid, userId) {
  const now = new Date().toISOString();
  const result = await executeDirectSQL(
    `UPDATE notification_queue
     SET status = 'delivered', delivered_at = $1, updated_at = $1
     WHERE queue_uuid = $2 AND user_id = $3
     RETURNING *`,
    [now, queueUuid, userId]
  );

  if (!result.data || result.data.length === 0) {
    throw new Error('Notification not found');
  }
  return result.data[0];
}

/**
 * Mark all notifications as read for a user in a tenant
 */
async function markAllAsRead(userId, tenantId) {
  const now = new Date().toISOString();
  const result = await executeDirectSQL(
    `UPDATE notification_queue
     SET status = 'delivered', delivered_at = $1, updated_at = $1
     WHERE user_id = $2 AND tenant_id = $3 AND status = 'pending'
     RETURNING id`,
    [now, userId, tenantId]
  );

  return { updated: result.data?.length || 0 };
}

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead
};
