/**
 * Truck Service
 *
 * Provides truck listing with real-time location data for map display.
 * Includes ticket status, driver info, and coordinates for active trucks.
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');
const { getDateRange } = require('./orderService');

const FALLBACK_TZ = 'America/Chicago';

function formatTruckTimestamp(dateTimeStr, tz) {
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

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Cache for getActiveTrucksForMap
const _mapCache = { data: null, timestamp: 0 };
const MAP_CACHE_TTL = 30 * 1000;

/**
 * Get trucks with pagination, filtering, and ticket info.
 * All filtering, sorting, and pagination is performed in SQL.
 * @param {object} params - Query parameters
 * @returns {Promise<object>} Paginated truck response
 */
async function getTrucks(params = {}, tz = null) {
  const {
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
    dateFrom,
    dateTo,
    sortBy = 'created_at',
    sortOrder = 'desc',
    search,
    status,
    active,
    hasTickets,
    filterByOrder,
    filterByPlant
  } = params;

  // Validate pagination
  const validPage = Math.max(1, parseInt(page) || 1);
  const validPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(pageSize) || DEFAULT_PAGE_SIZE));

  try {
    // Build date filter for tickets
    let dateCondition = '';
    const queryParams = [];
    let paramIndex = 1;

    if (dateFrom) {
      dateCondition += ` AND t.created_date >= $${paramIndex}::date`;
      queryParams.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      dateCondition += ` AND t.created_date < ($${paramIndex}::date + INTERVAL '1 day')`;
      queryParams.push(dateTo);
      paramIndex++;
    }

    // If no date filter, default to today in user's timezone
    if (!dateFrom && !dateTo) {
      const todayRange = getDateRange('today', tz);
      dateCondition = ` AND t.created_date >= $${paramIndex}::date AND t.created_date < ($${paramIndex + 1}::date + INTERVAL '1 day')`;
      queryParams.push(todayRange.startDate, todayRange.endDate);
      paramIndex += 2;
    }

    // Build dynamic WHERE conditions for the outer query
    const outerConditions = [];

    // Search filter
    if (search && search.trim()) {
      const searchPattern = `%${search.trim()}%`;
      outerConditions.push(`(tr.code ILIKE $${paramIndex} OR tr.current_driver_name ILIKE $${paramIndex} OR lt.order_code ILIKE $${paramIndex} OR lt.customer_name ILIKE $${paramIndex})`);
      queryParams.push(searchPattern);
      paramIndex++;
    }

    // Status filter - compute ticket_status in SQL using CASE and filter on it
    // Status is derived from timestamps in reverse order
    const statusCaseExpr = `
      CASE
        WHEN lt.remove_reason_code IS NOT NULL AND TRIM(lt.remove_reason_code) <> '' THEN 'Cancelled'
        WHEN lt.at_plant_time IS NOT NULL THEN 'At Plant'
        WHEN lt.to_plant_time IS NOT NULL THEN 'To Plant'
        WHEN lt.wash_time IS NOT NULL THEN 'Washing'
        WHEN lt.unload_time IS NOT NULL THEN 'Pouring'
        WHEN lt.on_job_time IS NOT NULL THEN 'At Job'
        WHEN lt.to_job_time IS NOT NULL THEN 'To Job'
        WHEN lt.loaded_time IS NOT NULL THEN 'Loaded'
        WHEN lt.load_time IS NOT NULL THEN 'Loading'
        WHEN lt.printed_time IS NOT NULL THEN 'Ticketed'
        ELSE NULL
      END`;

    if (status && status !== 'all') {
      outerConditions.push(`(${statusCaseExpr}) ILIKE $${paramIndex}`);
      queryParams.push(status.trim());
      paramIndex++;
    }

    // Active filter
    if (active !== undefined && active !== null) {
      outerConditions.push(`tr.active = $${paramIndex}`);
      queryParams.push(active);
      paramIndex++;
    }

    // Has tickets filter
    if (hasTickets === true) {
      outerConditions.push(`lt.ticket_id IS NOT NULL`);
    }

    // Filter by order code
    if (filterByOrder && filterByOrder.trim()) {
      const orderPattern = `%${filterByOrder.trim()}%`;
      outerConditions.push(`lt.order_code ILIKE $${paramIndex}`);
      queryParams.push(orderPattern);
      paramIndex++;
    }

    // Filter by plant
    if (filterByPlant && filterByPlant.trim()) {
      const plantPattern = `%${filterByPlant.trim()}%`;
      outerConditions.push(`(lt.plant_code_display ILIKE $${paramIndex} OR lt.plant_name ILIKE $${paramIndex} OR tr.current_plant_code ILIKE $${paramIndex} OR tr.current_plant_name ILIKE $${paramIndex})`);
      queryParams.push(plantPattern);
      paramIndex++;
    }

    const outerWhereClause = outerConditions.length > 0
      ? 'WHERE ' + outerConditions.join(' AND ')
      : '';

    // Build ORDER BY clause
    const sortFieldMap = {
      'code': 'tr.code',
      'created_at': 'tr.created_at',
      'current_driver_name': 'tr.current_driver_name',
      'ticket_status': `(${statusCaseExpr})`,
      'order_code': 'lt.order_code'
    };
    const validSortDir = sortOrder === 'asc' ? 'ASC' : 'DESC';
    const sqlSortField = sortFieldMap[sortBy] || 'tr.created_at';
    const orderByClause = `ORDER BY ${sqlSortField} ${validSortDir} NULLS LAST`;

    // Pagination params
    const offset = (validPage - 1) * validPageSize;
    queryParams.push(validPageSize);
    const limitParam = paramIndex;
    paramIndex++;
    queryParams.push(offset);
    const offsetParam = paramIndex;
    paramIndex++;

    // Query to get trucks with their latest ticket info, all filtering/sorting/pagination in SQL
    const sql = `
      WITH latest_tickets AS (
        SELECT DISTINCT ON (t.truck_code)
          t.ticket_id,
          t.ticket_code,
          t.truck_code,
          t.order_id,
          t.plant_code,
          t.driver_code,
          t.created_date,
          t.printed_time,
          t.load_time,
          t.loaded_time,
          t.to_job_time,
          t.on_job_time,
          t.unload_time,
          t.wash_time,
          t.to_plant_time,
          t.at_plant_time,
          t.remove_reason_code,
          o.order_code,
          o.delivery_addr1,
          o.delivery_addr2,
          o.delivery_addr3,
          o.customer_name,
          p.code as plant_code_display,
          p.description as plant_name,
          p.phone as plant_phone
        FROM tickets t
        LEFT JOIN orders o ON o.order_id = t.order_id
        LEFT JOIN plants p ON p.code = t.plant_code
        WHERE 1=1 ${dateCondition}
        ORDER BY t.truck_code, t.created_date DESC, t.ticket_id DESC
      ),
      truck_products AS (
        SELECT
          tp.ticket_id,
          tp.item_code,
          tp.ticket_qty
        FROM ticket_products tp
        INNER JOIN latest_tickets lt ON lt.ticket_id = tp.ticket_id
        WHERE tp.is_mix = true
      )
      SELECT
        tr.id as truck_id,
        tr.code,
        tr.description,
        tr.latitude,
        tr.longitude,
        tr.owner_name,
        tr.badge_card_number,
        tr.created_at,
        tr.active,
        tr.current_plant_code,
        tr.current_plant_name,
        tr.current_driver_id,
        tr.current_driver_name,
        e.code as driver_code,
        e.phone as driver_phone,
        lt.ticket_id,
        lt.ticket_code,
        lt.order_id,
        lt.order_code,
        lt.delivery_addr1,
        lt.delivery_addr2,
        lt.delivery_addr3,
        lt.customer_name,
        lt.plant_code_display,
        lt.plant_name,
        lt.plant_phone,
        lt.created_date as ticket_created_date,
        lt.printed_time,
        lt.load_time,
        lt.loaded_time,
        lt.to_job_time,
        lt.on_job_time,
        lt.unload_time,
        lt.wash_time,
        lt.to_plant_time,
        lt.at_plant_time,
        lt.remove_reason_code,
        tp.item_code as product_code,
        tp.ticket_qty as truck_qty,
        ${statusCaseExpr} as ticket_status,
        CASE
          WHEN (${statusCaseExpr}) IS NOT NULL
            AND (${statusCaseExpr}) NOT IN ('At Plant', 'Cancelled')
          THEN true
          ELSE false
        END as is_active_delivery,
        COUNT(*) OVER() as total_count
      FROM trucks tr
      LEFT JOIN latest_tickets lt ON lt.truck_code = tr.code
      LEFT JOIN truck_products tp ON tp.ticket_id = lt.ticket_id
      LEFT JOIN employees e ON e.id = tr.current_driver_id
      ${outerWhereClause}
      ${orderByClause}
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const result = await executeDirectSQL(sql, queryParams);
    const rows = result.data || [];

    // Total from window function (same for every row), or 0 if no rows
    const total = rows.length > 0 ? parseInt(rows[0].total_count) : 0;
    const totalPages = Math.ceil(total / validPageSize);

    // Map rows to response shape (minimal JS transformation only)
    const trucks = rows.map(truck => {
      const deliveryAddress = [
        truck.delivery_addr1,
        truck.delivery_addr2,
        truck.delivery_addr3
      ].filter(addr => addr && addr.trim()).join(', ');

      return {
        truck_id: truck.truck_id,
        code: truck.code,
        description: truck.description,
        latitude: truck.latitude ? String(truck.latitude) : null,
        longitude: truck.longitude ? String(truck.longitude) : null,
        owner_name: truck.owner_name,
        badge_card_number: truck.badge_card_number,
        created_at: formatTruckTimestamp(truck.created_at, tz),
        active: truck.active,
        current_plant_code: truck.current_plant_code,
        current_plant_name: truck.current_plant_name,
        current_driver_id: truck.current_driver_id,
        current_driver_name: truck.current_driver_name,
        driver_code: truck.driver_code,
        driver_phone: truck.driver_phone,
        ticket_id: truck.ticket_id,
        ticket_code: truck.ticket_code,
        order_id: truck.order_id,
        order_code: truck.order_code,
        delivery_address: deliveryAddress || null,
        delivery_addr1: truck.delivery_addr1,
        delivery_addr2: truck.delivery_addr2,
        delivery_addr3: truck.delivery_addr3,
        customer_name: truck.customer_name,
        plant_code: truck.plant_code_display,
        plant_name: truck.plant_name,
        plant_phone: truck.plant_phone || null,
        product_code: truck.product_code,
        truck_qty: truck.truck_qty ? parseFloat(truck.truck_qty) : null,
        ticket_status: truck.ticket_status,
        is_active_delivery: truck.is_active_delivery
      };
    });

    return {
      success: true,
      data: trucks,
      total,
      page: validPage,
      pageSize: validPageSize,
      totalPages,
      hasNextPage: validPage < totalPages,
      hasPreviousPage: validPage > 1
    };

  } catch (error) {
    console.error('Error getting trucks:', error);
    throw error;
  }
}

/**
 * Get active trucks for map display (trucks with active deliveries today).
 * Results are cached for 30 seconds to reduce database load.
 * Active delivery filtering is performed in SQL.
 * @returns {Promise<object>} List of active trucks with coordinates
 */
async function getActiveTrucksForMap(tz = null) {
  // Check cache first
  const now = Date.now();
  if (_mapCache.data && (now - _mapCache.timestamp) < MAP_CACHE_TTL) {
    return _mapCache.data;
  }

  try {
    const sql = `
      WITH today_tickets AS (
        SELECT DISTINCT ON (t.truck_code)
          t.ticket_id,
          t.ticket_code,
          t.truck_code,
          t.order_id,
          t.plant_code,
          t.driver_code,
          t.created_date,
          t.printed_time,
          t.load_time,
          t.loaded_time,
          t.to_job_time,
          t.on_job_time,
          t.unload_time,
          t.wash_time,
          t.to_plant_time,
          t.at_plant_time,
          t.remove_reason_code,
          o.order_code,
          o.delivery_addr1,
          o.delivery_addr2,
          o.delivery_addr3,
          o.customer_name,
          p.description as plant_name,
          p.phone as plant_phone,
          CASE
            WHEN t.remove_reason_code IS NOT NULL AND TRIM(t.remove_reason_code) <> '' THEN 'Cancelled'
            WHEN t.at_plant_time IS NOT NULL THEN 'At Plant'
            WHEN t.to_plant_time IS NOT NULL THEN 'To Plant'
            WHEN t.wash_time IS NOT NULL THEN 'Washing'
            WHEN t.unload_time IS NOT NULL THEN 'Pouring'
            WHEN t.on_job_time IS NOT NULL THEN 'At Job'
            WHEN t.to_job_time IS NOT NULL THEN 'To Job'
            WHEN t.loaded_time IS NOT NULL THEN 'Loaded'
            WHEN t.load_time IS NOT NULL THEN 'Loading'
            WHEN t.printed_time IS NOT NULL THEN 'Ticketed'
            ELSE NULL
          END as ticket_status
        FROM tickets t
        LEFT JOIN orders o ON o.order_id = t.order_id
        LEFT JOIN plants p ON p.code = t.plant_code
        WHERE t.created_date >= $1::date
          AND t.created_date < ($2::date + INTERVAL '1 day')
        ORDER BY t.truck_code, t.created_date DESC, t.ticket_id DESC
      )
      SELECT
        tr.id as truck_id,
        tr.code,
        tr.description,
        tr.latitude,
        tr.longitude,
        tr.current_driver_name,
        tr.current_plant_name,
        tt.ticket_id,
        tt.ticket_code,
        tt.order_id,
        tt.order_code,
        tt.delivery_addr1,
        tt.delivery_addr2,
        tt.delivery_addr3,
        tt.customer_name,
        tt.plant_name,
        tt.plant_phone,
        tt.ticket_status
      FROM trucks tr
      INNER JOIN today_tickets tt ON tt.truck_code = tr.code
      WHERE tr.latitude IS NOT NULL
        AND tr.longitude IS NOT NULL
        AND tr.active = true
        AND tt.ticket_status IS NOT NULL
        AND tt.ticket_status NOT IN ('At Plant', 'Cancelled')
      ORDER BY tt.created_date DESC
    `;

    const todayRange = getDateRange('today', tz);
    const result = await executeDirectSQL(sql, [todayRange.startDate, todayRange.endDate]);
    const rows = result.data || [];

    // Minimal JS transformation for response shape
    const trucks = rows.map(truck => {
      const deliveryAddress = [
        truck.delivery_addr1,
        truck.delivery_addr2,
        truck.delivery_addr3
      ].filter(addr => addr && addr.trim()).join(', ');

      return {
        truck_id: truck.truck_id,
        code: truck.code,
        description: truck.description,
        latitude: truck.latitude ? String(truck.latitude) : null,
        longitude: truck.longitude ? String(truck.longitude) : null,
        driver_name: truck.current_driver_name,
        plant_name: truck.plant_name || truck.current_plant_name,
        plant_phone: truck.plant_phone || null,
        ticket_id: truck.ticket_id,
        ticket_code: truck.ticket_code,
        order_id: truck.order_id,
        order_code: truck.order_code,
        delivery_address: deliveryAddress || null,
        customer_name: truck.customer_name,
        ticket_status: truck.ticket_status,
        is_active: true
      };
    });

    const response = {
      success: true,
      count: trucks.length,
      trucks
    };

    // Store in cache
    _mapCache.data = response;
    _mapCache.timestamp = Date.now();

    return response;

  } catch (error) {
    console.error('Error getting active trucks for map:', error);
    throw error;
  }
}

module.exports = {
  getTrucks,
  getActiveTrucksForMap
};
