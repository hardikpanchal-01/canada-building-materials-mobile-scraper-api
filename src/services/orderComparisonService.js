/**
 * Order Comparison Service
 *
 * Compares scraped orders with system database orders.
 * Detects matched, mismatched, missing, new, and cancelled orders.
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');
const { CommandCloudAPI } = require('./commandCloudService');

// Batch size for database queries (process N order codes at a time)
const DB_BATCH_SIZE = parseInt(process.env.DB_BATCH_SIZE) || 50;

// Command Cloud raw status codes to readable name mapping
const STATUS_CODE_TO_NAME = {
  0: 'Normal',
  1: 'Will Call',
  2: 'Weather Permitting',
  3: 'Hold',
  4: 'Completed',
  5: 'Wait List'
};

// Truckast order status categories (computed from delivery progress)
const STATUS_CATEGORY = {
  PRE_POUR: 'Pre-Pour',
  IN_PROCESS: 'In-Process',
  COMPLETED: 'Completed',
  CANCELED: 'Canceled'
};

/**
 * Check if all loads are ticketed (gap between ordered and ticketed qty <= 0.02 CY)
 * Uses 2-decimal rounding to handle IEEE 754 floating-point precision issues.
 *
 * @param {number} orderedQty - Total ordered quantity
 * @param {number} ticketedQty - Total ticketed quantity
 * @returns {boolean} True if all loads are ticketed
 */
function areAllLoadsTicketed(orderedQty, ticketedQty) {
  if ((orderedQty || 0) <= 0) return false;
  const ordered = Math.round((orderedQty || 0) * 100) / 100;
  const ticketed = Math.round((ticketedQty || 0) * 100) / 100;
  return (ordered - ticketed) <= 0.02;
}

/**
 * Compute the Truckast order status category based on delivery progress.
 *
 * Priority: Canceled > Completed/In-Process (if tickets) > Completed (status 4, no tickets) > Pre-Pour
 *
 * @param {object} order - System order with ticketed_qty, is_last_load_completed, etc.
 * @returns {string} Status category (Pre-Pour, In-Process, Completed, Canceled)
 */
function getOrderStatusCategory(order) {
  // Step 1: Canceled
  if (order.removed === true || order.removed === 'true') {
    return STATUS_CATEGORY.CANCELED;
  }

  // Step 2: In-Process vs Completed (order has tickets)
  const ticketedQty = order.ticketed_qty || 0;
  if (ticketedQty > 0) {
    if (order.is_last_load_completed && areAllLoadsTicketed(order.ordered_qty, ticketedQty)) {
      return STATUS_CATEGORY.COMPLETED;
    }
    return STATUS_CATEGORY.IN_PROCESS;
  }

  // Step 3: Completed without tickets (current_status === 4)
  // Use == instead of === to handle string/number type mismatch from DB drivers
  if ((parseInt(order.current_status) === 4) && (order.tickets_count || 0) === 0) {
    return STATUS_CATEGORY.COMPLETED;
  }

  // Step 4: Default
  return STATUS_CATEGORY.PRE_POUR;
}

/**
 * Check if a Command Cloud raw status is equivalent to a Truckast status category.
 *
 * Command Cloud "Normal" means the order is active, which maps to Pre-Pour or In-Process.
 * Command Cloud "Hold"/"Will Call"/"Weather Permitting"/"Wait List" are pre-pour states.
 *
 * @param {string} concreteGoStatus - Raw Command Cloud status string
 * @param {string} truckastCategory - Truckast computed status category
 * @returns {boolean} True if the statuses are considered equivalent
 */
function isStatusEquivalent(concreteGoStatus, truckastCategory) {
  const cc = (concreteGoStatus || '').toLowerCase().trim();
  const tc = (truckastCategory || '').toLowerCase().trim();

  if (cc === tc) return true;

  // Command Cloud "Normal" = active order → matches Pre-Pour or In-Process
  if (cc === 'normal' && (tc === 'pre-pour' || tc === 'in-process')) return true;

  // Command Cloud hold states → matches Pre-Pour
  if (['hold', 'will call', 'weather permitting', 'wait list'].includes(cc) && tc === 'pre-pour') return true;

  // Command Cloud "Completed" ↔ Truckast "Completed"
  if (cc === 'completed' && tc === 'completed') return true;

  // Both cancelled
  if (['cancelled', 'canceled'].includes(cc) && tc === 'canceled') return true;

  return false;
}

/**
 * Normalize order code for matching
 *
 * @param {string} orderCode - Order code to normalize
 * @returns {string} Normalized order code
 */
function normalizeOrderCode(orderCode) {
  if (!orderCode) return '';
  return String(orderCode).trim().toUpperCase();
}

/**
 * Normalize date to YYYY-MM-DD format
 *
 * @param {string} dateStr - Date string
 * @returns {string} Normalized date in YYYY-MM-DD format
 */
function normalizeDate(dateStr) {
  if (!dateStr) return '';

  // Handle Date objects directly (e.g. from PostgreSQL timestamptz columns)
  // IMPORTANT: Use UTC methods to avoid local timezone shifting the date.
  // Example: DB stores "2026-02-20 19:00:00+00" (7PM UTC = Feb 20).
  // If server runs in IST (UTC+5:30), getDate() returns 21 (Feb 21 IST), causing mismatches.
  // getUTCDate() correctly returns 20 regardless of server timezone.
  if (dateStr instanceof Date) {
    if (!isNaN(dateStr.getTime())) {
      const year = dateStr.getUTCFullYear();
      const month = String(dateStr.getUTCMonth() + 1).padStart(2, '0');
      const day = String(dateStr.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    return '';
  }

  const str = String(dateStr).trim();

  // If already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // Handle MM-DD-YYYY or MM/DD/YYYY format explicitly
  // JavaScript's Date constructor doesn't reliably parse "MM-DD-YYYY" with hyphens
  // (it treats hyphens as ISO format where year comes first, causing Invalid Date)
  const mdyMatch = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (mdyMatch) {
    const month = String(parseInt(mdyMatch[1], 10)).padStart(2, '0');
    const day = String(parseInt(mdyMatch[2], 10)).padStart(2, '0');
    const year = mdyMatch[3];
    return `${year}-${month}-${day}`;
  }

  // Try to parse and format (handles ISO timestamps, full date strings, etc.)
  // Use UTC methods to avoid local timezone shifting the date
  const date = new Date(str);
  if (!isNaN(date.getTime())) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  return str;
}

/**
 * Build match key for order matching
 *
 * @param {string} orderCode - Order code
 * @param {string} orderDate - Order date
 * @returns {string} Match key
 */
function buildMatchKey(orderCode, orderDate) {
  const normalizedCode = normalizeOrderCode(orderCode);
  const normalizedDate = normalizeDate(orderDate);
  return `${normalizedCode}_${normalizedDate}`;
}

/**
 * Check if the first 2 words of two strings match
 * Used for partial matching of customer_name and delivery_address
 * Only applies to these two fields per client requirement
 *
 * @param {string} value1 - First value to compare
 * @param {string} value2 - Second value to compare
 * @returns {boolean} True if first 2 words match
 */
function matchesFirstTwoWords(value1, value2) {
  if (!value1 && !value2) return true;
  if (!value1 || !value2) return false;

  // Normalize: trim, lowercase, remove punctuation, collapse whitespace
  const normalize = (str) => String(str)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');

  const words1 = normalize(value1).split(' ').filter(w => w.length > 0);
  const words2 = normalize(value2).split(' ').filter(w => w.length > 0);

  // If both are empty after normalization, consider match
  if (words1.length === 0 && words2.length === 0) return true;

  // Need at least 2 words to compare (or all available if fewer)
  const wordsToCompare = Math.min(2, words1.length, words2.length);

  // If one has words and other doesn't, no match
  if (wordsToCompare === 0) return false;

  // Compare word by word
  for (let i = 0; i < wordsToCompare; i++) {
    if (words1[i] !== words2[i]) return false;
  }

  return true;
}

/**
 * Normalize start_time to HH:MM format
 * Handles various input formats:
 * - Timestamp strings: "2025-12-08 09:00:00+00", "2025-12-08T09:00:00.000Z"
 * - Time strings: "09:00", "09:00:00"
 * - Date objects
 *
 * @param {any} timeValue - Time value (timestamp, time string, or Date object)
 * @returns {string|null} Normalized time in HH:MM format, or null if invalid
 */
function normalizeStartTime(timeValue) {
  if (!timeValue) return null;
  
  // Handle Date objects
  if (timeValue instanceof Date) {
    const hours = String(timeValue.getHours()).padStart(2, '0');
    const minutes = String(timeValue.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }
  
  const timeStr = String(timeValue).trim();
  
  // If already in HH:MM format, validate and return
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [hours, minutes] = timeStr.split(':');
    const h = parseInt(hours, 10);
    const m = parseInt(minutes, 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  
  // If in HH:MM:SS format, extract HH:MM
  if (/^\d{1,2}:\d{2}:\d{2}/.test(timeStr)) {
    const [hours, minutes] = timeStr.split(':');
    const h = parseInt(hours, 10);
    const m = parseInt(minutes, 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }

  // Handle HH:MM AM/PM format (e.g., "9:00 AM", "12:30 PM")
  const ampmMatch = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = parseInt(ampmMatch[2], 10);
    const period = ampmMatch[3].toUpperCase();
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }

  // Handle timestamp formats (ISO, PostgreSQL, etc.)
  // Try to parse as Date first (handles most formats)
  const dateObj = new Date(timeStr);
  if (!isNaN(dateObj.getTime())) {
    const hours = String(dateObj.getHours()).padStart(2, '0');
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }
  
  // Try regex extraction for timestamp formats
  // Match time pattern after date (handles both space and T separators)
  // Pattern: date separator time (e.g., "2025-12-08 09:00" or "2025-12-08T09:00")
  // Use a more specific pattern to avoid matching year/month/day
  const timestampMatch = timeStr.match(/(?:T|\s)(\d{1,2}):(\d{2})(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?/);
  if (timestampMatch) {
    const hours = parseInt(timestampMatch[1], 10);
    const minutes = parseInt(timestampMatch[2], 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
  }
  
  // If no pattern matches, return null
  return null;
}

/**
 * Fetch system orders from database (single batch)
 * Uses optimized query with CTEs instead of correlated subqueries
 *
 * @param {array} orderCodes - Array of order codes to fetch (already normalized)
 * @param {string} minDate - Minimum date (YYYY-MM-DD)
 * @param {string} maxDate - Maximum date (YYYY-MM-DD)
 * @param {number} timeoutMs - Query timeout in milliseconds
 * @returns {Promise<array>} Array of system orders with related data
 */
async function fetchSystemOrdersBatch(orderCodes, minDate, maxDate, timeoutMs = 15000) {
  if (!orderCodes || orderCodes.length === 0) {
    return [];
  }

  // Optimized query using CTEs instead of correlated subqueries
  const sql = `
    WITH order_notes_agg AS (
      SELECT order_id, COUNT(*) > 0 as has_notes
      FROM order_notes
      GROUP BY order_id
    ),
    tickets_agg AS (
      SELECT order_id, COUNT(*) as tickets_count
      FROM tickets
      GROUP BY order_id
    ),
    ticketed_qty_agg AS (
      SELECT
        t.order_id,
        COALESCE(SUM(tp.load_qty), 0) as ticketed_qty
      FROM tickets t
      JOIN ticket_products tp ON tp.ticket_id = t.ticket_id AND tp.is_mix = true
      WHERE t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = ''
      GROUP BY t.order_id
    ),
    last_ticket AS (
      SELECT DISTINCT ON (t.order_id)
        t.order_id,
        CASE
          WHEN t.wash_time IS NOT NULL OR t.unload_time IS NOT NULL THEN true
          WHEN t.to_plant_time IS NOT NULL OR t.at_plant_time IS NOT NULL THEN true
          WHEN GREATEST(
            t.printed_time, t.load_time, t.loaded_time, t.to_job_time,
            t.on_job_time, t.unload_time, t.wash_time, t.to_plant_time, t.at_plant_time
          ) < (NOW() AT TIME ZONE '${process.env.BUSINESS_TIMEZONE || 'America/Chicago'}') - INTERVAL '3 hours' THEN true
          ELSE false
        END as is_last_load_completed
      FROM tickets t
      WHERE t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code) = ''
      ORDER BY t.order_id, t.ticket_code DESC NULLS LAST
    ),
    schedule_fallback AS (
      SELECT DISTINCT ON (op_fb.order_id)
        op_fb.order_id,
        ops_fb.start_time,
        TO_CHAR(ops_fb.start_time, 'FMHH:MI AM') as start_time_formatted,
        ops_fb.plant_code
      FROM order_products op_fb
      JOIN order_product_schedules ops_fb ON ops_fb.order_product_id = op_fb.id
      ORDER BY op_fb.order_id, ops_fb.start_time ASC
    )
    SELECT DISTINCT
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
      COALESCE(o.current_status, 0) as current_status,
      op.id as order_product_id,
      op.product_id,
      op.item_code,
      op.order_qty as ordered_qty,
      op.delv_qty as delivered_qty,
      COALESCE(ops.start_time, sfb.start_time) as start_time,
      COALESCE(TO_CHAR(ops.start_time, 'FMHH:MI AM'), sfb.start_time_formatted) as start_time_formatted,
      COALESCE(ops.plant_code, sfb.plant_code) as plant_code,
      COALESCE(ona.has_notes, false) as has_notes,
      COALESCE(ta.tickets_count, 0) as tickets_count,
      COALESCE(tqa.ticketed_qty, 0) as ticketed_qty,
      COALESCE(lt.is_last_load_completed, false) as is_last_load_completed
    FROM orders o
    LEFT JOIN order_products op ON op.order_id = o.order_id
      AND (UPPER(op.order_qty_unit) = 'YDQ' AND op.is_mix = true)
    LEFT JOIN order_product_schedules ops ON ops.order_product_id = op.id
    LEFT JOIN schedule_fallback sfb ON sfb.order_id = o.order_id
    LEFT JOIN order_notes_agg ona ON ona.order_id = o.order_id
    LEFT JOIN tickets_agg ta ON ta.order_id = o.order_id
    LEFT JOIN ticketed_qty_agg tqa ON tqa.order_id = o.order_id
    LEFT JOIN last_ticket lt ON lt.order_id = o.order_id
    WHERE UPPER(TRIM(o.order_code)) = ANY($1::text[])
      AND o.order_date >= $2::date
      AND o.order_date < ($3::date + INTERVAL '1 day')
    ORDER BY o.order_code, o.order_date, op.id
  `;

  try {
    const result = await executeDirectSQL(sql, [orderCodes, minDate, maxDate], {
      timeoutMs: timeoutMs
    });
    return result.data || [];
  } catch (error) {
    throw error;
  }
}

/**
 * Fetch system orders from database in batches
 * Processes order codes in chunks to avoid timeouts on large datasets
 *
 * @param {array} orderCodes - Array of order codes to fetch
 * @param {string} minDate - Minimum date (YYYY-MM-DD)
 * @param {string} maxDate - Maximum date (YYYY-MM-DD)
 * @param {number} batchSize - Number of order codes per batch (default: DB_BATCH_SIZE)
 * @returns {Promise<array>} Combined array of system orders from all batches
 */
async function fetchSystemOrders(orderCodes, minDate, maxDate, batchSize = DB_BATCH_SIZE) {
  if (!orderCodes || orderCodes.length === 0) {
    return [];
  }

  // Normalize order codes
  const normalizedCodes = orderCodes.map(code => normalizeOrderCode(code));

  // If small batch, process directly
  if (normalizedCodes.length <= batchSize) {
    return await fetchSystemOrdersBatch(normalizedCodes, minDate, maxDate);
  }

  // Process in batches for large datasets
  const results = [];

  for (let i = 0; i < normalizedCodes.length; i += batchSize) {
    const batch = normalizedCodes.slice(i, i + batchSize);

    try {
      const batchResults = await fetchSystemOrdersBatch(batch, minDate, maxDate);
      results.push(...batchResults);
    } catch (error) {
      // Continue with other batches - partial results are better than none
    }
  }

  return results;
}

/**
 * Build system orders map from database results
 *
 * @param {array} systemOrderRows - Raw database rows
 * @returns {Map<string, object>} Map of matchKey -> SystemOrder
 */
function buildSystemOrdersMap(systemOrderRows) {
  const ordersMap = new Map();

  // Group by order_code and order_date (since one order can have multiple products)
  const groupedOrders = {};

  // Track seen order_product_ids to prevent double-counting from multiple schedule rows.
  // One order_product can have multiple order_product_schedules (different plants/times),
  // which creates duplicate rows in the SQL result. We must only count each product's qty once.
  const seenProductIds = new Set();

  for (const row of systemOrderRows) {
    const matchKey = buildMatchKey(row.order_code, row.order_date);

    if (!groupedOrders[matchKey]) {
      groupedOrders[matchKey] = {
        order_id: row.order_id,
        order_code: row.order_code,
        order_date: normalizeDate(row.order_date),
        customer_name: row.customer_name || '',
        delivery_address: row.delivery_address || '',
        start_time: null,
        plant_code: null,
        product_code: null,
        ordered_qty: 0,
        delivered_qty: 0,
        current_status: parseInt(row.current_status) || 0,
        has_notes: row.has_notes === true || row.has_notes === 'true',
        removed: row.removed === true || row.removed === 'true',
        remove_reason_code: row.remove_reason_code || null,
        tickets_count: parseInt(row.tickets_count) || 0,
        ticketed_qty: parseFloat(row.ticketed_qty) || 0,
        is_last_load_completed: row.is_last_load_completed === true || row.is_last_load_completed === 'true',
        products: []
      };
    }

    const order = groupedOrders[matchKey];

    // Collect start_time from schedules (take first non-null as fallback)
    // Note: We'll prioritize start_time from matching product during comparison
    // Use formatted time if available (from SQL), otherwise normalize the timestamp
    if (row.start_time && !order.start_time) {
      order.start_time = row.start_time_formatted || normalizeStartTime(row.start_time);
    }

    // Collect plant_code (take first non-null as fallback)
    // Note: We'll prioritize plant_code from matching product during comparison
    if (row.plant_code && !order.plant_code) {
      order.plant_code = String(row.plant_code).trim();
    }

    // Collect product information and aggregate quantities.
    // Only count each order_product_id once to avoid inflating quantities
    // when the same product has multiple schedules.
    if (row.item_code && row.order_product_id && !seenProductIds.has(row.order_product_id)) {
      seenProductIds.add(row.order_product_id);

      const productCode = row.item_code;
      const existingProduct = order.products.find(p => p.code === productCode);

      if (!existingProduct) {
        // Use formatted time if available (from SQL), otherwise normalize the timestamp
        const productStartTime = row.start_time_formatted || normalizeStartTime(row.start_time);

        order.products.push({
          code: productCode,
          product_id: row.product_id,
          ordered_qty: parseFloat(row.ordered_qty) || 0,
          delivered_qty: parseFloat(row.delivered_qty) || 0,
          start_time: productStartTime,
          plant_code: row.plant_code ? String(row.plant_code).trim() : null
        });
      } else {
        // Same item_code but different order_product_id — sum quantities
        existingProduct.ordered_qty = (parseFloat(existingProduct.ordered_qty) || 0) + (parseFloat(row.ordered_qty) || 0);
        existingProduct.delivered_qty = (parseFloat(existingProduct.delivered_qty) || 0) + (parseFloat(row.delivered_qty) || 0);
      }

      // Aggregate order-level quantities only once per product ID
      order.ordered_qty += parseFloat(row.ordered_qty) || 0;
      order.delivered_qty += parseFloat(row.delivered_qty) || 0;
    }
  }

  // Convert to final SystemOrder format and build map
  for (const [matchKey, order] of Object.entries(groupedOrders)) {
    // Use first product code if available, otherwise null
    const primaryProduct = order.products.length > 0 ? order.products[0].code : null;

    const systemOrder = {
      order_id: order.order_id,
      order_code: order.order_code,
      order_date: order.order_date,
      customer_name: order.customer_name,
      delivery_address: order.delivery_address,
      start_time: order.start_time,
      plant_code: order.plant_code,
      product_code: primaryProduct,
      ordered_qty: order.ordered_qty,
      delivered_qty: order.delivered_qty,
      current_status: order.current_status ?? 0,
      has_notes: order.has_notes,
      removed: order.removed,
      remove_reason_code: order.remove_reason_code,
      tickets_count: order.tickets_count,
      ticketed_qty: order.ticketed_qty,
      is_last_load_completed: order.is_last_load_completed,
      status_category: getOrderStatusCategory(order),
      products: order.products // Store products array for product-specific matching
    };

    ordersMap.set(matchKey, systemOrder);
  }

  return ordersMap;
}

/**
 * Compare two values with tolerance for floating point numbers
 *
 * @param {any} value1 - First value
 * @param {any} value2 - Second value
 * @param {string} fieldType - Type of field ('number' or 'string')
 * @returns {boolean} True if values match
 */
function compareValues(value1, value2, fieldType = 'string') {
  // Handle null/undefined cases
  if (value1 == null && value2 == null) return true;
  if (value1 == null || value2 == null) return false;
  
  // Strict equality check (handles same type and value)
  if (value1 === value2) return true;

  if (fieldType === 'number') {
    // Convert to numbers, handling strings, null, undefined
    let num1 = value1;
    let num2 = value2;
    
    // Convert to numbers if not already
    if (typeof num1 !== 'number') {
      num1 = parseFloat(num1);
    }
    if (typeof num2 !== 'number') {
      num2 = parseFloat(num2);
    }
    
    // If both are NaN, they match
    if (isNaN(num1) && isNaN(num2)) return true;
    // If one is NaN and the other isn't, they don't match
    if (isNaN(num1) || isNaN(num2)) return false;
    
    // For exact matches, return true immediately
    if (num1 === num2) return true;
    
    // Round to 2 decimal places for comparison to handle floating point precision issues
    const rounded1 = Math.round(num1 * 100) / 100;
    const rounded2 = Math.round(num2 * 100) / 100;
    if (rounded1 === rounded2) return true;
    
    // Allow small quantity differences up to 0.02 (client adds 0.01 to prevent order auto-close)
    // Also handle very small relative differences that might occur due to floating point precision
    const diff = Math.abs(num1 - num2);
    const maxVal = Math.max(Math.abs(num1), Math.abs(num2), 1);
    const relativeDiff = diff / maxVal;

    // Use absolute tolerance for small numbers, relative tolerance for larger numbers
    return diff <= 0.02 || relativeDiff < 0.0001;
  }

  if (fieldType === 'string') {
    const str1 = String(value1 || '').trim().toLowerCase();
    const str2 = String(value2 || '').trim().toLowerCase();
    return str1 === str2;
  }

  return false;
}

/**
 * Compare a scraped order with a system order
 *
 * @param {object} scrapedOrder - Scraped order object
 * @param {object} systemOrder - System order object
 * @returns {object} Comparison result with matchStatus and differences
 */
function compareOrder(scrapedOrder, systemOrder) {
  const differences = [];
  let matchStatus = 'matched';

  // Compare start_time (normalize both to HH:MM format for comparison)
  const scrapedStartTime = normalizeStartTime(scrapedOrder.start_time) || '';
  const systemStartTime = normalizeStartTime(systemOrder.start_time) || '';
  
  if (!compareValues(scrapedStartTime, systemStartTime, 'string')) {
    differences.push({
      field: 'start_time',
      external_value: scrapedOrder.start_time || null,
      system_value: systemOrder.start_time || null // Show original value in differences
    });
  }

  // Compare plant_code
  const scrapedPlantCode = scrapedOrder.plant_code ? String(scrapedOrder.plant_code).trim() : '';
  const systemPlantCode = systemOrder.plant_code ? String(systemOrder.plant_code).trim() : '';
  if (!compareValues(scrapedPlantCode, systemPlantCode, 'string')) {
    differences.push({
      field: 'plant_code',
      external_value: scrapedPlantCode || null,
      system_value: systemPlantCode || null
    });
  }

  // Compare customer_name (first 2 words matching is sufficient per client requirement)
  if (!matchesFirstTwoWords(scrapedOrder.customer_name, systemOrder.customer_name)) {
    differences.push({
      field: 'customer_name',
      external_value: scrapedOrder.customer_name || null,
      system_value: systemOrder.customer_name || null
    });
  }

  // Compare delivery_address (first 2 words matching is sufficient per client requirement)
  if (!matchesFirstTwoWords(scrapedOrder.delivery_address, systemOrder.delivery_address)) {
    differences.push({
      field: 'delivery_address',
      external_value: scrapedOrder.delivery_address || null,
      system_value: systemOrder.delivery_address || null
    });
  }

  // Compare product_code (only if available in system)
  // Note: product_code may not be available in order_products table
  if (systemOrder.product_code) {
    const scrapedProductCode = scrapedOrder.product_code ? String(scrapedOrder.product_code).trim().toUpperCase() : '';
    const systemProductCode = String(systemOrder.product_code).trim().toUpperCase();
    if (!compareValues(scrapedProductCode, systemProductCode, 'string')) {
      differences.push({
        field: 'product_code',
        external_value: scrapedOrder.product_code || null,
        system_value: systemOrder.product_code || null
      });
    }
  } else if (scrapedOrder.product_code) {
    // System doesn't have product_code, but scraped order does - note this as a difference
    differences.push({
      field: 'product_code',
      external_value: scrapedOrder.product_code,
      system_value: 'N/A (not available in system)'
    });
  }

  // Compare ordered_qty (normalize to numbers for consistent comparison)
  // Handle both null/undefined and ensure proper number conversion
  let scrapedOrderedQty = scrapedOrder.ordered_qty;
  let systemOrderedQty = systemOrder.ordered_qty;
  
  // Convert to numbers if they're not already, handling null/undefined
  if (scrapedOrderedQty != null) {
    scrapedOrderedQty = typeof scrapedOrderedQty === 'number' ? scrapedOrderedQty : parseFloat(scrapedOrderedQty);
  }
  if (systemOrderedQty != null) {
    systemOrderedQty = typeof systemOrderedQty === 'number' ? systemOrderedQty : parseFloat(systemOrderedQty);
  }
  
  const orderedQtyMatch = compareValues(scrapedOrderedQty, systemOrderedQty, 'number');

  if (!orderedQtyMatch) {
    differences.push({
      field: 'ordered_qty',
      external_value: scrapedOrder.ordered_qty,
      system_value: systemOrder.ordered_qty
    });
  }

  // Compare delivered_qty (normalize to numbers for consistent comparison)
  // Handle both null/undefined and ensure proper number conversion
  let scrapedDeliveredQty = scrapedOrder.delivered_qty;
  let systemDeliveredQty = systemOrder.delivered_qty;
  
  // Convert to numbers if they're not already, handling null/undefined
  if (scrapedDeliveredQty != null) {
    scrapedDeliveredQty = typeof scrapedDeliveredQty === 'number' ? scrapedDeliveredQty : parseFloat(scrapedDeliveredQty);
  }
  if (systemDeliveredQty != null) {
    systemDeliveredQty = typeof systemDeliveredQty === 'number' ? systemDeliveredQty : parseFloat(systemDeliveredQty);
  }
  
  const deliveredQtyMatch = compareValues(scrapedDeliveredQty, systemDeliveredQty, 'number');

  if (!deliveredQtyMatch) {
    differences.push({
      field: 'delivered_qty',
      external_value: scrapedOrder.delivered_qty,
      system_value: systemOrder.delivered_qty
    });
  }

  // Compare status using Truckast category logic
  // Truckast status is a computed category (Pre-Pour, In-Process, Completed, Canceled)
  // Command Cloud status is a raw string (Normal, Hold, Will Call, Completed, etc.)
  const scrapedStatusStr = scrapedOrder.status ? String(scrapedOrder.status).trim() : 'Normal';
  const systemCategory = systemOrder.status_category || getOrderStatusCategory(systemOrder);

  if (!isStatusEquivalent(scrapedStatusStr, systemCategory)) {
    differences.push({
      field: 'status',
      external_value: scrapedStatusStr,
      system_value: systemCategory
    });
  }

  // has_notes is NOT compared - notes exist only in Truckast DB and cannot be
  // validated from the scraped source, so mismatches are false positives.

  // If there are differences, mark as mismatched
  if (differences.length > 0) {
    matchStatus = 'mismatched';
  }

  return {
    matchStatus,
    differences
  };
}

/**
 * Compare scraped orders with system orders
 *
 * @param {array} sanitizedOrders - Array of sanitized scraped orders
 * @param {string} batchId - Batch ID for tracking
 * @param {string} fileUrl - File URL of stored orders
 * @param {number} processingStartTime - Processing start timestamp
 * @returns {Promise<object>} Comparison result with summary and details
 */
async function compareOrdersWithSystem({
  sanitizedOrders,
  batchId,
  fileUrl,
  processingStartTime
}) {
  try {
    const matchKeys = new Map();
    const orderCodes = new Set();
    const dates = [];

    for (const order of sanitizedOrders) {
      const matchKey = buildMatchKey(order.order_code, order.order_date);
      matchKeys.set(matchKey, order);
      orderCodes.add(normalizeOrderCode(order.order_code));
      dates.push(normalizeDate(order.order_date));
    }

    const minDate = dates.length > 0 ? dates.sort()[0] : null;
    const maxDate = dates.length > 0 ? dates.sort().reverse()[0] : null;

    if (!minDate || !maxDate) {
      throw new Error('Unable to determine date range from orders');
    }

    const systemOrderRows = await fetchSystemOrders(
      Array.from(orderCodes),
      minDate,
      maxDate
    );

    // Step 5.3: Build system orders map
    const systemOrdersMap = buildSystemOrdersMap(systemOrderRows);

    // Step 5.4 & 5.5: Compare orders
    const comparisonResults = [];
    let matchedCount = 0;
    let mismatchedCount = 0;
    let missingInSystemCount = 0;
    let noCyMixProductsExcludedCount = 0;

    for (const [matchKey, scrapedOrder] of matchKeys.entries()) {
      const systemOrder = systemOrdersMap.get(matchKey);

      let comparisonResult = {
        matchKey: matchKey,
        order_code: scrapedOrder.order_code,
        order_date: normalizeDate(scrapedOrder.order_date),
        matchStatus: null,
        match_status: null, // Also provide snake_case
        differences: [],
        // Provide both camelCase and snake_case for compatibility
        externalOrder: {
          order_code: scrapedOrder.order_code,
          order_date: normalizeDate(scrapedOrder.order_date),
          start_time: scrapedOrder.start_time || null,
          plant_code: scrapedOrder.plant_code || null,
          customer_name: scrapedOrder.customer_name || null,
          delivery_address: scrapedOrder.delivery_address || null,
          product_code: scrapedOrder.product_code || null,
          ordered_qty: scrapedOrder.ordered_qty || 0,
          delivered_qty: scrapedOrder.delivered_qty || 0,
          status: scrapedOrder.status || null,
          has_notes: scrapedOrder.has_notes || false
        },
        external_order: null, // Will be set to same as externalOrder
        systemOrder: null,
        system_order: null, // Will be set to same as systemOrder
        isCancelled: false,
        is_cancelled: false // Also provide snake_case
      };

      if (!systemOrder) {
        // Order not found in system
        comparisonResult.matchStatus = 'missing_in_system';
        comparisonResult.match_status = 'missing_in_system';
        comparisonResult.external_order = comparisonResult.externalOrder;
        missingInSystemCount++;
      } else if (systemOrder.products.length === 0 && systemOrder.product_code === null) {
        // Order exists in system but has NO CY mix products (LEFT JOIN returned NULL product data).
        // These orders are outside the scope of CY mix comparison and should be excluded.
        // They would otherwise create false mismatches (Truckast: "N/A", qty: 0 vs scraped data).
        // These orders also won't appear in the web app (which uses INNER JOIN on order_products).
        comparisonResult.matchStatus = 'excluded';
        comparisonResult.match_status = 'excluded';
        comparisonResult.external_order = comparisonResult.externalOrder;
        comparisonResult.excluded_reason = 'no_cy_mix_products';
        noCyMixProductsExcludedCount++;
        console.log(`  Order ${scrapedOrder.order_code} excluded: exists in system but has no CY mix products`);
      } else {
        // Find matching product to get correct start_time and plant_code
        let matchedProduct = null;
        if (scrapedOrder.product_code && systemOrder.products && systemOrder.products.length > 0) {
          const scrapedProductCode = normalizeOrderCode(scrapedOrder.product_code);
          matchedProduct = systemOrder.products.find(p => 
            normalizeOrderCode(p.code) === scrapedProductCode
          );
        }

        // Use start_time and plant_code from matching product, fallback to order-level values
        const systemStartTime = matchedProduct?.start_time || systemOrder.start_time || null;
        const systemPlantCode = matchedProduct?.plant_code || systemOrder.plant_code || null;
        const systemProductCode = matchedProduct?.code || systemOrder.product_code || null;
        // Use product-specific quantities when product match is found, otherwise use aggregated totals
        // Handle null/undefined explicitly to preserve 0 values
        const systemOrderedQty = matchedProduct 
          ? (matchedProduct.ordered_qty != null ? matchedProduct.ordered_qty : 0)
          : (systemOrder.ordered_qty != null ? systemOrder.ordered_qty : 0);
        const systemDeliveredQty = matchedProduct 
          ? (matchedProduct.delivered_qty != null ? matchedProduct.delivered_qty : 0)
          : (systemOrder.delivered_qty != null ? systemOrder.delivered_qty : 0);

        // Create system order object with product-matched values
        const systemOrderForComparison = {
          ...systemOrder,
          start_time: systemStartTime,
          plant_code: systemPlantCode,
          product_code: systemProductCode,
          ordered_qty: systemOrderedQty,
          delivered_qty: systemDeliveredQty
        };

        // Check if order is cancelled (using category logic: removed = canceled)
        const isCancelled = (systemOrder.status_category || getOrderStatusCategory(systemOrder)) === STATUS_CATEGORY.CANCELED;
        comparisonResult.isCancelled = isCancelled;
        comparisonResult.is_cancelled = isCancelled;

        // Include system order details
        const systemOrderData = {
          order_code: systemOrder.order_code,
          order_date: systemOrder.order_date,
          start_time: systemStartTime,
          plant_code: systemPlantCode,
          customer_name: systemOrder.customer_name || null,
          delivery_address: systemOrder.delivery_address || null,
          product_code: systemProductCode,
          ordered_qty: systemOrderedQty,
          delivered_qty: systemDeliveredQty,
          status: systemOrder.status_category || getOrderStatusCategory(systemOrder),
          current_status: systemOrder.current_status ?? 0,
          has_notes: systemOrder.has_notes || false,
          removed: systemOrder.removed || false,
          remove_reason_code: systemOrder.remove_reason_code || null
        };
        comparisonResult.systemOrder = systemOrderData;
        comparisonResult.system_order = systemOrderData; // Also provide snake_case
        
        // Also set external_order to same as externalOrder
        comparisonResult.external_order = comparisonResult.externalOrder;

        // Compare with system order (using product-matched values)
        const comparison = compareOrder(scrapedOrder, systemOrderForComparison);
        comparisonResult.matchStatus = comparison.matchStatus;
        comparisonResult.match_status = comparison.matchStatus; // Also provide snake_case
        // Provide both snake_case and camelCase for compatibility
        comparisonResult.differences = comparison.differences.map(diff => ({
          field: diff.field,
          external_value: diff.external_value,
          externalValue: diff.external_value,
          system_value: diff.system_value,
          systemValue: diff.system_value
        }));

        if (comparison.matchStatus === 'matched') {
          matchedCount++;
        } else {
          mismatchedCount++;
        }
      }

      comparisonResults.push(comparisonResult);
    }

    // Step 5.6: Detect new system orders (orders in system but not in scraped data)
    const newInSystemOrders = [];
    for (const [matchKey, systemOrder] of systemOrdersMap.entries()) {
      if (!matchKeys.has(matchKey)) {
        const newMatchKey = buildMatchKey(systemOrder.order_code, systemOrder.order_date);
        newInSystemOrders.push({
          matchKey: newMatchKey,
          order_code: systemOrder.order_code,
          order_date: systemOrder.order_date,
          matchStatus: 'new_in_system',
          systemOrder: {
            order_code: systemOrder.order_code,
            order_date: systemOrder.order_date,
            start_time: systemOrder.start_time || null,
            plant_code: systemOrder.plant_code || null,
            customer_name: systemOrder.customer_name || null,
            delivery_address: systemOrder.delivery_address || null,
            product_code: systemOrder.product_code || null,
            ordered_qty: systemOrder.ordered_qty || 0,
            delivered_qty: systemOrder.delivered_qty || 0,
            status: systemOrder.status_category || getOrderStatusCategory(systemOrder),
            current_status: systemOrder.current_status ?? 0,
            has_notes: systemOrder.has_notes || false
          }
        });
      }
    }

    // Step 6: Build comparison summary
    // Use matchKeys.size (unique order_code+order_date) instead of sanitizedOrders.length
    // because the scraper sends one row per product, so multi-product orders create duplicates
    const totalExternalOrders = matchKeys.size;
    const totalSystemOrders = systemOrdersMap.size;
    const newInSystemCount = newInSystemOrders.length;

    const matchPercentage = totalExternalOrders > 0
      ? ((matchedCount / totalExternalOrders) * 100).toFixed(2)
      : '0.00';
    
    const mismatchPercentage = totalExternalOrders > 0
      ? ((mismatchedCount / totalExternalOrders) * 100).toFixed(2)
      : '0.00';

    const processingDuration = Date.now() - processingStartTime;

    if (noCyMixProductsExcludedCount > 0) {
      console.log(`  ${noCyMixProductsExcludedCount} order(s) excluded from comparison (no CY mix products in system)`);
    }

    const comparisonSummary = {
      batch_id: batchId,
      file_url: fileUrl,
      // Provide both snake_case (for compatibility) and camelCase (for frontend)
      total_external_orders: totalExternalOrders,
      totalExternalOrders: totalExternalOrders,
      total_system_orders: totalSystemOrders,
      totalSystemOrders: totalSystemOrders,
      matched_count: matchedCount,
      matchedCount: matchedCount,
      matched_percentage: parseFloat(matchPercentage),
      matchedPercentage: parseFloat(matchPercentage),
      mismatched_count: mismatchedCount,
      mismatchedCount: mismatchedCount,
      mismatched_percentage: parseFloat(mismatchPercentage),
      mismatchedPercentage: parseFloat(mismatchPercentage),
      missing_in_system_count: missingInSystemCount,
      missingInSystemCount: missingInSystemCount,
      new_in_system_count: newInSystemCount,
      newInSystemCount: newInSystemCount,
      no_cy_mix_excluded_count: noCyMixProductsExcludedCount,
      noCyMixExcludedCount: noCyMixProductsExcludedCount,
      processing_duration_ms: processingDuration,
      comparison_timestamp: new Date().toISOString()
    };

    const fullComparisonResult = {
      summary: comparisonSummary,
      matched_orders: comparisonResults.filter(r => r.matchStatus === 'matched'),
      mismatched_orders: comparisonResults.filter(r => r.matchStatus === 'mismatched'),
      missing_in_system_orders: comparisonResults.filter(r => r.matchStatus === 'missing_in_system'),
      excluded_no_cy_mix_orders: comparisonResults.filter(r => r.matchStatus === 'excluded'),
      new_in_system_orders: newInSystemOrders
    };

    return {
      summary: comparisonSummary,
      fullResult: fullComparisonResult
    };

  } catch (error) {
    throw error;
  }
}

/**
 * Map a Command Cloud API order (PascalCase) to comparison format (snake_case)
 *
 * Extracts relevant fields from the Command Cloud OrderRet object and maps them
 * to the same snake_case format used in comparisons.
 *
 * @param {object} apiOrder - Raw order object from Command Cloud API (PascalCase fields)
 * @returns {object} Mapped order with snake_case fields
 */
function mapCommandCloudOrderToComparisonFormat(apiOrder) {
  if (!apiOrder) return null;

  /**
   * Helper: safely parse a numeric value from multiple possible field names.
   * Returns the parsed number or null if none of the fields exist.
   */
  function pickNumber(obj, ...keys) {
    for (const key of keys) {
      if (obj[key] != null && obj[key] !== '') {
        const val = parseFloat(obj[key]);
        if (!isNaN(val)) return val;
      }
    }
    return null;
  }

  /**
   * Helper: pick first non-empty string from multiple field names.
   */
  function pickString(obj, ...keys) {
    for (const key of keys) {
      if (obj[key] != null && String(obj[key]).trim() !== '') {
        return String(obj[key]).trim();
      }
    }
    return null;
  }

  // Extract product info (first CY product or first product)
  let productCode = null;
  let orderedQty = null;
  let deliveredQty = null;
  let startTime = null;
  let plantCode = null;
  const products = [];

  // Command Cloud API returns products under Products.Product (confirmed from karl-truck project)
  const productData = apiOrder.Products?.Product || apiOrder.OrderProductRet || apiOrder.ProductRet;
  if (productData) {
    const productList = Array.isArray(productData) ? productData : [productData];
    for (const prod of productList) {
      const itemCode = pickString(prod, 'ItemCode', 'ProductCode', 'ItemName', 'Code');
      const qty = pickNumber(prod, 'OrderedQty', 'OrderQty', 'Qty', 'Quantity');
      const delQty = pickNumber(prod, 'DeliveredQty', 'DelvQty', 'DelivQty', 'DlvQty', 'ActualQty');
      const unit = pickString(prod, 'OrderQtyUnit', 'UnitOfMeasure', 'UOM', 'Unit') || '';

      // Extract schedule info for this product
      // Command Cloud API nests schedules under Schedules.Schedule (confirmed from karl-truck project)
      let prodStartTime = null;
      let prodPlantCode = null;
      const scheduleData = prod.Schedules?.Schedule || prod.OrderProductScheduleRet || prod.ScheduleRet || prod.Schedule;
      if (scheduleData) {
        const schedules = Array.isArray(scheduleData) ? scheduleData : [scheduleData];
        if (schedules.length > 0) {
          prodStartTime = pickString(schedules[0], 'StartTime', 'SchedStartTime', 'ScheduleStartTime', 'Time');
          prodPlantCode = pickString(schedules[0], 'PlantCode', 'PlantID', 'Plant');
        }
      }

      products.push({
        code: itemCode,
        ordered_qty: qty != null ? qty : 0,
        delivered_qty: delQty != null ? delQty : 0,
        start_time: prodStartTime ? normalizeStartTime(prodStartTime) : null,
        plant_code: prodPlantCode || null,
        unit: unit
      });
    }

    // Use first product as primary (or first CY product if available)
    const cyProduct = products.find(p => p.unit && p.unit.toUpperCase() === 'YDQ');
    const primaryProduct = cyProduct || products[0] || null;
    if (primaryProduct) {
      productCode = primaryProduct.code;
      orderedQty = primaryProduct.ordered_qty;
      deliveredQty = primaryProduct.delivered_qty;
      startTime = primaryProduct.start_time;
      plantCode = primaryProduct.plant_code;
    }
  }

  // Extract schedule info at order level if not found in products
  if (!startTime || !plantCode) {
    const scheduleData = apiOrder.Schedules?.Schedule || apiOrder.OrderProductScheduleRet || apiOrder.ScheduleRet || apiOrder.Schedule;
    if (scheduleData) {
      const schedules = Array.isArray(scheduleData) ? scheduleData : [scheduleData];
      if (schedules.length > 0) {
        if (!startTime) {
          const rawTime = pickString(schedules[0], 'StartTime', 'SchedStartTime', 'ScheduleStartTime', 'Time');
          startTime = rawTime ? normalizeStartTime(rawTime) : null;
        }
        if (!plantCode) {
          plantCode = pickString(schedules[0], 'PlantCode', 'PlantID', 'Plant');
        }
      }
    }
  }

  // Map status — also check Removed flag for cancelled orders
  const statusCode = apiOrder.CurrentStatus != null ? parseInt(apiOrder.CurrentStatus) : 0;
  const isRemoved = apiOrder.Removed === 'true' || apiOrder.Removed === true ||
    String(apiOrder.Removed) === '1';
  const statusName = isRemoved ? 'Canceled' : (STATUS_CODE_TO_NAME[statusCode] || 'Normal');

  // Build delivery address from parts
  let deliveryAddress = '';
  const addr1 = apiOrder.DeliveryAddr1 || apiOrder.DeliveryAddress1 || '';
  const addr2 = apiOrder.DeliveryAddr2 || apiOrder.DeliveryAddress2 || '';
  const addr3 = apiOrder.DeliveryAddr3 || apiOrder.DeliveryAddress3 || '';
  const addrParts = [addr1, addr2, addr3].filter(a => a && a.trim());
  deliveryAddress = addrParts.join(', ').trim();

  // Check notes - Command Cloud API returns notes under Notes.Note
  const hasNotes = !!(apiOrder.Notes?.Note || apiOrder.OrderNoteRet || apiOrder.NoteRet);

  return {
    order_code: apiOrder.OrderCode || null,
    order_date: normalizeDate(apiOrder.OrderDate || null),
    customer_name: apiOrder.CustomerName || null,
    delivery_address: deliveryAddress,
    start_time: startTime,
    plant_code: plantCode,
    product_code: productCode,
    ordered_qty: orderedQty != null ? orderedQty : 0,
    delivered_qty: deliveredQty != null ? deliveredQty : 0,
    status: statusName,
    current_status: statusCode,
    has_notes: hasNotes,
    removed: apiOrder.Removed === 'true' || apiOrder.Removed === true,
    removed_raw: apiOrder.Removed,
    remove_reason_code: apiOrder.RemoveReasonCode || null,
    products: products
  };
}

/**
 * Format a date string to MM/dd/yyyy for Command Cloud API
 *
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {string} Date in MM/dd/yyyy format
 */
function formatDateForCommandCloudAPI(dateStr) {
  if (!dateStr) return '';
  const normalized = normalizeDate(dateStr);
  if (!normalized || normalized.length !== 10) return dateStr;
  const [year, month, day] = normalized.split('-');
  return `${month}/${day}/${year}`;
}

/**
 * Re-validate mismatched orders by fetching fresh data from the Command Cloud SOAP API
 *
 * For each mismatched order, queries the Command Cloud API to get the current state
 * and re-compares each mismatched field. Compares fresh Command Cloud values against
 * the Truckast DB values (system_order from original comparison) to determine if
 * the mismatch is "confirmed" (still different) or "resolved" (now matching).
 *
 * Graceful degradation: if Command Cloud API is unavailable or auth fails, skips
 * re-validation and returns empty results without failing the job.
 *
 * @param {array} mismatchedOrders - Array of mismatched order objects from comparison
 * @returns {Promise<object>} Re-validation results with per-order details
 */
async function revalidateMismatchedOrders(mismatchedOrders) {
  if (!mismatchedOrders || mismatchedOrders.length === 0) {
    return {
      revalidated_count: 0,
      confirmed_count: 0,
      resolved_count: 0,
      orders: []
    };
  }

  console.log(`🔄 Re-validating ${mismatchedOrders.length} mismatched order(s) via Command Cloud API...`);

  // Authenticate with Command Cloud API
  const commandCloudAPI = new CommandCloudAPI();
  let ticketHeader;
  try {
    const authResult = await commandCloudAPI.loginWithEnvCredentials();
    ticketHeader = authResult.ticketHeader;
    console.log('🔑 Command Cloud API authentication successful for re-validation');
  } catch (authError) {
    console.warn(`⚠️ Command Cloud API auth failed, skipping re-validation: ${authError.message}`);
    return {
      revalidated_count: 0,
      confirmed_count: 0,
      resolved_count: 0,
      error: `Command Cloud API auth failed: ${authError.message}`,
      orders: []
    };
  }

  // Re-validate each mismatched order by querying Command Cloud API
  const revalidatedOrders = [];
  let totalConfirmedOrders = 0;
  let totalResolvedOrders = 0;
  let apiFoundCount = 0;
  let apiNotFoundCount = 0;
  let apiErrorCount = 0;

  for (const order of mismatchedOrders) {
    const ext = order.external_order || order.externalOrder || {};
    const sys = order.system_order || order.systemOrder || {};
    const orderCode = ext.order_code;
    const orderDate = normalizeDate(ext.order_date);

    if (!orderCode) continue;

    // Query Command Cloud API for this order
    let freshApiOrder = null;
    try {
      const apiDateFormatted = formatDateForCommandCloudAPI(orderDate);
      const apiOrders = await commandCloudAPI.queryOrders({
        orderCode: orderCode,
        fromOrderDate: apiDateFormatted,
        toOrderDate: apiDateFormatted,
        includeRemovedOrder: true
      }, ticketHeader);

      if (apiOrders && apiOrders.length > 0) {
        // Find the matching order by code
        const normalizedCode = normalizeOrderCode(orderCode);
        freshApiOrder = apiOrders.find(o =>
          normalizeOrderCode(o.OrderCode) === normalizedCode
        ) || apiOrders[0];
      }
    } catch (queryError) {
      apiErrorCount++;
      console.warn(`⚠️ Failed to query Command Cloud for order ${orderCode}: ${queryError.message}`);
      // Mark all differences as confirmed if API query fails
      const revalidatedDiffs = (order.differences || []).map(diff => ({
        field: diff.field,
        scraped_value: diff.external_value,
        initial_system_value: diff.system_value,
        fresh_system_value: null,
        revalidation_status: 'confirmed'
      }));
      totalConfirmedOrders++;

      revalidatedOrders.push({
        order_code: orderCode,
        order_date: orderDate,
        customer_name: ext.customer_name,
        product_code: ext.product_code,
        fresh_data_found: false,
        differences: revalidatedDiffs,
        order_status: 'confirmed'
      });
      continue;
    }

    if (!freshApiOrder) {
      apiNotFoundCount++;
      // Order not found in Command Cloud API - mark all differences as confirmed
      const revalidatedDiffs = (order.differences || []).map(diff => ({
        field: diff.field,
        scraped_value: diff.external_value,
        initial_system_value: diff.system_value,
        fresh_system_value: null,
        revalidation_status: 'confirmed'
      }));
      totalConfirmedOrders++;

      revalidatedOrders.push({
        order_code: orderCode,
        order_date: orderDate,
        customer_name: ext.customer_name,
        product_code: ext.product_code,
        fresh_data_found: false,
        differences: revalidatedDiffs,
        order_status: 'confirmed'
      });
      continue;
    }

    apiFoundCount++;
    // Map Command Cloud PascalCase fields to comparison format
    const freshMapped = mapCommandCloudOrderToComparisonFormat(freshApiOrder);

    // Find matching product for product-specific comparison
    // Try exact match first, then prefix/contains match for composite codes
    let matchedProduct = null;
    if (ext.product_code && freshMapped.products && freshMapped.products.length > 0) {
      const scrapedProductCode = normalizeOrderCode(ext.product_code);
      // 1. Exact match
      matchedProduct = freshMapped.products.find(p =>
        normalizeOrderCode(p.code) === scrapedProductCode
      );
      // 2. Scraped code starts with API product code (e.g. scraped "A505A0BACC" starts with API "A505A0")
      if (!matchedProduct) {
        matchedProduct = freshMapped.products.find(p =>
          p.code && scrapedProductCode.startsWith(normalizeOrderCode(p.code))
        );
      }
      // 3. API product code starts with scraped code
      if (!matchedProduct) {
        matchedProduct = freshMapped.products.find(p =>
          p.code && normalizeOrderCode(p.code).startsWith(scrapedProductCode)
        );
      }
      // 4. If only one product, use it
      if (!matchedProduct && freshMapped.products.length === 1) {
        matchedProduct = freshMapped.products[0];
      }
    }

    // Build fresh values from Command Cloud API response
    // Use product-specific values when product match is found
    const hasProductData = freshMapped.products && freshMapped.products.length > 0;
    const freshValues = {
      start_time: matchedProduct?.start_time || freshMapped.start_time,
      plant_code: matchedProduct?.plant_code || freshMapped.plant_code,
      customer_name: freshMapped.customer_name,
      delivery_address: freshMapped.delivery_address,
      product_code: matchedProduct?.code || freshMapped.product_code,
      ordered_qty: matchedProduct ? matchedProduct.ordered_qty : freshMapped.ordered_qty,
      delivered_qty: matchedProduct ? matchedProduct.delivered_qty : freshMapped.delivered_qty,
      status: freshMapped.status,
      has_notes: freshMapped.has_notes
    };

    // Fields that depend on product/schedule data from the API
    // If the API didn't return product data, skip re-validation for these fields
    const productDependentFields = new Set(['start_time', 'plant_code', 'product_code', 'ordered_qty', 'delivered_qty']);

    // Re-validate each difference: compare fresh Command Cloud value vs Truckast DB value
    let orderConfirmed = 0;
    let orderResolved = 0;
    const revalidatedDiffs = (order.differences || []).map(diff => {
      const freshValue = freshValues[diff.field];
      // Compare fresh API value against the Truckast DB value (system_value from initial comparison)
      const systemValue = diff.system_value;
      let isResolved = false;

      // If API didn't return product data and this field depends on it,
      // skip comparison - keep as confirmed mismatch with original scraped value
      if (!hasProductData && productDependentFields.has(diff.field)) {
        orderConfirmed++;
        return {
          field: diff.field,
          scraped_value: diff.external_value,
          initial_system_value: systemValue,
          fresh_system_value: diff.external_value,
          revalidation_status: 'confirmed'
        };
      }

      if (diff.field === 'customer_name' || diff.field === 'delivery_address') {
        isResolved = matchesFirstTwoWords(freshValue, systemValue);
      } else if (diff.field === 'ordered_qty' || diff.field === 'delivered_qty') {
        isResolved = compareValues(freshValue, systemValue, 'number');
      } else if (diff.field === 'status') {
        // systemValue is a Truckast category (Pre-Pour, In-Process, Completed, Canceled)
        // freshValue is a Command Cloud API raw status (Normal, Hold, etc.)
        // Check if the fresh API status is equivalent to the Truckast category
        const freshStatusStr = freshValue ? String(freshValue).trim() : 'Normal';
        isResolved = isStatusEquivalent(freshStatusStr, systemValue);
      } else if (diff.field === 'has_notes') {
        isResolved = Boolean(freshValue) === Boolean(systemValue);
      } else if (diff.field === 'product_code') {
        const f = freshValue ? String(freshValue).trim().toUpperCase() : '';
        const s = systemValue ? String(systemValue).trim().toUpperCase() : '';
        isResolved = f === s;
      } else {
        isResolved = compareValues(freshValue, systemValue, 'string');
      }

      if (isResolved) {
        orderResolved++;
      } else {
        orderConfirmed++;
      }

      return {
        field: diff.field,
        scraped_value: diff.external_value,
        initial_system_value: systemValue,
        fresh_system_value: freshValue,
        revalidation_status: isResolved ? 'resolved' : 'confirmed'
      };
    });

    // Order-level status: "confirmed" if ANY field still mismatched, "resolved" only if ALL resolved
    const orderStatus = orderConfirmed > 0 ? 'confirmed' : 'resolved';
    if (orderStatus === 'confirmed') {
      totalConfirmedOrders++;
    } else {
      totalResolvedOrders++;
    }

    revalidatedOrders.push({
      order_code: orderCode,
      order_date: orderDate,
      customer_name: ext.customer_name,
      product_code: ext.product_code,
      fresh_data_found: true,
      differences: revalidatedDiffs,
      order_status: orderStatus,
      // API raw fields for debugging in email
      api_current_status: freshMapped.current_status,
      api_removed: freshMapped.removed,
      api_removed_raw: freshMapped.removed_raw,
      api_remove_reason_code: freshMapped.remove_reason_code,
      api_status: freshMapped.status
    });
  }


  return {
    revalidated_count: mismatchedOrders.length,
    confirmed_count: totalConfirmedOrders,
    resolved_count: totalResolvedOrders,
    revalidated_at: new Date().toISOString(),
    orders: revalidatedOrders
  };
}

/**
 * Fetch dashboard-matching order counts from the database
 *
 * Replicates the web app's getCompanySummaryData() logic exactly:
 *
 * Web app flow:
 * 1. Supabase query: orders with order_products!inner (INNER JOIN, any product)
 * 2. Post-filter: keep orders that have at least one CY product
 * 3. Exclusion: customer patterns filtered to CONCRETE-only, ALL product &
 *    delivery_address patterns kept. All use includes() (substring match).
 *    Product exclusion checks ALL item_codes of the order (not just CY products).
 * 4. Cancelled = removed === true AND remove_reason_code is non-empty string
 *
 * @param {string} minDate - Start date (YYYY-MM-DD)
 * @param {string} maxDate - End date (YYYY-MM-DD)
 * @returns {Promise<object>} { dashboard_total, dashboard_active, dashboard_cancelled }
 */
async function fetchDashboardCounts(minDate, maxDate) {
  const { fetchExclusionPatterns } = require('./exclusionPatternService');

  // Step 1+2: Get orders that have at least one CY product (matching !inner + CY filter),
  // AND aggregate ALL item_codes per order (for product exclusion checking).
  const sql = `
    SELECT o.order_id, o.order_code, o.customer_name,
           o.delivery_addr1, o.removed, o.remove_reason_code,
           array_agg(DISTINCT op.item_code) FILTER (WHERE op.item_code IS NOT NULL) as item_codes
    FROM orders o
    INNER JOIN order_products op ON op.order_id = o.order_id
    WHERE o.order_date >= $1::date
      AND o.order_date < ($2::date + INTERVAL '1 day')
      AND EXISTS (
        SELECT 1 FROM order_products op_cy
        WHERE op_cy.order_id = o.order_id
          AND UPPER(op_cy.order_qty_unit) = 'YDQ'
      )
    GROUP BY o.order_id, o.order_code, o.customer_name,
             o.delivery_addr1, o.removed, o.remove_reason_code
  `;

  const result = await executeDirectSQL(sql, [minDate, maxDate], { timeoutMs: 15000 });
  if (!result.success || !result.data) {
    throw new Error(`Dashboard count query failed: ${result.error || 'no data'}`);
  }

  let orders = result.data;

  // Step 3: Fetch exclusion patterns and apply web-app-style filtering
  const allPatterns = await fetchExclusionPatterns();

  // Web app filters customer patterns to CONCRETE-only (scheduling-note patterns cause false positives)
  const customerPatterns = allPatterns
    .filter(p => p.type === 'customer' && p.pattern.toUpperCase().includes('CONCRETE'));
  // ALL product and delivery_address patterns are kept as-is
  const productPatterns = allPatterns.filter(p => p.type === 'product');
  const addressPatterns = allPatterns.filter(p => p.type === 'delivery_address');

  orders = orders.filter(order => {
    const customerName = (order.customer_name || '').toLowerCase();
    const deliveryAddr = (order.delivery_addr1 || '').toLowerCase();
    const itemCodes = (order.item_codes || []).map(c => (c || '').toLowerCase());

    // Check customer name (CONCRETE-only patterns, substring match)
    for (const p of customerPatterns) {
      if (customerName.includes(p.pattern.toLowerCase())) return false;
    }

    // Check ALL item_codes against product patterns (substring match)
    // Web app: order.order_products.some(product => containsExcludedPattern(product.item_code, patterns))
    for (const p of productPatterns) {
      const lowerPattern = p.pattern.toLowerCase();
      if (itemCodes.some(code => code.includes(lowerPattern))) return false;
    }

    // Check delivery address (substring match)
    for (const p of addressPatterns) {
      if (deliveryAddr.includes(p.pattern.toLowerCase())) return false;
    }

    return true;
  });

  // Step 4: Count totals
  const total = orders.length;
  const cancelled = orders.filter(o =>
    (o.removed === true || o.removed === 'true') &&
    o.remove_reason_code != null &&
    String(o.remove_reason_code).trim() !== ''
  ).length;
  const active = total - cancelled;

  return { dashboard_total: total, dashboard_active: active, dashboard_cancelled: cancelled };
}

/**
 * Re-validate missing orders by fetching data from the Command Cloud SOAP API.
 *
 * For each order that is missing in the Truckast DB, queries the Command Cloud API.
 * If the API returns the order, it is marked as "resolved" (found in source system,
 * ready to be inserted into Truckast DB). If not found, it stays "still_missing".
 *
 * @param {array} missingOrders - Array of missing order objects from comparison
 * @returns {Promise<object>} Re-validation results with per-order details
 */
async function revalidateMissingOrders(missingOrders) {
  if (!missingOrders || missingOrders.length === 0) {
    return {
      total_count: 0,
      resolved_count: 0,
      still_missing_count: 0,
      orders: []
    };
  }

  console.log(`🔄 Re-validating ${missingOrders.length} missing order(s) via Command Cloud API...`);

  // Authenticate with Command Cloud API
  const commandCloudAPI = new CommandCloudAPI();
  let ticketHeader;
  try {
    const authResult = await commandCloudAPI.loginWithEnvCredentials();
    ticketHeader = authResult.ticketHeader;
    console.log('🔑 Command Cloud API authentication successful for missing order re-validation');
  } catch (authError) {
    console.warn(`⚠️ Command Cloud API auth failed, skipping missing order re-validation: ${authError.message}`);
    return {
      total_count: missingOrders.length,
      resolved_count: 0,
      still_missing_count: missingOrders.length,
      error: `Command Cloud API auth failed: ${authError.message}`,
      orders: []
    };
  }

  const revalidatedOrders = [];
  let resolvedCount = 0;
  let stillMissingCount = 0;

  for (const order of missingOrders) {
    const ext = order.external_order || order.externalOrder || {};
    const orderCode = ext.order_code;
    const orderDate = normalizeDate(ext.order_date);

    if (!orderCode) continue;

    // Query Command Cloud API for this order
    let freshApiOrder = null;
    let rawApiOrder = null;
    try {
      const apiDateFormatted = formatDateForCommandCloudAPI(orderDate);
      const apiOrders = await commandCloudAPI.queryOrders({
        orderCode: orderCode,
        fromOrderDate: apiDateFormatted,
        toOrderDate: apiDateFormatted,
        includeRemovedOrder: true
      }, ticketHeader);

      if (apiOrders && apiOrders.length > 0) {
        const normalizedCode = normalizeOrderCode(orderCode);
        rawApiOrder = apiOrders.find(o =>
          normalizeOrderCode(o.OrderCode) === normalizedCode
        ) || apiOrders[0];
        freshApiOrder = mapCommandCloudOrderToComparisonFormat(rawApiOrder);
      }
    } catch (queryError) {
      console.warn(`⚠️ Failed to query Command Cloud for missing order ${orderCode}: ${queryError.message}`);
      stillMissingCount++;
      revalidatedOrders.push({
        order_code: orderCode,
        order_date: orderDate,
        customer_name: ext.customer_name,
        product_code: ext.product_code,
        revalidation_status: 'still_missing',
        api_found: false,
        scraped_order: ext,
        error: queryError.message
      });
      continue;
    }

    if (!freshApiOrder || !rawApiOrder) {
      // Not found in Command Cloud API either
      stillMissingCount++;
      revalidatedOrders.push({
        order_code: orderCode,
        order_date: orderDate,
        customer_name: ext.customer_name,
        product_code: ext.product_code,
        revalidation_status: 'still_missing',
        api_found: false,
        scraped_order: ext
      });
      console.log(`  ❌ Missing order ${orderCode} (${orderDate}) - NOT found in Command Cloud API`);
      continue;
    }

    // Found in Command Cloud API - mark as resolved
    resolvedCount++;
    revalidatedOrders.push({
      order_code: orderCode,
      order_date: orderDate,
      customer_name: freshApiOrder.customer_name || ext.customer_name,
      product_code: freshApiOrder.product_code || ext.product_code,
      revalidation_status: 'resolved',
      api_found: true,
      scraped_order: ext,
      api_order: freshApiOrder,
      raw_api_order: rawApiOrder
    });
    console.log(`  ✅ Missing order ${orderCode} (${orderDate}) - FOUND in Command Cloud API → resolved`);
  }

  console.log(`🔄 Missing order re-validation complete: ${resolvedCount} resolved, ${stillMissingCount} still missing`);

  return {
    total_count: missingOrders.length,
    resolved_count: resolvedCount,
    still_missing_count: stillMissingCount,
    revalidated_at: new Date().toISOString(),
    orders: revalidatedOrders
  };
}

module.exports = {
  compareOrdersWithSystem,
  revalidateMismatchedOrders,
  revalidateMissingOrders,
  fetchDashboardCounts,
  fetchSystemOrders,
  buildSystemOrdersMap,
  getOrderStatusCategory,
  areAllLoadsTicketed,
  isStatusEquivalent,
  STATUS_CATEGORY
};
