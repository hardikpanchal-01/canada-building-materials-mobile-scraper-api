/**
 * Emailed Orders Service
 *
 * Handles order-level email deduplication across batches.
 * Uses the existing scraped_order_imports table to track which orders have been emailed.
 * Stores order identifiers in the emailed_orders_json JSONB column.
 */

const { executeDirectSQL } = require('../../utils/postgresExecutor');

/**
 * Generate a stable order key for tracking
 * Now includes changed_fields to distinguish between different types of changes
 *
 * @param {object} order - Order object
 * @returns {object} Order key components including changed_fields
 */
function getOrderKey(order) {
  // Handle both external_order and system_order formats
  const orderData = order.external_order || order.system_order || order;

  // Extract changed field names from differences array
  // Sort for consistent key generation (e.g., "ordered_qty,status" not "status,ordered_qty")
  const changedFields = (order.differences || [])
    .map(d => d.field)
    .filter(Boolean)
    .sort()
    .join(',');

  return {
    order_code: orderData.order_code || '',
    order_date: orderData.order_date || '',
    plant_code: orderData.plant_code || orderData.plt || '',
    product_code: orderData.product_code || '',
    changed_fields: changedFields || 'none'  // 'none' for matched orders with no differences
  };
}

/**
 * Format date to YYYY-MM-DD
 *
 * @param {string|Date} dateInput - Date string or Date object
 * @returns {string} Formatted date in YYYY-MM-DD format
 */
function formatDate(dateInput) {
  if (!dateInput) return null;

  try {
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return dateInput; // Return as-is if invalid

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  } catch (error) {
    return dateInput; // Return as-is if error
  }
}

/**
 * Check which orders from the comparison result have already been emailed
 * Queries the scraped_order_imports table's emailed_orders_json column
 *
 * Only returns keys for records that have changed_fields tracking.
 * Old records without changed_fields are ignored (we can't deduplicate them properly).
 *
 * @param {object} comparisonResult - Full comparison result with matched/mismatched/missing/new orders
 * @returns {Promise<Set>} Set of order keys that have been emailed WITH change tracking
 */
async function getEmailedOrderKeys(comparisonResult) {
  if (!process.env.DATABASE_URL) {
    return new Set();
  }

  // Extract all orders from comparison result
  const allOrders = [
    ...(comparisonResult.matched_orders || []),
    ...(comparisonResult.mismatched_orders || []),
    ...(comparisonResult.missing_in_system_orders || []),
    ...(comparisonResult.new_in_system_orders || [])
  ];

  if (allOrders.length === 0) {
    return new Set();
  }

  // Query all batches that have sent emails and extract their emailed_orders_json
  const sql = `
    SELECT emailed_orders_json
    FROM scraped_order_imports
    WHERE email_sent_at IS NOT NULL
      AND emailed_orders_json IS NOT NULL
    ORDER BY email_sent_at DESC
  `;

  try {
    const result = await executeDirectSQL(sql, []);

    if (!result.success) {
      // If column doesn't exist, silently skip deduplication
      if (result.error && (result.error.includes('does not exist') || result.error.includes('emailed_orders_json') || result.error.includes('column') && result.error.includes('emailed_orders'))) {
        console.log('⚠️  emailed_orders_json column does not exist - run: psql -d your_database -f ADD_COLUMN_NOW.sql');
        return new Set();
      }
      return new Set();
    }

    // Build set of emailed order keys - ONLY from records that have changed_fields
    // Old records without changed_fields are skipped (can't deduplicate without knowing what changed)
    const emailedKeys = new Set();
    let legacyCount = 0;

    for (const row of (result.data || [])) {
      if (!row.emailed_orders_json) continue;

      // Parse the JSONB array
      const emailedOrders = Array.isArray(row.emailed_orders_json)
        ? row.emailed_orders_json
        : JSON.parse(row.emailed_orders_json);

      for (const order of emailedOrders) {
        // Only use records that have changed_fields for deduplication
        if (order.changed_fields && order.changed_fields !== 'none') {
          const dateStr = formatDate(order.order_date);
          const fullKey = `${order.order_code}|${dateStr}|${order.plant_code}|${order.product_code}|${order.changed_fields}`;
          emailedKeys.add(fullKey);
        } else {
          // Old record without changed_fields - can't deduplicate, just count for logging
          legacyCount++;
        }
      }
    }

    if (emailedKeys.size > 0 || legacyCount > 0) {
      console.log(`  Found ${emailedKeys.size} orders with change tracking for deduplication (${legacyCount} legacy records ignored)`);
    }

    return emailedKeys;

  } catch (error) {
    // If column doesn't exist, silently skip deduplication
    if (error.message && (error.message.includes('does not exist') || error.message.includes('emailed_orders_json') || error.message.includes('column') && error.message.includes('emailed_orders'))) {
      console.log('⚠️  emailed_orders_json column does not exist - run: psql -d your_database -f ADD_COLUMN_NOW.sql');
      return new Set();
    }

    console.error('Error checking emailed orders:', error.message);
    // On error, return empty set to avoid blocking emails
    return new Set();
  }
}

/**
 * Filter out already-emailed orders from comparison result
 *
 * Only filters orders that have been emailed WITH change tracking (changed_fields).
 * Old records without changed_fields are ignored - we can't deduplicate them.
 *
 * @param {object} comparisonResult - Full comparison result
 * @returns {Promise<object>} Filtered result with only new orders and count of filtered orders
 */
async function filterAlreadyEmailedOrders(comparisonResult) {
  const emailedKeys = await getEmailedOrderKeys(comparisonResult);

  if (emailedKeys.size === 0) {
    // No orders with change tracking found - return everything
    return {
      filteredResult: comparisonResult,
      filteredCount: 0,
      newOrdersCount: getTotalOrderCount(comparisonResult)
    };
  }

  // Helper to check if order+change combo has been emailed before
  // Only checks against records that have changed_fields tracking
  const hasBeenEmailed = (order) => {
    const key = getOrderKey(order);
    const dateStr = formatDate(key.order_date);
    const fullKey = `${key.order_code}|${dateStr}|${key.plant_code}|${key.product_code}|${key.changed_fields}`;
    return emailedKeys.has(fullKey);
  };

  // Filter each category
  const filteredResult = {
    matched_orders: (comparisonResult.matched_orders || []).filter(o => !hasBeenEmailed(o)),
    mismatched_orders: (comparisonResult.mismatched_orders || []).filter(o => !hasBeenEmailed(o)),
    missing_in_system_orders: (comparisonResult.missing_in_system_orders || []).filter(o => !hasBeenEmailed(o)),
    new_in_system_orders: (comparisonResult.new_in_system_orders || []).filter(o => !hasBeenEmailed(o))
  };

  const originalCount = getTotalOrderCount(comparisonResult);
  const newCount = getTotalOrderCount(filteredResult);
  const filteredCount = originalCount - newCount;

  return {
    filteredResult,
    filteredCount,
    newOrdersCount: newCount
  };
}

/**
 * Get total count of orders in comparison result
 *
 * @param {object} comparisonResult - Comparison result
 * @returns {number} Total order count
 */
function getTotalOrderCount(comparisonResult) {
  return (
    (comparisonResult.matched_orders || []).length +
    (comparisonResult.mismatched_orders || []).length +
    (comparisonResult.missing_in_system_orders || []).length +
    (comparisonResult.new_in_system_orders || []).length
  );
}

/**
 * Record orders that were sent in an email
 * Updates the scraped_order_imports table's emailed_orders_json column
 *
 * @param {string} batchId - Batch ID
 * @param {object} emailedComparisonResult - Comparison result that was emailed
 * @returns {Promise<number>} Number of orders recorded
 */
async function recordEmailedOrders(batchId, emailedComparisonResult) {
  if (!process.env.DATABASE_URL) {
    return 0;
  }

  // Extract all orders that were emailed
  const emailedOrders = [];

  // Helper to extract order data including changed_fields for deduplication
  const extractOrders = (orderList) => {
    for (const order of (orderList || [])) {
      const key = getOrderKey(order);
      emailedOrders.push({
        order_code: key.order_code,
        order_date: formatDate(key.order_date),
        plant_code: key.plant_code,
        product_code: key.product_code,
        changed_fields: key.changed_fields  // Track which fields changed for this order
      });
    }
  };

  extractOrders(emailedComparisonResult.matched_orders);
  extractOrders(emailedComparisonResult.mismatched_orders);
  extractOrders(emailedComparisonResult.missing_in_system_orders);
  extractOrders(emailedComparisonResult.new_in_system_orders);

  if (emailedOrders.length === 0) {
    return 0;
  }

  // Update the batch record with the emailed orders JSON
  const sql = `
    UPDATE scraped_order_imports
    SET emailed_orders_json = $1::jsonb
    WHERE batch_id = $2::uuid
    RETURNING id, batch_id, emailed_orders_json
  `;

  const params = [JSON.stringify(emailedOrders), batchId];

  try {
    const result = await executeDirectSQL(sql, params);

    if (!result.success) {
      // If column doesn't exist, show warning
      if (result.error && (result.error.includes('does not exist') || result.error.includes('emailed_orders_json') || result.error.includes('column') && result.error.includes('emailed_orders'))) {
        console.log('⚠️  emailed_orders_json column does not exist - run: psql -d your_database -f ADD_COLUMN_NOW.sql');
        return 0;
      }
      console.error(`Failed to record emailed orders: ${result.error}`);
      return 0;
    }

    if (result.data && result.data.length > 0) {
      console.log(`  ✅ Recorded ${emailedOrders.length} orders in emailed_orders_json for batch ${batchId}`);
      return emailedOrders.length;
    } else {
      console.log(`  ⚠️  Batch ${batchId} not found - could not record emailed orders`);
      return 0;
    }

  } catch (error) {
    // If column doesn't exist, show warning
    if (error.message && (error.message.includes('does not exist') || error.message.includes('emailed_orders_json') || error.message.includes('column') && error.message.includes('emailed_orders'))) {
      console.log('⚠️  emailed_orders_json column does not exist - run: psql -d your_database -f ADD_COLUMN_NOW.sql');
      return 0;
    }

    console.error('Error recording emailed orders:', error.message);
    return 0;
  }
}

/**
 * Update comparison summary with filtered counts
 *
 * @param {object} originalSummary - Original comparison summary
 * @param {object} filteredResult - Filtered comparison result
 * @returns {object} Updated summary
 */
function updateSummaryWithFilteredCounts(originalSummary, filteredResult) {
  const matched_count = filteredResult.matched_orders.length;
  const mismatched_count = filteredResult.mismatched_orders.length;
  const missing_in_system_count = filteredResult.missing_in_system_orders.length;
  const new_in_system_count = filteredResult.new_in_system_orders.length;

  // Preserve the original totals from the scraper so they match the web app,
  // rather than recalculating from filtered (dedup) counts
  const total_external_orders = originalSummary.total_external_orders || 0;
  const total_system_orders = originalSummary.total_system_orders || 0;
  const match_percentage = total_external_orders > 0 ? ((matched_count / total_external_orders) * 100).toFixed(2) : '0.00';
  const mismatch_percentage = total_external_orders > 0 ? ((mismatched_count / total_external_orders) * 100).toFixed(2) : '0.00';

  return {
    ...originalSummary,
    matched_count,
    matchedCount: matched_count,
    mismatched_count,
    mismatchedCount: mismatched_count,
    missing_in_system_count,
    missingInSystemCount: missing_in_system_count,
    new_in_system_count,
    newInSystemCount: new_in_system_count,
    total_external_orders,
    totalExternalOrders: total_external_orders,
    total_system_orders,
    totalSystemOrders: total_system_orders,
    match_percentage: parseFloat(match_percentage),
    matchedPercentage: parseFloat(match_percentage),
    mismatched_percentage: parseFloat(mismatch_percentage),
    mismatchedPercentage: parseFloat(mismatch_percentage),
    // Explicitly preserve dashboard counts (from DB query matching web app)
    dashboard_total: originalSummary.dashboard_total,
    dashboard_active: originalSummary.dashboard_active,
    dashboard_cancelled: originalSummary.dashboard_cancelled
  };
}

module.exports = {
  filterAlreadyEmailedOrders,
  recordEmailedOrders,
  updateSummaryWithFilteredCounts
};
