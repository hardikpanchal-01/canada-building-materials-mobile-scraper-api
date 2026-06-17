const { getNotificationSupabase } = require('../config/notificationDatabase');

/**
 * Get notifications for a user filtered by tenant with pagination
 * @param {string} userId - User UUID
 * @param {number} tenantId - Tenant ID
 * @param {number} page - Page number (1-based)
 * @param {number} limit - Results per page (default 50)
 * @returns {Object} { notifications, total, page, limit, totalPages }
 */
async function getNotifications(userId, tenantId, page = 1, limit = 50) {
  const supabase = getNotificationSupabase();

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error, count } = await supabase
    .from('notification_queue')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new Error(`Failed to fetch notifications: ${error.message}`);

  return {
    notifications: data || [],
    total: count || 0,
    page,
    limit,
    totalPages: Math.ceil((count || 0) / limit)
  };
}

/**
 * Get the authenticated user's recent notifications (across the tenant), paginated.
 * Filters by user_id only (the central JWT id, which is how notification_queue.user_id
 * is keyed) — used by the mobile Notifications screen (GET /api/notifications/recent).
 * @param {string} userId - User UUID (central auth id)
 * @param {number} page
 * @param {number} limit
 */
async function getRecentNotifications(userId, page = 1, limit = 20) {
  const supabase = getNotificationSupabase();

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error, count } = await supabase
    .from('notification_queue')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new Error(`Failed to fetch notifications: ${error.message}`);

  return {
    notifications: data || [],
    total: count || 0,
    page,
    limit,
    totalPages: Math.ceil((count || 0) / limit)
  };
}

module.exports = {
  getNotifications,
  getRecentNotifications
};
