/**
 * Order Service
 *
 * Business logic for order management in mobile app.
 * Provides order listing, filtering, and detail retrieval.
 *
 * Filters applied:
 * 1. Only products with order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND is_mix = true (concrete mixes only)
 * 2. Cancelled = removed=true AND remove_reason_code is non-empty (AND, not OR)
 * 3. Applies exclusion patterns from excluded_order_patterns table
 *    - Customer / Product / Delivery address: substring LIKE match
 *    - Count endpoints use affects_counts=true subset
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');
const { fetchExclusionPatterns } = require('./exclusionPatternService');
const { getSupabaseAdmin } = require('../config/database');

/**
 * Get timezone abbreviation (CST/CDT/EST/etc.) from IANA timezone name.
 * Dynamically resolves DST — returns "CDT" in summer, "CST" in winter automatically.
 * @param {Object|null} tz - Timezone object { iana: "America/Chicago" } or null
 * @param {Date} [date] - Date to resolve abbreviation for (defaults to now)
 * @returns {string} Abbreviation like "CST" or empty string if no tz
 */
function getTzAbbr(tz, date) {
  if (!tz || !tz.iana) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz.iana,
      timeZoneName: 'short'
    }).formatToParts(date || new Date());
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    return tzPart ? tzPart.value : '';
  } catch {
    return '';
  }
}

/**
 * Append timezone abbreviation to a formatted time string.
 * @param {string|null} timeStr - Formatted time (e.g., "11:00" or "09:00AM")
 * @param {Object|null} tz - Timezone object { iana: "America/Chicago" }
 * @param {Date} [date] - Date context for DST resolution
 * @returns {string|null} Time with tz suffix (e.g., "11:00 CST") or original if no tz
 */
function appendTz(timeStr, tz, date) {
  // Timezone suffix removed — time still converts to correct timezone,
  // abbreviation label (CDT, EDT, etc.) is no longer appended.
  return timeStr || null;
}

/**
 * Strip timezone abbreviation suffix (e.g., " CDT", " PDT") from a formatted time string.
 * Time still converts to the correct timezone — only the label is removed.
 */
function stripTzAbbr(str) {
  if (!str) return str;
  return str.replace(/\s+[A-Z]{2,5}$/, '');
}

/**
 * Order Status Enum
 * Maps numeric status codes to display names
 */
const ORDER_STATUS = {
  CANCELLED: 'Canceled',
  NORMAL: 'Normal',
  WILL_CALL: 'Will Call',
  WEATHER_PERMITTING: 'Weather Permitting',
  HOLD_DELIVERY: 'Hold Delivery',
  COMPLETED: 'Completed',
  WAIT_LIST: 'Wait List',
  IN_PROGRESS: 'In Progress'
};

/**
 * Status code mapping from database
 * current_status values: 0=Normal, 1=Will Call, 2=Weather Permitting, 3=Hold Delivery, 4=Completed, 5=Wait List
 */
const STATUS_CODE_MAP = {
  '0': ORDER_STATUS.NORMAL,
  '1': ORDER_STATUS.WILL_CALL,
  '2': ORDER_STATUS.WEATHER_PERMITTING,
  '3': ORDER_STATUS.HOLD_DELIVERY,
  '4': ORDER_STATUS.COMPLETED,
  '5': ORDER_STATUS.WAIT_LIST
};

// Ticket status display mapping (used in multiple functions)
const STATUS_DISPLAY = {
  cancelled: 'Cancelled', at_plant: 'At Plant', to_plant: 'To Plant',
  washing: 'Washing', pouring: 'Pouring', at_job: 'At Job',
  to_job: 'To Job', loaded: 'Loaded', loading: 'Loading',
  ticketed: 'Ticketed', pending: 'Pending'
};

// Delivery progress bar: status order (most progressed first: at_plant → ticketed)
// Colors are fetched from system_config table (config_key = 'progress_bar_colors')
const PROGRESS_STATUSES = [
  { status: 'at_plant', status_display: 'At Plant' },
  { status: 'to_plant', status_display: 'To Plant' },
  { status: 'washing', status_display: 'Washing' },
  { status: 'pouring', status_display: 'Pouring' },
  { status: 'at_job', status_display: 'At Job' },
  { status: 'to_job', status_display: 'To Job' },
  { status: 'loaded', status_display: 'Loaded' },
  { status: 'loading', status_display: 'Loading' },
  { status: 'ticketed', status_display: 'Ticketed' }
];


// Default progress bar colors (matching mobile app & web)
// No hardcoded defaults — all progress bar colors come from database (system_config)

// Cache for progress bar colors from system_config (5 min TTL)
let _progressBarColorsCache = null;
let _progressBarColorsCacheTime = 0;
const PROGRESS_COLORS_CACHE_TTL = 0;

/**
 * Fetch progress bar colors from system_config table in Supabase.
 * Returns a map like { loading: '#FFC107', to_job: '#2196F3', ... }
 * Fully dynamic — returns only DB colors, no hardcoded defaults.
 */
async function fetchProgressBarColors() {
  const now = Date.now();
  if (_progressBarColorsCache && (now - _progressBarColorsCacheTime) < PROGRESS_COLORS_CACHE_TTL) {
    return _progressBarColorsCache;
  }
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('system_config')
      .select('config_value')
      .eq('config_key', 'progress_bar_colors')
      .single();

    if (error || !data) return {};

    const parsed = typeof data.config_value === 'string'
      ? JSON.parse(data.config_value)
      : data.config_value;

    _progressBarColorsCache = parsed || {};
    _progressBarColorsCacheTime = now;
    return _progressBarColorsCache;
  } catch {
    return {};
  }
}

// Cache for tracking status colors from system_config (5 min TTL, DB-only, no defaults)
let _trackingStatusColorsCache = null;
let _trackingStatusColorsCacheTime = 0;

/**
 * Fetch tracking status colors ONLY from the database (system_config).
 * Returns only what's stored in the DB — no hardcoded fallbacks.
 * Used by the tracking endpoint so colors are fully dynamic.
 */
async function fetchTrackingStatusColors() {
  const now = Date.now();
  if (_trackingStatusColorsCache && (now - _trackingStatusColorsCacheTime) < PROGRESS_COLORS_CACHE_TTL) {
    return _trackingStatusColorsCache;
  }
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('system_config')
      .select('config_value')
      .eq('config_key', 'progress_bar_colors')
      .single();

    if (error || !data) return {};

    const parsed = typeof data.config_value === 'string'
      ? JSON.parse(data.config_value)
      : data.config_value;

    // Only include non-empty string values
    const dbColors = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      if (typeof value === 'string' && value.trim()) {
        dbColors[key] = value;
      }
    }

    // Map aliases (loaded = loading, returning = to_plant) if not explicitly set
    if (dbColors.loading && !dbColors.loaded) dbColors.loaded = dbColors.loading;
    if (dbColors.to_plant && !dbColors.returning) dbColors.returning = dbColors.to_plant;

    _trackingStatusColorsCache = dbColors;
    _trackingStatusColorsCacheTime = now;
    return _trackingStatusColorsCache;
  } catch {
    return {};
  }
}

/**
 * Build delivery_progress object from per-status quantities
 * @param {number} totalQty - Total ordered quantity
 * @param {object} qtyByStatus - { ticketed, loading, loaded, to_job, at_job, pouring, washing, to_plant, at_plant }
 * @param {object|null} colorMap - Optional color map from system_config (e.g. { loading: '#FFC107', ... })
 * @param {object|null} countByStatus - Optional ticket counts per status (e.g. { loading: 2, to_job: 1, ... })
 * @returns {object} delivery_progress with segments array
 */
function buildDeliveryProgress(totalQty, qtyByStatus, colorMap, countByStatus) {
  const fix2 = v => parseFloat(v.toFixed(2));
  const pct1 = (v, t) => t > 0 ? parseFloat(((v / t) * 100).toFixed(1)) : 0;

  // Per-status quantities
  const ticketed = qtyByStatus.ticketed || 0;
  const loading = qtyByStatus.loading || 0;
  const loaded = qtyByStatus.loaded || 0;
  const toJob = qtyByStatus.to_job || 0;
  const atJob = qtyByStatus.at_job || 0;
  const pouring = qtyByStatus.pouring || 0;
  const washing = qtyByStatus.washing || 0;
  const toPlant = qtyByStatus.to_plant || 0;
  const atPlant = qtyByStatus.at_plant || 0;

  // Phase aggregates (each ticket counted once in its current status)
  const dispatchedQty = ticketed + loading + loaded + toJob + atJob + pouring + washing + toPlant + atPlant;
  const inTransitQty = ticketed + loading + loaded + toJob;  // at plant or on the way
  const onSiteQty = atJob;                                 // arrived at job, waiting to pour
  const pouringQty = pouring;                               // actively pouring
  const pouredQty = washing + toPlant + atPlant;           // pour complete, truck returning
  const deliveredQty = atJob + pouring + washing + toPlant + atPlant;  // reached job site or beyond
  const remainingQty = Math.max(0, fix2(totalQty - dispatchedQty));

  // Combine into 5 active statuses (same as web: loading+loaded, to_job, at_job, pouring, washing+to_plant+at_plant)
  // ticketed → excluded (goes to remaining)
  const cnt = countByStatus || {};
  const combined = [
    { status: 'loading', colorKey: 'loading', status_display: 'Loading', qty: fix2(loading + loaded), ticketCount: (cnt.loading || 0) + (cnt.loaded || 0) },
    { status: 'to_job', colorKey: 'to_job', status_display: 'To Job', qty: fix2(toJob), ticketCount: cnt.to_job || 0 },
    { status: 'at_job', colorKey: 'at_job', status_display: 'At Job', qty: fix2(atJob), ticketCount: cnt.at_job || 0 },
    { status: 'pouring', colorKey: 'pouring', status_display: 'Pouring', qty: fix2(pouring), ticketCount: cnt.pouring || 0 },
    { status: 'at_plant', colorKey: 'poured', status_display: 'Poured', qty: fix2(washing + toPlant + atPlant), ticketCount: (cnt.washing || 0) + (cnt.to_plant || 0) + (cnt.at_plant || 0) },
  ];

  const activeQty = combined.reduce((sum, s) => sum + s.qty, 0);
  const displayTotal = activeQty + remainingQty;

  const effectiveColorMap = colorMap || {};
  const segments = [
    ...combined.map(s => ({
      status: s.status,
      status_display: s.status_display,
      qty: s.qty,
      percentage: pct1(s.qty, displayTotal),
      label: `${s.qty.toFixed(1)} ${process.env.VOLUME_UNIT || 'CY'} ${s.status_display}`,
      color: effectiveColorMap[s.colorKey] || effectiveColorMap[s.status] || null,
      ticketCount: s.ticketCount
    })),
    {
      status: 'remaining',
      status_display: 'Remaining',
      qty: remainingQty,
      percentage: pct1(remainingQty, displayTotal),
      label: `${remainingQty.toFixed(1)} ${process.env.VOLUME_UNIT || 'CY'} Remaining`,
      color: effectiveColorMap['remaining'] || null,
      ticketCount: 0
    }
  ];

  return {
    total_qty: fix2(totalQty),
    segments,
    dispatched_qty: fix2(dispatchedQty),
    in_transit_qty: fix2(inTransitQty),
    on_site_qty: fix2(onSiteQty),
    pouring_qty: fix2(pouringQty),
    poured_qty: fix2(pouredQty),
    delivered_qty: fix2(deliveredQty),
    remaining_qty: remainingQty,
    dispatched_percentage: pct1(dispatchedQty, totalQty),
    delivered_percentage: pct1(deliveredQty, totalQty),
    poured_percentage: pct1(pouredQty, totalQty),
    overall_percentage: pct1(deliveredQty, totalQty)
  };
}

/**
 * Get date range for filter
 *
 * @param {string} filter - Date filter type
 * @returns {object} { startDate, endDate } in YYYY-MM-DD format
 */
function getDateRange(filter, tz = null) {
  // Use the user's timezone (from X-Timezone header or tenant setting) to determine "today".
  // Falls back to America/Chicago if no timezone provided.
  // new Date() alone would use UTC, causing wrong dates after 6 PM CST.
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

  const today = new Date(
    parseInt(cstDateMap.year, 10),
    parseInt(cstDateMap.month, 10) - 1,
    parseInt(cstDateMap.day, 10),
    0, 0, 0, 0
  );

  let startDate = new Date(today);
  let endDate = new Date(today);

  switch (filter?.toLowerCase()) {
    case 'today':
      // Today: start and end are today
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'tomorrow':
      // Tomorrow: one day after today
      startDate.setDate(startDate.getDate() + 1);
      endDate = new Date(startDate);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'yesterday':
      // Yesterday: one day before today
      startDate.setDate(startDate.getDate() - 1);
      endDate = new Date(startDate);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'last_week':
    case 'lastweek':
      // Last week (Monday to Sunday) - exact web logic from date-utils.ts:178-198
      {
        // Get the start of current week (Monday)
        const currentWeekStart = new Date(today);
        const dayOfWeekLast = today.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
        const daysToMonday = dayOfWeekLast === 0 ? 6 : dayOfWeekLast - 1; // Days to subtract to get to Monday
        currentWeekStart.setDate(today.getDate() - daysToMonday);
        currentWeekStart.setHours(0, 0, 0, 0);

        // Get the start of last week (previous Monday)
        const lastWeekStart = new Date(currentWeekStart);
        lastWeekStart.setDate(currentWeekStart.getDate() - 7);

        // Get the end of last week (previous Sunday)
        const lastWeekEnd = new Date(lastWeekStart);
        lastWeekEnd.setDate(lastWeekStart.getDate() + 6);
        lastWeekEnd.setHours(23, 59, 59, 999);

        startDate = lastWeekStart;
        endDate = lastWeekEnd;
      }
      break;

    case 'next_week':
    case 'nextweek':
      // Next week (Monday to Sunday) - exact web logic from date-utils.ts:42-70
      {
        // Get next Monday (start of next week)
        const nextMonday = new Date(today);
        const dayOfWeekNext = today.getDay();
        const daysUntilMonday = (1 - dayOfWeekNext + 7) % 7;
        nextMonday.setDate(today.getDate() + (daysUntilMonday === 0 ? 7 : daysUntilMonday));

        // Get next Sunday (end of next week)
        const nextSunday = new Date(nextMonday);
        nextSunday.setDate(nextMonday.getDate() + 6);

        startDate = new Date(nextMonday.getFullYear(), nextMonday.getMonth(), nextMonday.getDate());
        endDate = new Date(nextSunday.getFullYear(), nextSunday.getMonth(), nextSunday.getDate(), 23, 59, 59, 999);
      }
      break;

    case 'next_month':
    case 'nextmonth':
      // Next 30 days
      endDate.setDate(endDate.getDate() + 30);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'this_week':
    case 'thisweek':
      // Current week (Sunday to Saturday)
      const dayOfWeek = today.getDay();
      startDate.setDate(startDate.getDate() - dayOfWeek);
      endDate.setDate(startDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
      break;

    case 'this_month':
    case 'thismonth':
      // Current month
      startDate.setDate(1);
      endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
      break;

    default:
      // Default to today
      endDate.setHours(23, 59, 59, 999);
  }

  return {
    startDate: formatDate(startDate),
    endDate: formatDate(endDate)
  };
}

/**
 * Format date to YYYY-MM-DD
 *
 * @param {Date} date - Date object
 * @returns {string} Formatted date string
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Convert a calendar date (YYYY-MM-DD) to the UTC instant of that day's midnight
 * in the given IANA timezone, returned as an ISO timestamp string. DST-safe via
 * a two-pass offset resolution.
 *
 * Used to build tenant-timezone-aware order_date filter bounds. order_date is a
 * `timestamp with time zone`; filtering on tenant-local midnight (rather than
 * plain date strings, which Postgres evaluates in the UTC session) keeps the
 * mobile day boundary identical to the web frontend.
 *
 * @param {string} dateStr - Calendar date 'YYYY-MM-DD'
 * @param {string} timeZone - IANA timezone (e.g. 'America/New_York')
 * @returns {string} ISO UTC timestamp of local midnight (e.g. '2026-06-09T04:00:00.000Z')
 */
function zonedMidnightToUTCISO(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const baseUTC = Date.UTC(y, m - 1, d, 0, 0, 0);

  // Offset (local - utc, in ms) that `timeZone` has at a given UTC instant.
  const offsetMsAt = (utcMs) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(utcMs));
    const p = {};
    for (const part of parts) p[part.type] = part.value;
    const hour = p.hour === '24' ? 0 : Number(p.hour);
    const localAsUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
    return localAsUTC - utcMs;
  };

  // Two-pass: estimate with the offset at UTC-midnight, then refine so DST
  // transitions resolve to the correct local-midnight instant.
  let utc = baseUTC - offsetMsAt(baseUTC);
  utc = baseUTC - offsetMsAt(utc);
  return new Date(utc).toISOString();
}

/**
 * Format date to YYYY-MM-DD using UTC extraction (for DATE-type columns)
 *
 * PostgreSQL DATE columns store plain calendar dates. The pg driver maps them
 * to JavaScript Date objects at midnight UTC (e.g., "2026-02-18" → 2026-02-18T00:00:00.000Z).
 * Using CST conversion would shift midnight UTC back to the previous day (6 PM CST on Feb 17).
 * Instead, use UTC methods to extract the raw calendar date — matches the web frontend which
 * does dateString.split("T")[0] without timezone conversion.
 *
 * @param {string|Date} dateValue - Date value from DB (DATE type)
 * @returns {string} Formatted date string YYYY-MM-DD
 */
function formatDateCST(dateValue) {
  if (!dateValue) return null;

  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (isNaN(date.getTime())) return null;

  // Use UTC methods to extract the raw calendar date from the pg driver's Date object
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Format time to HH:MM AM/PM in CST timezone (UTC-6)
 *
 * @param {string|Date} time - UTC time value
 * @param {Object|null} [tz] - Tenant timezone { iana: "America/Chicago" }
 * @returns {string} Formatted time string in CST (e.g., "09:00AM CST")
 */
function formatTimeCST(time, tz) {
  if (!time) return null;

  const date = time instanceof Date ? new Date(time) : new Date(time);
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
    hour12: true
  }).format(realUtc);

  return formatted.replace(' ', '');
}

/**
 * Format full datetime in CST (e.g., "13 Feb 2026 08:15 CST")
 *
 * @param {string|Date} dateTime - Date/time value
 * @param {Object|null} [tz] - Tenant timezone { iana: "America/Chicago" }
 * @returns {string|null} Formatted datetime string
 */
function formatDateTimeCST(dateTime, tz) {
  if (!dateTime) return null;

  const date = dateTime instanceof Date ? new Date(dateTime) : new Date(dateTime);
  if (isNaN(date.getTime())) return null;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Convert to target timezone using Intl.DateTimeFormat
  const timeZone = tz?.iana || 'America/Chicago';
  const cstParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).formatToParts(date);

  const parts = {};
  for (const p of cstParts) {
    parts[p.type] = p.value;
  }

  const day = parts.day;
  const month = months[parseInt(parts.month, 10) - 1];
  const year = parts.year;
  const hour = parts.hour;
  const minute = parts.minute;
  const period = parts.dayPeriod;

  return `${day} ${month} ${year} ${hour}:${minute}${period}`;
}


/**
 * Format time to HH:MM AM/PM in tenant timezone
 *
 * @param {string|Date} time - Time value (CST stored in DB)
 * @param {Object|null} [tz] - Tenant timezone { iana: "America/Chicago" }
 * @returns {string} Formatted time string in 12h format (e.g., "10:00 PM CST")
 */
function formatTime(time, tz) {
  if (!time) return null;

  let date;
  if (time instanceof Date) {
    date = time;
  } else {
    date = new Date(time);
  }

  if (isNaN(date.getTime())) {
    // Try parsing as time string (HH:MM or HH:MM:SS)
    const timeMatch = String(time).match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      const hours = parseInt(timeMatch[1], 10);
      const minutes = timeMatch[2];
      const period = hours >= 12 ? 'PM' : 'AM';
      const h12 = hours % 12 || 12;
      const result = `${String(h12).padStart(2, '0')}:${minutes}${period}`;
      return appendTz(result, tz);
    }
    return null;
  }

  // Convert to target timezone using Intl.DateTimeFormat
  const timeZone = tz?.iana || 'America/Chicago';
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date);

  return appendTz(formatted.replace(' ', ''), tz, date);
}

/**
 * Format date for display (DD MMM YYYY)
 *
 * @param {string|Date} dateTime - Date/time value
 * @returns {string} Formatted date string (e.g., "08 Apr 2025")
 */
function formatDisplayDateTime(orderDate) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let date;
  if (orderDate instanceof Date) {
    date = orderDate;
  } else {
    date = new Date(orderDate);
  }

  if (isNaN(date.getTime())) {
    return null;
  }

  // Use UTC methods to extract raw calendar date (same as formatDateCST - see comment there)
  // Web frontend does dateString.split("T")[0] without timezone conversion
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();

  return `${day} ${month} ${year}`;
}

/**
 * Calculate order status based on order data
 * Matches the web app logic:
 * - Removed = true AND remove_reason_code has length > 0 → 'Canceled'
 * - current_status: 0=Normal, 1=Will Call, 2=Weather Permitting, 3=Hold Delivery, 4=Completed, 5=Wait List
 *
 * @param {object} order - Order data
 * @returns {string} Order status
 */
function calculateOrderStatus(order) {
  // Check if cancelled (removed = true AND remove_reason_code has length > 0)
  // This matches the web app logic
  if ((order.removed === true || order.removed === 'true') &&
    order.remove_reason_code !== null &&
    String(order.remove_reason_code || '').length > 0) {
    return ORDER_STATUS.CANCELLED;
  }

  // Get current_status as string for mapping
  const statusCode = String(order.current_status || '0');

  // Check if completed by status code (4 = Completed)
  if (statusCode === '4') {
    return ORDER_STATUS.COMPLETED;
  }

  // Check if completed based on delivered qty
  const orderedQty = parseFloat(order.ordered_qty) || 0;
  const deliveredQty = parseFloat(order.delivered_qty) || 0;

  if (orderedQty > 0 && deliveredQty >= orderedQty) {
    return ORDER_STATUS.COMPLETED;
  }

  // Check if completed based on last ticket completion + 0.02 CY tolerance (web parity)
  if (deliveredQty > 0 && (order.is_last_load_completed === true || order.is_last_load_completed === 'true') &&
    (orderedQty - deliveredQty) <= 0.02) {
    return ORDER_STATUS.COMPLETED;
  }

  // Check if in progress (has some deliveries but not completed)
  if (deliveredQty > 0 && deliveredQty < orderedQty) {
    return ORDER_STATUS.IN_PROGRESS;
  }

  // Map from current_status code: 0=Normal, 1=Will Call, 2=Weather Permitting, 3=Hold Delivery, 5=Wait List
  return STATUS_CODE_MAP[statusCode] || ORDER_STATUS.NORMAL;
}

/**
 * Get orders list with filters and access control
 *
 * @param {object} params - Query parameters
 * @param {string} params.date_filter - Date filter (today, yesterday, last_week, next_week, next_month)
 * @param {string} params.start_date - Custom start date (YYYY-MM-DD)
 * @param {string} params.end_date - Custom end date (YYYY-MM-DD)
 * @param {string} params.status - Status filter (Normal, Will Call, Hold Delivery, Completed, Wait List, Canceled, In Progress)
 * @param {string} params.search - Search query (order code, customer name, address)
 * @param {number} params.page - Page number (default: 1)
 * @param {number} params.limit - Items per page (default: 10, optimized for mobile)
 * @param {string} params.sort_by - Sort field (order_date, order_code, customer_name, start_time, ordered_qty, delivered_qty, status)
 * @param {string} params.sort_order - Sort order: desc = High to Low, asc = Low to High
 * @param {object} userAccess - User access control data from req.user
 * @param {boolean} userAccess.isAdmin - Is user admin
 * @param {string} userAccess.userType - User type (admin/producer/contractor)
 * @param {string[]} userAccess.allowedPlants - Allowed plant codes for producer
 * @param {string[]} userAccess.allowedPlants - Allowed plant codes (includes zone-derived plants)
 * @param {(string|number)[]} userAccess.allowedCustomerIds - Allowed customer IDs for contractor
 * @returns {Promise<object>} Orders list with pagination
 */
async function getOrders(params = {}, userAccess = null) {
  const {
    date_filter = 'today',
    start_date,
    end_date,
    status,
    search,
    page = 1,
    limit = 10,
    sort_by = 'order_date',
    sort_order = 'desc',
    company_name,
    region_name,
    plant_code,
    plant_name,
    is_favourite_filter,
    favourite_order_ids,
    tab
  } = params;

  const userTz = userAccess?.timezone || null;
  // The orders "day" follows the tenant's business timezone (BUSINESS_TIMEZONE),
  // matching the web frontend — not the DB session TZ or the user's personal tz.
  const tzIana = process.env.BUSINESS_TIMEZONE || userTz?.iana || 'America/New_York';
  // Display formatting uses the user's personal timezone when set, otherwise the
  // tenant business timezone — never an unrelated default (previously Central).
  const tz = userTz || { iana: tzIana };

  // Determine date range (computed in the tenant timezone so "today" is correct)
  let dateRange;
  if (start_date && end_date) {
    dateRange = { startDate: start_date, endDate: end_date };
  } else {
    dateRange = getDateRange(date_filter, { iana: tzIana });
  }

  // Fetch exclusion patterns and progress bar colors in parallel.
  // Use affects_counts=true subset so order counts mirror the web frontend
  // summary card (src/actions/orderActions.ts getAllSummaryData).
  const [exclusionPatterns, progressBarColors] = await Promise.all([
    fetchExclusionPatterns({ affectsCountsOnly: true }),
    fetchProgressBarColors()
  ]);

  // Compute exclusive end date (day after endDate) to match frontend date filtering
  // Frontend passes next-day string directly: order_date >= 'YYYY-MM-DD' AND order_date < 'YYYY-MM-DD+1'
  const endDateObj = new Date(dateRange.endDate + 'T00:00:00');
  endDateObj.setDate(endDateObj.getDate() + 1);
  const endDateExclusive = formatDate(endDateObj);

  // order_date is `timestamp with time zone`. Comparing it against plain date
  // strings would be evaluated in the DB session TZ (UTC) and mis-bucket
  // late-evening local orders into the wrong day. Convert the window to the
  // tenant timezone's local midnight (as UTC timestamptz) so the day boundary
  // matches the web frontend exactly (half-open [start, end)).
  const startBound = zonedMidnightToUTCISO(dateRange.startDate, tzIana);
  const endBound = zonedMidnightToUTCISO(endDateExclusive, tzIana);

  // Build query with all required filters
  let whereConditions = [
    'o.order_date >= $1',
    'o.order_date < $2'
  ];
  let queryParams = [startBound, endBound];
  let paramIndex = 3;

  // Add exclusion pattern filters.
  // Matches web frontend filterExcludedOrders (src/lib/order-filters.ts):
  // all pattern types use case-insensitive substring match, including customer
  // patterns (no "CONCRETE" gate). Patterns are already restricted to
  // affects_counts=true above so count results align with the web summary.
  if (exclusionPatterns && exclusionPatterns.length > 0) {
    for (const pattern of exclusionPatterns) {
      const normalizedPattern = pattern.pattern?.trim()?.toLowerCase();
      if (!normalizedPattern) continue;

      switch (pattern.type) {
        case 'product':
          whereConditions.push(`NOT EXISTS (
            SELECT 1 FROM order_products op_excl
            WHERE op_excl.order_id = o.order_id
              AND op_excl.item_code ILIKE $${paramIndex}
          )`);
          queryParams.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;

        case 'customer':
          whereConditions.push(`o.customer_name NOT ILIKE $${paramIndex}`);
          queryParams.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;

        case 'delivery_address':
          whereConditions.push(`COALESCE(o.delivery_addr1, '') NOT ILIKE $${paramIndex}`);
          queryParams.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;
      }
    }
  }

  // Add search filter
  if (search && search.trim()) {
    const searchTerm = `%${search.trim().toLowerCase()}%`;
    whereConditions.push(`(
      o.order_code ILIKE $${paramIndex}
      OR o.customer_name ILIKE $${paramIndex}
      OR o.delivery_addr1 ILIKE $${paramIndex}
      OR o.delivery_addr2 ILIKE $${paramIndex}
      OR o.delivery_addr3 ILIKE $${paramIndex}
    )`);
    queryParams.push(searchTerm);
    paramIndex++;
  }

  // Company name filter (via pricing_plant_code → plants → companies)
  if (company_name && company_name.trim()) {
    whereConditions.push(`EXISTS (
      SELECT 1 FROM plants p_cf
      INNER JOIN companies c_cf ON c_cf.code = p_cf.company_code
      WHERE p_cf.code = o.pricing_plant_code
        AND c_cf.name ILIKE $${paramIndex}
    )`);
    queryParams.push(`%${company_name.trim().toLowerCase()}%`);
    paramIndex++;
  }

  // Region name filter (via pricing_plant_code → plants → regions)
  if (region_name && region_name.trim()) {
    whereConditions.push(`EXISTS (
      SELECT 1 FROM plants p_rf
      INNER JOIN regions r_rf ON r_rf.id = p_rf.region_id
      WHERE p_rf.code = o.pricing_plant_code
        AND r_rf.description ILIKE $${paramIndex}
    )`);
    queryParams.push(`%${region_name.trim().toLowerCase()}%`);
    paramIndex++;
  }

  // Plant code filter (exact match via order_product_schedules)
  if (plant_code && plant_code.trim()) {
    whereConditions.push(`EXISTS (
      SELECT 1 FROM order_products op_pcf
      INNER JOIN order_product_schedules ops_pcf ON ops_pcf.order_product_id = op_pcf.id
      WHERE op_pcf.order_id = o.order_id
        AND (op_pcf.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op_pcf.is_mix = true)
        AND ops_pcf.plant_code::text = $${paramIndex}
    )`);
    queryParams.push(plant_code.trim());
    paramIndex++;
  }

  // Plant name filter (partial match via order_product_schedules → plants)
  if (plant_name && plant_name.trim()) {
    whereConditions.push(`EXISTS (
      SELECT 1 FROM order_products op_pnf
      INNER JOIN order_product_schedules ops_pnf ON ops_pnf.order_product_id = op_pnf.id
      INNER JOIN plants p_pnf ON p_pnf.code = ops_pnf.plant_code
      WHERE op_pnf.order_id = o.order_id
        AND (op_pnf.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op_pnf.is_mix = true)
        AND p_pnf.description ILIKE $${paramIndex}
    )`);
    queryParams.push(`%${plant_name.trim().toLowerCase()}%`);
    paramIndex++;
  }

  // Access Control Filtering (same logic as web app)
  // Admin: no filter | Non-admin: OR of plant_code, customer_id, project_code
  if (userAccess && !userAccess.isAdmin) {
    const accessOrConditions = [];

    // Producer plant filter
    if (userAccess.allowedPlants && userAccess.allowedPlants.length > 0) {
      const plantPlaceholders = userAccess.allowedPlants.map((_, i) => `$${paramIndex + i}::text`).join(', ');
      accessOrConditions.push(`EXISTS (
        SELECT 1 FROM order_products op_access
        INNER JOIN order_product_schedules ops_access ON ops_access.order_product_id = op_access.id
        WHERE op_access.order_id = o.order_id
          AND (op_access.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op_access.is_mix = true)
          AND ops_access.plant_code::text IN (${plantPlaceholders})
      )`);
      queryParams.push(...userAccess.allowedPlants.map(p => String(p)));
      paramIndex += userAccess.allowedPlants.length;
    }

    // Customer filter
    if (userAccess.allowedCustomerIds && userAccess.allowedCustomerIds.length > 0) {
      const customerPlaceholders = userAccess.allowedCustomerIds.map((_, i) => `$${paramIndex + i}`).join(', ');
      accessOrConditions.push(`o.customer_id IN (${customerPlaceholders})`);
      queryParams.push(...userAccess.allowedCustomerIds);
      paramIndex += userAccess.allowedCustomerIds.length;
    }

    // Project code filter
    if (userAccess.allowedProjectCodes && userAccess.allowedProjectCodes.length > 0) {
      const projectPlaceholders = userAccess.allowedProjectCodes.map((_, i) => `$${paramIndex + i}`).join(', ');
      accessOrConditions.push(`o.project_code IN (${projectPlaceholders})`);
      queryParams.push(...userAccess.allowedProjectCodes);
      paramIndex += userAccess.allowedProjectCodes.length;
    }

    if (accessOrConditions.length > 0) {
      whereConditions.push(`(${accessOrConditions.join(' OR ')})`);
    } else {
      // No access - return empty result
      whereConditions.push('FALSE');
    }
  }

  // Favourite filter (SQL-level for correct pagination) — skip when tab mode is active
  if (!tab && is_favourite_filter !== undefined && favourite_order_ids) {
    if (is_favourite_filter) {
      // Show only favourite orders
      if (favourite_order_ids.length > 0) {
        const favPlaceholders = favourite_order_ids.map((_, i) => `$${paramIndex + i}`).join(', ');
        whereConditions.push(`o.order_id IN (${favPlaceholders})`);
        queryParams.push(...favourite_order_ids);
        paramIndex += favourite_order_ids.length;
      } else {
        // No favourites — return empty result
        whereConditions.push('FALSE');
      }
    } else {
      // Show only non-favourite orders
      if (favourite_order_ids.length > 0) {
        const favPlaceholders = favourite_order_ids.map((_, i) => `$${paramIndex + i}`).join(', ');
        whereConditions.push(`o.order_id NOT IN (${favPlaceholders})`);
        queryParams.push(...favourite_order_ids);
        paramIndex += favourite_order_ids.length;
      }
      // If no favourites exist, all orders are non-favourite — no filter needed
    }
  }

  // Validate sort parameters
  const allowedSortFields = ['order_date', 'order_code', 'customer_name', 'start_time', 'created_at', 'ordered_qty', 'delivered_qty', 'status'];
  const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'order_date';
  const sortDirection = sort_order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  // Calculate offset
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
  const offset = (pageNum - 1) * limitNum;

  // Parse and validate status filters for SQL-level filtering
  const STATUS_NAME_MAP = {
    'canceled': 'Canceled', 'normal': 'Normal',
    'will call': 'Will Call', 'will_call': 'Will Call',
    'hold delivery': 'Hold Delivery', 'hold_delivery': 'Hold Delivery',
    'completed': 'Completed',
    'wait list': 'Wait List', 'wait_list': 'Wait List',
    'in progress': 'In Progress', 'in_progress': 'In Progress'
  };

  let statusFilterClause = '';

  // Register favourite IDs as SQL params (needed for tab_counts saved count in all modes)
  let favParamPlaceholders = '';
  if (favourite_order_ids && favourite_order_ids.length > 0) {
    favParamPlaceholders = favourite_order_ids.map((_, i) => `$${paramIndex + i}`).join(', ');
    queryParams.push(...favourite_order_ids);
    paramIndex += favourite_order_ids.length;
  }

  // Build tab filter clause or legacy status filter clause
  let tabFilterClause = '';
  const VALID_TABS = ['saved', 'scheduled', 'active', 'completed', 'cancelled', 'requested'];
  const resolvedTab = (tab && VALID_TABS.includes(tab)) ? tab : null;

  if (resolvedTab) {
    // Tab mode: build filter based on tab value (no table prefix — used inside CTE)
    switch (resolvedTab) {
      case 'saved':
        tabFilterClause = favParamPlaceholders
          ? `WHERE order_id IN (${favParamPlaceholders})`
          : 'WHERE FALSE';
        break;
      case 'scheduled':
        tabFilterClause = `WHERE computed_status IN ('Normal', 'Will Call', 'Hold Delivery', 'Wait List')`;
        break;
      case 'active':
        tabFilterClause = `WHERE computed_status = 'In Progress'`;
        break;
      case 'completed':
        tabFilterClause = `WHERE computed_status = 'Completed'`;
        break;
      case 'cancelled':
        tabFilterClause = `WHERE computed_status = 'Canceled'`;
        break;
      case 'requested':
        tabFilterClause = 'WHERE FALSE';
        break;
    }
  } else if (!tab) {
    // Legacy status filter
    let statusFilters = [];
    if (status) {
      statusFilters = status.split(',').map(s => s.trim().toLowerCase()).filter(s => STATUS_NAME_MAP[s]);
    }
    if (statusFilters.length > 0) {
      const sqlStatuses = statusFilters.map(s => STATUS_NAME_MAP[s]);
      const placeholders = sqlStatuses.map((_, i) => `$${paramIndex + i}`).join(', ');
      statusFilterClause = `WHERE computed_status IN (${placeholders})`;
      queryParams.push(...sqlStatuses);
      paramIndex += sqlStatuses.length;
    }
  }

  // Build ORDER BY clause (all sorting done in SQL)
  // Custom status-based sorting priority:
  // 1. In Progress - sort by most recent activity (DESC)
  // 2. Completed - sort by completion time (DESC)
  // 3. Pre-Pour statuses in sequence: Normal(0) → Will Call(1) → Hold Delivery(3) → Wait List(5)
  // 4. Canceled - last
  let orderByClause;
  if (sortField === 'ordered_qty') {
    orderByClause = `ordered_qty ${sortDirection} NULLS LAST`;
  } else if (sortField === 'delivered_qty') {
    orderByClause = `delivered_qty ${sortDirection} NULLS LAST`;
  } else {
    // Default: Custom status-based sorting
    orderByClause = `
      CASE computed_status
        WHEN 'In Progress' THEN 1
        WHEN 'Completed' THEN 2
        WHEN 'Normal' THEN 3
        WHEN 'Will Call' THEN 4
        WHEN 'Hold Delivery' THEN 5
        WHEN 'Wait List' THEN 6
        WHEN 'Canceled' THEN 7
        ELSE 8
      END ASC,
      CASE WHEN computed_status = 'In Progress'
           THEN COALESCE(last_activity_time, start_time) END DESC NULLS LAST,
      CASE WHEN computed_status = 'Completed'
           THEN COALESCE(last_activity_time, start_time) END DESC NULLS LAST,
      start_time DESC NULLS LAST
    `;
  }

  // Add LIMIT and OFFSET params
  const limitParamIdx = paramIndex;
  const offsetParamIdx = paramIndex + 1;
  queryParams.push(limitNum, offset);

  // Main query: status computed in SQL, correlated subqueries replaced with JOIN CTEs,
  // pagination via LIMIT/OFFSET, counts via window functions
  const sql = `
    WITH order_totals AS (
      -- Order eligibility: every order with >=1 order_product, regardless of unit.
      -- Mirrors the web get_orders_paginated after migration 20260603000001
      -- ("show all units") so the mobile list matches the web Orders table.
      -- Concrete volume columns still sum only IN ('YDQ','CY') AND is_mix rows,
      -- so non-concrete orders show 0 CY instead of being dropped.
      SELECT
        op.order_id,
        SUM(CASE WHEN op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true THEN COALESCE(op.order_qty, 0) ELSE 0 END) as ordered_qty,
        SUM(CASE WHEN op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true THEN COALESCE(op.delv_qty, 0) ELSE 0 END) as delivered_qty,
        STRING_AGG(DISTINCT op.item_code, ', ') as product_codes,
        STRING_AGG(DISTINCT op.description, ', ') FILTER (WHERE op.description IS NOT NULL AND op.description != '') as product_description
      FROM order_products op
      INNER JOIN orders o_ot ON o_ot.order_id = op.order_id
      WHERE o_ot.order_date >= $1 AND o_ot.order_date < $2
      GROUP BY op.order_id
    ),
    order_schedules AS (
      SELECT
        op.order_id,
        timezone('UTC', MIN(ops.start_time)) as start_time,
        timezone('UTC', MAX(
          CASE
            WHEN sub.completed_loads > 0 AND sub.last_fin_pour_time IS NOT NULL THEN
              sub.last_fin_pour_time + ((ops.number_of_loads - sub.completed_loads) * COALESCE(ops.truck_space, 0)) * INTERVAL '1 minute'
            ELSE
              ops.start_time + (COALESCE(ops.number_of_loads, 1) * COALESCE(ops.truck_space, 0)) * INTERVAL '1 minute'
          END
        )) as estimated_finish_time,
        COALESCE(SUM(ops.number_of_loads), 0) as total_loads
      FROM order_products op
      INNER JOIN order_product_schedules ops ON ops.order_product_id = op.id
      INNER JOIN orders o_os ON o_os.order_id = op.order_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(COALESCE(t.end_unload, t.wash_time)) as completed_loads,
          MAX(COALESCE(t.end_unload, t.wash_time)) as last_fin_pour_time
        FROM order_product_schedule_loads opsl
        LEFT JOIN tickets t
          ON t.ticket_code = opsl.ticket_code
          AND t.order_id = op.order_id
          AND (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
        WHERE opsl.order_product_schedule_id = ops.id
          AND COALESCE(t.end_unload, t.wash_time) IS NOT NULL
      ) sub ON true
      WHERE (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
        AND o_os.order_date >= $1 AND o_os.order_date < $2
      GROUP BY op.order_id
    ),
    order_plants AS (
      SELECT
        op.order_id,
        STRING_AGG(DISTINCT ops.plant_code, ', ') as plant_codes,
        (SELECT p.description FROM plants p WHERE p.code = MIN(ops.plant_code) LIMIT 1) as plant_name
      FROM order_products op
      INNER JOIN order_product_schedules ops ON ops.order_product_id = op.id
      INNER JOIN orders o_opl ON o_opl.order_id = op.order_id
      WHERE (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
        AND ops.plant_code IS NOT NULL
        AND o_opl.order_date >= $1 AND o_opl.order_date < $2
      GROUP BY op.order_id
    ),
    ticket_counts AS (
      SELECT
        t_tc.order_id,
        COUNT(*) as tickets_count,
        COUNT(*) FILTER (WHERE t_tc.remove_reason_code IS NULL OR TRIM(t_tc.remove_reason_code) = '') as active_tickets,
        MAX(t_tc.created_date) as last_activity_time
      FROM tickets t_tc
      INNER JOIN orders o_tc ON o_tc.order_id = t_tc.order_id
      WHERE o_tc.order_date >= $1 AND o_tc.order_date < $2
      GROUP BY t_tc.order_id
    ),
    ticket_progress AS (
      SELECT
        sub.order_id,
        COALESCE(SUM(sub.load_qty) FILTER (WHERE sub.ticket_status = 'ticketed'), 0) as qty_ticketed,
        COALESCE(SUM(sub.load_qty) FILTER (WHERE sub.ticket_status = 'loading'), 0) as qty_loading,
        COALESCE(SUM(sub.load_qty) FILTER (WHERE sub.ticket_status = 'loaded'), 0) as qty_loaded,
        COALESCE(SUM(sub.load_qty) FILTER (WHERE sub.ticket_status = 'to_job'), 0) as qty_to_job,
        COALESCE(SUM(sub.load_qty) FILTER (WHERE sub.ticket_status = 'at_job'), 0) as qty_at_job,
        COALESCE(SUM(sub.load_qty) FILTER (WHERE sub.ticket_status = 'pouring'), 0) as qty_pouring,
        COALESCE(SUM(sub.load_qty) FILTER (WHERE sub.ticket_status = 'washing'), 0) as qty_washing,
        COALESCE(SUM(sub.load_qty) FILTER (WHERE sub.ticket_status = 'to_plant'), 0) as qty_to_plant,
        COALESCE(SUM(sub.load_qty) FILTER (WHERE sub.ticket_status = 'at_plant'), 0) as qty_at_plant,
        COALESCE(COUNT(*) FILTER (WHERE sub.ticket_status = 'ticketed'), 0) as cnt_ticketed,
        COALESCE(COUNT(*) FILTER (WHERE sub.ticket_status = 'loading'), 0) as cnt_loading,
        COALESCE(COUNT(*) FILTER (WHERE sub.ticket_status = 'loaded'), 0) as cnt_loaded,
        COALESCE(COUNT(*) FILTER (WHERE sub.ticket_status = 'to_job'), 0) as cnt_to_job,
        COALESCE(COUNT(*) FILTER (WHERE sub.ticket_status = 'at_job'), 0) as cnt_at_job,
        COALESCE(COUNT(*) FILTER (WHERE sub.ticket_status = 'pouring'), 0) as cnt_pouring,
        COALESCE(COUNT(*) FILTER (WHERE sub.ticket_status = 'washing'), 0) as cnt_washing,
        COALESCE(COUNT(*) FILTER (WHERE sub.ticket_status = 'to_plant'), 0) as cnt_to_plant,
        COALESCE(COUNT(*) FILTER (WHERE sub.ticket_status = 'at_plant'), 0) as cnt_at_plant
      FROM (
        SELECT
          t_tp.order_id,
          COALESCE(tp_sum.load_qty, 0) as load_qty,
          CASE
            WHEN t_tp.at_plant_time IS NOT NULL THEN 'at_plant'
            WHEN t_tp.to_plant_time IS NOT NULL THEN 'to_plant'
            WHEN t_tp.wash_time IS NOT NULL THEN 'washing'
            WHEN t_tp.unload_time IS NOT NULL THEN 'pouring'
            WHEN t_tp.on_job_time IS NOT NULL THEN 'at_job'
            WHEN t_tp.to_job_time IS NOT NULL THEN 'to_job'
            WHEN t_tp.loaded_time IS NOT NULL THEN 'loaded'
            WHEN t_tp.load_time IS NOT NULL THEN 'loading'
            WHEN t_tp.printed_time IS NOT NULL THEN 'ticketed'
            ELSE 'pending'
          END as ticket_status
        FROM tickets t_tp
        INNER JOIN orders o_tpg ON o_tpg.order_id = t_tp.order_id
        LEFT JOIN LATERAL (
          -- Concrete line's load qty. Prefer is_mix=true, but CBM's ticket_products
          -- are mis-tagged (is_mix=false, unit '40013'/null), so also accept volume
          -- units. Without this the progress bar gets load_qty=0 → all-gray.
          SELECT tp2.load_qty
          FROM ticket_products tp2
          WHERE tp2.ticket_id = t_tp.ticket_id
            AND (tp2.is_mix = true OR tp2.order_qty_unit IN ('m3', 'M3', 'CY', 'YDQ', '40013'))
          ORDER BY (tp2.is_mix = true) DESC, tp2.load_qty DESC NULLS LAST
          LIMIT 1
        ) tp_sum ON true
        WHERE o_tpg.order_date >= $1 AND o_tpg.order_date < $2
          AND (t_tp.remove_reason_code IS NULL OR TRIM(t_tp.remove_reason_code) = '')
      ) sub
      GROUP BY sub.order_id
    ),
    note_flags AS (
      SELECT DISTINCT on_nf.order_id
      FROM order_notes on_nf
      INNER JOIN orders o_nf ON o_nf.order_id = on_nf.order_id
      WHERE o_nf.order_date >= $1 AND o_nf.order_date < $2
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
      INNER JOIN orders o_ltc ON o_ltc.order_id = t.order_id
      WHERE (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
        AND o_ltc.order_date >= $1 AND o_ltc.order_date < $2
      ORDER BY t.order_id, t.created_date DESC NULLS LAST
    ),
    recent_ticket AS (
      SELECT DISTINCT ON (t_rt.order_id)
        t_rt.order_id,
        t_rt.ticket_code as rt_ticket_code,
        t_rt.truck_code as rt_truck_code,
        t_rt.driver_name as rt_driver_name,
        t_rt.remove_reason_code as rt_remove_reason_code,
        t_rt.printed_time as rt_printed_time,
        t_rt.load_time as rt_load_time,
        t_rt.loaded_time as rt_loaded_time,
        t_rt.to_job_time as rt_to_job_time,
        t_rt.on_job_time as rt_on_job_time,
        t_rt.unload_time as rt_unload_time,
        t_rt.wash_time as rt_wash_time,
        t_rt.to_plant_time as rt_to_plant_time,
        t_rt.at_plant_time as rt_at_plant_time,
        t_rt.created_date as rt_created_date,
        tp_rt.load_qty as rt_load_qty
      FROM tickets t_rt
      INNER JOIN orders o_rt ON o_rt.order_id = t_rt.order_id
      LEFT JOIN LATERAL (
        SELECT SUM(tp2.load_qty) as load_qty
        FROM ticket_products tp2
        WHERE tp2.ticket_id = t_rt.ticket_id AND tp2.is_mix = true
      ) tp_rt ON true
      WHERE o_rt.order_date >= $1 AND o_rt.order_date < $2
      ORDER BY t_rt.order_id, t_rt.created_date DESC NULLS LAST
    ),
    order_data AS (
      SELECT
        o.order_id,
        o.order_code,
        o.order_date,
        o.customer_name,
        o.project_name,
        TRIM(BOTH ', ' FROM
          COALESCE(NULLIF(o.delivery_addr1, ''), '') ||
          CASE WHEN o.delivery_addr2 IS NOT NULL AND o.delivery_addr2 != '' THEN ', ' || o.delivery_addr2 ELSE '' END ||
          CASE WHEN o.delivery_addr3 IS NOT NULL AND o.delivery_addr3 != '' THEN ', ' || o.delivery_addr3 ELSE '' END
        ) as delivery_address,
        o.removed,
        o.remove_reason_code,
        COALESCE(o.current_status, 1) as current_status,
        os.start_time,
        os.estimated_finish_time,
        ot.ordered_qty,
        ot.delivered_qty,
        CASE WHEN nf.order_id IS NOT NULL THEN true ELSE false END as has_notes,
        COALESCE(tc.tickets_count, 0) as tickets_count,
        COALESCE(tc.active_tickets, 0) as active_tickets,
        COALESCE(os.total_loads, 0) as total_loads,
        ot.product_codes,
        ot.product_description,
        opl.plant_codes,
        opl.plant_name,
        o.weather_data,
        o.latitude as order_latitude,
        o.longitude as order_longitude,
        o.pricing_plant_code,
        p.description as plant_description,
        p.short_description as plant_short_description,
        p.address1 as plant_address1,
        p.address2 as plant_address2,
        p.phone as plant_phone,
        p.latitude as plant_latitude,
        p.longitude as plant_longitude,
        tc.last_activity_time,
        rt.rt_ticket_code,
        rt.rt_truck_code,
        rt.rt_driver_name,
        rt.rt_remove_reason_code,
        rt.rt_printed_time,
        rt.rt_load_time,
        rt.rt_loaded_time,
        rt.rt_to_job_time,
        rt.rt_on_job_time,
        rt.rt_unload_time,
        rt.rt_wash_time,
        rt.rt_to_plant_time,
        rt.rt_at_plant_time,
        rt.rt_created_date,
        rt.rt_load_qty,
        COALESCE(tpg.qty_ticketed, 0) as qty_ticketed,
        COALESCE(tpg.qty_loading, 0) as qty_loading,
        COALESCE(tpg.qty_loaded, 0) as qty_loaded,
        COALESCE(tpg.qty_to_job, 0) as qty_to_job,
        COALESCE(tpg.qty_at_job, 0) as qty_at_job,
        COALESCE(tpg.qty_pouring, 0) as qty_pouring,
        COALESCE(tpg.qty_washing, 0) as qty_washing,
        COALESCE(tpg.qty_to_plant, 0) as qty_to_plant,
        COALESCE(tpg.qty_at_plant, 0) as qty_at_plant,
        COALESCE(ltc.is_last_load_completed, false) as is_last_load_completed,
        CASE
          WHEN o.removed = true AND o.remove_reason_code IS NOT NULL AND LENGTH(o.remove_reason_code) > 0 THEN 'Canceled'
          WHEN COALESCE(o.current_status, 1) = 4 THEN 'Completed'
          WHEN ot.ordered_qty > 0 AND ot.delivered_qty >= ot.ordered_qty THEN 'Completed'
          WHEN ot.delivered_qty > 0 AND COALESCE(ltc.is_last_load_completed, false) = true
            AND (ot.ordered_qty - ot.delivered_qty) <= 0.02 THEN 'Completed'
          WHEN ot.delivered_qty > 0 AND ot.delivered_qty < ot.ordered_qty THEN 'In Progress'
          WHEN COALESCE(o.current_status, 1) = 1 THEN 'Will Call'
          WHEN COALESCE(o.current_status, 1) = 3 THEN 'Hold Delivery'
          WHEN COALESCE(o.current_status, 1) = 5 THEN 'Wait List'
          ELSE 'Normal'
        END as computed_status
      FROM orders o
      INNER JOIN order_totals ot ON ot.order_id = o.order_id
      LEFT JOIN order_schedules os ON os.order_id = o.order_id
      LEFT JOIN order_plants opl ON opl.order_id = o.order_id
      LEFT JOIN ticket_counts tc ON tc.order_id = o.order_id
      LEFT JOIN note_flags nf ON nf.order_id = o.order_id
      LEFT JOIN plants p ON p.code = o.pricing_plant_code
      LEFT JOIN last_ticket_completion ltc ON ltc.order_id = o.order_id
      LEFT JOIN recent_ticket rt ON rt.order_id = o.order_id
      LEFT JOIN ticket_progress tpg ON tpg.order_id = o.order_id
      WHERE ${whereConditions.join(' AND ')}
    )${resolvedTab ? `,
    tab_counts AS (
      SELECT
        ${favParamPlaceholders
        ? `COUNT(*) FILTER (WHERE order_id IN (${favParamPlaceholders})) as saved_count`
        : '0 as saved_count'},
        COUNT(*) FILTER (WHERE computed_status IN ('Normal','Will Call','Hold Delivery','Wait List')) as scheduled_count,
        COUNT(*) FILTER (WHERE computed_status = 'In Progress') as active_count,
        COUNT(*) FILTER (WHERE computed_status = 'Completed') as completed_count,
        COUNT(*) FILTER (WHERE computed_status = 'Canceled') as cancelled_count
      FROM order_data
    ),
    filtered_data AS (
      SELECT *, COUNT(*) OVER() as total_count
      FROM order_data
      ${tabFilterClause}
      ORDER BY ${orderByClause}
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
    )
    SELECT fd.*, tc.saved_count, tc.scheduled_count, tc.active_count, tc.completed_count, tc.cancelled_count
    FROM tab_counts tc
    LEFT JOIN filtered_data fd ON true
    ORDER BY fd.order_id IS NULL, ${orderByClause}` : `
    SELECT *,
      COUNT(*) OVER() as total_count,
      COUNT(*) FILTER (WHERE computed_status = 'Canceled') OVER() as count_canceled,
      COUNT(*) FILTER (WHERE computed_status = 'Normal') OVER() as count_normal,
      COUNT(*) FILTER (WHERE computed_status = 'Will Call') OVER() as count_will_call,
      COUNT(*) FILTER (WHERE computed_status = 'Hold Delivery') OVER() as count_hold_delivery,
      COUNT(*) FILTER (WHERE computed_status = 'Completed') OVER() as count_completed,
      COUNT(*) FILTER (WHERE computed_status = 'Wait List') OVER() as count_wait_list,
      COUNT(*) FILTER (WHERE computed_status = 'In Progress') OVER() as count_in_progress,
      ${favParamPlaceholders
      ? `COUNT(*) FILTER (WHERE order_id IN (${favParamPlaceholders})) OVER() as count_saved`
      : '0 as count_saved'}
    FROM order_data
    ${statusFilterClause}
    ORDER BY ${orderByClause}
    LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`}
  `;

  try {
    const result = await executeDirectSQL(sql, queryParams);
    const allRows = result.data || [];

    // In tab mode, LEFT JOIN guarantees at least 1 row (counts-only sentinel when no orders match).
    // Filter out sentinel rows (order_id IS NULL) to get actual data rows.
    let rows, firstRow, totalCount;
    let tabCounts;
    let defaultTab;
    let activeTab = resolvedTab || null;

    if (resolvedTab) {
      // Extract tab counts from the first row (always present due to LEFT JOIN)
      const countsRow = allRows[0];
      tabCounts = {
        saved: countsRow ? parseInt(countsRow.saved_count, 10) || 0 : 0,
        scheduled: countsRow ? parseInt(countsRow.scheduled_count, 10) || 0 : 0,
        active: countsRow ? parseInt(countsRow.active_count, 10) || 0 : 0,
        completed: countsRow ? parseInt(countsRow.completed_count, 10) || 0 : 0,
        cancelled: countsRow ? parseInt(countsRow.cancelled_count, 10) || 0 : 0,
        requested: 0
      };

      // Filter out sentinel row (order_id IS NULL = no matching orders for this tab)
      rows = allRows.filter(r => r.order_id != null);
      firstRow = rows[0];
      totalCount = firstRow ? parseInt(firstRow.total_count, 10) : 0;
    } else {
      rows = allRows;
      firstRow = rows[0];
      totalCount = firstRow ? parseInt(firstRow.total_count, 10) : 0;

      // Compute tab_counts from window function counts in legacy mode
      const countNormal = firstRow ? parseInt(firstRow.count_normal, 10) : 0;
      const countWillCall = firstRow ? parseInt(firstRow.count_will_call, 10) : 0;
      const countHoldDelivery = firstRow ? parseInt(firstRow.count_hold_delivery, 10) : 0;
      const countWaitList = firstRow ? parseInt(firstRow.count_wait_list, 10) : 0;
      tabCounts = {
        saved: firstRow ? parseInt(firstRow.count_saved, 10) || 0 : 0,
        scheduled: countNormal + countWillCall + countHoldDelivery + countWaitList,
        active: firstRow ? parseInt(firstRow.count_in_progress, 10) : 0,
        completed: firstRow ? parseInt(firstRow.count_completed, 10) : 0,
        cancelled: firstRow ? parseInt(firstRow.count_canceled, 10) : 0,
        requested: 0
      };
    }

    // Auto-detect best default tab based on priority
    defaultTab =
      tabCounts.saved > 0 ? 'saved' :
        tabCounts.scheduled > 0 ? 'scheduled' :
          tabCounts.active > 0 ? 'active' :
            tabCounts.completed > 0 ? 'completed' :
              tabCounts.cancelled > 0 ? 'cancelled' : 'scheduled';

    // status_counts: per-status breakdown (legacy). In tab mode, only tab_counts are meaningful.
    const statusCounts = resolvedTab ? {
      'Canceled': tabCounts.cancelled,
      'Normal': 0, 'Will Call': 0, 'Hold Delivery': 0, 'Wait List': 0,
      'Completed': tabCounts.completed,
      'Unknown': 0, 'Delayed': 0,
      'In Progress': tabCounts.active
    } : {
      'Canceled': firstRow ? parseInt(firstRow.count_canceled, 10) : 0,
      'Normal': firstRow ? parseInt(firstRow.count_normal, 10) : 0,
      'Will Call': firstRow ? parseInt(firstRow.count_will_call, 10) : 0,
      'Hold Delivery': firstRow ? parseInt(firstRow.count_hold_delivery, 10) : 0,
      'Completed': firstRow ? parseInt(firstRow.count_completed, 10) : 0,
      'Wait List': firstRow ? parseInt(firstRow.count_wait_list, 10) : 0,
      'Unknown': 0,
      'Delayed': 0,
      'In Progress': firstRow ? parseInt(firstRow.count_in_progress, 10) : 0
    };

    // Transform rows to response format
    const orders = rows.map(row => {
      const orderedQty = parseFloat(row.ordered_qty) || 0;
      const deliveredQty = parseFloat(row.delivered_qty) || 0;
      const orderStatus = row.computed_status;
      const remainingQty = orderStatus === ORDER_STATUS.CANCELLED ? 0 : Math.max(0, orderedQty - deliveredQty);

      const isRemoved = (row.removed === true || row.removed === 'true') &&
        row.remove_reason_code !== null &&
        String(row.remove_reason_code || '').length > 0;

      // Chat is enabled for ALL orders
      const canChat = true;

      return {
        order_id: row.order_id,
        order_code: row.order_code,
        order_date: formatDateCST(row.order_date),
        display_date: formatDisplayDateTime(row.order_date),
        start_time: formatTime(row.start_time, tz),
        estimated_finish_time: formatTime(row.estimated_finish_time, tz),
        customer_name: row.customer_name || '',
        project_name: row.project_name || '',
        delivery_address: row.delivery_address || '',
        plant_codes: row.plant_codes || '',
        plant_name: row.plant_name || '',
        plant_details: row.pricing_plant_code ? {
          code: row.pricing_plant_code,
          description: row.plant_description || '',
          short_description: row.plant_short_description || '',
          address1: row.plant_address1 || '',
          address2: row.plant_address2 || '',
          phone: row.plant_phone || '',
          latitude: row.plant_latitude ? parseFloat(row.plant_latitude) : null,
          longitude: row.plant_longitude ? parseFloat(row.plant_longitude) : null
        } : null,
        order_location: {
          latitude: row.order_latitude ? parseFloat(row.order_latitude) : null,
          longitude: row.order_longitude ? parseFloat(row.order_longitude) : null
        },
        ordered_qty: orderedQty,
        delivered_qty: deliveredQty,
        remaining_qty: remainingQty,
        remaining_display: `${remainingQty.toFixed(0)}CY`,
        status: orderStatus,
        can_chat: canChat,
        can_ticketed: orderStatus === ORDER_STATUS.IN_PROGRESS || orderStatus === ORDER_STATUS.COMPLETED,
        is_removed: isRemoved,
        current_status: parseInt(row.current_status, 10) || 0,
        is_last_load_completed: row.is_last_load_completed === true || row.is_last_load_completed === 'true',
        has_notes: row.has_notes || false,
        tickets_count: parseInt(row.tickets_count, 10) || 0,
        active_tickets: parseInt(row.active_tickets, 10) || 0,
        total_loads: parseInt(row.total_loads, 10) || 0,
        product_codes: row.product_codes || '',
        product_description: row.product_description || '',
        weather_data: (() => {
          if (!row.weather_data) return null;
          if (typeof row.weather_data === 'object') return row.weather_data;
          if (typeof row.weather_data === 'string') {
            try {
              return JSON.parse(row.weather_data);
            } catch (e) {
              return row.weather_data;
            }
          }
          return row.weather_data;
        })(),
        delivery_progress: buildDeliveryProgress(orderedQty, {
          ticketed: parseFloat(row.qty_ticketed) || 0,
          loading: parseFloat(row.qty_loading) || 0,
          loaded: parseFloat(row.qty_loaded) || 0,
          to_job: parseFloat(row.qty_to_job) || 0,
          at_job: parseFloat(row.qty_at_job) || 0,
          pouring: parseFloat(row.qty_pouring) || 0,
          washing: parseFloat(row.qty_washing) || 0,
          to_plant: parseFloat(row.qty_to_plant) || 0,
          at_plant: parseFloat(row.qty_at_plant) || 0
        }, progressBarColors, {
          ticketed: parseInt(row.cnt_ticketed, 10) || 0,
          loading: parseInt(row.cnt_loading, 10) || 0,
          loaded: parseInt(row.cnt_loaded, 10) || 0,
          to_job: parseInt(row.cnt_to_job, 10) || 0,
          at_job: parseInt(row.cnt_at_job, 10) || 0,
          pouring: parseInt(row.cnt_pouring, 10) || 0,
          washing: parseInt(row.cnt_washing, 10) || 0,
          to_plant: parseInt(row.cnt_to_plant, 10) || 0,
          at_plant: parseInt(row.cnt_at_plant, 10) || 0
        }),
        recent_ticket: row.rt_ticket_code ? (() => {
          // Derive ticket status from timestamps (same logic as ticketService.deriveTicketStatus)
          let rtStatus = 'pending';
          let rtStatusDisplay = 'Pending';
          const rtRemoveReason = row.rt_remove_reason_code && String(row.rt_remove_reason_code).trim() !== '' ? String(row.rt_remove_reason_code).trim() : null;

          if (rtRemoveReason) {
            rtStatus = 'cancelled';
            rtStatusDisplay = `Cancelled-${rtRemoveReason}`;
          } else if (row.rt_at_plant_time) {
            rtStatus = 'at_plant'; rtStatusDisplay = 'At Plant';
          } else if (row.rt_to_plant_time) {
            rtStatus = 'to_plant'; rtStatusDisplay = 'To Plant';
          } else if (row.rt_wash_time) {
            rtStatus = 'washing'; rtStatusDisplay = 'Washing';
          } else if (row.rt_unload_time) {
            rtStatus = 'pouring'; rtStatusDisplay = 'Pouring';
          } else if (row.rt_on_job_time) {
            rtStatus = 'at_job'; rtStatusDisplay = 'At Job';
          } else if (row.rt_to_job_time) {
            rtStatus = 'to_job'; rtStatusDisplay = 'To Job';
          } else if (row.rt_loaded_time) {
            rtStatus = 'loaded'; rtStatusDisplay = 'Loaded';
          } else if (row.rt_load_time) {
            rtStatus = 'loading'; rtStatusDisplay = 'Loading';
          } else if (row.rt_printed_time) {
            rtStatus = 'ticketed'; rtStatusDisplay = 'Ticketed';
          }

          // Pick the latest timestamp as the current status timestamp
          const latestTimestamp = row.rt_at_plant_time || row.rt_to_plant_time || row.rt_wash_time ||
            row.rt_unload_time || row.rt_on_job_time || row.rt_to_job_time ||
            row.rt_loaded_time || row.rt_load_time || row.rt_printed_time || row.rt_created_date;

          return {
            ticket_code: row.rt_ticket_code,
            truck_code: row.rt_truck_code || null,
            driver_name: row.rt_driver_name || null,
            status: rtStatus,
            status_display: rtStatusDisplay,
            load_qty: row.rt_load_qty ? `${parseFloat(row.rt_load_qty).toFixed(2)} CY` : null,
            latest_timestamp: latestTimestamp ? formatDateTimeCST(latestTimestamp, tz) : null
          };
        })() : null
      };
    });

    const response = {
      orders,
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
        status: status ? status.split(',').map(s => s.trim()).filter(s => s) : null,
        search: search || null,
        sort_by: sortField,
        sort_order: sortDirection.toLowerCase(),
        company_name: company_name || null,
        region_name: region_name || null,
        plant_code: plant_code || null,
        plant_name: plant_name || null
      },
      status_counts: statusCounts,
      progress_bar_colors: progressBarColors || null
    };

    response.tab_counts = tabCounts;
    response.default_tab = defaultTab;
    response.active_tab = activeTab;

    return response;
  } catch (error) {
    throw error;
  }
}

/**
 * Get single order by order code and order date with full details
 *
 * @param {string} orderCode - Order code
 * @param {string} orderDate - Order date (YYYY-MM-DD)
 * @returns {Promise<object>} Order details
 */
async function getOrderByCodeAndDate(orderCode, orderDate, tz = null, loadsPagination = { page: 1, limit: 100 }) {
  const sql = `
    SELECT
      o.order_id,
      o.order_code,
      o.order_date,
      extract(epoch from o.order_date) as order_date_epoch,
      o.customer_name,
      o.project_name,
      o.delivery_addr1,
      o.delivery_addr2,
      o.delivery_addr3,
      TRIM(BOTH ', ' FROM
        COALESCE(NULLIF(o.delivery_addr1, ''), '') ||
        CASE WHEN o.delivery_addr2 IS NOT NULL AND o.delivery_addr2 != '' THEN ', ' || o.delivery_addr2 ELSE '' END ||
        CASE WHEN o.delivery_addr3 IS NOT NULL AND o.delivery_addr3 != '' THEN ', ' || o.delivery_addr3 ELSE '' END
      ) as delivery_address,
      o.removed,
      o.remove_reason_code,
      COALESCE(o.current_status, 1) as current_status,
      CASE WHEN EXISTS (SELECT 1 FROM order_notes WHERE order_id = o.order_id) THEN true ELSE false END as has_notes,
      o.weather_data,
      o.latitude as order_latitude,
      o.longitude as order_longitude,
      o.pricing_plant_code,
      p.code as plant_code,
      p.description as plant_description,
      p.short_description as plant_short_description,
      p.address1 as plant_address1,
      p.address2 as plant_address2,
      p.phone as plant_phone,
      p.latitude as plant_latitude,
      p.longitude as plant_longitude
    FROM orders o
    LEFT JOIN plants p ON p.code = o.pricing_plant_code
    WHERE o.order_code = $1 AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
  `;

  // Query to get unique products with description
  const uniqueProductsSql = `
    SELECT DISTINCT
      op.id as order_product_id,
      op.product_id,
      op.item_code,
      op.description,
      op.is_mix,
      op.order_qty as ordered_qty,
      op.delv_qty as delivered_qty
    FROM order_products op
    INNER JOIN orders o ON o.order_id = op.order_id
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
    ORDER BY op.id
  `;

  // Query to get product schedules (items as shown in web - each schedule is an item)
  const productSchedulesSql = `
    SELECT
      ops.id as schedule_id,
      op.id as order_product_id,
      op.item_code,
      op.description,
      op.is_mix,
      ops.plant_code,
      p.description as plant_description,
      ops.order_qty as scheduled_qty,
      ops.delv_qty as delivered_qty,
      timezone('UTC', ops.start_time) as start_time,
      TO_CHAR(timezone('UTC', ops.start_time), 'FMHH:MI AM') as start_time_formatted,
      ops.number_of_loads,
      CASE
        WHEN op.removed = true OR (op.remove_reason_code IS NOT NULL AND LENGTH(op.remove_reason_code) > 0) THEN 'Canceled'
        WHEN COALESCE(ops.delv_qty, 0) >= COALESCE(ops.order_qty, 0) AND COALESCE(ops.order_qty, 0) > 0 THEN 'Completed'
        WHEN COALESCE(ops.delv_qty, 0) > 0 THEN 'In Progress'
        ELSE 'Normal'
      END as schedule_status
    FROM order_product_schedules ops
    INNER JOIN order_products op ON op.id = ops.order_product_id
    INNER JOIN orders o ON o.order_id = op.order_id
    LEFT JOIN plants p ON p.code = ops.plant_code
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
    ORDER BY ops.start_time ASC
  `;

  // Query to get truck status counts from tickets (excluding cancelled tickets)
  const truckStatusCountSql = `
    SELECT
      COUNT(*) FILTER (WHERE t.printed_time IS NOT NULL) as ticketed,
      COUNT(*) FILTER (WHERE t.load_time IS NOT NULL) as loading,
      COUNT(*) FILTER (WHERE t.loaded_time IS NOT NULL) as loaded,
      COUNT(*) FILTER (WHERE t.to_job_time IS NOT NULL) as to_job,
      COUNT(*) FILTER (WHERE t.on_job_time IS NOT NULL) as at_job,
      COUNT(*) FILTER (WHERE t.unload_time IS NOT NULL) as pouring,
      COUNT(*) FILTER (WHERE t.wash_time IS NOT NULL) as washing,
      COUNT(*) FILTER (WHERE t.to_plant_time IS NOT NULL) as to_plant,
      COUNT(*) FILTER (WHERE t.at_plant_time IS NOT NULL) as at_plant,
      COUNT(*) as total,
      COALESCE(SUM(tp.load_qty) FILTER (WHERE t.on_job_time IS NOT NULL), 0) as ticket_delivered_qty,
      COALESCE(SUM(tp.load_qty) FILTER (WHERE t.wash_time IS NOT NULL), 0) as ticket_poured_qty
    FROM tickets t
    INNER JOIN orders o ON o.order_id = t.order_id
    LEFT JOIN LATERAL (
      SELECT load_qty
      FROM ticket_products
      WHERE ticket_id = t.ticket_id AND is_mix = true
      LIMIT 1
    ) tp ON true
    WHERE o.order_code = $1 AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
  `;

  const productsSql = `
    SELECT
      op.id as order_product_id,
      op.product_id,
      op.item_code,
      op.order_qty as ordered_qty,
      op.delv_qty as delivered_qty,
      op.is_mix,
      ops.id as order_product_schedule_id,
      timezone('UTC', ops.start_time) as start_time,
      TO_CHAR(timezone('UTC', ops.start_time), 'FMHH:MI AM') as start_time_formatted,
      ops.plant_code,
      opsl.ticket_code,
      tp.load_qty,
      tp.acc_delv_qty as run_qty,
      t.truck_code,
      timezone('UTC', t.printed_time) as ticketed_time,
      timezone('UTC', t.load_time) as load_time,
      timezone('UTC', t.loaded_time) as loaded_time,
      timezone('UTC', t.to_job_time) as to_job_time,
      timezone('UTC', t.on_job_time) as on_job_time,
      timezone('UTC', t.unload_time) as pouring_time,
      timezone('UTC', t.wash_time) as washing_time,
      timezone('UTC', t.to_plant_time) as to_plant_time,
      timezone('UTC', t.at_plant_time) as at_plant_time,
      CASE
        WHEN t.at_plant_time IS NOT NULL THEN 'at_plant'
        WHEN t.to_plant_time IS NOT NULL THEN 'to_plant'
        WHEN t.wash_time IS NOT NULL THEN 'washing'
        WHEN t.end_unload IS NOT NULL THEN 'delivered'
        WHEN t.unload_time IS NOT NULL THEN 'pouring'
        WHEN t.on_job_time IS NOT NULL THEN 'on_job'
        WHEN t.to_job_time IS NOT NULL THEN 'to_job'
        WHEN t.loaded_time IS NOT NULL THEN 'loaded'
        WHEN t.load_time IS NOT NULL THEN 'loading'
        WHEN t.printed_time IS NOT NULL THEN 'ticketed'
        WHEN COALESCE(t.current_status, t.order_current_status) = 4 THEN 'delivered'
        ELSE 'pending'
      END as ticket_status,
      CASE
        WHEN sp.completed_loads > 0 AND sp.last_fin_pour_time IS NOT NULL THEN
          timezone('UTC', sp.last_fin_pour_time + ((ops.number_of_loads - sp.completed_loads) * COALESCE(ops.truck_space, 0)) * INTERVAL '1 minute')
        ELSE
          timezone('UTC', ops.start_time + (COALESCE(ops.number_of_loads, 1) * COALESCE(ops.truck_space, 0)) * INTERVAL '1 minute')
      END as eta_at_job
    FROM order_products op
    LEFT JOIN order_product_schedules ops ON ops.order_product_id = op.id
    INNER JOIN orders o ON o.order_id = op.order_id
    LEFT JOIN order_product_schedule_loads opsl ON opsl.order_product_schedule_id = ops.id
    LEFT JOIN tickets t ON t.ticket_code = opsl.ticket_code AND t.order_id = o.order_id
    LEFT JOIN ticket_products tp ON tp.ticket_id = t.ticket_id AND tp.is_mix = true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(COALESCE(t2.end_unload, t2.wash_time)) as completed_loads,
        MAX(COALESCE(t2.end_unload, t2.wash_time)) as last_fin_pour_time
      FROM order_product_schedule_loads x
      LEFT JOIN tickets t2
        ON t2.ticket_code = x.ticket_code
        AND t2.order_id = o.order_id
        AND (t2.remove_reason_code IS NULL OR TRIM(t2.remove_reason_code) = '')
      WHERE x.order_product_schedule_id = ops.id
        AND COALESCE(t2.end_unload, t2.wash_time) IS NOT NULL
    ) sp ON true
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
    ORDER BY tp.acc_delv_qty ASC NULLS LAST, ops.start_time ASC NULLS LAST
  `;

  const notesSql = `
    SELECT n.*
    FROM order_notes n
    INNER JOIN orders o ON o.order_id = n.order_id
    WHERE o.order_code = $1 AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
  `;

  // Query to get schedule data for accurate estimated finish time
  // Uses ACTUAL ticket times (end_unload / wash_time) as "Pour Out" time per spec
  // Uses extract(epoch) for unambiguous UTC timestamps — avoids pg driver timezone parsing issues
  const scheduleSql = `
    SELECT
      ops.id as schedule_id,
      extract(epoch from ops.start_time) as start_time_epoch,
      ops.number_of_loads,
      ops.unload_time,
      ops.truck_space,
      COUNT(COALESCE(t.end_unload, t.wash_time)) as completed_loads,
      extract(epoch from MAX(COALESCE(t.end_unload, t.wash_time))) as last_fin_pour_epoch
    FROM order_product_schedules ops
    INNER JOIN order_products op ON op.id = ops.order_product_id
    INNER JOIN orders o ON o.order_id = op.order_id
    LEFT JOIN order_product_schedule_loads opsl
      ON ops.id = opsl.order_product_schedule_id
    LEFT JOIN tickets t
      ON t.ticket_code = opsl.ticket_code
      AND t.order_id = o.order_id
      AND COALESCE(t.end_unload, t.wash_time) IS NOT NULL
      AND (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
    GROUP BY ops.id, ops.start_time, ops.number_of_loads, ops.unload_time, ops.truck_space
    ORDER BY ops.start_time ASC
  `;

  // Graph data: schedule info for Pour Speed and ODP charts
  // (delivery_rate_per_hour, truck_space, load_qty, etc.)
  // Uses extract(epoch) for unambiguous UTC timestamps — avoids pg driver timezone parsing issues
  // CRITICAL ordering: match the web's fetchProductSchedule exactly.
  //
  // Web uses Supabase `.from("order_products").eq("order_id", ...)` with a
  // nested `order_product_schedules(...)` relation and NO explicit ordering
  // (see orderTabDataActions.ts fetchProductSchedule lines 145-315). That
  // returns rows in PostgREST default order — which is primary-key ASC for
  // the outer table AND for the nested relation. Then HourlyODPChart
  // iterates productScheduleItems top-to-bottom and breaks at the first
  // `is_mix=true` entry (performance-charts.tsx lines 1512-1534 + 1753-1764).
  //
  // The effective "primary schedule" on web is therefore:
  //   the is_mix=true product with the LOWEST order_products.id,
  //   and within that product, the schedule with the LOWEST
  //   order_product_schedules.id.
  //
  // We had this sorted by ops.start_time ASC, which silently picks a
  // DIFFERENT row whenever an order has multiple is_mix=true products whose
  // (lowest id) ≠ (earliest start_time). That was the 21 vs 31.5 mismatch.
  //
  // Fix: sort by op.id ASC, then ops.id ASC — exactly matching web.
  //
  // IMPORTANT: do NOT filter on `order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3')`. The web reducer
  // (truckast-dolese-readymix-frontend/src/app/(protected)/orders/
  // _components/performance-charts.tsx lines 1511-1535 and 1751-1765)
  // ONLY filters by `is_mix` when selecting the primary schedule — it
  // iterates productScheduleItems and picks the FIRST one with
  // `psi.is_mix === true`, regardless of unit. Adding an `order_qty_unit`
  // filter here caused the backend to silently skip a non-CY mix product
  // that the web WOULD have picked, resulting in different primary-schedule
  // values (rate / schedule_qty / load_qty / start_time) on mobile vs web
  // whenever an order had any non-CY mix product ordered before the CY one.
  // Since the reducer guarantees value parity only when fed the same
  // primary schedule, removing this filter is the REAL root cause fix.
  const graphScheduleSql = `
    SELECT
      op.id AS product_id,
      ops.id AS schedule_id,
      ops.delivery_rate_per_hour,
      ops.truck_space,
      extract(epoch from ops.start_time) as start_time_epoch,
      ops.number_of_loads,
      ops.schedule_qty,
      ops.load_qty,
      ops.unload_time as unload_duration_minutes
    FROM order_product_schedules ops
    INNER JOIN order_products op ON op.id = ops.order_product_id
    INNER JOIN orders o ON o.order_id = op.order_id
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND op.is_mix = true
    ORDER BY op.id ASC, ops.id ASC
  `;

  // Query to get unique truck count from tickets
  const truckCountSql = `
    SELECT COUNT(DISTINCT t.truck_code) as truck_count
    FROM tickets t
    INNER JOIN orders o ON o.order_id = t.order_id
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND t.truck_code IS NOT NULL
      AND (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
  `;

  // Graph data: ticket timestamps + load quantities for both graphs
  // Uses extract(epoch) for unambiguous UTC timestamps
  // Fetches ALL non-cancelled tickets (not just those with on_job_time)
  // so trucks chart can use fallback chain and poured line can use wash/to_plant
  const graphTicketsSql = `
    SELECT
      t.ticket_code,
      t.truck_code,
      extract(epoch from t.on_job_time) as on_job_time_epoch,
      extract(epoch from t.unload_time) as unload_time_epoch,
      extract(epoch from t.end_unload) as end_unload_epoch,
      extract(epoch from t.wash_time) as wash_time_epoch,
      extract(epoch from t.to_plant_time) as to_plant_time_epoch,
      extract(epoch from t.at_plant_time) as at_plant_time_epoch,
      extract(epoch from t.loaded_time) as loaded_time_epoch,
      extract(epoch from t.load_time) as load_time_epoch,
      extract(epoch from t.printed_time) as printed_time_epoch,
      extract(epoch from t.scheduled_on_job_time) as scheduled_on_job_time_epoch,
      t.remove_reason_code as remove_reason_code,
      COALESCE(tp.load_qty, 0) as load_qty
    FROM tickets t
    INNER JOIN orders o ON o.order_id = t.order_id
    LEFT JOIN LATERAL (
      -- Deterministic: web uses Array.find(p => p.is_mix === true) which
      -- picks the FIRST is_mix product in Supabase's default (physical/
      -- insertion) order — effectively id ASC on a fresh table. ORDER BY
      -- tp2.id ASC makes the backend pick the same row the web would,
      -- eliminating a non-deterministic source of load_qty drift when a
      -- ticket has more than one is_mix=true product.
      SELECT tp2.load_qty
      FROM ticket_products tp2
      WHERE tp2.ticket_id = t.ticket_id AND tp2.is_mix = true
      ORDER BY tp2.id ASC
      LIMIT 1
    ) tp ON true
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
    ORDER BY t.on_job_time ASC NULLS LAST
  `;

  // Query to get full product schedule details (matching web's Product Schedules Table)
  const productScheduleDetailsSql = `
    SELECT
      ops.id as schedule_id,
      ops.order_product_id,
      ops.product_schedule_id,
      op.item_code,
      op.description,
      op.is_mix,
      op.slump,
      ops.plant_code,
      p.description as plant_description,
      ops.schedule_qty,
      ops.schedule_delv_qty,
      ops.number_of_loads,
      ops.trucks_required,
      ops.load_qty,
      ops.truck_space,
      ops.delivery_rate_per_hour,
      ops.unload_time,
      ops.unload_rate_per_hour,
      ops.distance,
      ops.time_to_job,
      ops.time_to_plant,
      ops.job_wash_time,
      ops.hold_qty,
      ops.truck_type_code,
      ops.truck_type_name,
      ops.pouring_method_code,
      ops.pouring_method_short,
      timezone('UTC', ops.start_time) as start_time,
      extract(epoch from ops.start_time) as start_time_epoch_for_delay
    FROM order_product_schedules ops
    INNER JOIN order_products op ON op.id = ops.order_product_id
    INNER JOIN orders o ON o.order_id = op.order_id
    LEFT JOIN plants p ON p.code = ops.plant_code
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
    ORDER BY ops.start_time ASC
  `;

  // Query to get per-status ticket quantities for delivery progress bar
  const ticketProgressSql = `
    SELECT
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
      END as ticket_status,
      COALESCE(SUM(tp.load_qty), 0) as status_qty,
      COUNT(*) as status_cnt
    FROM tickets t
    INNER JOIN orders o ON o.order_id = t.order_id
    LEFT JOIN LATERAL (
      SELECT load_qty
      FROM ticket_products
      WHERE ticket_id = t.ticket_id AND is_mix = true
      LIMIT 1
    ) tp ON true
    WHERE o.order_code = $1 AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
    GROUP BY ticket_status
  `;

  // Query to get associated non-mix products for the order
  const associatedProductsSql = `
    SELECT
      op.id as order_product_id,
      op.product_id,
      op.item_code,
      op.description,
      op.is_mix,
      op.slump,
      op.order_qty as ordered_qty,
      op.delv_qty as delivered_qty,
      op.order_qty_unit,
      ops.product_schedule_id
    FROM order_products op
    INNER JOIN orders o ON o.order_id = op.order_id
    LEFT JOIN order_product_schedules ops ON ops.order_product_id = op.id
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND op.is_mix = false
    ORDER BY op.id
  `;

  // Query to get order change logs (realtime updates)
  const changeLogsSql = `
    SELECT
      id,
      order_id,
      order_code,
      order_date,
      table_name,
      record_id,
      field_name,
      old_value,
      new_value,
      old_display_value,
      new_display_value,
      change_message,
      change_type,
      change_source,
      changed_at,
      cron_execution_id,
      related_field_name,
      related_old_value,
      related_new_value,
      related_display_message,
      display_order,
      has_comment
    FROM order_change_logs
    WHERE order_id = $1
    ORDER BY changed_at DESC, id DESC
    LIMIT 100
  `;

  // Query to get order archive snapshot for "Order Created" item in realtime updates
  // Data comes from archive_orders table (purchase_order, instructions, ordered_by, created_date)
  // Uses is_latest = true to get the most current archived snapshot
  const snapshotFieldsSql = `
    SELECT
      oa.purchase_order,
      TRIM(BOTH ', ' FROM
        COALESCE(NULLIF(oa.instruction_addr1, ''), '') ||
        CASE WHEN oa.instruction_addr2 IS NOT NULL AND oa.instruction_addr2 != '' THEN ', ' || oa.instruction_addr2 ELSE '' END ||
        CASE WHEN oa.instruction_addr3 IS NOT NULL AND oa.instruction_addr3 != '' THEN ', ' || oa.instruction_addr3 ELSE '' END ||
        CASE WHEN oa.instruction_addr4 IS NOT NULL AND oa.instruction_addr4 != '' THEN ', ' || oa.instruction_addr4 ELSE '' END ||
        CASE WHEN oa.instruction_addr5 IS NOT NULL AND oa.instruction_addr5 != '' THEN ', ' || oa.instruction_addr5 ELSE '' END ||
        CASE WHEN oa.instruction_addr6 IS NOT NULL AND oa.instruction_addr6 != '' THEN ', ' || oa.instruction_addr6 ELSE '' END
      ) as instructions,
      TRIM(
        COALESCE(oa.ordered_by_name, '') ||
        CASE WHEN oa.ordered_by_phone IS NOT NULL AND oa.ordered_by_phone != '' THEN ' ' || oa.ordered_by_phone ELSE '' END
      ) as ordered_by,
      oa.created_date
    FROM archive_orders oa
    WHERE oa.order_id = $1
    ORDER BY oa.archived_at ASC
    LIMIT 1
  `;

  // Query to get all tickets for delay details (filter/sort in JS per delay-details.md)
  // Use AT TIME ZONE 'UTC' so stored wall-clock times (15:00, 13:32) are returned as 15:00Z, 13:32Z to match reference
  const delayDetailsTicketsSql = `
    SELECT
      t.ticket_id,
      t.ticket_code,
      t.truck_code,
      extract(epoch from (t.printed_time AT TIME ZONE 'UTC')) as printed_time_epoch,
      extract(epoch from (t.on_job_time AT TIME ZONE 'UTC')) as on_job_time_epoch,
      extract(epoch from (t.unload_time AT TIME ZONE 'UTC')) as unload_time_epoch,
      extract(epoch from (t.end_unload AT TIME ZONE 'UTC')) as end_unload_epoch,
      extract(epoch from (t.wash_time AT TIME ZONE 'UTC')) as wash_time_epoch,
      extract(epoch from (t.to_plant_time AT TIME ZONE 'UTC')) as to_plant_time_epoch,
      extract(epoch from (t.scheduled_on_job_time AT TIME ZONE 'UTC')) as scheduled_on_job_time_epoch,
      t.remove_reason_code,
      COALESCE(tp.load_qty, 0) as load_qty
    FROM tickets t
    INNER JOIN orders o ON o.order_id = t.order_id
    LEFT JOIN LATERAL (
      SELECT tp2.load_qty
      FROM ticket_products tp2
      WHERE tp2.ticket_id = t.ticket_id AND tp2.is_mix = true
      LIMIT 1
    ) tp ON true
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
  `;

  // Query to get scheduled loads with actual ticket data
  // Uses extract(epoch) for unambiguous UTC timestamps — matches graph query approach
  const scheduledLoadsSql = `
    SELECT
      opsl.id,
      opsl.order_product_schedule_id,
      opsl.schedule_load_id,
      opsl.from_plant_id,
      opsl.from_plant,
      opsl.load_qty as scheduled_load_qty,
      opsl.truck_id,
      opsl.truck_code,
      opsl.to_plant_id,
      opsl.to_plant,
      opsl.time_to_job,
      opsl.unload_time,
      opsl.time_to_plant,
      opsl.truck_space,
      extract(epoch from opsl.printed_time) as scheduled_printed_time_epoch,
      extract(epoch from opsl.load_time) as scheduled_load_time_epoch,
      extract(epoch from opsl.on_job_time) as scheduled_on_job_time_epoch,
      extract(epoch from opsl.fin_pour_time) as scheduled_fin_pour_time_epoch,
      extract(epoch from opsl.at_plant_time) as scheduled_at_plant_time_epoch,
      opsl.time_to_wash,
      opsl.ticket_id,
      opsl.ticket_code,
      extract(epoch from t.printed_time) as actual_ticketed_time_epoch,
      extract(epoch from t.load_time) as actual_loading_time_epoch,
      extract(epoch from t.loaded_time) as actual_loaded_time_epoch,
      extract(epoch from t.to_job_time) as actual_to_job_time_epoch,
      extract(epoch from t.on_job_time) as actual_on_job_time_epoch,
      extract(epoch from t.unload_time) as actual_unload_time_epoch,
      extract(epoch from t.end_unload) as actual_end_pour_time_epoch,
      extract(epoch from t.wash_time) as actual_wash_time_epoch,
      extract(epoch from t.to_plant_time) as actual_to_plant_time_epoch,
      extract(epoch from t.at_plant_time) as actual_at_plant_time_epoch,
      t.remove_reason_code as ticket_remove_reason_code,
      tp.load_qty as actual_load_qty
    FROM order_product_schedule_loads opsl
    INNER JOIN order_product_schedules ops ON ops.id = opsl.order_product_schedule_id
    INNER JOIN order_products op ON op.id = ops.order_product_id
    INNER JOIN orders o ON o.order_id = op.order_id
    LEFT JOIN tickets t ON t.ticket_code = opsl.ticket_code AND t.order_id = o.order_id
    LEFT JOIN LATERAL (
      SELECT tp2.load_qty
      FROM ticket_products tp2
      WHERE tp2.ticket_id = t.ticket_id AND tp2.is_mix = true
      LIMIT 1
    ) tp ON true
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
    ORDER BY opsl.schedule_load_id ASC
    LIMIT $3 OFFSET $4
  `;

  // Count query for scheduled loads pagination (includes completed and cancelled counts)
  const scheduledLoadsCountSql = `
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (
        WHERE t.ticket_id IS NOT NULL
        AND t.remove_reason_code IS NOT NULL
        AND TRIM(t.remove_reason_code) != ''
      ) as cancelled_count,
      COUNT(*) FILTER (
        WHERE t.ticket_id IS NOT NULL
        AND (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
        AND (t.end_unload IS NOT NULL OR t.wash_time IS NOT NULL)
      ) as completed_count
    FROM order_product_schedule_loads opsl
    INNER JOIN order_product_schedules ops ON ops.id = opsl.order_product_schedule_id
    INNER JOIN order_products op ON op.id = ops.order_product_id
    INNER JOIN orders o ON o.order_id = op.order_id
    LEFT JOIN tickets t ON t.ticket_code = opsl.ticket_code AND t.order_id = o.order_id
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
  `;

  // Calculate pagination offset
  const loadsPage = loadsPagination.page || 1;
  const loadsLimit = loadsPagination.limit || 100;
  const loadsOffset = (loadsPage - 1) * loadsLimit;

  try {
    // Execute order query first (required - other queries depend on order existing)
    const orderResult = await executeDirectSQL(sql, [orderCode, orderDate]);
    const orderRow = orderResult.data?.[0];

    if (!orderRow) {
      return null;
    }

    const orderId = orderRow.order_id;

    // Execute all remaining queries in parallel
    const queryArgs = [orderCode, orderDate];
    const scheduledLoadsQueryArgs = [orderCode, orderDate, loadsLimit, loadsOffset];
    const [
      productsResult,
      uniqueProductsResult,
      productSchedulesResult,
      truckStatusCountResult,
      truckCountResult,
      notesResult,
      scheduleResult,
      graphScheduleResult,
      graphTicketsResult,
      productScheduleDetailsResult,
      scheduledLoadsResult,
      scheduledLoadsCountResult,
      changeLogsResult,
      associatedProductsResult,
      snapshotFieldsResult,
      delayDetailsTicketsResult,
      ticketProgressResult
    ] = await Promise.all([
      executeDirectSQL(productsSql, queryArgs),
      executeDirectSQL(uniqueProductsSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch unique products:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(productSchedulesSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch product schedules:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(truckStatusCountSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch truck status counts:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(truckCountSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch truck count:', err.message);
        return { data: [{ truck_count: 0 }] };
      }),
      executeDirectSQL(notesSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch notes:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(scheduleSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch schedule data:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(graphScheduleSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch graph schedule data:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(graphTicketsSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch graph ticket data:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(productScheduleDetailsSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch product schedule details:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(scheduledLoadsSql, scheduledLoadsQueryArgs).catch(err => {
        console.warn('Warning: Could not fetch scheduled loads:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(scheduledLoadsCountSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch scheduled loads count:', err.message);
        return { data: [{ total: 0 }] };
      }),
      executeDirectSQL(changeLogsSql, [orderId]).catch(err => {
        console.warn('Warning: Could not fetch change logs:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(associatedProductsSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch associated products:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(snapshotFieldsSql, [orderId]).catch(err => {
        console.warn('Warning: Could not fetch order archive snapshot:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(delayDetailsTicketsSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch delay details tickets:', err.message);
        return { data: [] };
      }),
      executeDirectSQL(ticketProgressSql, queryArgs).catch(err => {
        console.warn('Warning: Could not fetch ticket progress:', err.message);
        return { data: [] };
      })
    ]);

    // Get products with tickets for calculating totals
    const productsWithTickets = (productsResult.data || []).filter(p => p.ticket_code);
    const firstProduct = (productsResult.data || [])[0];

    // Build unique products array (no duplicates, with description and quantities)
    const products = (uniqueProductsResult.data || []).map(p => ({
      order_product_id: p.order_product_id,
      product_id: p.product_id,
      item_code: p.item_code,
      description: p.description || null,
      is_mix: p.is_mix || false,
      ordered_qty: parseFloat(p.ordered_qty) || 0,
      delivered_qty: parseFloat(p.delivered_qty) || 0
    }));

    // Build product items array (schedules as shown in web - each schedule is an item with plant info)
    const product_items = (productSchedulesResult.data || []).map(s => ({
      schedule_id: s.schedule_id,
      order_product_id: s.order_product_id,
      item_code: s.item_code,
      description: s.description || null,
      is_mix: s.is_mix || false,
      plant_code: s.plant_code,
      plant_description: s.plant_description || null,
      scheduled_qty: parseFloat(s.scheduled_qty) || 0,
      delivered_qty: parseFloat(s.delivered_qty) || 0,
      start_time: formatTime(s.start_time, tz),
      number_of_loads: parseInt(s.number_of_loads) || 0,
      status: s.schedule_status || 'Normal'
    }));

    // Build associated products array (non-mix products for this order)
    const associated_products = (associatedProductsResult.data || []).map(p => ({
      order_product_id: p.order_product_id,
      product_id: p.product_id,
      item_code: p.item_code,
      description: p.description || null,
      is_mix: p.is_mix || false,
      slump: p.slump || null,
      schedule_number: p.product_schedule_id || null,
      ordered_qty: parseFloat(p.ordered_qty) || 0,
      delivered_qty: parseFloat(p.delivered_qty) || 0,
      order_qty_unit: p.order_qty_unit || null
    }));

    // Calculate actual average spacing from delivered tickets (for pour_rate)
    const graphTicketsForSpacing = (graphTicketsResult.data || [])
      .filter(t => t.on_job_time_epoch)
      .sort((a, b) => parseFloat(a.on_job_time_epoch) - parseFloat(b.on_job_time_epoch));
    let avgActualSpacingMin = null;
    if (graphTicketsForSpacing.length > 1) {
      let totalSpacing = 0;
      let spacingCount = 0;
      for (let i = 1; i < graphTicketsForSpacing.length; i++) {
        const prev = parseFloat(graphTicketsForSpacing[i - 1].on_job_time_epoch);
        const curr = parseFloat(graphTicketsForSpacing[i].on_job_time_epoch);
        if (prev && curr) {
          totalSpacing += (curr - prev) / 60;
          spacingCount++;
        }
      }
      if (spacingCount > 0) {
        avgActualSpacingMin = Math.round(totalSpacing / spacingCount * 10) / 10;
      }
    }

    // Build product schedule details (full schedule data matching web's Product Schedules Table)
    const product_schedule_details = (productScheduleDetailsResult.data || []).map(s => ({
      schedule_id: s.schedule_id,
      order_product_id: s.order_product_id,
      product_schedule_id: s.product_schedule_id,
      item_code: s.item_code,
      description: s.description || null,
      is_mix: s.is_mix || false,
      slump: s.slump || null,
      plant_code: s.plant_code,
      plant_description: s.plant_description || null,
      schedule_qty: parseFloat(s.schedule_qty) || 0,
      schedule_delv_qty: parseFloat(s.schedule_delv_qty) || 0,
      hold_qty: parseFloat(s.hold_qty) || 0,
      number_of_loads: parseInt(s.number_of_loads) || 0,
      trucks_required: parseFloat(s.trucks_required) || 0,
      load_qty: parseFloat(s.load_qty) || 0,
      truck_space: parseInt(s.truck_space) || 0,
      delivery_rate_per_hour: parseFloat(s.delivery_rate_per_hour) || 0,
      unload_time: parseInt(s.unload_time) || 0,
      unload_rate_per_hour: parseFloat(s.unload_rate_per_hour) || 0,
      distance: parseFloat(s.distance) || 0,
      time_to_job: parseInt(s.time_to_job) || 0,
      time_to_plant: parseInt(s.time_to_plant) || 0,
      job_wash_time: parseInt(s.job_wash_time) || 0,
      truck_type_code: s.truck_type_code || null,
      truck_type_name: s.truck_type_name || null,
      pouring_method_code: s.pouring_method_code || null,
      pouring_method_short: s.pouring_method_short || null,
      start_time: formatTime(s.start_time, tz),
      primary_product: {
        item_code: s.item_code,
        description: s.description || null,
        quantity: parseFloat(s.schedule_qty) || 0,
        slump: s.slump || null,
        schedule_number: s.product_schedule_id,
        start_time: formatTime(s.start_time, tz)
      },
      pour_rate: {
        spacing_min: parseInt(s.truck_space) || 0,
        scheduled_rate: parseFloat(s.delivery_rate_per_hour) || 0,
        actual_spacing_min: avgActualSpacingMin
      },
      associated_products
    }));

    // Build realtime order updates from change logs
    const changeLogItems = (changeLogsResult.data || []).map(c => ({
      id: c.id,
      order_id: c.order_id,
      order_code: c.order_code,
      order_date: c.order_date,
      table_name: c.table_name || null,
      record_id: c.record_id || null,
      field_name: c.field_name || null,
      old_value: c.old_value || null,
      new_value: c.new_value || null,
      old_display_value: c.old_display_value || null,
      new_display_value: c.new_display_value || null,
      change_message: c.change_message || null,
      change_type: c.change_type || null,
      change_source: c.change_source || null,
      changed_at: formatDateTimeCST(c.changed_at, tz),
      cron_execution_id: c.cron_execution_id || null,
      related_field_name: c.related_field_name || null,
      related_old_value: c.related_old_value || null,
      related_new_value: c.related_new_value || null,
      related_display_message: c.related_display_message || null,
      display_order: c.display_order != null ? parseInt(c.display_order) : null,
      has_comment: c.has_comment || false
    }));

    // Build "Order Created" snapshot item (displayed at bottom of realtime updates list)
    // Reconstructs initial order state from change logs + current order data
    const rawChangeLogs = changeLogsResult.data || [];
    const snapshotRow = (snapshotFieldsResult.data || [])[0] || {};

    // Find initial status by looking at the oldest status change log
    const oldestStatusChange = [...rawChangeLogs]
      .filter(c => c.field_name === 'current_status')
      .sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at))[0];
    const initialStatus = oldestStatusChange
      ? (oldestStatusChange.old_display_value || STATUS_CODE_MAP[String(orderRow.current_status)] || ORDER_STATUS.NORMAL)
      : (STATUS_CODE_MAP[String(orderRow.current_status)] || ORDER_STATUS.NORMAL);

    // Find initial delivery address from oldest address change log
    const currentAddress = [orderRow.delivery_addr1, orderRow.delivery_addr2, orderRow.delivery_addr3]
      .filter(Boolean).join(', ');
    const oldestAddressChange = [...rawChangeLogs]
      .filter(c => c.field_name === 'delivery_address')
      .sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at))[0];
    const initialAddress = oldestAddressChange
      ? (oldestAddressChange.old_value || currentAddress)
      : currentAddress;

    // Find initial volume from oldest volume change log (for single-product orders)
    const volumeChanges = [...rawChangeLogs]
      .filter(c => c.field_name === 'volume' && c.table_name === 'order_products')
      .sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));
    const oldestVolumeValue = volumeChanges.length > 0
      ? parseFloat(volumeChanges[0].old_value)
      : null;

    // Build products list for snapshot (mix + non-mix associated products)
    const snapshotProducts = [];
    const hasSingleMixProduct = products.length === 1;

    for (const p of products) {
      // Use initial volume if single mix product and volume changes exist
      const initialQty = (hasSingleMixProduct && oldestVolumeValue != null)
        ? oldestVolumeValue
        : (parseFloat(p.ordered_qty) || 0);
      const schedule = product_schedule_details.find(s => s.order_product_id === p.order_product_id);
      snapshotProducts.push({
        item_code: p.item_code,
        description: p.description || null,
        quantity: `${initialQty.toFixed(2)} CY`,
        slump: schedule ? schedule.slump : null
      });
    }

    for (const p of associated_products) {
      const unit = p.order_qty_unit || 'ea';
      const qty = parseFloat(p.ordered_qty) || 0;
      snapshotProducts.push({
        item_code: p.item_code,
        description: p.description || null,
        quantity: `${qty.toFixed(2)} ${unit}`,
        slump: null
      });
    }

    const orderCreatedItem = {
      change_type: 'order_created',
      order_number: orderRow.order_code,
      order_status: initialStatus,
      plant: orderRow.plant_description || orderRow.plant_short_description || null,
      delivery_address: initialAddress,
      purchase_order: snapshotRow.purchase_order || 'n/a',
      instructions: snapshotRow.instructions || 'n/a',
      ordered_by: snapshotRow.ordered_by || 'n/a',
      created: formatDateTimeCST(snapshotRow.created_date, tz),
      products: snapshotProducts
    };

    const realtime_order_updates = {
      items: [...changeLogItems, orderCreatedItem],
      count: changeLogItems.length + 1
    };

    // Build scheduled loads with actual ticket data
    // Uses epoch-based time formatting (same as graph) to match web frontend exactly
    // Times in 12-hour AM/PM format (e.g., "1:45 PM"), quantities as "10.50 CY"
    const scheduledLoadItems = (scheduledLoadsResult.data || []).map((l, index) => {
      const scheduledQty = parseFloat(l.scheduled_load_qty) || 0;
      const isTicketCancelled = l.ticket_remove_reason_code != null &&
        String(l.ticket_remove_reason_code).trim() !== '';
      const hasTicket = l.ticket_code != null && !isTicketCancelled;
      const actualQty = hasTicket && l.actual_load_qty != null ? parseFloat(l.actual_load_qty) : null;
      const variance = actualQty != null ? actualQty - scheduledQty : null;

      // Convert epochs to Date objects for formatting
      const scheduledOnJobDate = epochToDate(l.scheduled_on_job_time_epoch);
      const actualOnJobDate = hasTicket ? epochToDate(l.actual_on_job_time_epoch) : null;

      // Derive per-load truck status from actual ticket timestamps
      // Uses GREATEST logic: the latest non-null timestamp determines current status
      let load_status = 'Scheduled';
      let load_status_code = 'scheduled';
      if (isTicketCancelled) {
        load_status = 'Cancelled';
        load_status_code = 'cancelled';
      } else if (hasTicket) {
        const statusTimestamps = [
          { epoch: l.actual_at_plant_time_epoch, status: 'At Plant', code: 'at_plant' },
          { epoch: l.actual_to_plant_time_epoch, status: 'To Plant', code: 'to_plant' },
          { epoch: l.actual_wash_time_epoch, status: 'Washing', code: 'washing' },
          { epoch: l.actual_end_pour_time_epoch, status: 'Poured Out', code: 'poured_out' },
          { epoch: l.actual_unload_time_epoch, status: 'Pouring', code: 'pouring' },
          { epoch: l.actual_on_job_time_epoch, status: 'At Job', code: 'at_job' },
          { epoch: l.actual_to_job_time_epoch, status: 'To Job', code: 'to_job' },
          { epoch: l.actual_loaded_time_epoch, status: 'Loaded', code: 'loaded' },
          { epoch: l.actual_loading_time_epoch, status: 'Loading', code: 'loading' },
          { epoch: l.actual_ticketed_time_epoch, status: 'Ticketed', code: 'ticketed' },
        ];
        let latestEpoch = 0;
        for (const st of statusTimestamps) {
          const ep = st.epoch != null ? parseFloat(st.epoch) : 0;
          if (ep > latestEpoch) {
            latestEpoch = ep;
            load_status = st.status;
            load_status_code = st.code;
          }
        }
        // Fallback: if ticket exists but no timestamps, it's ticketed
        if (latestEpoch === 0) {
          load_status = 'Ticketed';
          load_status_code = 'ticketed';
        }
      }

      // A load is "completed" (poured out) when end_unload or wash_time exists
      const endPourEpoch = l.actual_end_pour_time_epoch != null ? parseFloat(l.actual_end_pour_time_epoch) : null;
      const washEpoch = l.actual_wash_time_epoch != null ? parseFloat(l.actual_wash_time_epoch) : null;
      const is_completed = hasTicket && (endPourEpoch != null || washEpoch != null);

      return {
        load_number: index + 1,
        // Per-load status (replaces "Done" badge on frontend)
        load_status,
        load_status_code,
        is_completed,
        // Display values matching web's Load Summary table
        scheduled_time: formatGraphTime(scheduledOnJobDate, tz),
        actual_time: formatGraphTime(actualOnJobDate, tz),
        scheduled_qty: `${scheduledQty.toFixed(2)} CY`,
        actual_qty: actualQty != null ? `${actualQty.toFixed(2)} CY` : null,
        variance: variance != null ? `${variance >= 0 ? '+' : ''}${variance.toFixed(2)} CY` : null,
        // Raw numeric values for programmatic use
        scheduled_qty_raw: scheduledQty,
        actual_qty_raw: actualQty,
        variance_raw: variance,
        // All other fields
        id: l.id,
        order_product_schedule_id: l.order_product_schedule_id,
        schedule_load_id: l.schedule_load_id,
        from_plant_id: l.from_plant_id,
        from_plant: l.from_plant || null,
        truck_id: l.truck_id,
        truck_code: l.truck_code || null,
        to_plant_id: l.to_plant_id,
        to_plant: l.to_plant || null,
        time_to_job: parseInt(l.time_to_job) || 0,
        unload_time: parseInt(l.unload_time) || 0,
        time_to_plant: parseInt(l.time_to_plant) || 0,
        truck_space: parseInt(l.truck_space) || 0,
        scheduled_printed_time: formatGraphTime(epochToDate(l.scheduled_printed_time_epoch), tz),
        scheduled_load_time: formatGraphTime(epochToDate(l.scheduled_load_time_epoch), tz),
        scheduled_on_job_time: formatGraphTime(scheduledOnJobDate, tz),
        scheduled_fin_pour_time: formatGraphTime(epochToDate(l.scheduled_fin_pour_time_epoch), tz),
        scheduled_at_plant_time: formatGraphTime(epochToDate(l.scheduled_at_plant_time_epoch), tz),
        time_to_wash: parseInt(l.time_to_wash) || 0,
        ticket_id: l.ticket_id || null,
        ticket_code: l.ticket_code || null,
        // Actual times — clearly named for frontend
        actual_on_job_time: formatGraphTime(actualOnJobDate, tz),
        actual_begin_pour_time: hasTicket ? formatGraphTime(epochToDate(l.actual_unload_time_epoch), tz) : null,
        actual_end_pour_time: hasTicket ? formatGraphTime(epochToDate(l.actual_end_pour_time_epoch), tz) : null,
        actual_wash_time: hasTicket ? formatGraphTime(epochToDate(l.actual_wash_time_epoch), tz) : null,
        actual_to_plant_time: hasTicket ? formatGraphTime(epochToDate(l.actual_to_plant_time_epoch), tz) : null,
        actual_at_plant_time: hasTicket ? formatGraphTime(epochToDate(l.actual_at_plant_time_epoch), tz) : null,
        // Keep old field name for backward compat
        actual_unload_time: hasTicket ? formatGraphTime(epochToDate(l.actual_unload_time_epoch), tz) : null,
        ticket_remove_reason_code: l.ticket_remove_reason_code || null
      };
    });

    // Get total scheduled loads counts from count query (for pagination and truck_status_count)
    const scheduledLoadsCountRow = scheduledLoadsCountResult.data?.[0] || {};
    const totalScheduledLoads = parseInt(scheduledLoadsCountRow.total) || 0;
    const totalCompletedLoads = parseInt(scheduledLoadsCountRow.completed_count) || 0;
    const totalCancelledLoads = parseInt(scheduledLoadsCountRow.cancelled_count) || 0;
    const totalPages = Math.ceil(totalScheduledLoads / loadsLimit);

    const scheduled_loads = {
      items: scheduledLoadItems,
      total: totalScheduledLoads,
      count: totalScheduledLoads,
      completed_count: totalCompletedLoads,
      cancelled_count: totalCancelledLoads,
      pagination: {
        page: loadsPage,
        limit: loadsLimit,
        total: totalScheduledLoads,
        total_pages: totalPages,
        has_next: loadsPage < totalPages,
        has_prev: loadsPage > 1
      }
    };

    // Build truck status count object (includes all scheduled loads, not just ticketed ones)
    const truckStatusRow = truckStatusCountResult.data?.[0] || {};
    const ticketedLoadCount = parseInt(truckStatusRow.total) || 0;
    const cancelledLoadCount = totalCancelledLoads;
    const scheduledOnlyCount = Math.max(0, totalScheduledLoads - ticketedLoadCount - cancelledLoadCount);
    const truck_status_count = {
      scheduled: scheduledOnlyCount,
      ticketed: parseInt(truckStatusRow.ticketed) || 0,
      loading: parseInt(truckStatusRow.loading) || 0,
      loaded: parseInt(truckStatusRow.loaded) || 0,
      to_job: parseInt(truckStatusRow.to_job) || 0,
      at_job: parseInt(truckStatusRow.at_job) || 0,
      pouring: parseInt(truckStatusRow.pouring) || 0,
      washing: parseInt(truckStatusRow.washing) || 0,
      to_plant: parseInt(truckStatusRow.to_plant) || 0,
      at_plant: parseInt(truckStatusRow.at_plant) || 0,
      cancelled: cancelledLoadCount,
      total: (totalScheduledLoads - cancelledLoadCount) || ticketedLoadCount
    };

    // Ticket-based delivered & poured quantities
    const ticketDeliveredQty = parseFloat(truckStatusRow.ticket_delivered_qty) || 0;
    const ticketPouredQty = parseFloat(truckStatusRow.ticket_poured_qty) || 0;

    // Build per-status qty and count maps for delivery progress bar
    const ticketProgressRows = ticketProgressResult.data || [];
    const qtyByStatus = {};
    const countByStatus = {};
    for (const r of ticketProgressRows) {
      if (r.ticket_status && r.ticket_status !== 'pending') {
        qtyByStatus[r.ticket_status] = parseFloat(r.status_qty) || 0;
        countByStatus[r.ticket_status] = parseInt(r.status_cnt, 10) || 0;
      }
    }

    // Get unique truck count
    const truckCount = parseInt(truckCountResult.data?.[0]?.truck_count) || 0;

    // Build plant details object directly from orders → plants JOIN
    const plant_details = orderRow.plant_code ? {
      code: orderRow.plant_code || null,
      description: orderRow.plant_description || null,
      short_description: orderRow.plant_short_description || null,
      address1: orderRow.plant_address1 || null,
      address2: orderRow.plant_address2 || null,
      phone: orderRow.plant_phone || null,
      latitude: orderRow.plant_latitude ? parseFloat(orderRow.plant_latitude) : null,
      longitude: orderRow.plant_longitude ? parseFloat(orderRow.plant_longitude) : null
    } : null;

    const notes = (notesResult.data || []).map(n => ({
      note_id: n.note_id || n.id || null,
      note_text: n.note_text || n.note || n.notes || n.content || n.text || '',
      created_at: n.created_at || n.created || null
    }));

    // Calculate totals from unique products only (avoid counting same product multiple times per ticket)
    const uniqueProductIds = [...new Set((uniqueProductsResult.data || []).map(p => p.order_product_id))];
    const orderedQty = (uniqueProductsResult.data || []).reduce((sum, p) => sum + (parseFloat(p.ordered_qty) || 0), 0);
    const deliveredQty = (uniqueProductsResult.data || []).reduce((sum, p) => sum + (parseFloat(p.delivered_qty) || 0), 0);

    // Check if order is cancelled to set remaining quantity to 0
    // Must be AND: removed=true AND remove_reason_code is non-empty (21 orders have reason code but removed=false)
    const isCancelled = (orderRow.removed === true || orderRow.removed === 'true') &&
      orderRow.remove_reason_code !== null &&
      String(orderRow.remove_reason_code || '').trim() !== '';
    const remainingQty = isCancelled ? 0 : Math.max(0, orderedQty - deliveredQty);

    // Get first start time from products with tickets
    const firstStartTime = formatTime(productsWithTickets.find(p => p.start_time)?.start_time || null, tz);

    // Calculate estimated finish time using schedule data
    // Dynamic recalculation: if trucks have started delivering, project from last pour time
    // Phase 1 (no pours yet): startTime + numberOfLoads × spacing
    // Phase 2 (pours in progress): lastPourTime + remainingLoads × spacing
    let estimatedFinishTime = null;
    const schedules = scheduleResult.data || [];

    if (schedules.length > 0) {
      const allEstimatedFinishTimes = schedules
        .filter(s => s.start_time_epoch)
        .map(s => {
          const startTimeMs = parseFloat(s.start_time_epoch) * 1000;
          const numberOfLoads = parseInt(s.number_of_loads) || 1;
          const truckSpaceMinutes = parseFloat(s.truck_space) || 0;
          const completedLoads = parseInt(s.completed_loads) || 0;
          const lastFinPourEpoch = parseFloat(s.last_fin_pour_epoch);

          if (completedLoads > 0 && lastFinPourEpoch) {
            // Dynamic: lastPourTime + remainingLoads × spacing
            const remainingLoads = numberOfLoads - completedLoads;
            const lastFinPourMs = lastFinPourEpoch * 1000;
            return new Date(lastFinPourMs + (remainingLoads * truckSpaceMinutes * 60 * 1000));
          } else {
            // Static: startTime + numberOfLoads × spacing
            const totalMinutes = numberOfLoads * truckSpaceMinutes;
            return new Date(startTimeMs + (totalMinutes * 60 * 1000));
          }
        });

      if (allEstimatedFinishTimes.length > 0) {
        const maxEstimatedFinish = new Date(Math.max(...allEstimatedFinishTimes));
        estimatedFinishTime = formatTime(maxEstimatedFinish, tz);
      }
    }

    // Fallback: use eta_at_job from products if schedule data not available
    if (!estimatedFinishTime) {
      const allEtaAtJob = (productsResult.data || [])
        .map(p => p.eta_at_job)
        .filter(eta => eta != null);
      estimatedFinishTime = allEtaAtJob.length > 0
        ? formatTime(allEtaAtJob.reduce((max, eta) => new Date(eta) > new Date(max) ? eta : max), tz)
        : null;
    }

    // Build order object with calculated status
    const orderData = {
      order_id: orderRow.order_id,
      order_code: orderRow.order_code,
      order_date: formatDateCST(orderRow.order_date),
      display_date: formatDisplayDateTime(orderRow.order_date),
      start_time: firstStartTime,
      estimated_finish_time: estimatedFinishTime,
      customer_name: orderRow.customer_name || '',
      project_name: orderRow.project_name || '',
      delivery_address: orderRow.delivery_address || '',
      delivery_addr1: orderRow.delivery_addr1 || '',
      delivery_addr2: orderRow.delivery_addr2 || '',
      delivery_addr3: orderRow.delivery_addr3 || '',
      ordered_qty: orderedQty,
      delivered_qty: deliveredQty,
      remaining_qty: remainingQty,
      remaining_display: `${remainingQty.toFixed(0)}CY`,
      ticket_delivered_qty: parseFloat(ticketDeliveredQty.toFixed(2)),
      ticket_poured_qty: parseFloat(ticketPouredQty.toFixed(2)),
      poured_percentage: orderedQty > 0 ? parseFloat(((ticketPouredQty / orderedQty) * 100).toFixed(1)) : 0,
      delivery_progress: buildDeliveryProgress(orderedQty, qtyByStatus, await fetchProgressBarColors(), countByStatus),
      current_status: orderRow.current_status,
      removed: orderRow.removed,
      remove_reason_code: orderRow.remove_reason_code,
      has_notes: orderRow.has_notes || notes.length > 0,
      products,
      product_items,
      product_items_count: product_items.length,
      truck_status_count,
      truck_count: truckCount,
      plant_details,
      order_location: {
        latitude: orderRow.order_latitude ? parseFloat(orderRow.order_latitude) : null,
        longitude: orderRow.order_longitude ? parseFloat(orderRow.order_longitude) : null
      },
      notes,
      tickets_count: ticketedLoadCount,
      notes_count: notes.length,
      product_schedule_details,
      realtime_order_updates,
      scheduled_loads,
      weather_data: (() => {
        if (!orderRow.weather_data) return null;
        if (typeof orderRow.weather_data === 'object') return orderRow.weather_data;
        if (typeof orderRow.weather_data === 'string') {
          try {
            return JSON.parse(orderRow.weather_data);
          } catch (e) {
            return orderRow.weather_data;
          }
        }
        return orderRow.weather_data;
      })()
    };

    // Calculate status
    orderData.status = calculateOrderStatus({
      ...orderData,
      tickets_count: ticketedLoadCount
    });

    // Chat is enabled for ALL orders
    orderData.can_chat = true;

    // Ticketed is enabled only for In Progress and Completed orders
    orderData.can_ticketed = orderData.status === ORDER_STATUS.IN_PROGRESS || orderData.status === ORDER_STATUS.COMPLETED;

    // Build graph data for Pour Speed and Trucks on Job charts
    const graphSchedules = graphScheduleResult.data || [];
    const graphTickets = graphTicketsResult.data || [];

    orderData.graphs = {
      pour_speed: buildPourSpeedData(graphSchedules, graphTickets, tz),
      trucks_on_job: buildTrucksOnJobData(graphTickets, tz),
      ordered_delivered_poured: buildODPData(graphSchedules, graphTickets, tz)
    };

    // Delay details: one row per load (ticket) with planned/actual times and producer/contractor delay
    const primaryScheduleRow = (productScheduleDetailsResult.data || [])[0] || null;
    const orderDateEpoch = orderRow.order_date_epoch != null ? parseFloat(orderRow.order_date_epoch) : null;
    orderData.delay_details = calculateDelayDetails(
      delayDetailsTicketsResult.data || [],
      primaryScheduleRow,
      orderDateEpoch
    );

    return orderData;
  } catch (error) {
    throw error;
  }
}

/**
 * Get orders summary/statistics with access control
 *
 * @param {object} params - Query parameters
 * @param {string} params.date_filter - Date filter
 * @param {object} userAccess - User access control data
 * @returns {Promise<object>} Summary statistics
 */
async function getOrdersSummary(params = {}, userAccess = null) {
  const { date_filter = 'today', start_date, end_date, company_name, region_name, plant_code, plant_name } = params;
  const userTz = userAccess?.timezone || null;
  // The summary "day" follows the tenant business timezone (matches the web).
  const tzIana = process.env.BUSINESS_TIMEZONE || userTz?.iana || 'America/New_York';

  // Determine date range (computed in the tenant timezone so "today" is correct)
  let dateRange;
  if (start_date && end_date) {
    dateRange = { startDate: start_date, endDate: end_date };
  } else {
    dateRange = getDateRange(date_filter, { iana: tzIana });
  }

  // Tenant-timezone-aware half-open [start, end) bounds for the timestamptz
  // order_date column, so the day boundary matches the web frontend.
  const startBound = zonedMidnightToUTCISO(dateRange.startDate, tzIana);
  const endObj = new Date(dateRange.endDate + 'T00:00:00');
  endObj.setDate(endObj.getDate() + 1);
  const endBound = zonedMidnightToUTCISO(formatDate(endObj), tzIana);

  // Fetch exclusion patterns for filtering (affects_counts subset — matches
  // web frontend getAllSummaryData so summary counts align).
  const exclusionPatterns = await fetchExclusionPatterns({ affectsCountsOnly: true });

  // Build WHERE conditions
  let extraConditions = '';
  let queryParams = [startBound, endBound];
  let paramIndex = 3;

  // Add exclusion pattern filters.
  // Matches web frontend filterExcludedOrders (src/lib/order-filters.ts):
  // customer patterns are applied as plain substring match (no "CONCRETE" gate).
  if (exclusionPatterns && exclusionPatterns.length > 0) {
    for (const pattern of exclusionPatterns) {
      const normalizedPattern = pattern.pattern?.trim()?.toLowerCase();
      if (!normalizedPattern) continue;

      switch (pattern.type) {
        case 'product':
          extraConditions += ` AND NOT EXISTS (
            SELECT 1 FROM order_products op_excl
            WHERE op_excl.order_id = o.order_id
              AND op_excl.item_code ILIKE $${paramIndex}
          )`;
          queryParams.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;

        case 'customer':
          extraConditions += ` AND o.customer_name NOT ILIKE $${paramIndex}`;
          queryParams.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;

        case 'delivery_address':
          extraConditions += ` AND COALESCE(o.delivery_addr1, '') NOT ILIKE $${paramIndex}`;
          queryParams.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;
      }
    }
  }

  // Company name filter (via pricing_plant_code → plants → companies)
  if (company_name && company_name.trim()) {
    extraConditions += ` AND EXISTS (
      SELECT 1 FROM plants p_cf
      INNER JOIN companies c_cf ON c_cf.code = p_cf.company_code
      WHERE p_cf.code = o.pricing_plant_code
        AND c_cf.name ILIKE $${paramIndex}
    )`;
    queryParams.push(`%${company_name.trim().toLowerCase()}%`);
    paramIndex++;
  }

  // Region name filter (via pricing_plant_code → plants → regions)
  if (region_name && region_name.trim()) {
    extraConditions += ` AND EXISTS (
      SELECT 1 FROM plants p_rf
      INNER JOIN regions r_rf ON r_rf.id = p_rf.region_id
      WHERE p_rf.code = o.pricing_plant_code
        AND r_rf.description ILIKE $${paramIndex}
    )`;
    queryParams.push(`%${region_name.trim().toLowerCase()}%`);
    paramIndex++;
  }

  // Plant code filter (exact match via order_product_schedules)
  if (plant_code && plant_code.trim()) {
    extraConditions += ` AND EXISTS (
      SELECT 1 FROM order_product_schedules ops_pcf
      WHERE ops_pcf.order_product_id = op.id
        AND ops_pcf.plant_code::text = $${paramIndex}
    )`;
    queryParams.push(plant_code.trim());
    paramIndex++;
  }

  // Plant name filter (partial match via order_product_schedules → plants)
  if (plant_name && plant_name.trim()) {
    extraConditions += ` AND EXISTS (
      SELECT 1 FROM order_product_schedules ops_pnf
      INNER JOIN plants p_pnf ON p_pnf.code = ops_pnf.plant_code
      WHERE ops_pnf.order_product_id = op.id
        AND p_pnf.description ILIKE $${paramIndex}
    )`;
    queryParams.push(`%${plant_name.trim().toLowerCase()}%`);
    paramIndex++;
  }

  // Access Control (zones already resolved to plants in auth.js)
  if (userAccess && !userAccess.isAdmin) {
    const accessOrParts = [];

    if (userAccess.allowedPlants && userAccess.allowedPlants.length > 0) {
      const placeholders = userAccess.allowedPlants.map((_, i) => `$${paramIndex + i}::text`).join(', ');
      accessOrParts.push(`EXISTS (SELECT 1 FROM order_product_schedules ops WHERE ops.order_product_id = op.id AND ops.plant_code::text IN (${placeholders}))`);
      queryParams.push(...userAccess.allowedPlants.map(p => String(p)));
      paramIndex += userAccess.allowedPlants.length;
    }

    if (userAccess.allowedCustomerIds && userAccess.allowedCustomerIds.length > 0) {
      const placeholders = userAccess.allowedCustomerIds.map((_, i) => `$${paramIndex + i}`).join(', ');
      accessOrParts.push(`o.customer_id IN (${placeholders})`);
      queryParams.push(...userAccess.allowedCustomerIds);
      paramIndex += userAccess.allowedCustomerIds.length;
    }

    if (userAccess.allowedProjectCodes && userAccess.allowedProjectCodes.length > 0) {
      const placeholders = userAccess.allowedProjectCodes.map((_, i) => `$${paramIndex + i}`).join(', ');
      accessOrParts.push(`o.project_code IN (${placeholders})`);
      queryParams.push(...userAccess.allowedProjectCodes);
      paramIndex += userAccess.allowedProjectCodes.length;
    }

    if (accessOrParts.length > 0) {
      extraConditions += ` AND (${accessOrParts.join(' OR ')})`;
    } else {
      extraConditions += ' AND FALSE';
    }
  }

  const sql = `
    WITH order_base AS (
      -- Eligibility: order has at least one CY-unit mix product. Matches web
      -- frontend INNER JOIN on (CY AND is_mix=true) so summary counts mirror
      -- web getAllSummaryData / market summary card.
      SELECT
        o.order_id,
        o.removed,
        o.remove_reason_code,
        COALESCE(o.current_status, 1) as current_status,
        SUM(COALESCE(op.order_qty, 0)) as ordered_qty,
        SUM(COALESCE(op.delv_qty, 0)) as delivered_qty
      FROM orders o
      INNER JOIN order_products op ON op.order_id = o.order_id
        AND op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true
      WHERE o.order_date >= $1::timestamptz
        AND o.order_date < $2::timestamptz
        ${extraConditions}
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
      INNER JOIN orders o_ltc ON o_ltc.order_id = t.order_id
      WHERE (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
        AND o_ltc.order_date >= $1::timestamptz AND o_ltc.order_date < $2::timestamptz
      ORDER BY t.order_id, t.created_date DESC NULLS LAST
    ),
    order_statuses AS (
      SELECT
        ob.order_id,
        ob.removed,
        ob.remove_reason_code,
        ob.ordered_qty,
        ob.delivered_qty,
        CASE
          WHEN ob.removed = true AND ob.remove_reason_code IS NOT NULL AND TRIM(CAST(ob.remove_reason_code AS TEXT)) <> '' THEN 'Canceled'
          WHEN ob.current_status = 4 THEN 'Completed'
          WHEN ob.ordered_qty > 0 AND ob.delivered_qty >= ob.ordered_qty THEN 'Completed'
          WHEN ob.delivered_qty > 0 AND COALESCE(ltc.is_last_load_completed, false) = true
            AND (ob.ordered_qty - ob.delivered_qty) <= 0.02 THEN 'Completed'
          WHEN ob.delivered_qty > 0 AND ob.delivered_qty < ob.ordered_qty THEN 'In Progress'
          WHEN ob.current_status = 1 THEN 'Will Call'
          WHEN ob.current_status = 3 THEN 'Hold Delivery'
          WHEN ob.current_status = 5 THEN 'Wait List'
          ELSE 'Normal'
        END as status
      FROM order_base ob
      LEFT JOIN last_ticket_completion ltc ON ltc.order_id = ob.order_id
    ),
    status_counts AS (
      SELECT
        COUNT(*) as total_orders,
        COUNT(*) FILTER (WHERE status = 'Canceled') as cancelled_orders,
        COUNT(*) FILTER (WHERE status != 'Canceled') as active_orders,
        COUNT(*) FILTER (WHERE status = 'Completed') as completed_orders,
        COUNT(*) FILTER (WHERE status = 'Normal') as normal_orders,
        COUNT(*) FILTER (WHERE status = 'Will Call') as will_call_orders,
        COUNT(*) FILTER (WHERE status = 'Hold Delivery') as hold_delivery_orders,
        COUNT(*) FILTER (WHERE status = 'Wait List') as wait_list_orders,
        COUNT(*) FILTER (WHERE status = 'In Progress') as in_progress_orders
      FROM order_statuses
    ),
    cy_totals AS (
      SELECT
        COALESCE(SUM(os.ordered_qty), 0) as total_ordered_qty,
        COALESCE(SUM(os.delivered_qty), 0) as total_delivered_qty
      FROM order_statuses os
      WHERE os.status != 'Canceled'
    )
    SELECT
      sc.total_orders,
      sc.cancelled_orders,
      sc.active_orders,
      sc.completed_orders,
      sc.normal_orders,
      sc.will_call_orders,
      sc.hold_delivery_orders,
      sc.wait_list_orders,
      sc.in_progress_orders,
      ct.total_ordered_qty,
      ct.total_delivered_qty
    FROM status_counts sc, cy_totals ct
  `;

  try {
    const result = await executeDirectSQL(sql, queryParams);
    const row = result.data?.[0] || {};

    const totalOrdered = parseFloat(row.total_ordered_qty) || 0;
    const totalDelivered = parseFloat(row.total_delivered_qty) || 0;
    const totalRemaining = Math.max(0, totalOrdered - totalDelivered);

    return {
      total_orders: parseInt(row.total_orders, 10) || 0,
      active_orders: parseInt(row.active_orders, 10) || 0,
      total_ordered_qty: totalOrdered,
      total_delivered_qty: totalDelivered,
      total_remaining_qty: totalRemaining,
      cancelled_orders: parseInt(row.cancelled_orders, 10) || 0,
      completed_orders: parseInt(row.completed_orders, 10) || 0,
      normal_orders: parseInt(row.normal_orders, 10) || 0,
      will_call_orders: parseInt(row.will_call_orders, 10) || 0,
      hold_delivery_orders: parseInt(row.hold_delivery_orders, 10) || 0,
      wait_list_orders: parseInt(row.wait_list_orders, 10) || 0,
      in_progress_orders: parseInt(row.in_progress_orders, 10) || 0,
      date_range: dateRange,
      delivery_progress: totalOrdered > 0
        ? Math.round((totalDelivered / totalOrdered) * 100)
        : 0
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Get today's In Progress orders with full tracking data:
 * truck locations, plant locations, order location, all tickets load-by-load
 *
 * @param {object} params - Query parameters
 * @param {string} params.date_filter - Date filter (default: today)
 * @param {string} params.start_date - Custom start date
 * @param {string} params.end_date - Custom end date
 * @param {object} userAccess - User access control data
 * @returns {Promise<object>} Active tracking data
 */
async function getActiveTrackingOrders(params = {}, userAccess = null) {
  const { date_filter = 'today', start_date, end_date, company_name, region_name, plant_code, plant_name } = params;
  const userTz = userAccess?.timezone || null;
  // The tracking "day" follows the tenant business timezone (matches the web).
  const tzIana = process.env.BUSINESS_TIMEZONE || userTz?.iana || 'America/New_York';
  // Display formatting uses the user's personal tz when set, otherwise tenant tz.
  const tz = userTz || { iana: tzIana };

  let dateRange;
  if (start_date && end_date) {
    dateRange = { startDate: start_date, endDate: end_date };
  } else {
    dateRange = getDateRange(date_filter, { iana: tzIana });
  }

  // Tenant-timezone-aware half-open [start, end) bounds for the timestamptz
  // order_date column, so the day boundary matches the web frontend.
  const startBound = zonedMidnightToUTCISO(dateRange.startDate, tzIana);
  const endObj = new Date(dateRange.endDate + 'T00:00:00');
  endObj.setDate(endObj.getDate() + 1);
  const endBound = zonedMidnightToUTCISO(formatDate(endObj), tzIana);

  // affects_counts=true subset — matches web frontend getAllSummaryData
  const exclusionPatterns = await fetchExclusionPatterns({ affectsCountsOnly: true });

  // Build WHERE conditions for orders.
  // status != 2 (Weather Permitting) is kept here because this endpoint
  // powers active-tracking views that exclude weather-held orders by design.
  let whereConditions = [
    'o.order_date >= $1::timestamptz',
    'o.order_date < $2::timestamptz',
    'COALESCE(o.current_status, 0) != 2'
  ];
  let queryParams = [startBound, endBound];
  let paramIndex = 3;

  // Add exclusion pattern filters — matches web frontend filterExcludedOrders.
  // Customer patterns use plain substring match (no "CONCRETE" gate).
  if (exclusionPatterns && exclusionPatterns.length > 0) {
    for (const pattern of exclusionPatterns) {
      const normalizedPattern = pattern.pattern?.trim()?.toLowerCase();
      if (!normalizedPattern) continue;

      switch (pattern.type) {
        case 'product':
          whereConditions.push(`NOT EXISTS (
            SELECT 1 FROM order_products op_excl
            WHERE op_excl.order_id = o.order_id
              AND op_excl.item_code ILIKE $${paramIndex}
          )`);
          queryParams.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;

        case 'customer':
          whereConditions.push(`o.customer_name NOT ILIKE $${paramIndex}`);
          queryParams.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;

        case 'delivery_address':
          whereConditions.push(`COALESCE(o.delivery_addr1, '') NOT ILIKE $${paramIndex}`);
          queryParams.push(`%${normalizedPattern}%`);
          paramIndex++;
          break;
      }
    }
  }

  // Company name filter (via pricing_plant_code → plants → companies)
  if (company_name && company_name.trim()) {
    whereConditions.push(`EXISTS (
      SELECT 1 FROM plants p_cf
      INNER JOIN companies c_cf ON c_cf.code = p_cf.company_code
      WHERE p_cf.code = o.pricing_plant_code
        AND c_cf.name ILIKE $${paramIndex}
    )`);
    queryParams.push(`%${company_name.trim().toLowerCase()}%`);
    paramIndex++;
  }

  // Region name filter (via pricing_plant_code → plants → regions)
  if (region_name && region_name.trim()) {
    whereConditions.push(`EXISTS (
      SELECT 1 FROM plants p_rf
      INNER JOIN regions r_rf ON r_rf.id = p_rf.region_id
      WHERE p_rf.code = o.pricing_plant_code
        AND r_rf.description ILIKE $${paramIndex}
    )`);
    queryParams.push(`%${region_name.trim().toLowerCase()}%`);
    paramIndex++;
  }

  // Plant code filter (exact match via order_product_schedules)
  if (plant_code && plant_code.trim()) {
    whereConditions.push(`EXISTS (
      SELECT 1 FROM order_products op_pcf
      INNER JOIN order_product_schedules ops_pcf ON ops_pcf.order_product_id = op_pcf.id
      WHERE op_pcf.order_id = o.order_id
        AND (op_pcf.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op_pcf.is_mix = true)
        AND ops_pcf.plant_code::text = $${paramIndex}
    )`);
    queryParams.push(plant_code.trim());
    paramIndex++;
  }

  // Plant name filter (partial match via order_product_schedules → plants)
  if (plant_name && plant_name.trim()) {
    whereConditions.push(`EXISTS (
      SELECT 1 FROM order_products op_pnf
      INNER JOIN order_product_schedules ops_pnf ON ops_pnf.order_product_id = op_pnf.id
      INNER JOIN plants p_pnf ON p_pnf.code = ops_pnf.plant_code
      WHERE op_pnf.order_id = o.order_id
        AND (op_pnf.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op_pnf.is_mix = true)
        AND p_pnf.description ILIKE $${paramIndex}
    )`);
    queryParams.push(`%${plant_name.trim().toLowerCase()}%`);
    paramIndex++;
  }

  // Access Control Filtering (zones already resolved to plants in auth.js)
  if (userAccess && !userAccess.isAdmin) {
    const accessOrConditions = [];

    if (userAccess.allowedPlants && userAccess.allowedPlants.length > 0) {
      const placeholders = userAccess.allowedPlants.map((_, i) => `$${paramIndex + i}::text`).join(', ');
      accessOrConditions.push(`EXISTS (SELECT 1 FROM order_products op_access INNER JOIN order_product_schedules ops_access ON ops_access.order_product_id = op_access.id WHERE op_access.order_id = o.order_id AND (op_access.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op_access.is_mix = true) AND ops_access.plant_code::text IN (${placeholders}))`);
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

  // Single query: In Progress orders + all their tickets + truck/plant/order locations
  const sql = `
    WITH order_totals AS (
      -- Eligibility matches web frontend cyOrders filter (any CY-unit product).
      -- Quantity sums still use is_mix=true to match web computeCY() per-order
      -- CY math.
      SELECT
        op.order_id,
        SUM(COALESCE(op.order_qty, 0)) FILTER (WHERE op.is_mix = true) as ordered_qty,
        SUM(COALESCE(op.delv_qty, 0)) FILTER (WHERE op.is_mix = true) as delivered_qty,
        STRING_AGG(DISTINCT op.item_code, ', ') as product_codes,
        STRING_AGG(DISTINCT op.description, ', ') FILTER (WHERE op.description IS NOT NULL AND op.description != '') as product_description
      FROM order_products op
      INNER JOIN orders o_ot ON o_ot.order_id = op.order_id
      WHERE op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3')
        AND o_ot.order_date >= $1::timestamptz AND o_ot.order_date < $2::timestamptz
      GROUP BY op.order_id
    ),
    order_schedules AS (
      SELECT
        op.order_id,
        timezone('UTC', MIN(ops.start_time)) as start_time,
        timezone('UTC', MAX(
          CASE
            WHEN sub.completed_loads > 0 AND sub.last_fin_pour_time IS NOT NULL THEN
              sub.last_fin_pour_time + ((ops.number_of_loads - sub.completed_loads) * COALESCE(ops.truck_space, 0)) * INTERVAL '1 minute'
            ELSE
              ops.start_time + (COALESCE(ops.number_of_loads, 1) * COALESCE(ops.truck_space, 0)) * INTERVAL '1 minute'
          END
        )) as estimated_finish_time
      FROM order_products op
      INNER JOIN order_product_schedules ops ON ops.order_product_id = op.id
      INNER JOIN orders o_os ON o_os.order_id = op.order_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(COALESCE(t.end_unload, t.wash_time)) as completed_loads,
          MAX(COALESCE(t.end_unload, t.wash_time)) as last_fin_pour_time
        FROM order_product_schedule_loads opsl
        LEFT JOIN tickets t
          ON t.ticket_code = opsl.ticket_code
          AND t.order_id = op.order_id
          AND (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
        WHERE opsl.order_product_schedule_id = ops.id
          AND COALESCE(t.end_unload, t.wash_time) IS NOT NULL
      ) sub ON true
      WHERE (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
        AND o_os.order_date >= $1::timestamptz AND o_os.order_date < $2::timestamptz
      GROUP BY op.order_id
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
      INNER JOIN orders o_ltc ON o_ltc.order_id = t.order_id
      WHERE (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
        AND o_ltc.order_date >= $1::timestamptz AND o_ltc.order_date < $2::timestamptz
      ORDER BY t.order_id, t.created_date DESC NULLS LAST
    ),
    in_progress_orders AS (
      SELECT
        o.order_id,
        o.order_code,
        o.order_date,
        o.customer_name,
        o.project_name,
        TRIM(BOTH ', ' FROM
          COALESCE(NULLIF(o.delivery_addr1, ''), '') ||
          CASE WHEN o.delivery_addr2 IS NOT NULL AND o.delivery_addr2 != '' THEN ', ' || o.delivery_addr2 ELSE '' END ||
          CASE WHEN o.delivery_addr3 IS NOT NULL AND o.delivery_addr3 != '' THEN ', ' || o.delivery_addr3 ELSE '' END
        ) as delivery_address,
        ot.ordered_qty,
        ot.delivered_qty,
        ot.product_codes,
        ot.product_description,
        os.start_time,
        os.estimated_finish_time,
        o.latitude as order_latitude,
        o.longitude as order_longitude,
        o.delivery_addr1,
        o.delivery_addr2,
        o.delivery_addr3,
        COALESCE(o.current_status, 1) as current_status,
        o.removed,
        o.remove_reason_code,
        CASE WHEN EXISTS (SELECT 1 FROM order_notes WHERE order_id = o.order_id) THEN true ELSE false END as has_notes,
        o.weather_data
      FROM orders o
      INNER JOIN order_totals ot ON ot.order_id = o.order_id
      LEFT JOIN order_schedules os ON os.order_id = o.order_id
      LEFT JOIN last_ticket_completion ltc ON ltc.order_id = o.order_id
      WHERE ${whereConditions.join(' AND ')}
        AND NOT (o.removed = true AND o.remove_reason_code IS NOT NULL AND LENGTH(o.remove_reason_code) > 0)
        AND COALESCE(o.current_status, 1) != 4
        AND ot.delivered_qty > 0
        AND ot.delivered_qty < ot.ordered_qty
        AND NOT (COALESCE(ltc.is_last_load_completed, false) = true AND (ot.ordered_qty - ot.delivered_qty) <= 0.02)
    )
    SELECT
      ipo.order_id,
      ipo.order_code,
      ipo.order_date,
      ipo.customer_name,
      ipo.project_name,
      ipo.delivery_address,
      ipo.ordered_qty,
      ipo.delivered_qty,
      ipo.product_codes,
      ipo.product_description,
      ipo.start_time as order_start_time,
      ipo.estimated_finish_time,
      ipo.order_latitude,
      ipo.order_longitude,
      ipo.delivery_addr1,
      ipo.delivery_addr2,
      ipo.delivery_addr3,
      ipo.current_status,
      ipo.removed,
      ipo.remove_reason_code,
      ipo.has_notes,
      ipo.weather_data,

      -- Ticket data
      t.ticket_id,
      t.ticket_code,
      t.created_date as ticket_created_date,
      t.plant_code as ticket_plant_code,
      t.plant_name as ticket_plant_name,
      t.driver_name,
      timezone('UTC', t.scheduled_on_job_time) as scheduled_on_job_time,
      t.remove_reason_code as ticket_remove_reason_code,

      -- Ticket timestamps (formatted as CST)
      timezone('UTC', t.printed_time) as printed_time,
      timezone('UTC', t.load_time) as load_time,
      timezone('UTC', t.loaded_time) as loaded_time,
      timezone('UTC', t.to_job_time) as to_job_time,
      timezone('UTC', t.on_job_time) as on_job_time,
      timezone('UTC', t.unload_time) as unload_time,
      timezone('UTC', t.wash_time) as wash_time,
      timezone('UTC', t.to_plant_time) as to_plant_time,
      timezone('UTC', t.at_plant_time) as at_plant_time,

      -- Ticket product data (concrete/mix)
      tp.load_qty,
      tp.acc_delv_qty,
      tp.item_code as ticket_item_code,

      -- Truck details
      t.truck_code,
      tr.description as truck_description,
      COALESCE(tr.latitude, o2.latitude) as truck_latitude,
      COALESCE(tr.longitude, o2.longitude) as truck_longitude,

      -- Driver phone
      e.phone as driver_phone,

      -- Plant details
      p.code as plant_code,
      p.description as plant_description,
      p.address1 as plant_address1,
      p.address2 as plant_address2,
      p.phone as plant_phone,
      p.latitude as plant_latitude,
      p.longitude as plant_longitude

    FROM in_progress_orders ipo
    LEFT JOIN tickets t ON t.order_id = ipo.order_id
    LEFT JOIN orders o2 ON o2.order_id = ipo.order_id
    LEFT JOIN LATERAL (
      SELECT tp2.load_qty, tp2.acc_delv_qty, tp2.item_code
      FROM ticket_products tp2
      WHERE tp2.ticket_id = t.ticket_id AND tp2.is_mix = true
      LIMIT 1
    ) tp ON true
    LEFT JOIN trucks tr ON tr.code = t.truck_code
    LEFT JOIN employees e ON e.code = t.driver_code
    LEFT JOIN plants p ON p.code = t.plant_code
    ORDER BY ipo.order_code ASC, tp.acc_delv_qty ASC NULLS LAST, t.ticket_code ASC
  `;

  try {
    const result = await executeDirectSQL(sql, queryParams);
    const rows = result.data || [];

    // Collect unique order IDs for batch query (notes)
    const orderIds = [...new Set(rows.map(r => r.order_id))];

    // Run batch query for notes
    let notesMap = new Map();

    if (orderIds.length > 0) {
      const notesResult = await executeDirectSQL(`
        SELECT n.*
        FROM order_notes n
        WHERE n.order_id = ANY($1::int[])
      `, [orderIds]).catch(() => ({ data: [] }));

      // Build notes lookup map
      for (const n of (notesResult.data || [])) {
        if (!notesMap.has(n.order_id)) notesMap.set(n.order_id, []);
        notesMap.get(n.order_id).push({
          note_id: n.note_id || n.id || null,
          note_text: n.note_text || n.note || n.notes || n.content || n.text || '',
          created_at: n.created_at || n.created || null
        });
      }
    }

    // Group rows by order_id
    const orderMap = new Map();

    for (const row of rows) {
      if (!orderMap.has(row.order_id)) {
        const orderedQty = parseFloat(row.ordered_qty) || 0;
        const deliveredQty = parseFloat(row.delivered_qty) || 0;
        const remainingQty = Math.max(0, orderedQty - deliveredQty);
        const progressPercent = orderedQty > 0 ? Math.round((deliveredQty / orderedQty) * 100) : 0;

        const orderNotes = notesMap.get(row.order_id) || [];

        orderMap.set(row.order_id, {
          order_id: row.order_id,
          order_code: row.order_code,
          order_date: formatDateCST(row.order_date),
          display_date: formatDisplayDateTime(row.order_date),
          customer_name: row.customer_name || '',
          project_name: row.project_name || '',
          delivery_address: row.delivery_address || '',
          delivery_addr1: row.delivery_addr1 || '',
          delivery_addr2: row.delivery_addr2 || '',
          delivery_addr3: row.delivery_addr3 || '',
          ordered_qty: orderedQty,
          delivered_qty: deliveredQty,
          remaining_qty: remainingQty,
          remaining_display: `${remainingQty.toFixed(0)}CY`,
          progress_percent: progressPercent,
          current_status: row.current_status,
          removed: row.removed,
          remove_reason_code: row.remove_reason_code,
          status: 'In Progress',
          can_chat: true, // In Progress orders always have chat enabled
          can_ticketed: true, // In Progress orders always have ticketed enabled
          has_notes: row.has_notes || orderNotes.length > 0,
          product_codes: row.product_codes || '',
          product_description: row.product_description || '',
          start_time: formatTimeCST(row.order_start_time, tz),
          estimated_finish_time: formatTimeCST(row.estimated_finish_time, tz),
          order_location: {
            latitude: row.order_latitude ? parseFloat(row.order_latitude) : null,
            longitude: row.order_longitude ? parseFloat(row.order_longitude) : null
          },
          plant: null,
          notes: orderNotes,
          notes_count: orderNotes.length,
          weather_data: (() => {
            if (!row.weather_data) return null;
            if (typeof row.weather_data === 'object') return row.weather_data;
            if (typeof row.weather_data === 'string') {
              try { return JSON.parse(row.weather_data); } catch (e) { return null; }
            }
            return null;
          })(),
          tickets: [],
          _plantSet: false
        });
      }

      const order = orderMap.get(row.order_id);

      // Set plant from first ticket that has plant data
      if (!order._plantSet && row.plant_code) {
        order.plant = {
          code: row.plant_code,
          description: row.plant_description || null,
          address: [row.plant_address1, row.plant_address2].filter(a => a && a.trim()).join(', ') || null,
          phone: row.plant_phone || null,
          latitude: row.plant_latitude ? parseFloat(row.plant_latitude) : null,
          longitude: row.plant_longitude ? parseFloat(row.plant_longitude) : null
        };
        order._plantSet = true;
      }

      // Add ticket (skip if no ticket_id — order might have 0 tickets)
      if (row.ticket_id) {
        // Derive ticket status from timestamps
        let ticketStatus = 'pending';
        let ticketRemoveReason = null;
        if (row.ticket_remove_reason_code && String(row.ticket_remove_reason_code).trim() !== '') {
          ticketStatus = 'cancelled';
          ticketRemoveReason = String(row.ticket_remove_reason_code).trim();
        } else if (row.at_plant_time) { ticketStatus = 'at_plant'; }
        else if (row.to_plant_time) { ticketStatus = 'to_plant'; }
        else if (row.wash_time) { ticketStatus = 'washing'; }
        else if (row.unload_time) { ticketStatus = 'pouring'; }
        else if (row.on_job_time) { ticketStatus = 'at_job'; }
        else if (row.to_job_time) { ticketStatus = 'to_job'; }
        else if (row.loaded_time) { ticketStatus = 'loaded'; }
        else if (row.load_time) { ticketStatus = 'loading'; }
        else if (row.printed_time) { ticketStatus = 'ticketed'; }

        const statusDisplay = ticketStatus === 'cancelled' && ticketRemoveReason
          ? `Cancelled-${ticketRemoveReason}`
          : STATUS_DISPLAY[ticketStatus] || 'Pending';

        const loadQty = parseFloat(row.load_qty) || 0;
        const runningQty = parseFloat(row.acc_delv_qty) || 0;
        const orderedQty = parseFloat(row.ordered_qty) || 0;

        // Build tracking_status array (chronological order: Ticketed first -> At Plant last)
        // is_current = true for the current active status (matches web logic)
        const trackingStatus = [
          { status: 'ticketed', status_display: 'Ticketed', completed: !!row.printed_time, is_current: ticketStatus === 'ticketed', time: row.printed_time || null },
          { status: 'loading', status_display: 'Loading', completed: !!row.load_time, is_current: ticketStatus === 'loading', time: row.load_time || null },
          { status: 'loaded', status_display: 'Loaded', completed: !!row.loaded_time, is_current: ticketStatus === 'loaded', time: row.loaded_time || null },
          { status: 'to_job', status_display: 'To Job', completed: !!row.to_job_time, is_current: ticketStatus === 'to_job', time: row.to_job_time || null },
          { status: 'at_job', status_display: 'At Job', completed: !!row.on_job_time, is_current: ticketStatus === 'at_job', time: row.on_job_time || null },
          { status: 'pouring', status_display: 'Pouring', completed: !!row.unload_time, is_current: ticketStatus === 'pouring', time: row.unload_time || null },
          { status: 'washing', status_display: 'Washing', completed: !!row.wash_time, is_current: ticketStatus === 'washing', time: row.wash_time || null },
          { status: 'to_plant', status_display: 'To Plant', completed: !!row.to_plant_time, is_current: ticketStatus === 'to_plant', time: row.to_plant_time || null },
          { status: 'at_plant', status_display: 'At Plant', completed: !!row.at_plant_time, is_current: ticketStatus === 'at_plant', time: row.at_plant_time || null }
        ];

        order.tickets.push({
          ticket_code: row.ticket_code,
          status: ticketStatus,
          status_display: statusDisplay,
          tracking_status: trackingStatus,
          truck: {
            code: row.truck_code || null,
            description: row.truck_description || null,
            driver_name: row.driver_name || null,
            driver_phone: row.driver_phone || null,
            latitude: row.truck_latitude ? parseFloat(row.truck_latitude) : null,
            longitude: row.truck_longitude ? parseFloat(row.truck_longitude) : null
          },
          product: row.ticket_item_code || null,
          load_qty: loadQty,
          running_qty: runningQty,
          ordered_qty: orderedQty,
          remaining_after_load: parseFloat(Math.max(0, orderedQty - runningQty).toFixed(2)),
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
          }
        });
      }
    }

    // Build final orders array with load numbers and summaries
    const orders = [];
    for (const order of orderMap.values()) {
      // Remove internal flag
      delete order._plantSet;

      // Assign load numbers (tickets already sorted by acc_delv_qty/ticket_code from SQL)
      order.tickets.forEach((ticket, idx) => {
        ticket.load = idx + 1;
      });

      // Reverse tickets to show in descending order (latest load first, like web view)
      order.tickets.reverse();

      // Calculate summary from tickets
      const nonCancelledTickets = order.tickets.filter(t => t.status !== 'cancelled');
      const cancelledTickets = order.tickets.filter(t => t.status === 'cancelled');

      // Delivered = sum of load_qty from tickets that have reached on_job (at_job) or beyond
      // Statuses at_job or beyond: at_job, pouring, washing, to_plant, at_plant
      const ON_JOB_STATUSES = ['at_job', 'pouring', 'washing', 'to_plant', 'at_plant'];
      const onJobDeliveredQty = parseFloat(
        nonCancelledTickets
          .filter(t => ON_JOB_STATUSES.includes(t.status))
          .reduce((sum, t) => sum + (t.load_qty || 0), 0)
          .toFixed(2)
      );
      const onJobRemainingQty = Math.max(0, parseFloat((order.ordered_qty - onJobDeliveredQty).toFixed(2)));
      const onJobProgressPercent = order.ordered_qty > 0 ? Math.round((onJobDeliveredQty / order.ordered_qty) * 100) : 0;

      // Build per-status qty and count maps from tickets for delivery progress bar
      const activeQtyByStatus = {};
      const activeCountByStatus = {};
      for (const t of nonCancelledTickets) {
        if (t.status && t.status !== 'pending') {
          activeQtyByStatus[t.status] = (activeQtyByStatus[t.status] || 0) + (t.load_qty || 0);
          activeCountByStatus[t.status] = (activeCountByStatus[t.status] || 0) + 1;
        }
      }

      // Update order-level fields to reflect on-job delivered qty
      order.delivered_qty = onJobDeliveredQty;
      order.remaining_qty = onJobRemainingQty;
      order.remaining_display = `${onJobRemainingQty.toFixed(0)}CY`;
      order.progress_percent = onJobProgressPercent;

      order.delivery_progress = buildDeliveryProgress(order.ordered_qty, activeQtyByStatus, await fetchProgressBarColors(), activeCountByStatus);

      order.summary = {
        total_tickets: order.tickets.length,
        active_tickets: nonCancelledTickets.length,
        cancelled_tickets: cancelledTickets.length,
        total_delivered_qty: onJobDeliveredQty,
        ordered_qty: order.ordered_qty,
        remaining_qty: onJobRemainingQty,
        progress_percent: onJobProgressPercent,
        progress_display: `${onJobDeliveredQty.toFixed(2)} OF ${order.ordered_qty.toFixed(2)} CY`
      };

      orders.push(order);
    }

    return {
      date: dateRange.startDate,
      date_range: dateRange,
      total_orders: orders.length,
      orders
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Convert epoch (seconds) to a Date object
 * @param {number|string} epoch - Unix epoch in seconds
 * @returns {Date|null} Date or null
 */
function epochToDate(epoch) {
  const val = parseFloat(epoch);
  if (!val || isNaN(val)) return null;
  return new Date(val * 1000);
}

/**
 * Format a graph Date for display in CST.
 *
 * The DB stores timestamps as "timestamp without time zone" in CST.
 * extract(epoch from col) treats those values as UTC, so the Date object's
 * UTC hours/minutes already represent the correct CST hours/minutes.
 * We read them directly with getUTCHours/getUTCMinutes to avoid any
 * additional timezone shift.
 *
 * @param {Date} date - Date built from epochToDate()
 * @returns {string|null} Formatted time like "01:00PM"
 */
function formatGraphTime(date, tz) {
  if (!date || isNaN(date.getTime())) return null;
  const userTz = tz?.iana || 'America/Chicago';

  // The DB stores "timestamp without time zone" in CST. extract(epoch) treats
  // those as UTC, so date's UTC values are really CST values. To convert to the
  // user's timezone: first find the real UTC by subtracting the CST/CDT offset,
  // then format in the user's timezone.
  const storedTz = 'America/Chicago';
  const storedOffsetMs = getGraphTzOffsetMs(storedTz, date);
  const realUtc = new Date(date.getTime() - storedOffsetMs);

  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: userTz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(realUtc);
  return formatted.replace(' ', '');
}

/**
 * Get UTC offset in ms for a timezone on a given date (for formatGraphTime).
 */
function getGraphTzOffsetMs(timeZone, date) {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone });
  return new Date(tzStr) - new Date(utcStr);
}

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * Calculate delay details rows for an order per delay-details.md spec.
 *
 * Planned On Job:
 *   Load 1 (i=0):  ticket.scheduled_on_job_time ?? schedule.start_time
 *   Load 2+ (i>=1): Load1_planned + (i * exact_spacing_ms)
 *
 * @param {Array} ticketRows - Raw ticket rows with *_epoch, scheduled_on_job_time_epoch, remove_reason_code
 * @param {Object|null} primarySchedule - First mix schedule with start_time_epoch_for_delay, delivery_rate_per_hour, load_qty, truck_space, number_of_loads
 * @param {number|null} orderDateEpoch - unused (kept for future order_date override)
 * @returns {Array} delay details array
 */
function calculateDelayDetails(ticketRows, primarySchedule, orderDateEpoch) {
  if (!ticketRows || ticketRows.length === 0) return [];

  // §3.1 Primary schedule: use first schedule (already first mix product's first by start_time)
  if (!primarySchedule) return [];

  // Schedule start from extract(epoch) — matches graph approach for correct timezone handling
  const scheduleStartEpoch = primarySchedule.start_time_epoch_for_delay != null
    ? parseFloat(primarySchedule.start_time_epoch_for_delay) : null;
  const scheduleStartMs = scheduleStartEpoch != null && !isNaN(scheduleStartEpoch)
    ? scheduleStartEpoch * 1000 : null;
  if (scheduleStartMs == null) return [];

  const deliveryRatePerHour = parseFloat(primarySchedule.delivery_rate_per_hour) || 0;
  const loadQty = parseFloat(primarySchedule.load_qty) || 0;
  const truckSpace = primarySchedule.truck_space != null ? parseInt(primarySchedule.truck_space, 10) : null;
  const numberOfLoads = primarySchedule.number_of_loads != null ? parseInt(primarySchedule.number_of_loads, 10) : null;

  // §3.3 Spacing
  let exactSpacingMs;
  let displaySpacing;
  if (deliveryRatePerHour > 0) {
    exactSpacingMs = (loadQty / deliveryRatePerHour) * MS_PER_HOUR;
    displaySpacing = Math.floor((loadQty / deliveryRatePerHour) * 60);
  } else {
    const spaceMin = truckSpace ?? 0;
    exactSpacingMs = spaceMin * MS_PER_MINUTE;
    displaySpacing = spaceMin;
  }

  // §3.2 Filter and sort tickets
  const validTickets = ticketRows.filter(t => {
    const code = t.remove_reason_code;
    return code == null || String(code).trim() === '';
  });
  validTickets.sort((a, b) => {
    const aPrinted = a.printed_time_epoch != null ? parseFloat(a.printed_time_epoch) : Infinity;
    const bPrinted = b.printed_time_epoch != null ? parseFloat(b.printed_time_epoch) : Infinity;
    if (aPrinted !== bPrinted) return aPrinted - bPrinted;
    return (parseInt(a.ticket_id, 10) || 0) - (parseInt(b.ticket_id, 10) || 0);
  });

  const delayDetails = [];
  let prevEndPourMs = null;
  let load1BaseMs = null;

  for (let i = 0; i < validTickets.length; i++) {
    const t = validTickets[i];
    const loadOrder = i + 1;

    const ticketId = t.ticket_id;
    const ticketCode = String(t.ticket_code || '').trim();
    const truckCode = t.truck_code != null ? String(t.truck_code).trim() : '';

    const onJobEpoch = t.on_job_time_epoch != null ? parseFloat(t.on_job_time_epoch) : null;
    const unloadEpoch = t.unload_time_epoch != null ? parseFloat(t.unload_time_epoch) : null;
    const endUnloadEpoch = t.end_unload_epoch != null ? parseFloat(t.end_unload_epoch) : null;
    const washEpoch = t.wash_time_epoch != null ? parseFloat(t.wash_time_epoch) : null;
    const toPlantEpoch = t.to_plant_time_epoch != null ? parseFloat(t.to_plant_time_epoch) : null;

    const actualOnJobMs = onJobEpoch != null && !isNaN(onJobEpoch) ? onJobEpoch * 1000 : null;
    const actualOnJob = actualOnJobMs != null ? new Date(actualOnJobMs).toISOString() : null;

    // §3.5.1 Planned On Job
    // Load 1 (i=0): Use first ticket's scheduled_on_job_time from DB, fallback to schedule.start_time
    // Load 2+ (i>=1): Load 1 planned time (base) + (i * exact_spacing_ms)
    let plannedOnJobMs = null;
    let plannedOnJob = null;
    if (i === 0) {
      // First load: use the dispatcher-scheduled on-job time from the ticket
      const scheduledOnJobEpoch = t.scheduled_on_job_time_epoch != null ? parseFloat(t.scheduled_on_job_time_epoch) : null;
      const scheduledOnJobMs = scheduledOnJobEpoch != null && !isNaN(scheduledOnJobEpoch) ? scheduledOnJobEpoch * 1000 : null;
      plannedOnJobMs = scheduledOnJobMs ?? scheduleStartMs;
      // Store Load 1's planned time as the base for all subsequent loads
      load1BaseMs = plannedOnJobMs;
    } else {
      // Subsequent loads: Load 1 base + (i * spacing)
      plannedOnJobMs = load1BaseMs != null ? load1BaseMs + i * exactSpacingMs : null;
    }
    if (plannedOnJobMs != null) {
      plannedOnJob = new Date(plannedOnJobMs).toISOString();
    }

    // §3.5.3 Effective base
    let effectiveBaseMs = null;
    if (plannedOnJobMs != null && actualOnJobMs != null) {
      effectiveBaseMs = Math.max(plannedOnJobMs, actualOnJobMs);
    } else if (actualOnJobMs != null) {
      effectiveBaseMs = actualOnJobMs;
    } else if (plannedOnJobMs != null) {
      effectiveBaseMs = plannedOnJobMs;
    }

    // §3.5.4 Begin Pour
    const beginPourMs = (unloadEpoch != null && !isNaN(unloadEpoch))
      ? unloadEpoch * 1000
      : (onJobEpoch != null && !isNaN(onJobEpoch) ? onJobEpoch * 1000 : null);
    const beginPour = beginPourMs != null ? new Date(beginPourMs).toISOString() : null;

    // §3.5.5 End Pour: wash_time || end_unload || to_plant_time
    let endPourMs = null;
    if (washEpoch != null && !isNaN(washEpoch)) endPourMs = washEpoch * 1000;
    else if (endUnloadEpoch != null && !isNaN(endUnloadEpoch)) endPourMs = endUnloadEpoch * 1000;
    else if (toPlantEpoch != null && !isNaN(toPlantEpoch)) endPourMs = toPlantEpoch * 1000;
    const endPour = endPourMs != null ? new Date(endPourMs).toISOString() : null;

    // §3.5.6 Producer Delay
    const adjustedPlannedMs = (prevEndPourMs != null && plannedOnJobMs != null)
      ? Math.max(plannedOnJobMs, prevEndPourMs)
      : plannedOnJobMs;
    let producerDelay = 0;
    if (actualOnJobMs != null && adjustedPlannedMs != null) {
      producerDelay = Math.max(0, Math.round((actualOnJobMs - adjustedPlannedMs) / MS_PER_MINUTE));
    }
    if (endPourMs != null) prevEndPourMs = endPourMs;

    // §3.5.7 Scheduled End Pour
    let scheduledEndPour = null;
    if (plannedOnJobMs != null && displaySpacing != null && displaySpacing > 0) {
      scheduledEndPour = new Date(plannedOnJobMs + displaySpacing * MS_PER_MINUTE).toISOString();
    }

    // §3.5.9 Waiting To Pour
    let waitingToPour = 0;
    if (beginPourMs != null && effectiveBaseMs != null) {
      waitingToPour = Math.max(0, Math.round((beginPourMs - effectiveBaseMs) / MS_PER_MINUTE));
    }

    // §3.5.10 Pour Min Over
    let pourMinOver = 0;
    if (endPourMs != null && beginPourMs != null && displaySpacing != null) {
      const pourDurationMin = Math.round((endPourMs - beginPourMs) / MS_PER_MINUTE);
      pourMinOver = pourDurationMin - displaySpacing;
    }

    // §3.5.11 Contractor Delay
    const contractorDelay = waitingToPour + pourMinOver;

    // §3.5.12 Plus Load
    const plusLoad = numberOfLoads != null && loadOrder > numberOfLoads;

    // Load quantity from ticket_products (actual qty delivered)
    const ticketLoadQty = parseFloat(t.load_qty) || 0;

    // Pour Duration = End Pour - Begin Pour (minutes)
    let pourDuration = null;
    if (endPourMs != null && beginPourMs != null) {
      pourDuration = Math.round((endPourMs - beginPourMs) / MS_PER_MINUTE);
    }

    // Waiting Minutes = Begin Pour - Arrive Job (on_job_time)
    let waitingMinutes = null;
    if (beginPourMs != null && actualOnJobMs != null) {
      waitingMinutes = Math.round((beginPourMs - actualOnJobMs) / MS_PER_MINUTE);
    }

    // Pour Out Minutes = End Pour - Begin Pour (how fast truck is unloaded)
    let pourOutMinutes = null;
    if (endPourMs != null && beginPourMs != null) {
      pourOutMinutes = Math.round((endPourMs - beginPourMs) / MS_PER_MINUTE);
    }

    // Pour Performance = Waiting Minutes + Pour Out Minutes
    let pourPerformanceMinutes = null;
    if (waitingMinutes != null && pourOutMinutes != null) {
      pourPerformanceMinutes = waitingMinutes + pourOutMinutes;
    }

    delayDetails.push({
      load_order: loadOrder,
      ticket: ticketCode,
      truck: truckCode,
      load_qty: ticketLoadQty,
      load_qty_display: `${ticketLoadQty.toFixed(2)} CY`,
      planned_on_job: plannedOnJob,
      actual_on_job: actualOnJob,
      producer_delay: producerDelay,
      begin_pour: beginPour,
      end_pour: endPour,
      pour_duration: pourDuration,
      waiting_minutes: waitingMinutes,
      pour_out_minutes: pourOutMinutes,
      pour_performance_minutes: pourPerformanceMinutes,
      scheduled_end_pour: scheduledEndPour,
      spacing: displaySpacing != null ? displaySpacing : null,
      waiting_to_pour: waitingToPour,
      pour_min_over: pourMinOver,
      contractor_delay: contractorDelay,
      plus_load: plusLoad
    });
  }

  return delayDetails;
}

/**
 * Build Pour Speed graph data (Line Chart)
 *
 * Three lines:
 * - Ordered (scheduled): constant flat line at delivery_rate_per_hour, points at truck_space intervals
 * - Delivered (actual): cumulative CY/HR based on on_job_time timestamps
 * - Poured (actual): cumulative CY/HR based on wash_time || to_plant_time, elapsed from first delivery
 *
 * @param {Array} schedules - Schedule rows with delivery_rate_per_hour, truck_space, start_time_epoch, number_of_loads, schedule_qty
 * @param {Array} tickets - Ticket rows with on_job_time_epoch, wash_time_epoch, to_plant_time_epoch, load_qty
 * @returns {Object|null} Pour speed graph data
 */
function buildPourSpeedData(schedules, tickets, tz) {
  if (!schedules || schedules.length === 0) {
    return null;
  }

  const scheduleRate = parseFloat(schedules[0].delivery_rate_per_hour) || 0;
  if (scheduleRate === 0) return null;

  // --- Ordered line: constant rate at each truck_space interval ---
  // Web rule: if truck_space <= 0, show empty ordered line
  const orderedPoints = [];
  for (const schedule of schedules) {
    const rate = parseFloat(schedule.delivery_rate_per_hour) || scheduleRate;
    const truckSpaceMinutes = parseFloat(schedule.truck_space) || 0;
    const numberOfLoads = parseInt(schedule.number_of_loads) || 0;
    const startTime = epochToDate(schedule.start_time_epoch);

    if (!startTime || numberOfLoads === 0 || truckSpaceMinutes <= 0) continue;

    for (let i = 0; i < numberOfLoads; i++) {
      const pointTime = new Date(startTime.getTime() + (i * truckSpaceMinutes * 60 * 1000));
      orderedPoints.push({
        time: pointTime.toISOString(),
        time_display: formatGraphTime(pointTime, tz),
        rate: rate
      });
    }
  }

  const maxRateCap = scheduleRate * 1.5;

  // --- Delivered line: cumulative rate based on on_job_time ---
  const deliveredTickets = tickets
    .filter(t => t.on_job_time_epoch)
    .sort((a, b) => parseFloat(a.on_job_time_epoch) - parseFloat(b.on_job_time_epoch));

  const deliveredPoints = [];
  let cumulativeQty = 0;
  const firstDeliveryTime = deliveredTickets.length > 0
    ? epochToDate(deliveredTickets[0].on_job_time_epoch)
    : null;

  for (let i = 0; i < deliveredTickets.length; i++) {
    const ticket = deliveredTickets[i];
    const loadQty = parseFloat(ticket.load_qty) || 0;
    cumulativeQty += loadQty;
    const currentTime = epochToDate(ticket.on_job_time_epoch);
    if (!currentTime) continue;

    let rate;
    if (i === 0) {
      // First truck: use scheduled rate (can't calculate rate with zero elapsed time)
      rate = scheduleRate;
    } else {
      const elapsedHours = (currentTime - firstDeliveryTime) / (1000 * 60 * 60);
      const actualRate = elapsedHours > 0 ? cumulativeQty / elapsedHours : scheduleRate;
      rate = Math.min(actualRate, maxRateCap);
    }

    // Calculate actual spacing from previous truck (minutes)
    let actualSpacingMin = null;
    if (i > 0) {
      const prevTime = epochToDate(deliveredTickets[i - 1].on_job_time_epoch);
      if (prevTime) {
        actualSpacingMin = Math.round((currentTime - prevTime) / (1000 * 60) * 10) / 10;
      }
    }

    deliveredPoints.push({
      time: currentTime.toISOString(),
      time_display: formatGraphTime(currentTime, tz),
      rate: Math.round(rate * 100) / 100,
      cumulative_qty: Math.round(cumulativeQty * 100) / 100,
      load_qty: Math.round(loadQty * 100) / 100,
      actual_spacing_min: actualSpacingMin
    });
  }

  // --- Poured line: cumulative rate based on wash_time (priority) || to_plant_time (fallback), elapsed from first delivery ---
  // Frontend rule: if no valid delivery tickets exist → no Poured line
  const pouredPoints = [];
  let pouredCumulativeQty = 0;

  if (firstDeliveryTime) {
    const pouredTickets = tickets
      .filter(t => t.wash_time_epoch || t.to_plant_time_epoch)
      .map(t => ({
        ...t,
        pour_time_epoch: t.wash_time_epoch || t.to_plant_time_epoch
      }))
      .sort((a, b) => parseFloat(a.pour_time_epoch) - parseFloat(b.pour_time_epoch));

    for (let i = 0; i < pouredTickets.length; i++) {
      const ticket = pouredTickets[i];
      const loadQty = parseFloat(ticket.load_qty) || 0;
      pouredCumulativeQty += loadQty;
      const currentTime = epochToDate(ticket.pour_time_epoch);
      if (!currentTime) continue;

      // Elapsed time from first DELIVERY (on_job_time) to this pour-complete time
      const elapsedHours = (currentTime - firstDeliveryTime) / (1000 * 60 * 60);
      const actualRate = elapsedHours > 0 ? pouredCumulativeQty / elapsedHours : scheduleRate;
      const rate = Math.min(actualRate, maxRateCap);

      pouredPoints.push({
        time: currentTime.toISOString(),
        time_display: formatGraphTime(currentTime, tz),
        rate: Math.round(rate * 100) / 100,
        cumulative_qty: Math.round(pouredCumulativeQty * 100) / 100
      });
    }
  }

  // --- Y-Axis domain (matches frontend roundToNiceValue) ---
  function roundToNiceValue(value) {
    if (value <= 25) return 25;
    if (value <= 50) return 50;
    if (value <= 75) return 75;
    if (value <= 100) return 100;
    if (value <= 150) return 150;
    if (value <= 200) return 200;
    return Math.ceil(value / 50) * 50;
  }

  const allRates = [
    ...orderedPoints.map(p => p.rate),
    ...deliveredPoints.map(p => p.rate),
    ...pouredPoints.map(p => p.rate)
  ];

  let yMax;
  if (allRates.length === 0 && scheduleRate === 0) {
    yMax = 50;
  } else if (allRates.length === 0) {
    yMax = Math.ceil(scheduleRate * 1.2);
  } else {
    const maxDataValue = Math.max(...allRates);
    yMax = roundToNiceValue(maxDataValue);

    // Outlier detection: if max > 10× schedule rate, cap at roundToNice(5× rate)
    if (scheduleRate > 0 && maxDataValue > scheduleRate * 10) {
      const cappedValue = Math.max(scheduleRate * 5, scheduleRate);
      yMax = roundToNiceValue(cappedValue);
    }

    // Ensure minimum readability
    if (scheduleRate > 0) {
      yMax = Math.max(yMax, roundToNiceValue(scheduleRate));
    }
  }

  // Schedule metadata for subtitle display
  const truckSpace = parseFloat(schedules[0].truck_space) || 0;
  const scheduleQty = parseFloat(schedules[0].schedule_qty) || 0;
  const unloadDurationMinutes = parseFloat(schedules[0].unload_duration_minutes) || 0;

  return {
    schedule_rate: scheduleRate,
    truck_space: truckSpace,
    schedule_qty: scheduleQty,
    unload_duration_minutes: unloadDurationMinutes,
    y_max: yMax,
    ordered: orderedPoints,
    delivered: deliveredPoints,
    poured: pouredPoints
  };
}

/**
 * Build Ordered / Delivered / Poured (ODP) graph data — hourly grouped bar chart
 *
 * Matches the web frontend performance-charts.tsx HourlyODPChart implementation
 * for full visual parity. Each hourly bucket contains:
 *
 *   ORDERED (blue):
 *     - ordered_solid   — actual scheduled qty for the hour
 *     - ordered_striped — padding on the LAST bucket when it's a partial hour
 *                         (e.g. schedule_rate=32, last bucket has 7.5 ordered,
 *                          striped = 24.5 to visually fill to 32)
 *
 *   DELIVERED (dark gray) — with CARRYOVER tracking:
 *     - delivered_carry_in  — delivered in a PREVIOUS hour but poured this hour
 *                             (renders as diagonal-striped segment from bottom)
 *     - delivered_solid     — delivered AND poured in the same hour (solid)
 *     - delivered_carry_out — delivered this hour but not yet poured
 *                             (renders as diagonal-striped segment at top)
 *
 *   POURED (lime green): simple solid bar, no segmentation.
 *
 *   LOADS MODE (alternative view — truck count instead of CY):
 *     - ordered_loads_solid   — actual scheduled load count
 *     - ordered_loads_striped — padding on last bucket to reach loads/hour rate
 *     - delivered_loads       — actual trucks delivered this hour
 *     - poured_loads          — actual trucks completed this hour
 *
 * Per-bucket trucks[] array lists each contributing truck with its delivered
 * and poured CY for tooltip display.
 *
 * Carryover algorithm (see ODP_CHART_LOGIC.md in frontend for full spec):
 *   let carryOver = 0;
 *   for each bucket in order:
 *     carryIn = carryOver;
 *     pouredFromCarryIn = min(carryIn, poured);
 *     pouredFromCurrent = max(0, min(delivered, poured - pouredFromCarryIn));
 *     solid = pouredFromCurrent;
 *     carryOut = max(0, delivered - solid);
 *     carryOver = max(0, carryIn - poured) + carryOut;
 *
 * Early arrivals are clamped to bucket 0. Cancelled tickets already filtered
 * at the SQL level.
 *
 * Returns null when schedules/rate/start are missing or there's no data at all.
 *
 * @param {Array}  schedules - Product schedule rows (from graphScheduleSql)
 * @param {Array}  tickets   - Non-cancelled tickets (from graphTicketsSql)
 * @param {string} tz        - Timezone (unused; UTC hours match other builders)
 * @returns {Object|null}    ODP graph data or null
 */
function buildODPData(schedules, tickets, tz) {
  if (!schedules || schedules.length === 0) return null;

  // CRITICAL: Use ONLY schedules[0] for ALL schedule metadata — matches web
  // exactly (see performance-charts.tsx getPrimarySchedule lines 76-94, and
  // the HourlyODPChart lines 1511-1535 + 1752-1764). The web picks the FIRST
  // `is_mix=true` product's FIRST schedule as the sole source of truth and
  // does NOT sum across schedule rows. Previously this function summed
  // number_of_loads and schedule_qty across all rows, which caused the mobile
  // chart to show bigger Ordered bars (e.g. 31.5 instead of 21) whenever an
  // order had more than one mix-CY schedule row.
  //
  // buildPourSpeedData at line 4027-4029 already uses schedules[0] for
  // schedule_qty / truck_space — this keeps ODP consistent with that chart.
  const primary = schedules[0];
  const scheduleRate = parseFloat(primary.delivery_rate_per_hour) || 0;
  if (scheduleRate === 0) return null;

  // --- Schedule metadata (for info pills in the mobile header) --------
  const truckSpaceMinutes = parseFloat(primary.truck_space) || 0;
  const totalNumberOfLoads = parseInt(primary.number_of_loads) || 0;
  const totalScheduleQty = parseFloat(primary.schedule_qty) || 0;
  // load_qty comes DIRECTLY from ops.load_qty (database field) — same source
  // the web ODP chart uses (productScheduleItems[0].load_qty). Do NOT compute
  // it as schedule_qty / number_of_loads — that's an approximation that
  // doesn't match the web's displayed value.
  const loadQty = parseFloat(primary.load_qty) || 0;

  // --- Scheduled start from the PRIMARY schedule only -----------------
  // Web uses primary.start_time (not the min across all schedules). Using
  // the primary row keeps bucket 0 aligned with the row we derived the
  // rate/qty/loads from, preventing off-by-one hour bucket drift.
  const scheduledStart = epochToDate(primary.start_time_epoch);
  if (!scheduledStart) return null;

  // CRITICAL: Use the EXACT scheduled start (not floored to top-of-hour).
  // The web uses a SINGLE anchor for both clamping AND bucket-index math
  // (performance-charts.tsx lines 1566-1588):
  //
  //   startMinFromMidnight = scheduledStartHour * 60 + scheduledStartMinute
  //   getBucketForData(min)  = max(0, floor((min - startMinFromMidnight)/60))
  //
  // So for a schedule that starts at 01:50, bucket 0 spans 01:50–02:50,
  // bucket 1 spans 02:50–03:50, etc. Labels read "1:50 / 2:50 / 3:50".
  //
  // Previously this function ALSO maintained a floored `startMinFromMidnight`
  // (01:00) for bucket alignment, which caused a delivery at 02:30 to land
  // in bucket 1 on backend (floor((150-60)/60)=1) but bucket 0 on web
  // (floor((150-110)/60)=0). Any schedule starting at a non-zero minute
  // produced off-by-one mismatches for per-bucket Ordered-Loads,
  // Delivered CY, and Poured CY values.
  const scheduledStartMinFromMidnight =
    scheduledStart.getUTCHours() * 60 + scheduledStart.getUTCMinutes();
  // Single source of truth — NO flooring. Matches web exactly.
  const startMinFromMidnight = scheduledStartMinFromMidnight;

  // --- Helpers --------------------------------------------------------
  const epochToMinFromMidnight = (epoch) => {
    if (epoch === null || epoch === undefined) return null;
    const e = parseFloat(epoch);
    if (!isFinite(e)) return null;
    const d = new Date(e * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  };

  // Bucket index matches web `getBucketForData`
  // (performance-charts.tsx:1585-1588).
  const getBucket = (min) =>
    Math.max(0, Math.floor((min - startMinFromMidnight) / 60));

  const round2 = (v) => Math.round(v * 100) / 100;

  // Hour label format matches the web: no leading zero on the hour.
  // "1:00" not "01:00". Minutes are still zero-padded: "1:00" / "13:30".
  const formatHourLabel = (min) => {
    const h = Math.floor(min / 60) % 24;
    const m = min % 60;
    return `${h}:${m.toString().padStart(2, '0')}`;
  };

  // --- Step 1: Distribute ordered CY across hourly buckets ------------
  // schedule_qty spread at scheduleRate CY/hour. Last bucket may be partial.
  const orderedByHour = new Map();
  {
    let remaining = totalScheduleQty;
    let h = 0;
    while (remaining > 0.001 && h < 48) {
      const chunk = Math.min(scheduleRate, remaining);
      orderedByHour.set(h, chunk);
      remaining -= chunk;
      h += 1;
    }
  }

  // --- Step 1b: Ordered LOADS per hour — bucket by each ticket's
  //                scheduled_on_job_time (matches web line 1653-1657).
  //
  // Previously this block synthesized truck arrivals as
  // `scheduledStart + i * truckSpace`, which was the **schedule's ideal**
  // arrival times. Web instead uses the **actual tickets'** `scheduled_on_job_time`
  // (which the planner may have customized per-truck). The two differ
  // whenever any ticket's planned ETA was edited after creation.
  const orderedLoadsByHour = new Map();
  for (const t of tickets) {
    const lq = parseFloat(t.load_qty) || 0;
    if (lq <= 0) continue;
    const sMin = epochToMinFromMidnight(t.scheduled_on_job_time_epoch);
    if (sMin === null) continue;
    // Web does NOT clamp orderedCount by scheduledStartMinFromMidnight
    // (performance-charts.tsx:1653-1657 — only delivered/poured are clamped).
    const b = getBucket(sMin);
    orderedLoadsByHour.set(b, (orderedLoadsByHour.get(b) || 0) + 1);
  }

  // --- Step 2: Bucket delivered + poured tickets ----------------------
  const makeBucketObj = () => ({ qty: 0, loadCount: 0, truckMap: new Map() });
  const deliveredByHour = new Map();
  const pouredByHour = new Map();

  const ensure = (map, key) => {
    if (!map.has(key)) map.set(key, makeBucketObj());
    return map.get(key);
  };

  const addTruck = (truckMap, code, qty) => {
    if (!code) return;
    truckMap.set(code, (truckMap.get(code) || 0) + qty);
  };

  for (const t of tickets) {
    const lq = parseFloat(t.load_qty) || 0;
    if (lq <= 0) continue;

    // Delivered: from on_job_time (clamp early arrivals to scheduled start)
    const dMin = epochToMinFromMidnight(t.on_job_time_epoch);
    if (dMin !== null) {
      const clamped = Math.max(dMin, scheduledStartMinFromMidnight);
      const bk = ensure(deliveredByHour, getBucket(clamped));
      bk.qty += lq;
      bk.loadCount += 1;
      addTruck(bk.truckMap, t.truck_code, lq);
    }

    // Poured: from wash_time primary, to_plant_time fallback
    const pourEpoch = t.wash_time_epoch || t.to_plant_time_epoch;
    const pMin = epochToMinFromMidnight(pourEpoch);
    if (pMin !== null) {
      const clamped = Math.max(pMin, scheduledStartMinFromMidnight);
      const bk = ensure(pouredByHour, getBucket(clamped));
      bk.qty += lq;
      bk.loadCount += 1;
      addTruck(bk.truckMap, t.truck_code, lq);
    }
  }

  // --- Step 3: Determine bucket range — MATCH WEB exactly.
  //
  // Web includes ONLY (delivered + poured + orderedLoads) in the bucket
  // range (performance-charts.tsx:1689-1692). It does NOT include the
  // synthetic CY orderedByHour distribution — that would extend buckets
  // past the ticket activity range and show trailing empty-delivered /
  // empty-poured bars (even when the web reducer would have filtered them).
  //
  // If NO ticket activity exists yet but a schedule does, web pre-creates
  // buckets [0..durationHours] based on nLoads * truckSpace. We replicate
  // that fallback only in the no-activity case.
  const allHourKeys = new Set([
    ...orderedLoadsByHour.keys(),
    ...deliveredByHour.keys(),
    ...pouredByHour.keys(),
  ]);
  if (allHourKeys.size === 0) {
    // No tickets: pre-create buckets for the expected schedule duration
    // (matches web lines 1695-1716).
    if (totalNumberOfLoads > 0 && truckSpaceMinutes > 0) {
      const durationHours = Math.ceil((totalNumberOfLoads * truckSpaceMinutes) / 60);
      for (let h = 0; h <= durationHours; h++) allHourKeys.add(h);
    }
  }
  if (allHourKeys.size === 0) return null;
  const maxHourIdx = Math.max(...allHourKeys);

  // --- Step 4: Find the last bucket containing ordered data ----------
  // Used for placing striped padding only on the final bucket of the schedule.
  let lastOrderedIdx = -1;
  let lastOrderedLoadsIdx = -1;
  for (let i = maxHourIdx; i >= 0; i--) {
    if ((orderedByHour.get(i) || 0) > 0 && lastOrderedIdx === -1) {
      lastOrderedIdx = i;
    }
    if ((orderedLoadsByHour.get(i) || 0) > 0 && lastOrderedLoadsIdx === -1) {
      lastOrderedLoadsIdx = i;
    }
  }

  // Loads/hour used for padding the last loads bucket (mirrors scheduleRate).
  const loadsPerHour =
    truckSpaceMinutes > 0 ? Math.floor(60 / truckSpaceMinutes) : 0;

  // --- Step 5: Build buckets with carryover logic --------------------
  const buckets = [];
  let carryOver = 0;
  let hasCarryover = false;

  for (let i = 0; i <= maxHourIdx; i++) {
    // Label uses the EXACT scheduled start (e.g. "1:50, 2:50, 3:50") to match
    // web performance-charts.tsx line 1812. Bucket boundaries are offset by
    // the minutes past the hour.
    const minFromMidnight = startMinFromMidnight + i * 60;
    const ordered = orderedByHour.get(i) || 0;
    const orderedLoads = orderedLoadsByHour.get(i) || 0;
    const d = deliveredByHour.get(i) || makeBucketObj();
    const p = pouredByHour.get(i) || makeBucketObj();

    const delivered = d.qty;
    const poured = p.qty;

    // --- Carryover calculation ---
    // MATCHES THE WEB ACTUAL CODE, not the (outdated) ODP_CHART_LOGIC.md doc.
    // See performance-charts.tsx lines 1842-1870:
    //
    //   deliveredSolid  = raw delivered (ALWAYS)
    //   deliveredCarryIn = 0 unless poured > delivered this hour
    //   deliveredCarryOut = 0 ALWAYS (not rendered, not stored visibly)
    //
    // carryOver semantics:
    //   - When delivered > poured: stock is added to the backlog
    //     carryOver = carryIn + (delivered - poured)
    //   - When poured > delivered: some of this hour's pour came from backlog
    //     pouredFromBacklog = poured - delivered
    //     deliveredCarryIn  = min(carryIn, pouredFromBacklog)
    //     carryOver         = max(0, carryIn - pouredFromBacklog)
    //
    // Visual: the delivered bar stack = deliveredCarryIn + deliveredSolid
    //   = (backlog consumption shown as striped) + (raw delivered as solid)
    const carryIn = carryOver;
    const deliveredSolid = delivered; // Always equals raw delivered — matches web
    let deliveredCarryIn = 0;
    const deliveredCarryOut = 0; // Never rendered by web

    if (poured > delivered) {
      // Some of this hour's pour came from previously delivered stock
      const pouredFromBacklog = poured - delivered;
      deliveredCarryIn = Math.min(carryIn, pouredFromBacklog);
      carryOver = Math.max(0, carryIn - pouredFromBacklog);
    } else {
      // delivered >= poured: the unspent delivery accumulates for later hours
      carryOver = carryIn + (delivered - poured);
    }

    if (deliveredCarryIn > 0.001) {
      hasCarryover = true;
    }

    // --- Ordered solid + striped padding ---
    let orderedSolid = ordered;
    let orderedStriped = 0;
    if (i === lastOrderedIdx && ordered > 0 && ordered < scheduleRate) {
      orderedSolid = ordered;
      orderedStriped = scheduleRate - ordered;
    }

    // --- Ordered loads solid + striped padding (Loads mode) ---
    let orderedLoadsSolid = orderedLoads;
    let orderedLoadsStriped = 0;
    if (
      i === lastOrderedLoadsIdx &&
      orderedLoads > 0 &&
      loadsPerHour > 0 &&
      orderedLoads < loadsPerHour
    ) {
      orderedLoadsSolid = orderedLoads;
      orderedLoadsStriped = loadsPerHour - orderedLoads;
    }

    // --- Per-truck rollup for tooltip ---
    const truckRollup = new Map();
    for (const [code, qty] of d.truckMap) {
      if (!truckRollup.has(code)) {
        truckRollup.set(code, { truck_code: code, delivered: 0, poured: 0 });
      }
      truckRollup.get(code).delivered += qty;
    }
    for (const [code, qty] of p.truckMap) {
      if (!truckRollup.has(code)) {
        truckRollup.set(code, { truck_code: code, delivered: 0, poured: 0 });
      }
      truckRollup.get(code).poured += qty;
    }
    const trucks = Array.from(truckRollup.values())
      .map((t) => ({
        truck_code: t.truck_code,
        delivered: round2(t.delivered),
        poured: round2(t.poured),
      }))
      .sort((a, b) => a.truck_code.localeCompare(b.truck_code));

    buckets.push({
      hour_index: i,
      hour_label: formatHourLabel(minFromMidnight),
      // --- CY mode ---
      ordered: round2(ordered),
      ordered_solid: round2(orderedSolid),
      ordered_striped: round2(orderedStriped),
      delivered: round2(delivered),
      // CRITICAL: emit `deliveredCarryIn` (the amount CONSUMED from backlog
      // this hour), NOT the full incoming `carryIn` backlog. Matches the web
      // exactly (performance-charts.tsx:1905). Emitting `carryIn` here caused
      // the mobile delivered bar to be drawn as (backlog + delivered) in
      // every hour where a backlog existed but wasn't drained this hour,
      // inflating labels by the backlog amount (e.g. 21 → 31.5).
      delivered_carry_in: round2(deliveredCarryIn),
      delivered_solid: round2(deliveredSolid),
      delivered_carry_out: round2(deliveredCarryOut),
      poured: round2(poured),
      // --- Loads mode ---
      ordered_loads: orderedLoads,
      ordered_loads_solid: orderedLoadsSolid,
      ordered_loads_striped: orderedLoadsStriped,
      delivered_loads: d.loadCount,
      poured_loads: p.loadCount,
      // --- Shared ---
      trucks,
    });
  }

  // --- Step 6: Filter ALL empty buckets (not just trailing ones) ------
  // Matches web performance-charts.tsx:1917-1929 exactly: any bucket with
  // ordered/delivered/poured all at 0 is dropped, not just trailing ones.
  // (The previous trailing-only pop left in middle-of-chart empty buckets
  // whenever tickets skipped a scheduled hour.)
  const filteredBuckets = buckets.filter(
    (b) => b.ordered > 0 || b.delivered > 0 || b.poured > 0,
  );

  if (filteredBuckets.length === 0) return null;
  // Swap the reference so the rest of the function uses the filtered list.
  buckets.length = 0;
  buckets.push(...filteredBuckets);

  // --- Step 7: Totals (CY) -------------------------------------------
  const total = {
    ordered_qty: round2(buckets.reduce((s, b) => s + b.ordered, 0)),
    delivered_qty: round2(buckets.reduce((s, b) => s + b.delivered, 0)),
    poured_qty: round2(buckets.reduce((s, b) => s + b.poured, 0)),
  };

  // --- Step 8: Y-axis domain — separate for CY and Loads modes -------
  // Matches web ODP_CHART_LOGIC.md §11 exactly:
  //   25-increments up to 200, then 50-increments above.
  function roundToNiceValue(value) {
    if (value <= 25) return 25;
    if (value <= 50) return 50;
    if (value <= 75) return 75;
    if (value <= 100) return 100;
    if (value <= 125) return 125;
    if (value <= 150) return 150;
    if (value <= 175) return 175;
    if (value <= 200) return 200;
    return Math.ceil(value / 50) * 50;
  }

  // CY y-axis: max of scheduleRate and actual bar heights.
  //
  // Delivered bar stack = carryIn + solid only (carry_out is tracked in the
  // data for carry-over accounting but is NOT a visible segment, per
  // performance-charts.tsx lines 1940-1941 and 2263-2311 where only TWO
  // delivered Bar components are rendered).
  //
  // Formula matches web ODP_CHART_LOGIC.md §11 exactly:
  //   baseMax    = ceil(scheduleRate × 1.4)     — minimum room above the rate
  //   dataMax    = max(ordered, carryIn+solid, poured) per bucket
  //   targetMax  = max(baseMax, ceil(dataMax × 1.1))
  //   yMax       = roundToNiceValue(targetMax)
  const actualMaxCY = Math.max(
    ...buckets.map((b) =>
      Math.max(
        b.ordered_solid + b.ordered_striped,
        b.delivered_carry_in + b.delivered_solid,
        b.poured,
      ),
    ),
    0,
  );
  const baseMaxCY = Math.ceil(scheduleRate * 1.4);
  const targetMaxCY = Math.max(baseMaxCY, Math.ceil(actualMaxCY * 1.1));
  const yMax = roundToNiceValue(targetMaxCY);

  // Loads y-axis
  const maxBarLoads = Math.max(
    ...buckets.map((b) =>
      Math.max(
        b.ordered_loads_solid + b.ordered_loads_striped,
        b.delivered_loads,
        b.poured_loads,
      ),
    ),
    loadsPerHour,
    1,
  );
  // Round loads up to nearest even number for cleaner axis
  const yMaxLoads = Math.max(2, Math.ceil(maxBarLoads * 1.2));

  // ----- Debug log: proves the NEW code is running on the server ------
  // If the backend wasn't restarted, this log will be missing from the
  // Metro/API logs and the version field below will also be missing from
  // the JSON response. Look for "[ODP v3]" in the backend console when
  // fetching order details.
  console.log(
    `[ODP v3] primary schedule: rate=${scheduleRate} truckSpace=${truckSpaceMinutes} qty=${totalScheduleQty} nLoads=${totalNumberOfLoads} loadQty=${loadQty} start=${scheduledStart.toISOString()}`,
  );
  console.log(
    `[ODP v3] buckets (${buckets.length}): ` +
      buckets
        .map(
          (b) =>
            `${b.hour_label} O=${b.ordered}/${b.ordered_solid}+${b.ordered_striped} D=${b.delivered}(ci=${b.delivered_carry_in}) P=${b.poured}`,
        )
        .join(' | '),
  );

  // ----- Raw inputs for the WebView reducer ---------------------------
  // The mobile WebView ODPChart runs the web's HourlyODPChart reducer
  // byte-for-byte on these raw inputs, so values are guaranteed identical
  // to the web regardless of any backend bucket computation.
  //
  // Shape matches the web performance-charts.tsx expectations:
  //   - tickets[].remove_reason_code, on_job_time, wash_time, to_plant_time,
  //     scheduled_on_job_time, ticket_products[{is_mix, load_qty}]
  //   - productScheduleItems[{is_mix, schedules:[{delivery_rate_per_hour,
  //     truck_space, schedule_qty, number_of_loads, load_qty, start_time}]}]
  const epochToIso = (epoch) => {
    if (epoch === null || epoch === undefined) return null;
    const e = parseFloat(epoch);
    if (!isFinite(e)) return null;
    return new Date(e * 1000).toISOString();
  };
  const rawForReducer = {
    tickets: (tickets || []).map((t) => ({
      ticket_code: t.ticket_code || null,
      truck_code: t.truck_code || null,
      remove_reason_code: t.remove_reason_code || null,
      on_job_time: epochToIso(t.on_job_time_epoch),
      wash_time: epochToIso(t.wash_time_epoch),
      to_plant_time: epochToIso(t.to_plant_time_epoch),
      scheduled_on_job_time: epochToIso(t.scheduled_on_job_time_epoch),
      ticket_products: [
        { is_mix: true, load_qty: parseFloat(t.load_qty) || 0 },
      ],
    })),
    productScheduleItems: [
      {
        is_mix: true,
        schedules: [
          {
            delivery_rate_per_hour: scheduleRate,
            truck_space: truckSpaceMinutes,
            schedule_qty: totalScheduleQty,
            number_of_loads: totalNumberOfLoads,
            load_qty: loadQty,
            start_time: scheduledStart.toISOString(),
            loads: [],
          },
        ],
      },
    ],
  };

  // ----- Debug log: proves the NEW code is running on the server ------
  // If the backend wasn't restarted, this log will be missing from the
  // Metro/API logs and the version field below will also be missing from
  // the JSON response. Look for "[ODP v3]" in the backend console when
  // fetching order details.
  console.log(
    `[ODP v3] primary schedule: rate=${scheduleRate} truckSpace=${truckSpaceMinutes} qty=${totalScheduleQty} nLoads=${totalNumberOfLoads} loadQty=${loadQty} start=${scheduledStart.toISOString()}`,
  );
  console.log(
    `[ODP v3] buckets (${buckets.length}): ` +
      buckets
        .map(
          (b) =>
            `${b.hour_label} O=${b.ordered}/${b.ordered_solid}+${b.ordered_striped} D=${b.delivered}(ci=${b.delivered_carry_in}) P=${b.poured}`,
        )
        .join(' | '),
  );
  console.log(
    `[ODP v3] raw_for_reducer: ${rawForReducer.tickets.length} tickets`,
  );

  return {
    // Visible version marker — if this is missing from the API response
    // the user's backend is running stale code (needs restart).
    version: 'v5-parity-fix-2026-04-11',
    // Metadata for info pills in the mobile header
    schedule_rate: scheduleRate,
    schedule_qty: round2(totalScheduleQty),
    truck_space: truckSpaceMinutes,
    number_of_loads: totalNumberOfLoads,
    load_qty: round2(loadQty),
    start_time: scheduledStart.toISOString(),
    // Exact anchor (same value, kept for clients that already read it)
    start_min_from_midnight: startMinFromMidnight,
    scheduled_start_min_from_midnight: scheduledStartMinFromMidnight,
    // Chart axes
    y_max: yMax,
    y_max_loads: yMaxLoads,
    // Carryover flag for legend
    has_carryover: hasCarryover,
    // Data — backend pre-computed buckets (kept for backward compat and
    // for clients that want the fast native renderer without the WebView).
    buckets,
    total,
    // Raw inputs for the WebView reducer — see above. The mobile
    // ODPChartWebView uses this to run the web reducer locally.
    raw_for_reducer: rawForReducer,
  };
}

/**
 * Build Trucks on Job graph data (Stacked Area Chart)
 *
 * Matches web frontend performance-charts.tsx logic exactly:
 * - Filter: non-cancelled tickets with truck_code AND on_job_time (no fallback)
 * - Two stacked areas only: Waiting + Pouring (no Washout - per client spec)
 * - End Pour priority: wash_time > end_unload > to_plant_time
 * - If no end pour data, truck stays on job (in-progress = Infinity)
 * - Truck disappears AT departure time (exclusive upper bound)
 * - Staircase pattern: (T-1min, old_state) + (T, new_state) for each event
 *
 * @param {Array} tickets - Ticket rows with epoch timestamps and truck_code
 * @returns {Object|null} Trucks on job graph data
 */
function buildTrucksOnJobData(tickets, tz) {
  // Step 1: Filter — must have truck_code AND on_job_time (web: filterValidTickets + on_job_time filter)
  // No fallback chain — only trucks that actually arrived at job
  const validTickets = tickets.filter(t =>
    t.truck_code && String(t.truck_code).trim() !== '' && t.on_job_time_epoch
  );
  if (validTickets.length === 0) {
    return null;
  }

  // Step 2: Derive TruckState (web: processTruckStates)
  const parsed = validTickets.map(t => {
    const onJob = parseFloat(t.on_job_time_epoch) * 1000;
    const unload = t.unload_time_epoch ? parseFloat(t.unload_time_epoch) * 1000 : null;
    const endUnload = t.end_unload_epoch ? parseFloat(t.end_unload_epoch) * 1000 : null;
    const wash = t.wash_time_epoch ? parseFloat(t.wash_time_epoch) * 1000 : null;

    // to_plant_time with safety clamp (web: safeToPlant logic)
    let toPlant = t.to_plant_time_epoch ? parseFloat(t.to_plant_time_epoch) * 1000 : null;
    if (toPlant !== null && toPlant < onJob) {
      toPlant = onJob; // Clamp invalid data
    }

    // End Pour priority: wash_time > end_unload > to_plant_time (web §4.3)
    const endPour = wash || endUnload || toPlant;

    // If no end pour data, truck is still on job (in-progress → Infinity)
    const departure = endPour !== null ? endPour : Infinity;

    return { onJob, unload, endPour, departure };
  });

  // Step 3: Collect all event timestamps
  const timePointsSet = new Set();
  for (const p of parsed) {
    timePointsSet.add(p.onJob);                                 // Arrival
    if (p.unload !== null) timePointsSet.add(p.unload);         // Pour start
    if (p.endPour !== null && p.endPour !== Infinity) {
      timePointsSet.add(p.endPour);                             // Departure
    }
  }

  const allEventTimes = [...timePointsSet];
  if (allEventTimes.length === 0) return null;
  const minTime = Math.min(...allEventTimes);
  const maxTime = Math.max(...allEventTimes);

  // Add 5-minute interval time points for smooth visualization
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  for (let t = minTime; t <= maxTime; t += FIVE_MINUTES_MS) {
    timePointsSet.add(t);
  }

  // Web staircase pattern: add (T - 1min) before each event for step transitions
  const ONE_MINUTE_MS = 60 * 1000;
  for (const eventTime of allEventTimes) {
    const beforeTime = eventTime - ONE_MINUTE_MS;
    if (beforeTime >= minTime) {
      timePointsSet.add(beforeTime);
    }
  }

  const sortedTimes = [...timePointsSet].sort((a, b) => a - b);

  // Step 4: For each time point, count trucks in each state
  // Web §4.3: calculateTrucksOnJob — two states only (Waiting, Pouring)
  // Web §4.6: calculateAverageTimeDurations — avg waiting/pouring duration
  const timePoints = sortedTimes.map(T => {
    let waiting = 0;
    let pouring = 0;

    const waitingDurations = [];
    const pouringDurations = [];

    for (const p of parsed) {
      // Web §4.3: Truck is on job from [onJobTime, departureTime)
      // At departure time, truck is GONE (exclusive upper bound)
      if (T < p.onJob || T >= p.departure) continue;

      // State determination (web §4.3)
      if (p.unload !== null) {
        if (T < p.unload) {
          waiting++;        // Before unload = Waiting
        } else {
          pouring++;        // From unload to endPour = Pouring
        }
      } else {
        waiting++;          // No unload time = still waiting
      }
    }

    // Average durations (web §4.6) — uses inclusive upper bound for avg calculation
    for (const p of parsed) {
      if (T < p.onJob || T > (p.endPour !== null && p.endPour !== Infinity ? p.endPour : p.departure)) continue;

      if (p.unload !== null) {
        const unloadMs = p.unload;
        if (T < unloadMs) {
          // Waiting: duration = unload_time - on_job_time
          const dur = (unloadMs - p.onJob) / (1000 * 60);
          if (dur > 0) waitingDurations.push(dur);
        } else if (p.endPour !== null && p.endPour !== Infinity) {
          // Pouring: duration = endPour - unload_time
          const dur = (p.endPour - unloadMs) / (1000 * 60);
          if (dur > 0) pouringDurations.push(dur);
        }
      }
    }

    const avg = (arr) => arr.length > 0 ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 : null;

    const pointDate = new Date(T);
    return {
      time: pointDate.toISOString(),
      time_display: formatGraphTime(pointDate, tz),
      waiting,
      pouring,
      washout: 0,  // Kept for backward compat, always 0 (web has no washout)
      total: waiting + pouring,
      avg_waiting_minutes: avg(waitingDurations),
      avg_pouring_minutes: avg(pouringDurations),
      avg_washing_minutes: null  // Kept for backward compat
    };
  });

  return {
    time_points: timePoints
  };
}

/**
 * Get order tracking details by order ID with pagination and access control
 * Returns all tickets with truck details, plant info, and order location
 *
 * @param {number|string} orderId - The order ID
 * @param {object} params - Query parameters
 * @param {number} params.page - Page number (default: 1)
 * @param {number} params.limit - Items per page (default: 10)
 * @param {object} userAccess - User access control data
 * @returns {Promise<object|null>} Order tracking details or null if not found
 */
async function getOrderTrackingById(orderId, params = {}, userAccess = null) {
  if (!orderId) {
    return null;
  }

  const {
    page = 1,
    limit = 10
  } = params;
  const tz = userAccess?.timezone || null;

  // Access control check - verify user has access to this order
  if (userAccess && !userAccess.isAdmin) {
    const accessParams = [orderId];
    const accessOrParts = [];
    let paramIdx = 2;

    if (userAccess.allowedPlants?.length > 0) {
      const placeholders = userAccess.allowedPlants.map((_, i) => `$${paramIdx + i}::text`).join(', ');
      accessOrParts.push(`EXISTS (SELECT 1 FROM order_products op INNER JOIN order_product_schedules ops ON ops.order_product_id = op.id WHERE op.order_id = o.order_id AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true) AND ops.plant_code::text IN (${placeholders}))`);
      accessParams.push(...userAccess.allowedPlants.map(p => String(p)));
      paramIdx += userAccess.allowedPlants.length;
    }

    if (userAccess.allowedCustomerIds?.length > 0) {
      const placeholders = userAccess.allowedCustomerIds.map((_, i) => `$${paramIdx + i}`).join(', ');
      accessOrParts.push(`o.customer_id IN (${placeholders})`);
      accessParams.push(...userAccess.allowedCustomerIds);
      paramIdx += userAccess.allowedCustomerIds.length;
    }

    if (userAccess.allowedProjectCodes?.length > 0) {
      const placeholders = userAccess.allowedProjectCodes.map((_, i) => `$${paramIdx + i}`).join(', ');
      accessOrParts.push(`o.project_code IN (${placeholders})`);
      accessParams.push(...userAccess.allowedProjectCodes);
      paramIdx += userAccess.allowedProjectCodes.length;
    }

    if (accessOrParts.length === 0) {
      // No access permissions - return null
      return null;
    }

    const accessCheckSql = `SELECT 1 FROM orders o WHERE o.order_id = $1 AND (${accessOrParts.join(' OR ')})`;
    try {
      const accessResult = await executeDirectSQL(accessCheckSql, accessParams);
      if (!accessResult.data || accessResult.data.length === 0) {
        return null; // User doesn't have access to this order
      }
    } catch (error) {
      console.warn('Access check failed:', error.message);
      return null;
    }
  }

  // Calculate pagination values
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
  const offset = (pageNum - 1) * limitNum;

  // Query to get order basic info with location
  const orderSql = `
    SELECT
      o.order_id,
      o.order_code,
      o.order_date,
      o.customer_name,
      o.project_name,
      TRIM(BOTH ', ' FROM
        COALESCE(NULLIF(o.delivery_addr1, ''), '') ||
        CASE WHEN o.delivery_addr2 IS NOT NULL AND o.delivery_addr2 != '' THEN ', ' || o.delivery_addr2 ELSE '' END ||
        CASE WHEN o.delivery_addr3 IS NOT NULL AND o.delivery_addr3 != '' THEN ', ' || o.delivery_addr3 ELSE '' END
      ) as delivery_address,
      o.delivery_addr1,
      o.delivery_addr2,
      o.delivery_addr3,
      o.latitude as order_latitude,
      o.longitude as order_longitude,
      o.removed,
      o.remove_reason_code,
      COALESCE(o.current_status, 1) as current_status,
      o.weather_data,
      o.pricing_plant_code,
      p.code as plant_code,
      p.description as plant_description,
      p.short_description as plant_short_description,
      p.address1 as plant_address1,
      p.address2 as plant_address2,
      p.phone as plant_phone,
      p.latitude as plant_latitude,
      p.longitude as plant_longitude
    FROM orders o
    LEFT JOIN plants p ON p.code = o.pricing_plant_code
    WHERE o.order_id = $1
  `;

  // Query to get order totals
  const totalsSql = `
    SELECT
      SUM(COALESCE(op.order_qty, 0)) as ordered_qty,
      SUM(COALESCE(op.delv_qty, 0)) as delivered_qty,
      STRING_AGG(DISTINCT op.item_code, ', ') as product_codes,
      STRING_AGG(DISTINCT op.description, ', ') FILTER (WHERE op.description IS NOT NULL AND op.description != '') as product_description
    FROM order_products op
    WHERE op.order_id = $1
      AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
  `;

  // Query to count total tickets and status counts
  const ticketCountSql = `
    SELECT
      COUNT(*) as total_tickets,
      COUNT(*) FILTER (WHERE t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '') as active_tickets,
      COUNT(*) FILTER (WHERE t.remove_reason_code IS NOT NULL AND TRIM(t.remove_reason_code) != '') as cancelled_tickets
    FROM tickets t
    WHERE t.order_id = $1
  `;

  // Query to get paginated tickets with truck, plant, and driver details
  const ticketsSql = `
    WITH numbered_tickets AS (
      SELECT
        t.ticket_id,
        t.ticket_code,
        t.created_date as ticket_created_date,
        t.plant_code as ticket_plant_code,
        t.plant_name as ticket_plant_name,
        t.driver_code,
        t.driver_name,
        timezone('UTC', t.scheduled_on_job_time) as scheduled_on_job_time,
        t.remove_reason_code as ticket_remove_reason_code,
        timezone('UTC', t.printed_time) as printed_time,
        timezone('UTC', t.load_time) as load_time,
        timezone('UTC', t.loaded_time) as loaded_time,
        timezone('UTC', t.to_job_time) as to_job_time,
        timezone('UTC', t.on_job_time) as on_job_time,
        timezone('UTC', t.unload_time) as unload_time,
        timezone('UTC', t.wash_time) as wash_time,
        timezone('UTC', t.to_plant_time) as to_plant_time,
        timezone('UTC', t.at_plant_time) as at_plant_time,
        tp.load_qty,
        tp.acc_delv_qty,
        tp.item_code as ticket_item_code,
        tp.description as ticket_item_description,
        t.truck_code,
        tr.description as truck_description,
        tr.latitude as truck_latitude,
        tr.longitude as truck_longitude,
        tr.owner_name as truck_owner,
        e.phone as driver_phone,
        p.code as plant_code,
        p.description as plant_description,
        p.address1 as plant_address1,
        p.address2 as plant_address2,
        p.phone as plant_phone,
        p.latitude as plant_latitude,
        p.longitude as plant_longitude,
        CASE WHEN (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
          THEN ROW_NUMBER() OVER (
            PARTITION BY CASE WHEN (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '') THEN 0 ELSE 1 END
            ORDER BY tp.acc_delv_qty ASC NULLS LAST, t.ticket_code ASC
          )
          ELSE NULL
        END as load_number,
        CASE WHEN (t.remove_reason_code IS NOT NULL AND TRIM(t.remove_reason_code) != '') THEN 1 ELSE 0 END as is_cancelled
      FROM tickets t
      LEFT JOIN LATERAL (
        SELECT tp2.load_qty, tp2.acc_delv_qty, tp2.item_code, tp2.description
        FROM ticket_products tp2
        WHERE tp2.ticket_id = t.ticket_id AND tp2.is_mix = true
        LIMIT 1
      ) tp ON true
      LEFT JOIN trucks tr ON tr.code = t.truck_code
      LEFT JOIN employees e ON e.code = t.driver_code
      LEFT JOIN plants p ON p.code = t.plant_code
      WHERE t.order_id = $1
    )
    SELECT * FROM numbered_tickets
    ORDER BY is_cancelled ASC, load_number DESC NULLS LAST
    LIMIT $2 OFFSET $3
  `;

  try {
    // Execute order query first
    const orderResult = await executeDirectSQL(orderSql, [orderId]);
    const orderRow = orderResult.data?.[0];

    if (!orderRow) {
      return null;
    }

    // Execute all other queries in parallel
    const [totalsResult, ticketCountResult, ticketsResult] = await Promise.all([
      executeDirectSQL(totalsSql, [orderId]),
      executeDirectSQL(ticketCountSql, [orderId]),
      executeDirectSQL(ticketsSql, [orderId, limitNum, offset])
    ]);

    const totalsRow = totalsResult.data?.[0] || {};
    const ticketCountRow = ticketCountResult.data?.[0] || {};
    const ticketRows = ticketsResult.data || [];

    // Calculate order quantities
    const orderedQty = parseFloat(totalsRow.ordered_qty) || 0;
    const deliveredQty = parseFloat(totalsRow.delivered_qty) || 0;

    // Check if order is cancelled
    const isCancelled = (orderRow.removed === true || orderRow.removed === 'true') &&
      orderRow.remove_reason_code !== null &&
      String(orderRow.remove_reason_code || '').length > 0;
    const remainingQty = isCancelled ? 0 : Math.max(0, orderedQty - deliveredQty);
    const progressPercent = orderedQty > 0 ? Math.round((deliveredQty / orderedQty) * 100) : 0;

    // Calculate order status
    const orderStatus = calculateOrderStatus({
      ...orderRow,
      ordered_qty: orderedQty,
      delivered_qty: deliveredQty
    });

    // Build plant object directly from orders → plants JOIN
    let plant = null;
    if (orderRow.plant_code) {
      plant = {
        code: orderRow.plant_code,
        description: orderRow.plant_description || null,
        short_description: orderRow.plant_short_description || null,
        address: [orderRow.plant_address1, orderRow.plant_address2].filter(a => a && a.trim()).join(', ') || null,
        address1: orderRow.plant_address1 || null,
        address2: orderRow.plant_address2 || null,
        phone: orderRow.plant_phone || null,
        latitude: orderRow.plant_latitude ? parseFloat(orderRow.plant_latitude) : null,
        longitude: orderRow.plant_longitude ? parseFloat(orderRow.plant_longitude) : null
      };
    }

    // Build tickets array with truck details
    const tickets = [];

    for (const row of ticketRows) {
      // Derive ticket status from timestamps
      let ticketStatus = 'pending';
      let ticketRemoveReason = null;
      if (row.ticket_remove_reason_code && String(row.ticket_remove_reason_code).trim() !== '') {
        ticketStatus = 'cancelled';
        ticketRemoveReason = String(row.ticket_remove_reason_code).trim();
      } else if (row.at_plant_time) { ticketStatus = 'at_plant'; }
      else if (row.to_plant_time) { ticketStatus = 'to_plant'; }
      else if (row.wash_time) { ticketStatus = 'washing'; }
      else if (row.unload_time) { ticketStatus = 'pouring'; }
      else if (row.on_job_time) { ticketStatus = 'at_job'; }
      else if (row.to_job_time) { ticketStatus = 'to_job'; }
      else if (row.loaded_time) { ticketStatus = 'loaded'; }
      else if (row.load_time) { ticketStatus = 'loading'; }
      else if (row.printed_time) { ticketStatus = 'ticketed'; }

      const statusDisplay = ticketStatus === 'cancelled' && ticketRemoveReason
        ? `Cancelled-${ticketRemoveReason}`
        : STATUS_DISPLAY[ticketStatus] || 'Pending';

      const loadQty = parseFloat(row.load_qty) || 0;
      const runningQty = parseFloat(row.acc_delv_qty) || 0;

      // Build tracking_status array (chronological order: Ticketed first -> At Plant last)
      // is_current = true for the current active status (matches web logic)
      const trackingStatus = [
        { status: 'ticketed', status_display: 'Ticketed', completed: !!row.printed_time, is_current: ticketStatus === 'ticketed', time: formatTimeCST(row.printed_time, tz) },
        { status: 'loading', status_display: 'Loading', completed: !!row.load_time, is_current: ticketStatus === 'loading', time: formatTimeCST(row.load_time, tz) },
        { status: 'loaded', status_display: 'Loaded', completed: !!row.loaded_time, is_current: ticketStatus === 'loaded', time: formatTimeCST(row.loaded_time, tz) },
        { status: 'to_job', status_display: 'To Job', completed: !!row.to_job_time, is_current: ticketStatus === 'to_job', time: formatTimeCST(row.to_job_time, tz) },
        { status: 'at_job', status_display: 'At Job', completed: !!row.on_job_time, is_current: ticketStatus === 'at_job', time: formatTimeCST(row.on_job_time, tz) },
        { status: 'pouring', status_display: 'Pouring', completed: !!row.unload_time, is_current: ticketStatus === 'pouring', time: formatTimeCST(row.unload_time, tz) },
        { status: 'washing', status_display: 'Washing', completed: !!row.wash_time, is_current: ticketStatus === 'washing', time: formatTimeCST(row.wash_time, tz) },
        { status: 'to_plant', status_display: 'To Plant', completed: !!row.to_plant_time, is_current: ticketStatus === 'to_plant', time: formatTimeCST(row.to_plant_time, tz) },
        { status: 'at_plant', status_display: 'At Plant', completed: !!row.at_plant_time, is_current: ticketStatus === 'at_plant', time: formatTimeCST(row.at_plant_time, tz) }
      ];

      tickets.push({
        load: row.load_number != null ? parseInt(row.load_number, 10) : null,
        ticket_id: row.ticket_id,
        ticket_code: row.ticket_code,
        status: ticketStatus,
        status_display: statusDisplay,
        tracking_status: trackingStatus,
        product: {
          item_code: row.ticket_item_code || null,
          description: row.ticket_item_description || null
        },
        load_qty: loadQty,
        running_qty: runningQty,
        ordered_qty: orderedQty,
        remaining_after_load: parseFloat(Math.max(0, orderedQty - runningQty).toFixed(2)),
        truck: {
          code: row.truck_code || null,
          description: row.truck_description || null,
          owner: row.truck_owner || null,
          latitude: row.truck_latitude ? parseFloat(row.truck_latitude) : null,
          longitude: row.truck_longitude ? parseFloat(row.truck_longitude) : null
        },
        driver: {
          code: row.driver_code || null,
          name: row.driver_name || null,
          phone: row.driver_phone || null
        },
        plant: {
          code: row.ticket_plant_code || null,
          name: row.ticket_plant_name || null,
          latitude: row.plant_latitude ? parseFloat(row.plant_latitude) : null,
          longitude: row.plant_longitude ? parseFloat(row.plant_longitude) : null
        },
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
        }
      });
    }

    // Get summary counts from dedicated query
    const totalTickets = parseInt(ticketCountRow.total_tickets, 10) || 0;
    const activeTickets = parseInt(ticketCountRow.active_tickets, 10) || 0;
    const cancelledTickets = parseInt(ticketCountRow.cancelled_tickets, 10) || 0;
    const totalPages = Math.ceil(totalTickets / limitNum);

    // Fetch status colors purely from database (no hardcoded defaults)
    const statusColors = await fetchTrackingStatusColors();

    return {
      order_id: orderRow.order_id,
      order_code: orderRow.order_code,
      order_date: formatDateCST(orderRow.order_date),
      display_date: formatDisplayDateTime(orderRow.order_date),
      customer_name: orderRow.customer_name || '',
      project_name: orderRow.project_name || '',
      delivery_address: orderRow.delivery_address || '',
      delivery_addr1: orderRow.delivery_addr1 || '',
      delivery_addr2: orderRow.delivery_addr2 || '',
      delivery_addr3: orderRow.delivery_addr3 || '',
      ordered_qty: orderedQty,
      delivered_qty: deliveredQty,
      remaining_qty: remainingQty,
      remaining_display: `${remainingQty.toFixed(0)}CY`,
      progress_percent: progressPercent,
      status: orderStatus,
      can_chat: true,  // Chat enabled for ALL orders
      can_ticketed: orderStatus === ORDER_STATUS.IN_PROGRESS || orderStatus === ORDER_STATUS.COMPLETED,
      product_codes: totalsRow.product_codes || '',
      product_description: totalsRow.product_description || '',
      weather_data: (() => {
        if (!orderRow.weather_data) return null;
        if (typeof orderRow.weather_data === 'object') return orderRow.weather_data;
        if (typeof orderRow.weather_data === 'string') {
          try { return JSON.parse(orderRow.weather_data); } catch (e) { return null; }
        }
        return null;
      })(),
      order_location: {
        latitude: orderRow.order_latitude ? parseFloat(orderRow.order_latitude) : null,
        longitude: orderRow.order_longitude ? parseFloat(orderRow.order_longitude) : null
      },
      plant: plant,
      tickets: tickets,
      status_colors: statusColors,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalTickets,
        total_pages: totalPages,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1
      },
      summary: {
        total_tickets: totalTickets,
        active_tickets: activeTickets,
        cancelled_tickets: cancelledTickets,
        total_delivered_qty: deliveredQty,
        ordered_qty: orderedQty,
        remaining_qty: remainingQty,
        progress_percent: progressPercent,
        progress_display: `${deliveredQty.toFixed(2)} OF ${orderedQty.toFixed(2)} CY`
      }
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Get paginated scheduled loads for an order (lightweight endpoint)
 */
async function getScheduledLoadsByOrder(orderCode, orderDate, tz = null, pagination = { page: 1, limit: 10 }) {
  // Query to verify order exists and get order_id
  const orderCheckSql = `
    SELECT o.order_id
    FROM orders o
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
    LIMIT 1
  `;

  // Scheduled loads query with pagination
  const scheduledLoadsSql = `
    SELECT
      opsl.id,
      opsl.order_product_schedule_id,
      opsl.schedule_load_id,
      opsl.from_plant_id,
      opsl.from_plant,
      opsl.load_qty as scheduled_load_qty,
      opsl.truck_id,
      opsl.truck_code,
      opsl.to_plant_id,
      opsl.to_plant,
      opsl.time_to_job,
      opsl.unload_time,
      opsl.time_to_plant,
      opsl.truck_space,
      extract(epoch from opsl.printed_time) as scheduled_printed_time_epoch,
      extract(epoch from opsl.load_time) as scheduled_load_time_epoch,
      extract(epoch from opsl.on_job_time) as scheduled_on_job_time_epoch,
      extract(epoch from opsl.fin_pour_time) as scheduled_fin_pour_time_epoch,
      extract(epoch from opsl.at_plant_time) as scheduled_at_plant_time_epoch,
      opsl.time_to_wash,
      opsl.ticket_id,
      opsl.ticket_code,
      extract(epoch from t.printed_time) as actual_ticketed_time_epoch,
      extract(epoch from t.load_time) as actual_loading_time_epoch,
      extract(epoch from t.loaded_time) as actual_loaded_time_epoch,
      extract(epoch from t.to_job_time) as actual_to_job_time_epoch,
      extract(epoch from t.on_job_time) as actual_on_job_time_epoch,
      extract(epoch from t.unload_time) as actual_unload_time_epoch,
      extract(epoch from t.end_unload) as actual_end_pour_time_epoch,
      extract(epoch from t.wash_time) as actual_wash_time_epoch,
      extract(epoch from t.to_plant_time) as actual_to_plant_time_epoch,
      extract(epoch from t.at_plant_time) as actual_at_plant_time_epoch,
      t.remove_reason_code as ticket_remove_reason_code,
      tp.load_qty as actual_load_qty
    FROM order_product_schedule_loads opsl
    INNER JOIN order_product_schedules ops ON ops.id = opsl.order_product_schedule_id
    INNER JOIN order_products op ON op.id = ops.order_product_id
    INNER JOIN orders o ON o.order_id = op.order_id
    LEFT JOIN tickets t ON t.ticket_code = opsl.ticket_code AND t.order_id = o.order_id
    LEFT JOIN LATERAL (
      SELECT tp2.load_qty
      FROM ticket_products tp2
      WHERE tp2.ticket_id = t.ticket_id AND tp2.is_mix = true
      LIMIT 1
    ) tp ON true
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
    ORDER BY opsl.schedule_load_id ASC
    LIMIT $3 OFFSET $4
  `;

  // Count query for pagination
  const scheduledLoadsCountSql = `
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (
        WHERE t.ticket_id IS NOT NULL
        AND t.remove_reason_code IS NOT NULL
        AND TRIM(t.remove_reason_code) != ''
      ) as cancelled_count,
      COUNT(*) FILTER (
        WHERE t.ticket_id IS NOT NULL
        AND (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = '')
        AND (t.end_unload IS NOT NULL OR t.wash_time IS NOT NULL)
      ) as completed_count
    FROM order_product_schedule_loads opsl
    INNER JOIN order_product_schedules ops ON ops.id = opsl.order_product_schedule_id
    INNER JOIN order_products op ON op.id = ops.order_product_id
    INNER JOIN orders o ON o.order_id = op.order_id
    LEFT JOIN tickets t ON t.ticket_code = opsl.ticket_code AND t.order_id = o.order_id
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (op.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op.is_mix = true)
  `;

  const page = pagination.page || 1;
  const limit = pagination.limit || 10;
  const offset = (page - 1) * limit;

  try {
    // First verify order exists
    const orderResult = await executeDirectSQL(orderCheckSql, [orderCode, orderDate]);
    if (!orderResult.data?.[0]) {
      return null;
    }

    // Execute loads and count queries in parallel
    const [loadsResult, countResult] = await Promise.all([
      executeDirectSQL(scheduledLoadsSql, [orderCode, orderDate, limit, offset]),
      executeDirectSQL(scheduledLoadsCountSql, [orderCode, orderDate])
    ]);

    const countRow = countResult.data?.[0] || {};
    const total = parseInt(countRow.total) || 0;
    const completedCount = parseInt(countRow.completed_count) || 0;
    const cancelledCount = parseInt(countRow.cancelled_count) || 0;
    const totalPages = Math.ceil(total / limit);

    // Transform load items
    const items = (loadsResult.data || []).map((l, idx) => {
      const hasTicket = l.ticket_id != null;
      const isTicketCancelled = hasTicket &&
        l.ticket_remove_reason_code != null &&
        String(l.ticket_remove_reason_code).trim() !== '';

      // Determine load status
      let load_status = 'Scheduled';
      let load_status_code = 'scheduled';

      if (isTicketCancelled) {
        load_status = 'Cancelled';
        load_status_code = 'cancelled';
      } else if (hasTicket) {
        const statusTimestamps = [
          { key: 'at_plant', epoch: l.actual_at_plant_time_epoch, label: 'At Plant' },
          { key: 'to_plant', epoch: l.actual_to_plant_time_epoch, label: 'To Plant' },
          { key: 'washing', epoch: l.actual_wash_time_epoch, label: 'Washing' },
          { key: 'pouring', epoch: l.actual_unload_time_epoch, label: 'Pouring' },
          { key: 'at_job', epoch: l.actual_on_job_time_epoch, label: 'At Job' },
          { key: 'to_job', epoch: l.actual_to_job_time_epoch, label: 'To Job' },
          { key: 'loaded', epoch: l.actual_loaded_time_epoch, label: 'Loaded' },
          { key: 'loading', epoch: l.actual_loading_time_epoch, label: 'Loading' },
          { key: 'ticketed', epoch: l.actual_ticketed_time_epoch, label: 'Ticketed' }
        ];

        for (const s of statusTimestamps) {
          if (s.epoch != null) {
            load_status = s.label;
            load_status_code = s.key;
            break;
          }
        }
      }

      const scheduledOnJobDate = l.scheduled_on_job_time_epoch != null
        ? epochToDate(l.scheduled_on_job_time_epoch)
        : null;

      const endPourEpoch = l.actual_end_pour_time_epoch != null ? parseFloat(l.actual_end_pour_time_epoch) : null;
      const washEpoch = l.actual_wash_time_epoch != null ? parseFloat(l.actual_wash_time_epoch) : null;
      const is_completed = hasTicket && (endPourEpoch != null || washEpoch != null);

      const scheduledQty = parseFloat(l.scheduled_load_qty) || 0;
      const actualQty = hasTicket ? (parseFloat(l.actual_load_qty) || 0) : null;
      const variance = actualQty != null ? actualQty - scheduledQty : null;

      return {
        load_number: offset + idx + 1,
        load_status,
        load_status_code,
        is_completed,
        scheduled_time: formatGraphTime(scheduledOnJobDate, tz),
        actual_time: hasTicket ? formatGraphTime(epochToDate(l.actual_on_job_time_epoch), tz) : null,
        scheduled_qty: `${scheduledQty.toFixed(2)} CY`,
        actual_qty: actualQty != null ? `${actualQty.toFixed(2)} CY` : null,
        variance: variance != null ? `${variance >= 0 ? '+' : ''}${variance.toFixed(2)} CY` : null,
        scheduled_qty_raw: scheduledQty,
        actual_qty_raw: actualQty,
        variance_raw: variance,
        id: String(l.id),
        order_product_schedule_id: String(l.order_product_schedule_id),
        schedule_load_id: String(l.schedule_load_id),
        from_plant_id: l.from_plant_id ? String(l.from_plant_id) : null,
        from_plant: l.from_plant || null,
        truck_id: l.truck_id ? String(l.truck_id) : null,
        truck_code: l.truck_code || null,
        to_plant_id: l.to_plant_id ? String(l.to_plant_id) : null,
        to_plant: l.to_plant || null,
        time_to_job: l.time_to_job != null ? parseInt(l.time_to_job) : null,
        unload_time: l.unload_time != null ? parseInt(l.unload_time) : null,
        time_to_plant: l.time_to_plant != null ? parseInt(l.time_to_plant) : null,
        truck_space: l.truck_space != null ? parseInt(l.truck_space) : null,
        scheduled_printed_time: formatGraphTime(epochToDate(l.scheduled_printed_time_epoch), tz),
        scheduled_load_time: formatGraphTime(epochToDate(l.scheduled_load_time_epoch), tz),
        scheduled_on_job_time: formatGraphTime(scheduledOnJobDate, tz),
        scheduled_fin_pour_time: formatGraphTime(epochToDate(l.scheduled_fin_pour_time_epoch), tz),
        scheduled_at_plant_time: formatGraphTime(epochToDate(l.scheduled_at_plant_time_epoch), tz),
        time_to_wash: l.time_to_wash != null ? parseInt(l.time_to_wash) : 0,
        ticket_id: l.ticket_id ? String(l.ticket_id) : null,
        ticket_code: l.ticket_code || null,
        actual_on_job_time: hasTicket ? formatGraphTime(epochToDate(l.actual_on_job_time_epoch), tz) : null,
        actual_begin_pour_time: hasTicket ? formatGraphTime(epochToDate(l.actual_unload_time_epoch), tz) : null,
        actual_end_pour_time: hasTicket ? formatGraphTime(epochToDate(l.actual_end_pour_time_epoch), tz) : null,
        actual_wash_time: hasTicket ? formatGraphTime(epochToDate(l.actual_wash_time_epoch), tz) : null,
        actual_to_plant_time: hasTicket ? formatGraphTime(epochToDate(l.actual_to_plant_time_epoch), tz) : null,
        actual_at_plant_time: hasTicket ? formatGraphTime(epochToDate(l.actual_at_plant_time_epoch), tz) : null,
        actual_unload_time: hasTicket ? formatGraphTime(epochToDate(l.actual_unload_time_epoch), tz) : null,
        ticket_remove_reason_code: l.ticket_remove_reason_code || null
      };
    });

    return {
      scheduled_loads: {
        items,
        count: total,
        completed_count: completedCount,
        cancelled_count: cancelledCount,
        pagination: {
          page,
          limit,
          total,
          total_pages: totalPages,
          has_next: page < totalPages,
          has_prev: page > 1
        }
      }
    };
  } catch (error) {
    throw error;
  }
}

module.exports = {
  getOrders,
  getOrderByCodeAndDate,
  getScheduledLoadsByOrder,
  getOrdersSummary,
  getActiveTrackingOrders,
  getOrderTrackingById,
  ORDER_STATUS,
  getDateRange,
  formatDate,
  formatDateCST,
  formatTime,
  formatTimeCST,
  formatDisplayDateTime,
  buildDeliveryProgress,
  fetchProgressBarColors,
  fetchTrackingStatusColors,
  getTzAbbr,
  appendTz
};
