/**
 * Exclusion Pattern Service
 *
 * Fetches exclusion patterns from database and filters orders
 * before sending comparison email.
 *
 * Supported pattern types:
 * - 'product' -> matches against product_code field
 * - 'customer' -> matches against customer_name field
 * - 'delivery_address' -> matches against delivery_address field
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');

// In-memory cache for the active exclusion patterns (5-minute TTL).
let _cachedPatterns = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Match web RPC get_orders_summary post-2026-05-11: load every active pattern,
// ignoring the affects_counts flag. List views and count endpoints share the
// same source set so mobile and web stay aligned.
async function fetchExclusionPatterns() {
  const now = Date.now();
  if (_cachedPatterns !== null && (now - _cacheTimestamp) < CACHE_TTL_MS) {
    return _cachedPatterns;
  }

  const sql = `
    SELECT type, pattern
    FROM excluded_order_patterns
    WHERE active = true
  `;

  try {
    const result = await executeDirectSQL(sql, []);
    if (!result.success) {
      console.error('Failed to fetch exclusion patterns:', result.error);
      return _cachedPatterns || [];
    }
    _cachedPatterns = result.data || [];
    _cacheTimestamp = now;
    return _cachedPatterns;
  } catch (error) {
    console.error('Error fetching exclusion patterns:', error.message);
    return _cachedPatterns || [];
  }
}

/**
 * Normalize string for comparison (trim whitespace, handle null/undefined)
 *
 * @param {string} value - Value to normalize
 * @returns {string} Normalized string
 */
function normalizeValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

/**
 * Check if an order should be excluded based on patterns
 *
 * @param {object} order - Order object to check
 * @param {array} patterns - Array of exclusion patterns
 * @returns {boolean} True if order should be excluded
 */
function isOrderExcluded(order, patterns) {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  // Get order field values (handle both external and system order structures)
  const productCode = normalizeValue(
    order.product_code || order.external_order?.product_code || order.system_order?.product_code
  );
  const customerName = normalizeValue(
    order.customer_name || order.external_order?.customer_name || order.system_order?.customer_name
  );
  const deliveryAddress = normalizeValue(
    order.delivery_address || order.external_order?.delivery_address || order.system_order?.delivery_address
  );

  for (const pattern of patterns) {
    const normalizedPattern = normalizeValue(pattern.pattern).toLowerCase();
    if (!normalizedPattern) continue;

    switch (pattern.type) {
      case 'product':
        if (productCode.toLowerCase().includes(normalizedPattern)) {
          return true;
        }
        break;

      case 'customer':
        // Apply all customer patterns — matches web frontend filterExcludedOrders
        // (src/lib/order-filters.ts) so mobile and web counts align.
        if (customerName.toLowerCase().includes(normalizedPattern)) {
          return true;
        }
        break;

      case 'delivery_address':
        if (deliveryAddress.toLowerCase().includes(normalizedPattern)) {
          return true;
        }
        break;
    }
  }

  return false;
}

/**
 * Filter excluded orders from comparison results
 *
 * @param {object} comparisonResult - Full comparison result
 * @param {array} patterns - Array of exclusion patterns
 * @returns {object} { filteredResult, excludedCount, excludedOrders }
 */
function filterExcludedOrders(comparisonResult, patterns) {
  if (!patterns || patterns.length === 0) {
    return {
      filteredResult: comparisonResult,
      excludedCount: 0,
      excludedOrders: []
    };
  }

  const excludedOrders = [];
  let excludedFromMatched = 0;
  let excludedFromMismatched = 0;
  let excludedFromMissing = 0;
  let excludedFromNew = 0;

  // Filter matched orders
  const filteredMatched = (comparisonResult.fullResult.matched_orders || []).filter(order => {
    if (isOrderExcluded(order, patterns)) {
      excludedOrders.push({ ...order, excluded_from: 'matched' });
      excludedFromMatched++;
      return false;
    }
    return true;
  });

  // Filter mismatched orders
  const filteredMismatched = (comparisonResult.fullResult.mismatched_orders || []).filter(order => {
    if (isOrderExcluded(order, patterns)) {
      excludedOrders.push({ ...order, excluded_from: 'mismatched' });
      excludedFromMismatched++;
      return false;
    }
    return true;
  });

  // Filter missing in system orders
  const filteredMissing = (comparisonResult.fullResult.missing_in_system_orders || []).filter(order => {
    if (isOrderExcluded(order, patterns)) {
      excludedOrders.push({ ...order, excluded_from: 'missing_in_system' });
      excludedFromMissing++;
      return false;
    }
    return true;
  });

  // Filter new in system orders
  const filteredNew = (comparisonResult.fullResult.new_in_system_orders || []).filter(order => {
    if (isOrderExcluded(order, patterns)) {
      excludedOrders.push({ ...order, excluded_from: 'new_in_system' });
      excludedFromNew++;
      return false;
    }
    return true;
  });

  const totalExcluded = excludedOrders.length;

  if (totalExcluded > 0) {
    console.log(`Excluded ${totalExcluded} orders from email`);
  }

  // Combine pattern-based exclusions with no-CY-mix exclusions from comparison step
  const noCyMixExcluded = comparisonResult.summary.no_cy_mix_excluded_count || 0;
  const combinedExcludedCount = totalExcluded + noCyMixExcluded;

  // Create filtered result with updated counts
  const filteredResult = {
    summary: {
      ...comparisonResult.summary,
      matched_count: filteredMatched.length,
      matchedCount: filteredMatched.length,
      mismatched_count: filteredMismatched.length,
      mismatchedCount: filteredMismatched.length,
      missing_in_system_count: filteredMissing.length,
      missingInSystemCount: filteredMissing.length,
      new_in_system_count: filteredNew.length,
      newInSystemCount: filteredNew.length,
      excluded_count: combinedExcludedCount,
      excludedCount: combinedExcludedCount
    },
    fullResult: {
      matched_orders: filteredMatched,
      mismatched_orders: filteredMismatched,
      missing_in_system_orders: filteredMissing,
      excluded_no_cy_mix_orders: comparisonResult.fullResult.excluded_no_cy_mix_orders || [],
      new_in_system_orders: filteredNew
    }
  };

  // Recalculate percentages
  const totalExternal = comparisonResult.summary.total_external_orders || 0;
  if (totalExternal > 0) {
    filteredResult.summary.matched_percentage = parseFloat(((filteredMatched.length / totalExternal) * 100).toFixed(2));
    filteredResult.summary.matchedPercentage = filteredResult.summary.matched_percentage;
    filteredResult.summary.mismatched_percentage = parseFloat(((filteredMismatched.length / totalExternal) * 100).toFixed(2));
    filteredResult.summary.mismatchedPercentage = filteredResult.summary.mismatched_percentage;
  }

  return {
    filteredResult,
    excludedCount: totalExcluded,
    excludedOrders
  };
}

module.exports = {
  fetchExclusionPatterns,
  isOrderExcluded,
  filterExcludedOrders
};
