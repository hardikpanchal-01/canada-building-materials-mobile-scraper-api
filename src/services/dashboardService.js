/**
 * Dashboard Service
 *
 * Provides dashboard data for mobile app home screen.
 * All data is user-specific based on assigned customers.
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');
const { getUserProfile } = require('./userService');
const { fetchExclusionPatterns } = require('./exclusionPatternService');
const {
  buildExclusionConditions,
  getTodayOverview,
  getAverageWeather,
  formatTime,
  getAlertsAndUnreadCount
} = require('./dashboardShared');

// In-memory dashboard cache (60-second TTL per user)
const _dashboardCache = new Map();
const DASHBOARD_CACHE_TTL_MS = 60 * 1000; // 60 seconds

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _dashboardCache) {
    if (now - entry.timestamp > DASHBOARD_CACHE_TTL_MS) {
      _dashboardCache.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Get dashboard data for a user with access control
 * @param {string} userId - User ID (UUID)
 * @param {object} userAccess - User access control data
 * @param {object} pagination - Pagination parameters for active_deliveries
 * @returns {Promise<object>} Dashboard data
 */
async function getDashboardData(userId, userAccess = null, pagination = {}, userEmail = null, tz = null) {
  try {
    // Check cache first (include userAccess and pagination in cache key)
    const cacheKey = `${userId}_${userAccess?.userType || 'default'}_${pagination.page || 1}_${pagination.limit || 10}`;
    const now = Date.now();
    const cached = _dashboardCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < DASHBOARD_CACHE_TTL_MS) {
      return cached.data;
    }
    // Get user profile and exclusion patterns in parallel.
    // affects_counts=true subset so dashboard counts align with web summary.
    const [userProfile, exclusionPatterns] = await Promise.all([
      getUserProfile(userId, userEmail),
      fetchExclusionPatterns({ affectsCountsOnly: true })
    ]);

    // Get today's date in the user's timezone (from mobile app or tenant setting)
    const timeZone = tz?.iana || 'America/Chicago';
    const cstParts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());

    const cstDateMap = {};
    for (const p of cstParts) {
      cstDateMap[p.type] = p.value;
    }

    const todayStart = new Date(
      parseInt(cstDateMap.year, 10),
      parseInt(cstDateMap.month, 10) - 1,
      parseInt(cstDateMap.day, 10),
      0, 0, 0, 0
    );
    const todayDateStr = formatDate(todayStart);

    // Execute all queries in parallel (pass userAccess for filtering)
    // getAlertsAndUnreadCount combines 2 notification queries into 1 round-trip
    const [
      todayOverview,
      weatherData,
      activeDeliveriesResult,
      alertsResult
    ] = await Promise.all([
      getTodayOverview(todayDateStr, exclusionPatterns, userAccess),
      getAverageWeather(todayDateStr, exclusionPatterns, userAccess),
      getActiveDeliveries(todayDateStr, exclusionPatterns, userAccess, pagination, tz),
      getAlertsAndUnreadCount(userId)
    ]);

    const recentAlerts = alertsResult.alerts;
    const notificationCount = alertsResult.unreadCount;

    // Get counts from overview
    const totalOrders = parseInt(todayOverview.total_orders) || 0;
    const cancelledOrders = parseInt(todayOverview.cancelled) || 0;
    const completedOrders = parseInt(todayOverview.completed) || 0;
    const inProgressOrders = parseInt(todayOverview.in_progress) || 0;
    const normalOrders = parseInt(todayOverview.normal) || 0;
    const willCallOrders = parseInt(todayOverview.will_call) || 0;
    const holdDeliveryOrders = parseInt(todayOverview.hold_delivery) || 0;
    const waitListOrders = parseInt(todayOverview.wait_list) || 0;

    // Progress percentage (completed / total)
    const progressPercent = totalOrders > 0 ? Math.round((completedOrders / totalOrders) * 100) : 0;

    // Status percentages (average distribution)
    const completedPercent = totalOrders > 0 ? Math.round((completedOrders / totalOrders) * 100) : 0;
    const inProgressPercent = totalOrders > 0 ? Math.round((inProgressOrders / totalOrders) * 100) : 0;
    const cancelledPercent = totalOrders > 0 ? Math.round((cancelledOrders / totalOrders) * 100) : 0;
    const holdPercent = totalOrders > 0 ? Math.round((holdDeliveryOrders / totalOrders) * 100) : 0;
    const willCallPercent = totalOrders > 0 ? Math.round((willCallOrders / totalOrders) * 100) : 0;
    const normalPercent = totalOrders > 0 ? Math.round((normalOrders / totalOrders) * 100) : 0;

    const dashboardData = {
      user: {
        id: userProfile.id,
        firstName: userProfile.firstName,
        lastName: userProfile.lastName,
        fullName: userProfile.fullName || `${userProfile.firstName} ${userProfile.lastName}`.trim(),
        email: userProfile.email,
        avatarUrl: userProfile.avatarUrl,
        company: userProfile.company
      },
      notifications: {
        unread_count: notificationCount
      },
      weather: weatherData,
      today_overview: {
        total_orders: totalOrders,
        cancelled: cancelledOrders,
        normal: normalOrders,
        will_call: willCallOrders,
        hold_delivery: holdDeliveryOrders,
        completed: completedOrders,
        wait_list: waitListOrders,
        in_progress: inProgressOrders
      },
      today_progress: {
        percent: progressPercent,
        completed_orders: completedOrders,
        total_orders: totalOrders,
        active_orders: inProgressOrders,
        remaining_orders: Math.max(0, totalOrders - completedOrders - cancelledOrders),
        avg_status_percent: {
          completed: completedPercent,
          in_progress: inProgressPercent,
          normal: normalPercent,
          will_call: willCallPercent,
          hold_delivery: holdPercent,
          cancelled: cancelledPercent
        }
      },
      active_deliveries: {
        count: activeDeliveriesResult.pagination.total,
        orders: activeDeliveriesResult.orders,
        pagination: activeDeliveriesResult.pagination
      },
      recent_alerts: recentAlerts
    };

    // Store in cache (with role-based key)
    _dashboardCache.set(cacheKey, { data: dashboardData, timestamp: Date.now() });

    return dashboardData;
  } catch (error) {
    console.error('Error getting dashboard data:', error);
    throw error;
  }
}

/**
 * Get active deliveries - Today's recent In Progress orders
 */
async function getActiveDeliveries(dateStr, exclusionPatterns = [], userAccess = null, pagination = {}, tz = null) {
  // Pagination parameters
  const page = Math.max(1, parseInt(pagination.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(pagination.limit, 10) || 10));
  const offset = (page - 1) * limit;

  // Build exclusion conditions
  const { conditions: exclusionConditions, params: exclusionParams } = buildExclusionConditions(exclusionPatterns, 2);

  // Build WHERE clause
  let whereConditions = [
    'o.order_date >= $1::date AND o.order_date < ($1::date + INTERVAL \'1 day\')'
  ];
  whereConditions = whereConditions.concat(exclusionConditions);

  // Build query params
  let queryParams = [dateStr, ...exclusionParams];
  let paramIndex = queryParams.length + 1;

  // Access Control Filtering (zones already resolved to plants in auth.js)
  if (userAccess && !userAccess.isAdmin) {
    const accessOrConditions = [];

    if (userAccess.allowedPlants && userAccess.allowedPlants.length > 0) {
      const placeholders = userAccess.allowedPlants.map((_, i) => `$${paramIndex + i}::text`).join(', ');
      accessOrConditions.push(`ops.plant_code::text IN (${placeholders})`);
      queryParams.push(...userAccess.allowedPlants.map(p => String(p)));
      paramIndex += userAccess.allowedPlants.length;
    }

    if (userAccess.allowedCustomerIds && userAccess.allowedCustomerIds.length > 0) {
      const placeholders = userAccess.allowedCustomerIds.map((_, i) => `$${paramIndex + i}`).join(', ');
      accessOrConditions.push(`o.customer_id IN (${placeholders})`);
      queryParams.push(...userAccess.allowedCustomerIds);
      paramIndex += userAccess.allowedCustomerIds.length;
    }

    if (userAccess.allowedProjectCodes && userAccess.allowedProjectCodes.length > 0) {
      const placeholders = userAccess.allowedProjectCodes.map((_, i) => `$${paramIndex + i}`).join(', ');
      accessOrConditions.push(`o.project_code IN (${placeholders})`);
      queryParams.push(...userAccess.allowedProjectCodes);
      paramIndex += userAccess.allowedProjectCodes.length;
    }

    if (accessOrConditions.length > 0) {
      whereConditions.push(`(${accessOrConditions.join(' OR ')})`);
    } else {
      whereConditions.push('FALSE');
    }
  }

  // Add pagination params
  const limitParamIdx = paramIndex;
  const offsetParamIdx = paramIndex + 1;
  queryParams.push(limit, offset);

  const sql = `
    WITH order_data AS (
      SELECT
        o.order_id,
        o.order_code,
        o.order_date,
        o.customer_name,
        TRIM(BOTH ', ' FROM
          COALESCE(NULLIF(o.delivery_addr1, ''), '') ||
          CASE WHEN o.delivery_addr2 IS NOT NULL AND o.delivery_addr2 != '' THEN ', ' || o.delivery_addr2 ELSE '' END ||
          CASE WHEN o.delivery_addr3 IS NOT NULL AND o.delivery_addr3 != '' THEN ', ' || o.delivery_addr3 ELSE '' END
        ) as delivery_address,
        o.removed,
        o.remove_reason_code,
        COALESCE(o.current_status, 1) as current_status,
        MIN(ops.start_time) as start_time,
        SUM(COALESCE(op.order_qty, 0)) as ordered_qty,
        SUM(COALESCE(op.delv_qty, 0)) as delivered_qty,
        STRING_AGG(DISTINCT op.item_code, ', ') as product_codes
      FROM orders o
      INNER JOIN order_products op ON op.order_id = o.order_id
        AND (op.order_qty_unit = 'YDQ' AND op.is_mix = true)
      LEFT JOIN order_product_schedules ops ON ops.order_product_id = op.id
      WHERE ${whereConditions.join(' AND ')}
      GROUP BY o.order_id, o.order_code, o.order_date, o.customer_name,
               o.delivery_addr1, o.delivery_addr2, o.delivery_addr3,
               o.removed, o.remove_reason_code, o.current_status
    ),
    last_ticket_completion AS (
      SELECT DISTINCT ON (t.order_id)
        t.order_id,
        CASE
          WHEN t.at_plant_time IS NOT NULL THEN true
          WHEN t.to_plant_time IS NOT NULL THEN true
          WHEN t.wash_time IS NOT NULL THEN true
          WHEN t.unload_time IS NOT NULL THEN true
          WHEN t.loaded_time IS NOT NULL
            AND EXTRACT(EPOCH FROM (NOW() - t.loaded_time)) >= 10800 THEN true
          ELSE false
        END as is_last_load_completed
      FROM tickets t
      INNER JOIN order_data od ON od.order_id = t.order_id
      WHERE (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
      ORDER BY t.order_id, t.created_date DESC NULLS LAST
    ),
    in_progress_orders AS (
      SELECT od.*, COALESCE(ltc.is_last_load_completed, false) as is_last_load_completed
      FROM order_data od
      LEFT JOIN last_ticket_completion ltc ON ltc.order_id = od.order_id
      WHERE od.delivered_qty > 0
        AND od.delivered_qty < od.ordered_qty
        AND od.current_status != 4
        AND NOT (od.removed = true AND od.remove_reason_code IS NOT NULL AND LENGTH(od.remove_reason_code) > 0)
        AND NOT (COALESCE(ltc.is_last_load_completed, false) = true AND (od.ordered_qty - od.delivered_qty) <= 0.02)
    )
    SELECT *,
      COUNT(*) OVER() as total_count
    FROM in_progress_orders
    ORDER BY start_time DESC NULLS LAST
    LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
  `;

  try {
    const result = await executeDirectSQL(sql, queryParams);
    const rows = result.data || [];

    // Get total count from first row
    const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    const totalPages = Math.ceil(totalCount / limit);

    const orders = rows.map(o => {
      const orderedQty = parseFloat(o.ordered_qty) || 0;
      const deliveredQty = parseFloat(o.delivered_qty) || 0;
      const remainingQty = Math.max(0, orderedQty - deliveredQty);
      const progressPercent = orderedQty > 0 ? Math.round((deliveredQty / orderedQty) * 100) : 0;

      return {
        order_id: o.order_id,
        order_code: o.order_code,
        customer_name: o.customer_name,
        delivery_address: o.delivery_address || '',
        product_codes: o.product_codes || '',
        start_time: formatTime(o.start_time, tz),
        ordered_qty: orderedQty,
        delivered_qty: deliveredQty,
        remaining_qty: remainingQty,
        progress_percent: progressPercent,
        status: 'In Progress',
        current_status: parseInt(o.current_status, 10) || 0,
        is_removed: o.removed === true && o.remove_reason_code != null && String(o.remove_reason_code).trim() !== '',
        is_last_load_completed: o.is_last_load_completed === true || o.is_last_load_completed === 'true',
      };
    });

    return {
      orders,
      pagination: {
        page,
        limit,
        total: totalCount,
        total_pages: totalPages,
        has_next: page < totalPages,
        has_prev: page > 1
      }
    };
  } catch (error) {
    console.error('Error getting active deliveries:', error);
    return {
      orders: [],
      pagination: {
        page: 1,
        limit: 10,
        total: 0,
        total_pages: 0,
        has_next: false,
        has_prev: false
      }
    };
  }
}

/**
 * Format date to YYYY-MM-DD
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = {
  getDashboardData
};
