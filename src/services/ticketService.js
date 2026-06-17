/**
 * Ticket Service
 *
 * Provides ticket listing, filtering, status derivation, and detail retrieval
 * for the mobile app ticket list and tracking views.
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');
const {
  getDateRange,
  formatDate,
  formatDateCST,
  formatTime,
  formatDisplayDateTime,
  buildDeliveryProgress,
  fetchProgressBarColors,
  fetchTrackingStatusColors
} = require('./orderService');
const { calculateTruckETA } = require('../utils/awsRouteService');
const {
  TICKET_WEATHER_CACHE_DURATION_MS,
  fetchWeatherByCoordinates,
  geocodeAddress,
  buildAddressString,
  parseCoordinate,
  isCacheValid,
  buildTicketWeatherData
} = require('../utils/openWeatherMap');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const STATUS_DISPLAY_MAP = {
  cancelled: 'Cancelled',
  at_plant: 'At Plant',
  to_plant: 'To Plant',
  washing: 'Washing',
  pouring: 'Pouring',
  at_job: 'At Job',
  to_job: 'To Job',
  loaded: 'Loaded',
  loading: 'Loading',
  ticketed: 'Ticketed',
  pending: 'Pending'
};

/**
 * Format timestamp to display time (e.g., "06:19")
 * pg driver stores raw DB values (already CST) as UTC in Date objects,
 * so we use UTC methods to extract the correct time.
 * Uses same HH:MM format as formatTime in orderService.
 * @param {string|Date} timestamp
 * @returns {string|null}
 */
function formatTimeCST(timestamp, tz = null) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return null;

  // DB stores "timestamp without time zone" in CST. timezone('UTC', col) treats
  // those as UTC, so date's UTC values are really CST values. To convert to the
  // user's timezone: first find the real UTC by subtracting the CST/CDT offset,
  // then format in the user's timezone.
  const userTz = tz?.iana || 'America/Chicago';
  const storedTz = 'America/Chicago';
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const storedStr = date.toLocaleString('en-US', { timeZone: storedTz });
  const storedOffsetMs = new Date(storedStr) - new Date(utcStr);
  const realUtc = new Date(date.getTime() - storedOffsetMs);

  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: userTz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(realUtc);

  return formatted;
}

/**
 * Derive ticket status from timestamps.
 * Flow: Ticketed → Loading → Loaded → To Job → At Job → Pouring → Washing → To Plant → At Plant
 * Cancelled tickets have remove_reason_code set.
 * @param {object} ticket
 * @returns {object} { status: string, remove_reason_code: string|null }
 */
function deriveTicketStatus(ticket) {
  // Step 1: Check if ticket is CANCELLED (remove_reason_code is set)
  const removeReasonCode = ticket.remove_reason_code;
  if (removeReasonCode && String(removeReasonCode).trim() !== '') {
    return { status: 'cancelled', remove_reason_code: String(removeReasonCode).trim() };
  }

  // Step 2: Check timestamps in reverse order (find the LAST one with a value)
  // Order: at_plant_time, to_plant_time, wash_time, unload_time, on_job_time, to_job_time, loaded_time, load_time, printed_time
  if (ticket.at_plant_time) return { status: 'at_plant', remove_reason_code: null };
  if (ticket.to_plant_time) return { status: 'to_plant', remove_reason_code: null };
  if (ticket.wash_time) return { status: 'washing', remove_reason_code: null };
  if (ticket.unload_time) return { status: 'pouring', remove_reason_code: null };
  if (ticket.on_job_time) return { status: 'at_job', remove_reason_code: null };
  if (ticket.to_job_time) return { status: 'to_job', remove_reason_code: null };
  if (ticket.loaded_time) return { status: 'loaded', remove_reason_code: null };
  if (ticket.load_time) return { status: 'loading', remove_reason_code: null };
  if (ticket.printed_time) return { status: 'ticketed', remove_reason_code: null };

  return { status: 'pending', remove_reason_code: null };
}

/**
 * Get status display label. For cancelled, shows "Cancelled-{code}".
 * @param {string} status
 * @param {string|null} removeReasonCode
 * @returns {string}
 */
function getStatusLabel(status, removeReasonCode) {
  if (status === 'cancelled' && removeReasonCode) {
    return `Cancelled-${removeReasonCode}`;
  }
  return STATUS_DISPLAY_MAP[status] || 'Pending';
}

/**
 * Format a ticket record for LIST API response (basic data only).
 * @param {object} row
 * @returns {object}
 */
function formatTicketForList(row, tz = null) {
  const { status, remove_reason_code } = deriveTicketStatus(row);
  const statusDisplay = getStatusLabel(status, remove_reason_code);

  // Pick the latest timestamp based on current status
  const statusTimestamp =
    row.at_plant_time || row.to_plant_time || row.wash_time ||
    row.unload_time || row.on_job_time || row.to_job_time ||
    row.loaded_time || row.load_time || row.printed_time ||
    row.created_date;

  return {
    ticket_id: row.ticket_id || row.id,
    ticket_code: row.ticket_code,
    order_id: row.order_id,
    order_code: row.order_code,
    order_date: row.order_date ? formatDateCST(row.order_date) : null,
    customer_name: row.customer_name || '',
    delivery_address: row.delivery_address || '',
    plant_name: row.plant_name || row.location_name || null,
    truck_code: row.truck_code || row.truck_code_display || null,
    running_qty: parseFloat(row.running_qty) || 0,
    ordered_qty: parseFloat(row.ordered_qty) || 0,
    status: status,
    status_display: statusDisplay,
    status_time: formatTimeCST(statusTimestamp, tz)
  };
}

/**
 * Calculate duration in minutes between two timestamps.
 * Returns null if either timestamp is missing or invalid.
 * @param {string|Date} earlier
 * @param {string|Date} later
 * @returns {number|null}
 */
function calcDurationMinutes(earlier, later) {
  if (!earlier || !later) return null;
  const d1 = new Date(earlier);
  const d2 = new Date(later);
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
  const diffMs = d2.getTime() - d1.getTime();
  if (diffMs < 0) return null;
  const minutes = diffMs / 60000;
  if (minutes > 0 && minutes < 1) return 1;
  return Math.round(minutes);
}

/**
 * Format duration as display string: "X minutes" or "--" when null.
 */
function formatDurationDisplay(minutes) {
  if (minutes === null || minutes === undefined) return '--';
  return `${minutes} minutes`;
}

/**
 * Build delivery metrics: spacing, waiting, pour, and performance minutes.
 * @param {object} row - ticket row with timestamps
 * @param {object} options - { spacingMinutes }
 * @returns {object}
 */
function buildDeliveryMetrics(row, options = {}) {
  const spacingMinutes = options.spacingMinutes !== undefined ? options.spacingMinutes : null;
  const waitingMinutes = calcDurationMinutes(row.on_job_time, row.unload_time);
  const pourMinutes = calcDurationMinutes(row.unload_time, row.wash_time);

  let performanceMinutes = null;
  let idleMinutes = null;
  if (waitingMinutes !== null && pourMinutes !== null && spacingMinutes !== null) {
    performanceMinutes = spacingMinutes - waitingMinutes + pourMinutes;
    idleMinutes = spacingMinutes - performanceMinutes;
  }

  return {
    spacing_minutes: formatDurationDisplay(spacingMinutes),
    waiting_minutes: formatDurationDisplay(waitingMinutes),
    pour_minutes: formatDurationDisplay(pourMinutes),
    performance_minutes: formatDurationDisplay(performanceMinutes),
    idle_minutes: formatDurationDisplay(idleMinutes)
  };
}

/**
 * Format a ticket record for DETAILS API response (full data).
 * @param {object} row
 * @param {array} products - products array for this ticket
 * @returns {object}
 */
function formatTicketForDetails(row, products = [], options = {}, tz = null) {
  const { status, remove_reason_code } = deriveTicketStatus(row);
  const statusDisplay = getStatusLabel(status, remove_reason_code);

  // Choose a primary timestamp to display based on status
  const statusTimestamp =
    row.at_plant_time ||
    row.to_plant_time ||
    row.wash_time ||
    row.unload_time ||
    row.on_job_time ||
    row.to_job_time ||
    row.loaded_time ||
    row.load_time ||
    row.printed_time ||
    row.created_date;

  // Build plant address from plants table address1 + address2
  const plantAddress = [row.plant_address1, row.plant_address2]
    .filter(addr => addr && addr.trim())
    .join(', ') || null;

  // Find concrete product (is_mix = true) for running_qty/ordered_qty
  const concreteProduct = products.find(p => p.is_mix === true || p.is_mix === 'true') || products[0] || {};

  // Determine load display: "-" for cancelled, number for active
  const loadDisplay = row.is_cancelled ? '-' : String(row.load_num || 1);

  return {
    ticket_id: row.ticket_id || row.id,
    ticket_code: row.ticket_code,
    load: loadDisplay,
    order_id: row.order_id,
    order_code: row.order_code,
    order_date: row.order_date ? formatDateCST(row.order_date) : null,
    customer_name: row.customer_name || '',
    delivery_address: row.delivery_address || '',
    project_name: row.project_name || null,
    lot_block_number: row.lot_block_number || null,
    plant_code: row.plant_code || null,
    plant_name: row.plant_name || row.location_name || null,
    plant_address: plantAddress,
    plant_phone: row.plant_phone || null,
    load_qty: parseFloat(concreteProduct.load_qty) || 0,
    running_qty: parseFloat(concreteProduct.acc_delv_qty) || 0,
    ordered_qty: parseFloat(row.ordered_qty) || 0,
    driver_code: row.driver_code || null,
    driver_name: row.driver_name || null,
    driver_phone: row.driver_phone || null,
    created_date: formatTimeCST(row.created_date, tz),
    truck: {
      truck_code: row.truck_code || row.truck_code_display || null,
      truck_description: row.truck_description || null,
      latitude: row.truck_latitude || null,
      longitude: row.truck_longitude || null
    },
    plant_location: {
      latitude: row.plant_latitude || null,
      longitude: row.plant_longitude || null
    },
    order_location: {
      latitude: row.order_latitude || null,
      longitude: row.order_longitude || null
    },
    status: {
      status: status,
      status_display: statusDisplay,
      remove_reason_code: remove_reason_code,
      timestamp: formatTimeCST(statusTimestamp, tz),
      timestamp_display: formatTimeCST(statusTimestamp, tz),
      eta_at_job: formatTimeCST(row.scheduled_on_job_time, tz),
      ticketed: formatTimeCST(row.printed_time, tz),
      loading: formatTimeCST(row.load_time, tz),
      loaded: formatTimeCST(row.loaded_time, tz),
      to_job: formatTimeCST(row.to_job_time, tz),
      at_job: formatTimeCST(row.on_job_time, tz),
      pouring: formatTimeCST(row.unload_time, tz),
      washing: formatTimeCST(row.wash_time, tz),
      to_plant: formatTimeCST(row.to_plant_time, tz),
      at_plant: formatTimeCST(row.at_plant_time, tz),
      durations: {
        loading: formatDurationDisplay(calcDurationMinutes(row.printed_time, row.load_time)),
        loaded: formatDurationDisplay(calcDurationMinutes(row.load_time, row.loaded_time)),
        to_job: formatDurationDisplay(calcDurationMinutes(row.loaded_time, row.to_job_time)),
        at_job: formatDurationDisplay(calcDurationMinutes(row.to_job_time, row.on_job_time)),
        pouring: formatDurationDisplay(calcDurationMinutes(row.on_job_time, row.unload_time)),
        washing: formatDurationDisplay(calcDurationMinutes(row.unload_time, row.wash_time)),
        to_plant: formatDurationDisplay(calcDurationMinutes(row.wash_time, row.to_plant_time)),
        at_plant: formatDurationDisplay(calcDurationMinutes(row.to_plant_time, row.at_plant_time))
      }
    },
    delivery_metrics: buildDeliveryMetrics(row, options),
    products: products.map(p => ({
      id: p.id,
      ticket_id: p.ticket_id,
      item_code: p.item_code,
      description: p.description,
      is_mix: p.is_mix
    })),
    weather_data: (() => {
      const wd = options.weatherData;
      if (!wd) return null;
      if (typeof wd === 'object') return wd;
      if (typeof wd === 'string') {
        try { return JSON.parse(wd); } catch (e) { return null; }
      }
      return null;
    })(),
    verifi_json: (() => {
      const vj = row.verifi_json;
      if (!vj) return null;
      if (typeof vj === 'object') return vj;
      if (typeof vj === 'string') {
        try { return JSON.parse(vj); } catch (e) { return null; }
      }
      return null;
    })(),
    eta_data: (() => {
      const ed = row.eta_data;
      if (!ed) return null;
      if (typeof ed === 'object') return ed;
      if (typeof ed === 'string') {
        try { return JSON.parse(ed); } catch (e) { return null; }
      }
      return null;
    })()
  };
}

/**
 * Build the WHERE clause and parameters for ticket listing.
 */
function buildFilters({
  tz,
  date_filter,
  start_date,
  end_date,
  status,
  search,
  order_id,
  truck_code
}) {
  let dateRange;
  if (start_date && end_date) {
    dateRange = { startDate: start_date, endDate: end_date };
  } else {
    dateRange = getDateRange(date_filter || 'today', tz);
  }

  const where = [
    'o.order_date >= $1::date',
    'o.order_date < ($2::date + INTERVAL \'1 day\')'
  ];
  const params = [dateRange.startDate, dateRange.endDate];
  let idx = 3;

  if (order_id) {
    where.push(`t.order_id = $${idx}`);
    params.push(order_id);
    idx++;
  }

  if (truck_code) {
    where.push(`t.truck_code ILIKE $${idx}`);
    params.push(truck_code);
    idx++;
  }

  if (search && search.trim()) {
    const searchTerm = `%${search.trim().toLowerCase()}%`;
    where.push(`(
      t.ticket_code ILIKE $${idx}
      OR t.truck_code ILIKE $${idx}
      OR t.order_code ILIKE $${idx}
      OR o.customer_name ILIKE $${idx}
      OR o.delivery_addr1 ILIKE $${idx}
      OR o.delivery_addr2 ILIKE $${idx}
      OR o.delivery_addr3 ILIKE $${idx}
    )`);
    params.push(searchTerm);
    idx++;
  }

  // Note: status filter will be applied after CTE in main query
  const statusFilter = status ? status.toLowerCase() : null;

  return { where, params, paramIndex: idx, dateRange, statusFilter };
}

/**
 * Get tickets list with filters, search, sorting, and pagination.
 */
async function getTickets(params = {}) {
  const {
    tz = null,
    date_filter = 'today',
    start_date,
    end_date,
    status,
    search,
    order_id,
    truck_code,
    page = 1,
    limit = DEFAULT_LIMIT,
    sort_by = 'order_date',
    sort_order = 'desc'
  } = params;

  const { where, params: queryParams, paramIndex, dateRange, statusFilter } = buildFilters({
    tz,
    date_filter,
    start_date,
    end_date,
    status,
    search,
    order_id,
    truck_code
  });

  const allowedSort = [
    'order_date',
    'ticket_code',
    'truck_code',
    'created_date',
    'at_plant_time',
    'on_job_time',
    'unload_time',
    'end_unload'
  ];
  const sortField = allowedSort.includes(sort_by) ? sort_by : 'order_date';
  const sortDirection = sort_order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT));
  const offset = (pageNum - 1) * limitNum;

  // Build query with derived status in SQL to allow filtering and counting
  const sql = `
    WITH order_totals_agg AS (
      SELECT op.order_id, SUM(COALESCE(op.order_qty, 0)) as ordered_qty
      FROM order_products op
      WHERE op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true
      GROUP BY op.order_id
    ),
    ticket_data AS (
      SELECT
        t.ticket_id,
        t.ticket_code,
        timezone('UTC', t.created_date) as created_date,
        t.order_id,
        t.order_code,
        t.driver_name,
        e.phone as driver_phone,
        t.plant_name,
        t.plant_code,
        t.project_name,
        t.lot_block_number,
        t.truck_code,
        timezone('UTC', t.scheduled_on_job_time) as scheduled_on_job_time,
        timezone('UTC', t.printed_time) as printed_time,
        timezone('UTC', t.load_time) as load_time,
        timezone('UTC', t.loaded_time) as loaded_time,
        timezone('UTC', t.to_job_time) as to_job_time,
        timezone('UTC', t.on_job_time) as on_job_time,
        timezone('UTC', t.unload_time) as unload_time,
        timezone('UTC', t.wash_time) as wash_time,
        timezone('UTC', t.to_plant_time) as to_plant_time,
        timezone('UTC', t.at_plant_time) as at_plant_time,
        t.remove_reason_code,
        o.order_date,
        o.customer_name,
        TRIM(BOTH ', ' FROM
          COALESCE(NULLIF(o.delivery_addr1, ''), '') ||
          CASE WHEN o.delivery_addr2 IS NOT NULL AND o.delivery_addr2 != '' THEN ', ' || o.delivery_addr2 ELSE '' END ||
          CASE WHEN o.delivery_addr3 IS NOT NULL AND o.delivery_addr3 != '' THEN ', ' || o.delivery_addr3 ELSE '' END
        ) as delivery_address,
        p.address1 as plant_address1,
        p.address2 as plant_address2,
        p.phone as plant_phone,
        COALESCE(ota.ordered_qty, 0) as ordered_qty,
        COALESCE(tp.acc_delv_qty, 0) as running_qty,
        tr.code as truck_code_display,
        tr.description as truck_description,
        COALESCE(tr.latitude, o.latitude) as truck_latitude,
        COALESCE(tr.longitude, o.longitude) as truck_longitude,
        CASE
          WHEN t.remove_reason_code IS NOT NULL AND TRIM(t.remove_reason_code) != '' THEN 'cancelled'
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
        END as derived_status
      FROM tickets t
      LEFT JOIN orders o ON o.order_id = t.order_id
      LEFT JOIN plants p ON p.code = t.plant_code
      LEFT JOIN trucks tr ON tr.code = t.truck_code
      LEFT JOIN employees e ON e.code = t.driver_code
      LEFT JOIN ticket_products tp ON tp.ticket_id = t.ticket_id AND tp.is_mix = true
      LEFT JOIN order_totals_agg ota ON ota.order_id = t.order_id
      WHERE ${where.join(' AND ')}
    )
    SELECT *,
           COUNT(*) OVER() as total_count
    FROM ticket_data
    ${statusFilter ? `WHERE derived_status = $${paramIndex}` : ''}
    ORDER BY ${sortField} ${sortDirection} NULLS LAST
    LIMIT $${statusFilter ? paramIndex + 1 : paramIndex} OFFSET $${statusFilter ? paramIndex + 2 : paramIndex + 1}
  `;

  if (statusFilter) {
    queryParams.push(statusFilter);
  }
  queryParams.push(limitNum, offset);

  try {
    const result = await executeDirectSQL(sql, queryParams);
    const rows = result.data || [];

    const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    const statusCounts = {
      cancelled: 0,
      at_plant: 0,
      to_plant: 0,
      washing: 0,
      pouring: 0,
      at_job: 0,
      to_job: 0,
      loaded: 0,
      loading: 0,
      ticketed: 0,
      pending: 0
    };

    // Map rows to response tickets using list format (basic data only)
    const tickets = rows.map(row => {
      const ticket = formatTicketForList(row, tz);
      const derivedStatus = ticket.status;
      if (statusCounts.hasOwnProperty(derivedStatus)) {
        statusCounts[derivedStatus]++;
      }
      return ticket;
    });

    // Build simple order summary for returned page
    const orderSummary = {};
    tickets.forEach(t => {
      if (!t.order_id) return;
      if (!orderSummary[t.order_id]) {
        orderSummary[t.order_id] = {
          order_id: t.order_id,
          order_code: t.order_code,
          order_date: t.order_date,
          customer_name: t.customer_name,
          delivery_address: t.delivery_address,
          ordered_qty: t.ordered_qty || 0
        };
      }
    });

    // Fetch status colors from database (same as tracking API)
    const statusColors = await fetchTrackingStatusColors();

    return {
      tickets,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        total_pages: Math.ceil(totalCount / limitNum),
        has_next: pageNum * limitNum < totalCount,
        has_prev: pageNum > 1
      },
      filters: {
        date_filter,
        date_range: dateRange,
        status: status || null,
        search: search || null,
        order_id: order_id || null,
        truck_code: truck_code || null
      },
      status_counts: statusCounts,
      status_colors: statusColors,
      order_summary: Object.values(orderSummary)
    };
  } catch (error) {
    console.error('Error fetching tickets:', error);
    throw error;
  }
}

/**
 * Format a ticket record for the order tickets API response.
 * Matches the columns shown in the web app tickets table.
 * @param {object} row - Raw database row
 * @param {number} loadIndex - 1-based load number
 * @returns {object}
 */
function formatTicketForOrderView(row, loadIndex, tz = null) {
  const { status, remove_reason_code } = deriveTicketStatus(row);
  const statusDisplay = getStatusLabel(status, remove_reason_code);

  const statusTimestamp =
    row.at_plant_time || row.to_plant_time || row.wash_time ||
    row.unload_time || row.on_job_time || row.to_job_time ||
    row.loaded_time || row.load_time || row.printed_time ||
    row.created_date;

  return {
    load: loadIndex,
    ticket_code: row.ticket_code,
    truck: row.truck_code_display ? {
      truck_code: row.truck_code_display,
      truck_description: row.truck_description || '',
      latitude: row.truck_latitude || null,
      longitude: row.truck_longitude || null
    } : null,
    plant_location: {
      latitude: row.plant_latitude || null,
      longitude: row.plant_longitude || null
    },
    order_location: {
      latitude: row.order_latitude || null,
      longitude: row.order_longitude || null
    },
    load_qty: row.load_qty ? `${parseFloat(row.load_qty).toFixed(2)} CY` : null,
    run_qty_ord_qty: row.acc_delv_qty !== null && row.ordered_qty !== null
      ? `${parseFloat(row.acc_delv_qty || 0).toFixed(2)}/${parseFloat(row.ordered_qty || 0).toFixed(2)} CY`
      : null,
    running_qty: parseFloat(row.acc_delv_qty) || 0,
    ordered_qty: parseFloat(row.ordered_qty) || 0,
    status: status,
    status_display: statusDisplay,
    status_time: formatTimeCST(statusTimestamp, tz),
    remove_reason_code: remove_reason_code || null,
    product: row.item_code || null,
    timestamps: {
      eta_at_job: formatTimeCST(row.scheduled_on_job_time, tz),
      ticketed: formatTimeCST(row.printed_time, tz),
      loading: formatTimeCST(row.load_time, tz),
      loaded: formatTimeCST(row.loaded_time, tz),
      to_job: formatTimeCST(row.to_job_time, tz),
      at_job: formatTimeCST(row.on_job_time, tz),
      pouring: formatTimeCST(row.unload_time, tz),
      washing: formatTimeCST(row.wash_time, tz),
      to_plant: formatTimeCST(row.to_plant_time, tz),
      at_plant: formatTimeCST(row.at_plant_time, tz)
    },
    ordered_by_name: row.ordered_by_name ?? null,
    ordered_by_phone: row.ordered_by_phone ?? null,
    purchase_order: row.purchase_order ?? null,
    customer_job: row.customer_job ?? null,
    driver_name: row.driver_name ?? null,
    plant_name: row.plant_name ?? null,
    slump: row.verifi_slump
      ? (row.verifi_slump_units ? `${row.verifi_slump} ${row.verifi_slump_units}` : row.verifi_slump)
      : (row.order_slump ?? (row.slump != null ? String(row.slump) : null)),
    plant_address: [row.plant_address1, row.plant_address2, row.plant_address3]
      .filter(Boolean).join(', ') || null
  };
}

/**
 * Get all tickets for a specific order ID.
 * Returns ticket data matching the web app's ticket table view.
 * @param {number} orderId - The order ID to fetch tickets for
 * @param {object} options - Filter and sort options
 * @param {string|string[]} options.status - Status filter (single or array for multi-selection)
 * @param {number|number[]} options.load - Load number filter (single or array)
 * @param {string} options.sort_order - Sort direction: 'asc' or 'desc' (default: 'asc')
 * @returns {object} - Contains tickets array and order summary
 */
async function getTicketsByOrderId(orderId, options = {}) {
  if (!orderId) {
    throw new Error('Order ID is required');
  }

  const {
    tz = null,
    status,
    load,
    sort_order = 'desc'
  } = options;

  // Validate sort direction
  const sortDirection = sort_order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  // Parse status filter (supports comma-separated string or array)
  let statusArray = [];
  if (status) {
    if (Array.isArray(status)) {
      statusArray = status.map(s => s.toLowerCase().trim()).filter(Boolean);
    } else if (typeof status === 'string') {
      statusArray = status.split(',').map(s => s.toLowerCase().trim()).filter(Boolean);
    }
  }

  // Parse load filter (supports comma-separated string or array of numbers)
  let loadArray = [];
  if (load) {
    if (Array.isArray(load)) {
      loadArray = load.map(l => parseInt(l, 10)).filter(l => !isNaN(l));
    } else if (typeof load === 'string') {
      loadArray = load.split(',').map(l => parseInt(l.trim(), 10)).filter(l => !isNaN(l));
    } else if (typeof load === 'number') {
      loadArray = [load];
    }
  }

  // Build query parameters
  const queryParams = [orderId];
  let paramIndex = 2;

  // Build WHERE clause for outer query
  const outerWhere = [];

  // Status filter (multi-selection)
  if (statusArray.length > 0) {
    const statusPlaceholders = statusArray.map((_, i) => `$${paramIndex + i}`).join(', ');
    outerWhere.push(`derived_status IN (${statusPlaceholders})`);
    queryParams.push(...statusArray);
    paramIndex += statusArray.length;
  }

  // Load filter (multi-selection)
  if (loadArray.length > 0) {
    const loadPlaceholders = loadArray.map((_, i) => `$${paramIndex + i}`).join(', ');
    outerWhere.push(`load_number IN (${loadPlaceholders})`);
    queryParams.push(...loadArray);
    paramIndex += loadArray.length;
  }

  const outerWhereClause = outerWhere.length > 0 ? `WHERE ${outerWhere.join(' AND ')}` : '';

  // Main query: replaced per-row LATERAL for order_totals with a CTE (computed once)
  const sql = `
    WITH order_totals_cte AS (
      SELECT SUM(COALESCE(op.order_qty, 0)) as ordered_qty
      FROM order_products op
      WHERE op.order_id = $1 AND op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true
    ),
    ticket_data AS (
      SELECT
        t.id,
        t.ticket_id,
        t.ticket_code,
        t.order_id,
        t.order_code,
        t.truck_code,
        t.plant_code,
        t.plant_name,
        t.driver_name,
        timezone('UTC', t.scheduled_on_job_time) as scheduled_on_job_time,
        timezone('UTC', t.printed_time) as printed_time,
        timezone('UTC', t.load_time) as load_time,
        timezone('UTC', t.loaded_time) as loaded_time,
        timezone('UTC', t.to_job_time) as to_job_time,
        timezone('UTC', t.on_job_time) as on_job_time,
        timezone('UTC', t.unload_time) as unload_time,
        timezone('UTC', t.wash_time) as wash_time,
        timezone('UTC', t.to_plant_time) as to_plant_time,
        timezone('UTC', t.at_plant_time) as at_plant_time,
        t.remove_reason_code,
        timezone('UTC', t.created_date) as created_date,
        (t.verifi_json->'slumpFromTicket'->>'slump') as verifi_slump,
        (t.verifi_json->'slumpFromTicket'->>'slumpUnits') as verifi_slump_units,
        o.order_date,
        o.customer_name,
        o.project_name,
        o.ordered_by_name,
        o.ordered_by_phone,
        o.purchase_order,
        o.customer_job,
        o.weather_data,
        TRIM(BOTH ', ' FROM
          COALESCE(NULLIF(o.delivery_addr1, ''), '') ||
          CASE WHEN o.delivery_addr2 IS NOT NULL AND o.delivery_addr2 != '' THEN ', ' || o.delivery_addr2 ELSE '' END ||
          CASE WHEN o.delivery_addr3 IS NOT NULL AND o.delivery_addr3 != '' THEN ', ' || o.delivery_addr3 ELSE '' END
        ) as delivery_address,
        tp.item_code,
        tp.description as product_description,
        tp.load_qty,
        tp.acc_delv_qty,
        tp.slump,
        op_mix.slump as order_slump,
        p.address1 as plant_address1,
        p.address2 as plant_address2,
        p.address3 as plant_address3,
        COALESCE(otc.ordered_qty, 0) as ordered_qty,
        tr.code as truck_code_display,
        tr.description as truck_description,
        tr.latitude as truck_latitude,
        tr.longitude as truck_longitude,
        p.latitude as plant_latitude,
        p.longitude as plant_longitude,
        o.latitude as order_latitude,
        o.longitude as order_longitude,
        CASE
          WHEN t.remove_reason_code IS NOT NULL AND TRIM(t.remove_reason_code) != '' THEN true
          ELSE false
        END as is_cancelled,
        ROW_NUMBER() OVER (
          PARTITION BY CASE WHEN t.remove_reason_code IS NOT NULL AND TRIM(t.remove_reason_code) != '' THEN 1 ELSE 0 END
          ORDER BY t.ticket_code ASC
        ) as load_number,
        COUNT(*) OVER () as total_tickets_in_order,
        CASE
          WHEN t.remove_reason_code IS NOT NULL AND TRIM(t.remove_reason_code) != '' THEN 'cancelled'
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
        END as derived_status
      FROM tickets t
      INNER JOIN orders o ON o.order_id = t.order_id
      CROSS JOIN order_totals_cte otc
      LEFT JOIN trucks tr ON tr.code = t.truck_code
      LEFT JOIN plants p ON p.code = t.plant_code
      LEFT JOIN ticket_products tp ON tp.ticket_id = t.ticket_id AND tp.is_mix = true
      LEFT JOIN LATERAL (
        SELECT op_s.slump FROM order_products op_s
        WHERE op_s.order_id = t.order_id AND op_s.is_mix = true
        LIMIT 1
      ) op_mix ON true
      WHERE t.order_id = $1
    ),
    ticket_stats AS (
      SELECT
        COUNT(*) as total_before_filter,
        array_agg(DISTINCT derived_status) as all_statuses_in_order
      FROM ticket_data
    )
    SELECT td.*, ts.total_before_filter, ts.all_statuses_in_order
    FROM ticket_data td
    CROSS JOIN ticket_stats ts
    ${outerWhereClause}
    ORDER BY is_cancelled ASC, load_number ${sortDirection}
  `;

  try {
    const result = await executeDirectSQL(sql, queryParams);
    const rows = result.data || [];

    if (rows.length === 0) {
      // Check if order exists
      const orderCheck = await executeDirectSQL(
        'SELECT order_id, order_code, order_date, customer_name FROM orders WHERE order_id = $1',
        [orderId]
      );

      if (!orderCheck.data || orderCheck.data.length === 0) {
        return null; // Order not found
      }

      // Order exists but has no tickets (or no tickets match filters)
      const order = orderCheck.data[0];
      return {
        order: {
          order_id: order.order_id,
          order_code: order.order_code,
          order_date: order.order_date ? formatDateCST(order.order_date) : null,
          customer_name: order.customer_name || ''
        },
        tickets: [],
        filters: {
          applied: {
            status: statusArray.length > 0 ? statusArray : null,
            load: loadArray.length > 0 ? loadArray : null,
            sort_order: sort_order?.toLowerCase() === 'asc' ? 'asc' : 'desc'
          },
          available: {
            status: ['pending', 'ticketed', 'loading', 'loaded', 'to_job', 'at_job', 'pouring', 'washing', 'to_plant', 'at_plant', 'cancelled'],
            sort_order: ['desc', 'asc']
          }
        },
        summary: {
          total_tickets: 0,
          total_delivered_qty: 0,
          ordered_qty: 0
        }
      };
    }

    // Format tickets: active tickets get sequential load numbers, cancelled tickets get "-"
    const tickets = rows.map(row => {
      const loadDisplay = row.is_cancelled ? '-' : String(row.load_number);
      return formatTicketForOrderView(row, loadDisplay, tz);
    });

    // Calculate summary - EXCLUDE cancelled tickets from quantity calculations
    const nonCancelledRows = rows.filter(row => row.derived_status !== 'cancelled');
    const cancelledTickets = rows.filter(row => row.derived_status === 'cancelled').length;

    // Sum individual load_qty values from all non-cancelled tickets for progress display
    const totalDeliveredQty = nonCancelledRows.reduce((sum, row) => {
      const loadQty = parseFloat(row.load_qty) || 0;
      return sum + loadQty;
    }, 0);
    const orderedQty = parseFloat(rows[0]?.ordered_qty) || 0;

    // Build order info from first row
    const orderInfo = {
      order_id: rows[0].order_id,
      order_code: rows[0].order_code,
      order_date: rows[0].order_date ? formatDateCST(rows[0].order_date) : null,
      customer_name: rows[0].customer_name || '',
      project_name: rows[0].project_name || '',
      delivery_address: rows[0].delivery_address || '',
      ordered_by_name: rows[0].ordered_by_name || null,
      ordered_by_phone: rows[0].ordered_by_phone || null,
      weather_data: (() => {
        const wd = rows[0].weather_data;
        if (!wd) return null;
        if (typeof wd === 'object') return wd;
        if (typeof wd === 'string') {
          try { return JSON.parse(wd); } catch (e) { return null; }
        }
        return null;
      })()
    };

    // Get unique statuses and loads from current filtered data
    const statusesInFilteredData = [...new Set(rows.map(r => r.derived_status))];
    const loadsInFilteredData = rows.map(r => r.load_number);

    // Get active loads and all statuses from the order (before filter)
    // Only non-cancelled tickets count as loads (cancelled tickets show "-")
    const totalActiveLoadsInOrder = nonCancelledRows.length;
    const allStatusesInOrder = rows[0]?.all_statuses_in_order || statusesInFilteredData;
    const allLoadsInOrder = Array.from({ length: totalActiveLoadsInOrder }, (_, i) => i + 1);

    return {
      order: orderInfo,
      tickets,
      filters: {
        applied: {
          status: statusArray.length > 0 ? statusArray : null,
          load: loadArray.length > 0 ? loadArray : null,
          sort_order: sort_order?.toLowerCase() === 'asc' ? 'asc' : 'desc'
        },
        available: {
          status: ['pending', 'ticketed', 'loading', 'loaded', 'to_job', 'at_job', 'pouring', 'washing', 'to_plant', 'at_plant', 'cancelled'],
          load: allLoadsInOrder,
          sort_order: ['desc', 'asc']
        },
        in_order: {
          status: Array.isArray(allStatusesInOrder) ? allStatusesInOrder : [allStatusesInOrder],
          total_loads: totalActiveLoadsInOrder
        }
      },
      summary: {
        total_tickets: tickets.length,
        active_tickets: nonCancelledRows.length,
        cancelled_tickets: cancelledTickets,
        total_delivered_qty: parseFloat(totalDeliveredQty.toFixed(2)),
        ordered_qty: parseFloat(orderedQty),
        remaining_qty: parseFloat((orderedQty - totalDeliveredQty).toFixed(2)),
        progress_display: `${totalDeliveredQty.toFixed(2)} OF ${parseFloat(orderedQty).toFixed(2)} CY`
      },
      delivery_progress: await (async () => {
        const qtyByStatus = {};
        const countByStatus = {};
        for (const r of nonCancelledRows) {
          const st = r.derived_status;
          if (st && st !== 'pending') {
            qtyByStatus[st] = (qtyByStatus[st] || 0) + (parseFloat(r.load_qty) || 0);
            countByStatus[st] = (countByStatus[st] || 0) + 1;
          }
        }
        const progressColors = await fetchProgressBarColors();
        return buildDeliveryProgress(orderedQty, qtyByStatus, progressColors, countByStatus);
      })(),
      status_colors: await fetchTrackingStatusColors()
    };
  } catch (error) {
    console.error('Error fetching tickets by order ID:', error);
    throw error;
  }
}

/**
 * Get single ticket by order code, order date, and ticket code with related order/truck info.
 */
async function getTicketByCodeAndDate(orderCode, orderDate, ticketCode, tz = null) {
  const sql = `
    SELECT
      t.id,
      t.ticket_id,
      t.ticket_code,
      t.order_id,
      t.order_code,
      t.plant_code,
      t.plant_name,
      t.project_name,
      t.lot_block_number,
      t.driver_code,
      t.driver_name,
      t.truck_code,
      timezone('UTC', t.created_date) as created_date,
      t.remove_reason_code,
      timezone('UTC', t.scheduled_on_job_time) as scheduled_on_job_time,
      timezone('UTC', t.printed_time) as printed_time,
      timezone('UTC', t.load_time) as load_time,
      timezone('UTC', t.loaded_time) as loaded_time,
      timezone('UTC', t.to_job_time) as to_job_time,
      timezone('UTC', t.on_job_time) as on_job_time,
      timezone('UTC', t.unload_time) as unload_time,
      timezone('UTC', t.wash_time) as wash_time,
      timezone('UTC', t.to_plant_time) as to_plant_time,
      timezone('UTC', t.at_plant_time) as at_plant_time,
      t.verifi_json,
      t.eta_data,
      t.weather_data as ticket_weather_data,
      t.delivery_addr1 as ticket_delivery_addr1,
      t.delivery_addr2 as ticket_delivery_addr2,
      t.delivery_addr3 as ticket_delivery_addr3,
      o.order_date,
      o.customer_name,
      TRIM(BOTH ', ' FROM
        COALESCE(NULLIF(o.delivery_addr1, ''), '') ||
        CASE WHEN o.delivery_addr2 IS NOT NULL AND o.delivery_addr2 != '' THEN ', ' || o.delivery_addr2 ELSE '' END ||
        CASE WHEN o.delivery_addr3 IS NOT NULL AND o.delivery_addr3 != '' THEN ', ' || o.delivery_addr3 ELSE '' END
      ) as delivery_address,
      o.delivery_addr1 as order_delivery_addr1,
      o.delivery_addr2 as order_delivery_addr2,
      o.delivery_addr3 as order_delivery_addr3,
      p.address1 as plant_address1,
      p.address2 as plant_address2,
      p.phone as plant_phone,
      p.latitude as plant_latitude,
      p.longitude as plant_longitude,
      o.latitude as order_latitude,
      o.longitude as order_longitude,
      e.phone as driver_phone,
      COALESCE(order_totals.ordered_qty, 0) as ordered_qty,
      tr.code as truck_code_display,
      tr.description as truck_description,
      COALESCE(tr.latitude, o.latitude) as truck_latitude,
      COALESCE(tr.longitude, o.longitude) as truck_longitude,
      o.weather_data,
      CASE
        WHEN t.remove_reason_code IS NOT NULL AND TRIM(t.remove_reason_code) != '' THEN true
        ELSE false
      END as is_cancelled,
      load_number.load_num
    FROM tickets t
    INNER JOIN orders o ON o.order_id = t.order_id
    LEFT JOIN plants p ON p.code = t.plant_code
    LEFT JOIN trucks tr ON tr.code = t.truck_code
    LEFT JOIN employees e ON e.code = t.driver_code
    LEFT JOIN LATERAL (
      SELECT SUM(COALESCE(op.order_qty, 0)) as ordered_qty
      FROM order_products op
      WHERE op.order_id = t.order_id AND op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true
    ) order_totals ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) + 1 as load_num
      FROM tickets t2
      WHERE t2.order_id = t.order_id
        AND (t2.remove_reason_code IS NULL OR TRIM(t2.remove_reason_code) = '')
        AND t2.ticket_code < t.ticket_code
    ) load_number ON true
    WHERE TRIM(o.order_code) = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND TRIM(t.ticket_code) = $3
    LIMIT 1
  `;

  const normalizedOrderCode = orderCode ? String(orderCode).trim().toUpperCase() : '';
  const normalizedTicketCode = ticketCode ? String(ticketCode).trim().toUpperCase() : '';
  const result = await executeDirectSQL(sql, [normalizedOrderCode, orderDate, normalizedTicketCode]);
  const row = result.data?.[0];
  if (!row) return null;

  // Fetch products and spacing concurrently
  const productsSql = `
    SELECT id, ticket_id, item_code, description, is_mix, load_qty, order_qty, order_qty_unit, acc_delv_qty
    FROM ticket_products
    WHERE ticket_id = $1
  `;
  const spacingSql = `
    SELECT ops.truck_space
    FROM order_product_schedules ops
    INNER JOIN order_products op ON op.id = ops.order_product_id
    WHERE op.order_id = $1
      AND op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3')
      AND op.is_mix = true
    ORDER BY ops.start_time ASC
    LIMIT 1
  `;

  const [productsResult, spacingResult] = await Promise.all([
    executeDirectSQL(productsSql, [row.ticket_id]),
    row.order_id
      ? executeDirectSQL(spacingSql, [row.order_id])
      : Promise.resolve({ data: [] })
  ]);

  const products = productsResult.data || [];
  let spacingMinutes = null;
  if (spacingResult.data?.[0]?.truck_space != null) {
    spacingMinutes = parseInt(spacingResult.data[0].truck_space) || null;
  }

  // Return ticket-level weather_data (cached from previous fetch) if present, otherwise order-level
  let ticketWeather = null;
  const twRaw = row.ticket_weather_data;
  if (twRaw) {
    if (typeof twRaw === 'object') ticketWeather = twRaw;
    else if (typeof twRaw === 'string') { try { ticketWeather = JSON.parse(twRaw); } catch { /* ignore */ } }
  }

  const formatted = formatTicketForDetails(row, products, { spacingMinutes, weatherData: row.weather_data }, tz);
  formatted.fresh_weather = ticketWeather;
  return formatted;
}

/**
 * Fetch fresh weather for a ticket.
 * 1. If ticket.weather_data.fetched_at is < 5 min old → return cached.
 * 2. Otherwise fetch from OpenWeatherMap (truck location first, then geocode delivery addr).
 * 3. Calculate ACI 305R concrete evaporation using verifi temp.
 * 4. Save result to tickets.weather_data.
 */
async function fetchFreshTicketWeather(row) {
  const ticketId = row.ticket_id;

  // --- Resolve coordinates: truck location first, then geocode ---
  let lat = null;
  let lon = null;
  let source = 'truck_location';

  if (row.truck_code) {
    try {
      const truckSql = `SELECT code, latitude, longitude FROM trucks WHERE code = $1 LIMIT 1`;
      const truckResult = await executeDirectSQL(truckSql, [row.truck_code]);
      const truck = truckResult.data?.[0];
      if (truck) {
        lat = parseCoordinate(truck.latitude);
        lon = parseCoordinate(truck.longitude);
        if (lat !== null && lon !== null) {
          console.log(`[Ticket Weather] Ticket ${ticketId}: using truck ${row.truck_code} location: ${lat}, ${lon}`);
        }
      }
    } catch (err) {
      console.warn(`[Ticket Weather] Ticket ${ticketId}: truck lookup failed:`, err.message);
    }
  }

  if (lat === null || lon === null) {
    // Use ticket-level delivery address, fall back to order-level
    const addr = buildAddressString(
      row.ticket_delivery_addr1 || row.order_delivery_addr1,
      row.ticket_delivery_addr2 || row.order_delivery_addr2,
      row.ticket_delivery_addr3 || row.order_delivery_addr3
    );
    if (addr) {
      console.log(`[Ticket Weather] Ticket ${ticketId}: geocoding address: ${addr}`);
      const geo = await geocodeAddress(addr);
      if (geo) {
        lat = geo.lat;
        lon = geo.lon;
        source = 'geocoded_address';
      }
    }
  }

  if (lat === null || lon === null) {
    console.warn(`[Ticket Weather] Ticket ${ticketId}: no location data available`);
    return null;
  }

  // --- Fetch from OpenWeatherMap ---
  const weatherResponse = await fetchWeatherByCoordinates(lat, lon);
  if (!weatherResponse) {
    console.error(`[Ticket Weather] Ticket ${ticketId}: OpenWeatherMap API failed`);
    return null;
  }

  // Parse verifi_json
  let verifiJson = null;
  const vjRaw = row.verifi_json;
  if (vjRaw) {
    if (typeof vjRaw === 'object') verifiJson = vjRaw;
    else if (typeof vjRaw === 'string') { try { verifiJson = JSON.parse(vjRaw); } catch { /* ignore */ } }
  }

  // Build the full weather object (with ACI 305R concrete evaporation)
  const weatherData = buildTicketWeatherData(weatherResponse, lat, lon, source, verifiJson);

  console.log(`[Ticket Weather] Ticket ${ticketId}: fetched ${weatherData.temperature_fahrenheit}°F ${weatherData.weather_condition}` +
    (weatherData.concrete_evaporation_rate != null ? ` | concrete evap: ${weatherData.concrete_evaporation_rate} kg/m²/hr (${weatherData.concrete_evaporation_level})` : ''));

  // --- Persist to tickets.weather_data ---
  try {
    const updateSql = `UPDATE tickets SET weather_data = $1 WHERE ticket_id = $2`;
    await executeDirectSQL(updateSql, [JSON.stringify(weatherData), ticketId]);
  } catch (err) {
    console.error(`[Ticket Weather] Ticket ${ticketId}: failed to persist weather_data:`, err.message);
    // Still return the data even if persist fails
  }

  return weatherData;
}

/**
 * Fetch weather for a ticket by ID (called from POST /api/tickets/:ticketId/weather).
 * Same flow as web: check 5 min cache → fetch from OpenWeatherMap → save to tickets.weather_data.
 */
async function fetchTicketWeatherById(ticketId, forceRefresh = false) {
  const sql = `
    SELECT
      t.ticket_id,
      t.truck_code,
      t.to_job_time,
      t.at_plant_time,
      t.verifi_json,
      t.weather_data as ticket_weather_data,
      t.delivery_addr1 as ticket_delivery_addr1,
      t.delivery_addr2 as ticket_delivery_addr2,
      t.delivery_addr3 as ticket_delivery_addr3,
      o.delivery_addr1 as order_delivery_addr1,
      o.delivery_addr2 as order_delivery_addr2,
      o.delivery_addr3 as order_delivery_addr3
    FROM tickets t
    INNER JOIN orders o ON o.order_id = t.order_id
    WHERE t.ticket_id = $1
    LIMIT 1
  `;

  const result = await executeDirectSQL(sql, [ticketId]);
  const row = result.data?.[0];
  if (!row) return null;

  // Check condition: only fetch when to_job_time exists and at_plant_time is null
  if (!row.to_job_time || row.at_plant_time) {
    // Return cached ticket weather if any, otherwise null
    let cached = null;
    if (row.ticket_weather_data) {
      cached = typeof row.ticket_weather_data === 'object' ? row.ticket_weather_data : null;
      if (!cached && typeof row.ticket_weather_data === 'string') {
        try { cached = JSON.parse(row.ticket_weather_data); } catch { /* ignore */ }
      }
    }
    return {
      ticket_id: ticketId,
      weather_data: cached,
      cached: true
    };
  }

  // Check 5 min cache (unless force refresh)
  if (!forceRefresh) {
    let cached = null;
    if (row.ticket_weather_data) {
      if (typeof row.ticket_weather_data === 'object') cached = row.ticket_weather_data;
      else if (typeof row.ticket_weather_data === 'string') {
        try { cached = JSON.parse(row.ticket_weather_data); } catch { /* ignore */ }
      }
    }
    if (cached && cached.fetched_at && isCacheValid(cached.fetched_at, TICKET_WEATHER_CACHE_DURATION_MS)) {
      const ageMin = Math.round((Date.now() - new Date(cached.fetched_at).getTime()) / 60000);
      console.log(`[Ticket Weather] Ticket ${ticketId}: using cached weather (age: ${ageMin} min)`);
      return {
        ticket_id: ticketId,
        weather_data: cached,
        cached: true,
        cache_age_minutes: ageMin
      };
    }
  }

  // Fetch fresh weather
  const weatherData = await fetchFreshTicketWeather(row);
  if (!weatherData) {
    return {
      ticket_id: ticketId,
      weather_data: null,
      cached: false
    };
  }

  return {
    ticket_id: ticketId,
    weather_data: weatherData,
    cached: false
  };
}

/**
 * Calculate ETA for a ticket (same as web: POST /api/tickets/:ticketId/eta)
 * Uses AWS Location Services Route API with truck specs.
 */
async function calculateTicketETAById(ticketId, options = {}) {
  const { truckSpecs, optimizeFor, avoid, forceRecalculate } = options;

  // Get ticket with plant, truck, order coords
  const sql = `
    SELECT
      t.ticket_id, t.ticket_code, t.plant_code, t.truck_code, t.order_id, t.eta_data,
      p.latitude as plant_latitude, p.longitude as plant_longitude,
      o.latitude as order_latitude, o.longitude as order_longitude
    FROM tickets t
    LEFT JOIN plants p ON p.code = t.plant_code
    INNER JOIN orders o ON o.order_id = t.order_id
    WHERE t.ticket_id = $1
    LIMIT 1
  `;
  const result = await executeDirectSQL(sql, [ticketId]);
  const row = result.data?.[0];
  if (!row) return null;

  // Return cached if not force recalculate
  if (!forceRecalculate && row.eta_data) {
    const etaData = typeof row.eta_data === 'object' ? row.eta_data :
      (typeof row.eta_data === 'string' ? (() => { try { return JSON.parse(row.eta_data); } catch { return null; } })() : null);
    if (etaData) return etaData;
  }

  // Resolve origin: truck location (priority) → plant location (fallback)
  let originLat = null;
  let originLng = null;

  if (row.truck_code) {
    try {
      const truckSql = `SELECT latitude, longitude, location_update_time FROM trucks WHERE code = $1 LIMIT 1`;
      const truckResult = await executeDirectSQL(truckSql, [row.truck_code]);
      const truck = truckResult.data?.[0];
      if (truck && truck.latitude && truck.longitude) {
        const truckUpdateTime = truck.location_update_time ? new Date(truck.location_update_time).getTime() : 0;
        const THIRTY_MINUTES_MS = 30 * 60 * 1000;
        const isRecent = (Date.now() - truckUpdateTime) < THIRTY_MINUTES_MS || !truck.location_update_time;
        if (isRecent) {
          const lat = parseFloat(truck.latitude);
          const lng = parseFloat(truck.longitude);
          if (!isNaN(lat) && !isNaN(lng)) {
            originLat = lat;
            originLng = lng;
            console.log(`[ETA] Ticket ${ticketId}: using truck ${row.truck_code} location: ${lat}, ${lng}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[ETA] Ticket ${ticketId}: truck lookup failed:`, err.message);
    }
  }

  // Fallback to plant
  if (originLat === null || originLng === null) {
    const plantLat = row.plant_latitude ? parseFloat(row.plant_latitude) : null;
    const plantLng = row.plant_longitude ? parseFloat(row.plant_longitude) : null;
    if (!plantLat || !plantLng) {
      throw new Error('Origin coordinates not available. Please ensure truck or plant location has valid coordinates.');
    }
    originLat = plantLat;
    originLng = plantLng;
    console.log(`[ETA] Ticket ${ticketId}: using plant location: ${originLat}, ${originLng}`);
  }

  // Destination: job site
  const destLat = row.order_latitude ? parseFloat(row.order_latitude) : null;
  const destLng = row.order_longitude ? parseFloat(row.order_longitude) : null;
  if (!destLat || !destLng) {
    throw new Error('Job site coordinates not available. Please ensure the order has valid coordinates.');
  }

  // Calculate via AWS
  const etaData = await calculateTruckETA(originLat, originLng, destLat, destLng, truckSpecs, { optimizeFor, avoid });

  // Save to DB
  try {
    const updateSql = `UPDATE tickets SET eta_data = $1 WHERE ticket_id = $2`;
    await executeDirectSQL(updateSql, [JSON.stringify(etaData), ticketId]);
    console.log(`[ETA] Ticket ${ticketId}: saved successfully`);
  } catch (err) {
    console.error(`[ETA] Ticket ${ticketId}: failed to save:`, err.message);
  }

  return etaData;
}

/**
 * Get cached ETA data for a ticket
 */
async function getTicketETAById(ticketId) {
  const sql = `SELECT eta_data FROM tickets WHERE ticket_id = $1 LIMIT 1`;
  const result = await executeDirectSQL(sql, [ticketId]);
  const row = result.data?.[0];
  if (!row) return null;

  if (!row.eta_data) return null;

  if (typeof row.eta_data === 'object') return row.eta_data;
  if (typeof row.eta_data === 'string') {
    try { return JSON.parse(row.eta_data); } catch { return null; }
  }
  return null;
}

module.exports = {
  getTickets,
  getTicketByCodeAndDate,
  getTicketsByOrderId,
  fetchTicketWeatherById,
  calculateTicketETAById,
  getTicketETAById,
  deriveTicketStatus,
  getStatusLabel,
  formatTicketForList,
  formatTicketForDetails,
  formatTicketForOrderView
};

