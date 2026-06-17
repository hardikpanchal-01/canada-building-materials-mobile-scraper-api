/**
 * New Dashboard Service
 *
 * Enhanced dashboard with market summary (company, region, plant aggregations)
 * and date filtering support. Returns all data in a single call for mobile performance.
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');
const { getUserProfile } = require('./userService');
const { fetchExclusionPatterns } = require('./exclusionPatternService');
const { getMarketSummary } = require('./marketSummaryService');
const { getDateRange, buildDeliveryProgress, fetchProgressBarColors, formatTimeCST } = require('./orderService');
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
 * Get enhanced dashboard data for a user with access control
 * @param {string} userId - User ID (UUID)
 * @param {object} userAccess - User access control data
 * @param {object} pagination - Pagination parameters for active_deliveries
 * @param {object} dateParams - Date filter parameters
 * @param {string} [dateParams.dateFilter] - Preset filter (today, tomorrow, yesterday, etc.)
 * @param {string} [dateParams.startDate] - Custom start date YYYY-MM-DD (overrides dateFilter)
 * @param {string} [dateParams.endDate] - Custom end date YYYY-MM-DD (overrides dateFilter)
 * @returns {Promise<object>} Dashboard data
 */
async function getNewDashboardData(userId, userAccess = null, pagination = {}, dateParams = {}, userEmail = null, tz = null) {
  try {
    // Resolve date range
    let dateFrom, dateTo;
    if (dateParams.startDate && dateParams.endDate) {
      dateFrom = dateParams.startDate;
      dateTo = dateParams.endDate;
    } else {
      const range = getDateRange(dateParams.dateFilter || 'today', tz);
      dateFrom = range.startDate;
      dateTo = range.endDate;
    }

    // Check cache first (include userAccess, pagination, and dates in cache key)
    const cacheKey = `new_${userId}_${userAccess?.userType || 'default'}_${pagination.page || 1}_${pagination.limit || 10}_${dateFrom}_${dateTo}`;
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

    // Execute all queries in parallel (pass userAccess for filtering)
    // getAlertsAndUnreadCount combines 2 notification queries into 1 round-trip
    const [
      todayOverview,
      weatherData,
      activeDeliveriesResult,
      marketSummaryData,
      alertsResult
    ] = await Promise.all([
      getTodayOverview(dateFrom, exclusionPatterns, userAccess),
      getAverageWeather(dateFrom, exclusionPatterns, userAccess),
      getActiveDeliveries(dateFrom, exclusionPatterns, userAccess, pagination, tz),
      getMarketSummary(dateFrom, dateTo, exclusionPatterns, userAccess),
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

    // Format resolved dates as YYYY-MM-DD strings for the client
    const formatDateStr = (d) => {
      if (typeof d === 'string') return d;
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    };

    // Build timezone info from user's selected timezone
    const userTimezone = tz?.iana || 'America/Chicago';
    let tzAbbreviation = '';
    let tzCurrentTime = '';
    try {
      const now = new Date();
      const abbrevParts = new Intl.DateTimeFormat('en-US', {
        timeZone: userTimezone,
        timeZoneName: 'short'
      }).formatToParts(now);
      const tzPart = abbrevParts.find(p => p.type === 'timeZoneName');
      if (tzPart) tzAbbreviation = tzPart.value;

      const timeParts = new Intl.DateTimeFormat('en-US', {
        timeZone: userTimezone,
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }).formatToParts(now);
      const get = (type) => (timeParts.find(p => p.type === type)?.value || '');
      tzCurrentTime = `${get('month')}/${get('day')}/${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod')} ${tzAbbreviation}`;
    } catch {}

    const dashboardData = {
      // Tenant volume unit (m³ for metric tenants like CBM, CY for US). The shared
      // mobile app reads this and renders it instead of a hardcoded "CY".
      volume_unit: process.env.VOLUME_UNIT || 'CY',
      date_range: {
        start_date: formatDateStr(dateFrom),
        end_date: formatDateStr(dateTo),
        filter: dateParams.dateFilter || 'today'
      },
      user: {
        id: userProfile.id,
        firstName: userProfile.firstName,
        lastName: userProfile.lastName,
        fullName: userProfile.fullName || `${userProfile.firstName} ${userProfile.lastName}`.trim(),
        email: userProfile.email,
        avatarUrl: userProfile.avatarUrl,
        company: userProfile.company,
        current_user_timezone: {
          iana: userTimezone,
          abbreviation: tzAbbreviation,
          current_time: tzCurrentTime
        }
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
      market_summary: marketSummaryData,
      active_deliveries: {
        count: activeDeliveriesResult.pagination.total,
        orders: activeDeliveriesResult.orders,
        pagination: activeDeliveriesResult.pagination
      },
      recent_alerts: recentAlerts
    };

    // Store in cache
    _dashboardCache.set(cacheKey, { data: dashboardData, timestamp: Date.now() });

    return dashboardData;
  } catch (error) {
    console.error('Error getting new dashboard data:', error);
    throw error;
  }
}

/**
 * Get active deliveries - In Progress orders for the given date
 */
async function getActiveDeliveries(dateStr, exclusionPatterns = [], userAccess = null, pagination = {}, tz = null) {
  const page = Math.max(1, parseInt(pagination.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(pagination.limit, 10) || 10));
  const offset = (page - 1) * limit;

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
        timezone('UTC', MIN(ops.start_time)) as start_time,
        SUM(COALESCE(op.order_qty, 0)) as ordered_qty,
        SUM(COALESCE(op.delv_qty, 0)) as delivered_qty,
        STRING_AGG(DISTINCT op.item_code, ', ') as product_codes
      FROM orders o
      INNER JOIN order_products op ON op.order_id = o.order_id
        AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
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
    ),
    order_tickets AS (
      SELECT
        t.order_id,
        t.ticket_code,
        t.truck_code,
        t.created_date,
        COALESCE(tp.load_qty, 0) as load_qty,
        timezone('UTC', t.printed_time) as printed_time,
        timezone('UTC', t.load_time) as load_time,
        timezone('UTC', t.loaded_time) as loaded_time,
        timezone('UTC', t.to_job_time) as to_job_time,
        timezone('UTC', t.on_job_time) as on_job_time,
        timezone('UTC', t.unload_time) as unload_time,
        timezone('UTC', t.wash_time) as wash_time,
        timezone('UTC', t.to_plant_time) as to_plant_time,
        timezone('UTC', t.at_plant_time) as at_plant_time,
        CASE
          WHEN t.at_plant_time IS NOT NULL THEN 'at_plant'
          WHEN t.to_plant_time IS NOT NULL THEN 'to_plant'
          WHEN t.wash_time IS NOT NULL THEN 'washing'
          WHEN t.unload_time IS NOT NULL THEN 'pouring'
          WHEN t.on_job_time IS NOT NULL THEN 'at_job'
          WHEN t.to_job_time IS NOT NULL THEN 'to_job'
          WHEN t.loaded_time IS NOT NULL THEN 'loaded'
          WHEN t.load_time IS NOT NULL THEN 'loading'
          WHEN t.printed_time IS NOT NULL THEN 'ticketed'
          ELSE 'pending'
        END as ticket_status
      FROM tickets t
      INNER JOIN in_progress_orders ipo ON ipo.order_id = t.order_id
      LEFT JOIN ticket_products tp ON tp.ticket_id = t.ticket_id AND (tp.is_mix = true OR tp.order_qty_unit IN ('m3', 'M3', 'CY', 'YDQ', '40013'))
      WHERE (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
    ),
    recent_ticket AS (
      SELECT DISTINCT ON (order_id) *
      FROM order_tickets
      ORDER BY order_id, created_date DESC NULLS LAST
    ),
    ticket_progress AS (
      SELECT
        order_id,
        COALESCE(SUM(load_qty) FILTER (WHERE ticket_status = 'ticketed'), 0) as qty_ticketed,
        COALESCE(SUM(load_qty) FILTER (WHERE ticket_status = 'loading'), 0) as qty_loading,
        COALESCE(SUM(load_qty) FILTER (WHERE ticket_status = 'loaded'), 0) as qty_loaded,
        COALESCE(SUM(load_qty) FILTER (WHERE ticket_status = 'to_job'), 0) as qty_to_job,
        COALESCE(SUM(load_qty) FILTER (WHERE ticket_status = 'at_job'), 0) as qty_at_job,
        COALESCE(SUM(load_qty) FILTER (WHERE ticket_status = 'pouring'), 0) as qty_pouring,
        COALESCE(SUM(load_qty) FILTER (WHERE ticket_status = 'washing'), 0) as qty_washing,
        COALESCE(SUM(load_qty) FILTER (WHERE ticket_status = 'to_plant'), 0) as qty_to_plant,
        COALESCE(SUM(load_qty) FILTER (WHERE ticket_status = 'at_plant'), 0) as qty_at_plant,
        COALESCE(COUNT(*) FILTER (WHERE ticket_status = 'ticketed'), 0) as cnt_ticketed,
        COALESCE(COUNT(*) FILTER (WHERE ticket_status = 'loading'), 0) as cnt_loading,
        COALESCE(COUNT(*) FILTER (WHERE ticket_status = 'loaded'), 0) as cnt_loaded,
        COALESCE(COUNT(*) FILTER (WHERE ticket_status = 'to_job'), 0) as cnt_to_job,
        COALESCE(COUNT(*) FILTER (WHERE ticket_status = 'at_job'), 0) as cnt_at_job,
        COALESCE(COUNT(*) FILTER (WHERE ticket_status = 'pouring'), 0) as cnt_pouring,
        COALESCE(COUNT(*) FILTER (WHERE ticket_status = 'washing'), 0) as cnt_washing,
        COALESCE(COUNT(*) FILTER (WHERE ticket_status = 'to_plant'), 0) as cnt_to_plant,
        COALESCE(COUNT(*) FILTER (WHERE ticket_status = 'at_plant'), 0) as cnt_at_plant
      FROM order_tickets
      GROUP BY order_id
    )
    SELECT ipo.*,
      rt.ticket_code as recent_ticket_code,
      rt.truck_code as recent_truck_code,
      rt.load_qty as recent_load_qty,
      rt.ticket_status as recent_ticket_status,
      rt.printed_time as recent_printed_time,
      rt.load_time as recent_load_time,
      rt.loaded_time as recent_loaded_time,
      rt.to_job_time as recent_to_job_time,
      rt.on_job_time as recent_on_job_time,
      rt.unload_time as recent_unload_time,
      rt.wash_time as recent_wash_time,
      rt.to_plant_time as recent_to_plant_time,
      rt.at_plant_time as recent_at_plant_time,
      tpg.qty_ticketed, tpg.qty_loading, tpg.qty_loaded,
      tpg.qty_to_job, tpg.qty_at_job, tpg.qty_pouring,
      tpg.qty_washing, tpg.qty_to_plant, tpg.qty_at_plant,
      tpg.cnt_ticketed, tpg.cnt_loading, tpg.cnt_loaded,
      tpg.cnt_to_job, tpg.cnt_at_job, tpg.cnt_pouring,
      tpg.cnt_washing, tpg.cnt_to_plant, tpg.cnt_at_plant,
      COUNT(*) OVER() as total_count
    FROM in_progress_orders ipo
    LEFT JOIN recent_ticket rt ON rt.order_id = ipo.order_id
    LEFT JOIN ticket_progress tpg ON tpg.order_id = ipo.order_id
    ORDER BY ipo.start_time DESC NULLS LAST
    LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
  `;

  try {
    const result = await executeDirectSQL(sql, queryParams);
    const rows = result.data || [];

    const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    const totalPages = Math.ceil(totalCount / limit);

    const progressBarColors = await fetchProgressBarColors();
    const orders = rows.map(o => {
      const orderedQty = parseFloat(o.ordered_qty) || 0;
      const deliveredQty = parseFloat(o.delivered_qty) || 0;
      const remainingQty = Math.max(0, orderedQty - deliveredQty);
      const progressPercent = orderedQty > 0 ? Math.round((deliveredQty / orderedQty) * 100) : 0;

      // Recent ticket status display mapping
      const STATUS_DISPLAY_MAP = {
        ticketed: 'Ticketed', loading: 'Loading', loaded: 'Loaded',
        to_job: 'To Job', at_job: 'At Job', pouring: 'Pouring',
        washing: 'Washing', to_plant: 'To Plant', at_plant: 'At Plant',
        pending: 'Pending'
      };

      const ticketStatus = o.recent_ticket_status || null;

      const qtyByStatus = {
        ticketed: parseFloat(o.qty_ticketed) || 0,
        loading: parseFloat(o.qty_loading) || 0,
        loaded: parseFloat(o.qty_loaded) || 0,
        to_job: parseFloat(o.qty_to_job) || 0,
        at_job: parseFloat(o.qty_at_job) || 0,
        pouring: parseFloat(o.qty_pouring) || 0,
        washing: parseFloat(o.qty_washing) || 0,
        to_plant: parseFloat(o.qty_to_plant) || 0,
        at_plant: parseFloat(o.qty_at_plant) || 0
      };

      const countByStatus = {
        ticketed: parseInt(o.cnt_ticketed, 10) || 0,
        loading: parseInt(o.cnt_loading, 10) || 0,
        loaded: parseInt(o.cnt_loaded, 10) || 0,
        to_job: parseInt(o.cnt_to_job, 10) || 0,
        at_job: parseInt(o.cnt_at_job, 10) || 0,
        pouring: parseInt(o.cnt_pouring, 10) || 0,
        washing: parseInt(o.cnt_washing, 10) || 0,
        to_plant: parseInt(o.cnt_to_plant, 10) || 0,
        at_plant: parseInt(o.cnt_at_plant, 10) || 0
      };

      // Compute active tickets count from per-status counts
      const activeTickets = Object.values(countByStatus).reduce((sum, c) => sum + c, 0);

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
        delivery_progress: buildDeliveryProgress(orderedQty, qtyByStatus, progressBarColors, countByStatus),
        active_tickets: activeTickets,
        tickets_count: activeTickets,
        status: 'In Progress',
        current_status: parseInt(o.current_status, 10) || 0,
        is_removed: o.removed === true && o.remove_reason_code != null && String(o.remove_reason_code).trim() !== '',
        is_last_load_completed: o.is_last_load_completed === true || o.is_last_load_completed === 'true',
        recent_ticket: o.recent_ticket_code ? {
          ticket_code: o.recent_ticket_code,
          truck_code: o.recent_truck_code || null,
          load_qty: parseFloat(o.recent_load_qty) || 0,
          status: ticketStatus,
          status_display: STATUS_DISPLAY_MAP[ticketStatus] || 'Pending',
          timestamps: {
            ticketed: formatTimeCST(o.recent_printed_time, tz),
            loading: formatTimeCST(o.recent_load_time, tz),
            loaded: formatTimeCST(o.recent_loaded_time, tz),
            to_job: formatTimeCST(o.recent_to_job_time, tz),
            at_job: formatTimeCST(o.recent_on_job_time, tz),
            pouring: formatTimeCST(o.recent_unload_time, tz),
            washing: formatTimeCST(o.recent_wash_time, tz),
            to_plant: formatTimeCST(o.recent_to_plant_time, tz),
            at_plant: formatTimeCST(o.recent_at_plant_time, tz)
          }
        } : null
      };
    });

    return {
      orders,
      pagination: {
        page, limit, total: totalCount, total_pages: totalPages,
        has_next: page < totalPages, has_prev: page > 1
      }
    };
  } catch (error) {
    console.error('Error getting active deliveries:', error);
    return {
      orders: [],
      pagination: { page: 1, limit: 10, total: 0, total_pages: 0, has_next: false, has_prev: false }
    };
  }
}

module.exports = {
  getNewDashboardData
};
