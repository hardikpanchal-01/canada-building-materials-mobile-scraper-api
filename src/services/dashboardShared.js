/**
 * Shared Dashboard Utilities
 *
 * Common functions used by both dashboardService and newDashboardService.
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');
const { getNotificationSupabase } = require('../config/notificationDatabase');

/**
 * Build SQL exclusion conditions from exclusion patterns
 */
function buildExclusionConditions(patterns, startParamIndex = 2) {
  const conditions = [];
  const params = [];
  let paramIndex = startParamIndex;

  if (patterns && patterns.length > 0) {
    for (const pattern of patterns) {
      const normalizedPattern = pattern.pattern?.trim()?.toLowerCase();
      if (!normalizedPattern) continue;

      switch (pattern.type) {
        case 'product':
          conditions.push(`NOT EXISTS (
            SELECT 1 FROM order_products op_excl
            WHERE op_excl.order_id = o.order_id
              AND op_excl.item_code ILIKE $${paramIndex}
          )`);
          params.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;

        case 'customer':
          // Plain substring match — matches web filterExcludedOrders
          // (src/lib/order-filters.ts). No "CONCRETE" gate so dashboard
          // counts align with the web summary card.
          conditions.push(`o.customer_name NOT ILIKE $${paramIndex}`);
          params.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;

        case 'delivery_address':
          conditions.push(`COALESCE(o.delivery_addr1, '') NOT ILIKE $${paramIndex}`);
          params.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;
      }
    }
  }

  return { conditions, params };
}

/**
 * Get order overview counts for the given date
 */
async function getTodayOverview(dateStr, exclusionPatterns = [], userAccess = null) {
  const { conditions: exclusionConditions, params: exclusionParams } = buildExclusionConditions(exclusionPatterns, 2);

  let whereConditions = [
    'o.order_date >= $1::date AND o.order_date < ($1::date + INTERVAL \'1 day\')'
  ];
  whereConditions = whereConditions.concat(exclusionConditions);

  let queryParams = [dateStr, ...exclusionParams];
  let paramIndex = queryParams.length + 1;

  if (userAccess && !userAccess.isAdmin) {
    const accessOrConditions = [];

    if (userAccess.allowedPlants && userAccess.allowedPlants.length > 0) {
      const placeholders = userAccess.allowedPlants.map((_, i) => `$${paramIndex + i}::text`).join(', ');
      accessOrConditions.push(`EXISTS (SELECT 1 FROM order_products op_ac INNER JOIN order_product_schedules ops_ac ON ops_ac.order_product_id = op_ac.id WHERE op_ac.order_id = o.order_id AND (op_ac.order_qty_unit = 'YDQ' AND op_ac.is_mix = true) AND ops_ac.plant_code::text IN (${placeholders}))`);
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

  const sql = `
    WITH user_orders AS (
      SELECT
        o.order_id,
        o.removed,
        o.remove_reason_code,
        COALESCE(o.current_status, 1) as current_status,
        SUM(CASE WHEN op.order_qty_unit IN ('m3', 'M3', 'CY', 'YDQ') THEN COALESCE(op.order_qty, 0) ELSE 0 END) as ordered_qty,
        SUM(CASE WHEN op.order_qty_unit IN ('m3', 'M3', 'CY', 'YDQ') THEN COALESCE(op.delv_qty, 0) ELSE 0 END) as delivered_qty
      FROM orders o
      -- Any order with a product line (mirrors web getAllSummaryData; not is_mix-gated).
      INNER JOIN order_products op ON op.order_id = o.order_id
      WHERE ${whereConditions.join(' AND ')}
      GROUP BY o.order_id, o.removed, o.remove_reason_code, o.current_status
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
      INNER JOIN user_orders uo ON uo.order_id = t.order_id
      WHERE (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
      ORDER BY t.order_id, t.created_date DESC NULLS LAST
    ),
    order_statuses AS (
      SELECT
        uo.order_id,
        CASE
          WHEN uo.removed = true AND uo.remove_reason_code IS NOT NULL AND LENGTH(CAST(uo.remove_reason_code AS TEXT)) > 0 THEN 'Canceled'
          WHEN uo.current_status = 4 THEN 'Completed'
          WHEN uo.ordered_qty > 0 AND uo.delivered_qty >= uo.ordered_qty THEN 'Completed'
          WHEN uo.delivered_qty > 0 AND COALESCE(ltc.is_last_load_completed, false) = true
            AND (uo.ordered_qty - uo.delivered_qty) <= 0.02 THEN 'Completed'
          WHEN uo.delivered_qty > 0 AND uo.delivered_qty < uo.ordered_qty THEN 'In Progress'
          WHEN uo.current_status = 1 THEN 'Will Call'
          WHEN uo.current_status = 3 THEN 'Hold Delivery'
          WHEN uo.current_status = 5 THEN 'Wait List'
          ELSE 'Normal'
        END as status
      FROM user_orders uo
      LEFT JOIN last_ticket_completion ltc ON ltc.order_id = uo.order_id
    )
    SELECT
      COUNT(*) as total_orders,
      COUNT(*) FILTER (WHERE status = 'Canceled') as cancelled,
      COUNT(*) FILTER (WHERE status = 'Normal') as normal,
      COUNT(*) FILTER (WHERE status = 'Will Call') as will_call,
      COUNT(*) FILTER (WHERE status = 'Hold Delivery') as hold_delivery,
      COUNT(*) FILTER (WHERE status = 'Completed') as completed,
      COUNT(*) FILTER (WHERE status = 'Wait List') as wait_list,
      COUNT(*) FILTER (WHERE status = 'In Progress') as in_progress
    FROM order_statuses
  `;

  try {
    const result = await executeDirectSQL(sql, queryParams);
    return result.data?.[0] || {
      total_orders: 0, cancelled: 0, normal: 0, will_call: 0,
      hold_delivery: 0, completed: 0, wait_list: 0, in_progress: 0
    };
  } catch (error) {
    console.error('Error getting today overview:', error);
    return {
      total_orders: 0, cancelled: 0, normal: 0, will_call: 0,
      hold_delivery: 0, completed: 0, wait_list: 0, in_progress: 0
    };
  }
}

/**
 * Get average weather data from orders for the given date
 */
async function getAverageWeather(dateStr, exclusionPatterns = [], userAccess = null) {
  const { conditions: exclusionConditions, params: exclusionParams } = buildExclusionConditions(exclusionPatterns, 2);

  let whereConditions = [
    'o.order_date >= $1::date AND o.order_date < ($1::date + INTERVAL \'1 day\')',
    'o.weather_data IS NOT NULL'
  ];
  whereConditions = whereConditions.concat(exclusionConditions);

  let queryParams = [dateStr, ...exclusionParams];
  let paramIndex = queryParams.length + 1;

  // Access control filtering (same pattern as getTodayOverview)
  if (userAccess && !userAccess.isAdmin) {
    const accessOrConditions = [];

    if (userAccess.allowedPlants && userAccess.allowedPlants.length > 0) {
      const placeholders = userAccess.allowedPlants.map((_, i) => `$${paramIndex + i}::text`).join(', ');
      accessOrConditions.push(`EXISTS (SELECT 1 FROM order_products op_ac INNER JOIN order_product_schedules ops_ac ON ops_ac.order_product_id = op_ac.id WHERE op_ac.order_id = o.order_id AND (op_ac.order_qty_unit = 'YDQ' AND op_ac.is_mix = true) AND ops_ac.plant_code::text IN (${placeholders}))`);
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

  const sql = `
    SELECT
      o.weather_data,
      o.delivery_addr1,
      o.delivery_addr2,
      o.delivery_addr3
    FROM orders o
    INNER JOIN order_products op ON op.order_id = o.order_id
      AND (op.order_qty_unit = 'YDQ' AND op.is_mix = true)
    WHERE ${whereConditions.join(' AND ')}
    GROUP BY o.order_id, o.weather_data, o.delivery_addr1, o.delivery_addr2, o.delivery_addr3
    LIMIT 50
  `;

  try {
    const result = await executeDirectSQL(sql, queryParams);
    const orders = result.data || [];

    if (orders.length === 0) return null;

    let totalTemp = 0, totalFeelsLike = 0, totalHumidity = 0;
    let totalWindSpeed = 0, totalPrecipitation = 0, count = 0;
    let location = '', condition = '';

    for (const order of orders) {
      let weatherData = order.weather_data;
      if (typeof weatherData === 'string') {
        try { weatherData = JSON.parse(weatherData); } catch (e) { continue; }
      }

      if (weatherData) {
        if (weatherData.temperature_fahrenheit) totalTemp += parseFloat(weatherData.temperature_fahrenheit) || 0;
        if (weatherData.feels_like_fahrenheit) totalFeelsLike += parseFloat(weatherData.feels_like_fahrenheit) || 0;
        if (weatherData.humidity_percent) totalHumidity += parseFloat(weatherData.humidity_percent) || 0;
        if (weatherData.wind_speed_mph) totalWindSpeed += parseFloat(weatherData.wind_speed_mph) || 0;
        if (weatherData.precipitation_percent) totalPrecipitation += parseFloat(weatherData.precipitation_percent) || 0;

        if (!location && weatherData.location) location = weatherData.location;
        if (!condition && weatherData.condition) condition = weatherData.condition;
        count++;
      }

      if (!location && order.delivery_addr3) location = order.delivery_addr3;
    }

    if (count === 0) return null;

    return {
      location: location || 'Unknown',
      avg_temperature_fahrenheit: Math.round(totalTemp / count),
      avg_feels_like_fahrenheit: Math.round(totalFeelsLike / count),
      avg_humidity_percent: Math.round(totalHumidity / count),
      avg_wind_speed_mph: Math.round(totalWindSpeed / count),
      avg_precipitation_percent: Math.round(totalPrecipitation / count),
      condition: condition || 'Clear',
      orders_with_weather: count
    };
  } catch (error) {
    console.error('Error getting average weather:', error);
    return null;
  }
}

/**
 * Format time to HH:MM AM/PM in CST timezone
 */
function formatTime(time, tz = null) {
  if (!time) return null;
  let date;
  if (time instanceof Date) { date = time; } else { date = new Date(time); }
  if (isNaN(date.getTime())) return null;

  const timeZone = tz?.iana || 'America/Chicago';
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date);

  return formatted.replace(' ', '');
}

/**
 * Get human-readable time ago string
 */
function getTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hr ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;

  return date.toLocaleDateString();
}

/**
 * Get recent alerts/notifications for user from notification_queue table.
 * Column mapping: subject → title, body → message, status='delivered' → read=true
 */
async function getRecentAlerts(userId) {
  try {
    const supabase = getNotificationSupabase();
    const { data, error } = await supabase
      .from('notification_queue')
      .select('id, subject, body, created_at, status')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    return (data || []).map(a => ({
      id: a.id,
      title: a.subject || '',
      message: a.body || '',
      type: 'info',
      time_ago: getTimeAgo(a.created_at),
      created_at: a.created_at,
      read: a.status === 'delivered'
    }));
  } catch (error) {
    console.warn('Could not fetch notifications:', error.message);
    return [];
  }
}

/**
 * Get unread notification count from notification_queue table.
 * Unread = status is NOT 'delivered'
 */
async function getUnreadNotificationCount(userId) {
  try {
    const supabase = getNotificationSupabase();
    const { count, error } = await supabase
      .from('notification_queue')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .neq('status', 'delivered');

    if (error) throw error;
    return count || 0;
  } catch (error) {
    return 0;
  }
}

/**
 * Get recent alerts + unread count in parallel (2 queries to notification Supabase).
 * Returns { alerts: Array, unreadCount: number }
 */
async function getAlertsAndUnreadCount(userId) {
  try {
    const [alerts, unreadCount] = await Promise.all([
      getRecentAlerts(userId),
      getUnreadNotificationCount(userId)
    ]);
    return { alerts, unreadCount };
  } catch (error) {
    console.warn('Could not fetch notifications:', error.message);
    return { alerts: [], unreadCount: 0 };
  }
}

module.exports = {
  buildExclusionConditions,
  getTodayOverview,
  getAverageWeather,
  formatTime,
  getTimeAgo,
  getRecentAlerts,
  getUnreadNotificationCount,
  getAlertsAndUnreadCount
};
