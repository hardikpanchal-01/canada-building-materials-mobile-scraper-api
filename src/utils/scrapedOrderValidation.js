/**
 * Scraped Order Validation
 *
 * Validates and sanitizes incoming order data from scrapers.
 * Implements the validation rules defined in the API specification.
 */

// Valid status values
const VALID_STATUSES = [
  'Normal',
  'Hold',
  'Will Call',
  'Cancelled',
  'Completed',
  'Pending',
  'In Progress'
];

// Status value mappings (normalize variations)
// 'confirmed' and 'will call' are added for the Connex extension's lite flow:
// the Connex board shows "Confirmed" / "Will Call" badges, which map to the
// Command Cloud vocabulary the comparison understands (isStatusEquivalent).
const STATUS_MAPPINGS = {
  'normal': 'Normal',
  'confirmed': 'Normal',
  'hold': 'Hold',
  'will call': 'Will Call',
  'willcall': 'Will Call',
  'will_call': 'Will Call',
  'cancelled': 'Cancelled',
  'canceled': 'Cancelled',
  'completed': 'Completed',
  'complete': 'Completed',
  'pending': 'Pending',
  'in progress': 'In Progress',
  'inprogress': 'In Progress',
  'in_progress': 'In Progress'
};

/**
 * Validate the request payload structure
 *
 * @param {object} payload - Request body
 * @returns {object} Validation result with isValid flag and errors
 */
function validateRequestPayload(payload) {
  const errors = [];

  if (!payload) {
    errors.push({
      field: 'body',
      message: 'Request body is required',
      value: null
    });
    return { isValid: false, errors };
  }

  if (!payload.orders) {
    errors.push({
      field: 'orders',
      message: 'Orders array is required',
      value: null
    });
    return { isValid: false, errors };
  }

  if (!Array.isArray(payload.orders)) {
    errors.push({
      field: 'orders',
      message: 'Orders must be an array',
      value: typeof payload.orders
    });
    return { isValid: false, errors };
  }

  if (payload.orders.length === 0) {
    errors.push({
      field: 'orders',
      message: 'Orders array cannot be empty',
      value: []
    });
    return { isValid: false, errors };
  }

  return { isValid: true, errors: [] };
}

/**
 * Validate a single order object
 *
 * @param {object} order - Order object to validate
 * @param {number} rowIndex - Row index for error reporting (1-based)
 * @returns {object} Validation result with isValid, errors, and warnings
 */
function validateOrder(order, rowIndex) {
  const errors = [];
  const warnings = [];

  // Required field: order_code
  if (!order.order_code || String(order.order_code).trim() === '') {
    errors.push({
      row: rowIndex,
      field: 'order_code',
      message: 'Order code is required',
      value: order.order_code
    });
  }

  // Required field: order_date
  if (!order.order_date || String(order.order_date).trim() === '') {
    errors.push({
      row: rowIndex,
      field: 'order_date',
      message: 'Order date is required',
      value: order.order_date
    });
  } else {
    // Validate date format
    const dateValidation = validateDateFormat(order.order_date);
    if (!dateValidation.isValid) {
      errors.push({
        row: rowIndex,
        field: 'order_date',
        message: 'Invalid date format. Expected YYYY-MM-DD or MM/DD/YYYY',
        value: order.order_date
      });
    }
  }

  // Required field: customer_name
  if (!order.customer_name || String(order.customer_name).trim() === '') {
    errors.push({
      row: rowIndex,
      field: 'customer_name',
      message: 'Customer name is required',
      value: order.customer_name
    });
  }

  // Required field: product_code
  if (!order.product_code || String(order.product_code).trim() === '') {
    errors.push({
      row: rowIndex,
      field: 'product_code',
      message: 'Product code is required',
      value: order.product_code
    });
  }

  // Quantity validation (at least one quantity field required)
  const hasQty = order.qty !== undefined && order.qty !== null && order.qty !== '';
  const hasOrderedQty = order.ordered_qty !== undefined && order.ordered_qty !== null && order.ordered_qty !== '';
  const hasDeliveredQty = order.delivered_qty !== undefined && order.delivered_qty !== null && order.delivered_qty !== '';

  if (!hasQty && !hasOrderedQty) {
    errors.push({
      row: rowIndex,
      field: 'qty/ordered_qty',
      message: 'At least one quantity field (qty or ordered_qty) is required',
      value: null
    });
  }

  // Validate qty format if provided (can be "delivered/ordered" format)
  if (hasQty && typeof order.qty === 'string' && order.qty.includes('/')) {
    const parts = order.qty.split('/');
    if (parts.length !== 2 || isNaN(parseFloat(parts[0])) || isNaN(parseFloat(parts[1]))) {
      errors.push({
        row: rowIndex,
        field: 'qty',
        message: 'Invalid qty format. Expected number or "delivered/ordered" format',
        value: order.qty
      });
    }
  } else if (hasQty && isNaN(parseFloat(order.qty))) {
    errors.push({
      row: rowIndex,
      field: 'qty',
      message: 'Quantity must be a valid number',
      value: order.qty
    });
  }

  // Validate ordered_qty if provided
  if (hasOrderedQty && isNaN(parseFloat(order.ordered_qty))) {
    errors.push({
      row: rowIndex,
      field: 'ordered_qty',
      message: 'Ordered quantity must be a valid number',
      value: order.ordered_qty
    });
  }

  // Validate delivered_qty if provided
  if (hasDeliveredQty && isNaN(parseFloat(order.delivered_qty))) {
    errors.push({
      row: rowIndex,
      field: 'delivered_qty',
      message: 'Delivered quantity must be a valid number',
      value: order.delivered_qty
    });
  }

  // Optional field validation: start_time
  if (order.start_time) {
    const timeValidation = validateTimeFormat(order.start_time);
    if (!timeValidation.isValid) {
      warnings.push({
        row: rowIndex,
        field: 'start_time',
        message: 'Invalid time format. Expected HH:MM or HH:MM:SS',
        value: order.start_time
      });
    }
  }

  // Optional field validation: status
  if (order.status) {
    const normalizedStatus = normalizeStatus(order.status);
    if (!normalizedStatus) {
      warnings.push({
        row: rowIndex,
        field: 'status',
        message: `Unknown status value. Expected one of: ${VALID_STATUSES.join(', ')}`,
        value: order.status
      });
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate all orders in the array
 *
 * @param {array} orders - Array of order objects
 * @returns {object} Validation result with isValid, errors, warnings, and validCount
 */
function validateOrders(orders) {
  const allErrors = [];
  const allWarnings = [];
  let validCount = 0;

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const rowIndex = i + 1; // 1-based row index

    const result = validateOrder(order, rowIndex);

    if (result.isValid) {
      validCount++;
    }

    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  return {
    isValid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
    totalRows: orders.length,
    validRows: validCount,
    errorCount: allErrors.length,
    warningCount: allWarnings.length
  };
}

/**
 * Validate date format (YYYY-MM-DD or MM/DD/YYYY)
 *
 * @param {string} dateStr - Date string to validate
 * @returns {object} Validation result with isValid and normalized date
 */
function validateDateFormat(dateStr) {
  if (!dateStr) return { isValid: false, normalized: null };

  const str = String(dateStr).trim();

  // Check YYYY-MM-DD format
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    if (date.getFullYear() === parseInt(year) &&
        date.getMonth() === parseInt(month) - 1 &&
        date.getDate() === parseInt(day)) {
      return { isValid: true, normalized: str };
    }
  }

  // Check MM/DD/YYYY format
  const usMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    if (date.getFullYear() === parseInt(year) &&
        date.getMonth() === parseInt(month) - 1 &&
        date.getDate() === parseInt(day)) {
      // Normalize to YYYY-MM-DD
      const normalized = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      return { isValid: true, normalized };
    }
  }

  return { isValid: false, normalized: null };
}

/**
 * Validate time format (HH:MM or HH:MM:SS)
 *
 * @param {string} timeStr - Time string to validate
 * @returns {object} Validation result
 */
function validateTimeFormat(timeStr) {
  if (!timeStr) return { isValid: false };

  const str = String(timeStr).trim();

  // Check HH:MM format
  const shortMatch = str.match(/^(\d{1,2}):(\d{2})$/);
  if (shortMatch) {
    const [, hours, minutes] = shortMatch;
    if (parseInt(hours) >= 0 && parseInt(hours) <= 23 &&
        parseInt(minutes) >= 0 && parseInt(minutes) <= 59) {
      return { isValid: true };
    }
  }

  // Check HH:MM:SS format
  const longMatch = str.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (longMatch) {
    const [, hours, minutes, seconds] = longMatch;
    if (parseInt(hours) >= 0 && parseInt(hours) <= 23 &&
        parseInt(minutes) >= 0 && parseInt(minutes) <= 59 &&
        parseInt(seconds) >= 0 && parseInt(seconds) <= 59) {
      return { isValid: true };
    }
  }

  return { isValid: false };
}

/**
 * Normalize status value to standard format
 *
 * @param {string} status - Status value to normalize
 * @returns {string|null} Normalized status or null if invalid
 */
function normalizeStatus(status) {
  if (!status) return 'Normal'; // Default status

  const str = String(status).trim().toLowerCase();

  // Check direct match
  if (STATUS_MAPPINGS[str]) {
    return STATUS_MAPPINGS[str];
  }

  // Check if it's already a valid status (case-insensitive)
  const found = VALID_STATUSES.find(s => s.toLowerCase() === str);
  if (found) {
    return found;
  }

  return null;
}

/**
 * Normalize boolean value (handles Y/N, true/false, 1/0)
 *
 * @param {any} value - Value to normalize
 * @returns {boolean} Normalized boolean
 */
function normalizeBoolean(value) {
  if (value === undefined || value === null) return false;

  if (typeof value === 'boolean') return value;

  const str = String(value).trim().toLowerCase();

  if (['true', 'yes', 'y', '1'].includes(str)) {
    return true;
  }

  if (['false', 'no', 'n', '0', ''].includes(str)) {
    return false;
  }

  return Boolean(value);
}

/**
 * Parse quantity from various formats
 *
 * @param {any} value - Quantity value (number, string, or "delivered/ordered")
 * @returns {object} Parsed quantities { delivered, ordered }
 */
function parseQuantity(value) {
  if (value === undefined || value === null || value === '') {
    return { delivered: 0, ordered: 0 };
  }

  // Handle "delivered/ordered" format
  if (typeof value === 'string' && value.includes('/')) {
    const parts = value.split('/');
    return {
      delivered: parseFloat(parts[0]) || 0,
      ordered: parseFloat(parts[1]) || 0
    };
  }

  // Handle single number (treated as ordered quantity)
  const num = parseFloat(value);
  if (!isNaN(num)) {
    return { delivered: 0, ordered: num };
  }

  return { delivered: 0, ordered: 0 };
}

/**
 * Sanitize and normalize a single order
 *
 * @param {object} order - Raw order object
 * @returns {object} Sanitized order object
 */
function sanitizeOrder(order) {
  const sanitized = {};

  // Copy and trim string fields
  sanitized.order_code = String(order.order_code || '').trim();
  sanitized.customer_name = String(order.customer_name || '').trim();
  sanitized.product_code = String(order.product_code || '').trim();

  // Optional string fields
  if (order.plant_code) {
    sanitized.plant_code = String(order.plant_code).trim();
  }

  if (order.delivery_address) {
    sanitized.delivery_address = String(order.delivery_address).trim();
  }

  if (order.start_time) {
    sanitized.start_time = String(order.start_time).trim();
  }

  // Normalize date
  if (order.order_date) {
    const dateValidation = validateDateFormat(order.order_date);
    sanitized.order_date = dateValidation.normalized || String(order.order_date).trim();
  }

  // Normalize status
  sanitized.status = normalizeStatus(order.status) || 'Normal';

  // Handle quantities
  if (order.qty !== undefined && order.qty !== null) {
    const parsed = parseQuantity(order.qty);
    sanitized.delivered_qty = parsed.delivered;
    sanitized.ordered_qty = parsed.ordered;
  } else {
    sanitized.delivered_qty = parseFloat(order.delivered_qty) || 0;
    sanitized.ordered_qty = parseFloat(order.ordered_qty) || 0;
  }

  // Normalize boolean
  sanitized.has_notes = normalizeBoolean(order.has_notes);

  // Preserve any additional fields that might be useful
  if (order.notes) {
    sanitized.notes = String(order.notes).trim();
  }

  if (order.driver_name) {
    sanitized.driver_name = String(order.driver_name).trim();
  }

  if (order.truck_id) {
    sanitized.truck_id = String(order.truck_id).trim();
  }

  return sanitized;
}

/**
 * Validate and sanitize all orders, returning both results
 *
 * @param {array} orders - Array of raw order objects
 * @returns {object} Complete validation result with sanitized orders
 */
function validateAndSanitizeOrders(orders) {
  // First validate
  const validationResult = validateOrders(orders);

  // If there are errors, don't sanitize
  if (!validationResult.isValid) {
    return {
      isValid: false,
      errors: validationResult.errors,
      warnings: validationResult.warnings,
      validationSummary: {
        totalRows: validationResult.totalRows,
        validRows: validationResult.validRows,
        errorCount: validationResult.errorCount,
        warningCount: validationResult.warningCount
      },
      sanitizedOrders: []
    };
  }

  // Sanitize all orders
  const sanitizedOrders = orders.map(order => sanitizeOrder(order));

  // Calculate date range
  const dates = sanitizedOrders
    .map(o => o.order_date)
    .filter(d => d)
    .sort();

  const dateRange = dates.length > 0 ? {
    from: dates[0],
    to: dates[dates.length - 1]
  } : null;

  return {
    isValid: true,
    errors: [],
    warnings: validationResult.warnings,
    validationSummary: {
      totalRows: validationResult.totalRows,
      validRows: validationResult.validRows,
      errorCount: 0,
      warningCount: validationResult.warningCount,
      dateRange
    },
    sanitizedOrders
  };
}

/**
 * Validate a single order for the LITE flow (Connex extension).
 *
 * The browser extension can only reliably scrape order_code, order_date,
 * quantities and status. product_code / customer_name / delivery_address /
 * plant_code are NOT required here (the lite comparison ignores them).
 *
 * @param {object} order - Order object to validate
 * @param {number} rowIndex - Row index for error reporting (1-based)
 * @returns {object} Validation result with isValid, errors, and warnings
 */
function validateLiteOrder(order, rowIndex) {
  const errors = [];
  const warnings = [];

  // Required: order_code
  if (!order.order_code || String(order.order_code).trim() === '') {
    errors.push({ row: rowIndex, field: 'order_code', message: 'Order code is required', value: order.order_code });
  }

  // Required: order_date (must be a valid date — it is half of the match key)
  if (!order.order_date || String(order.order_date).trim() === '') {
    errors.push({ row: rowIndex, field: 'order_date', message: 'Order date is required', value: order.order_date });
  } else if (!validateDateFormat(order.order_date).isValid) {
    errors.push({ row: rowIndex, field: 'order_date', message: 'Invalid date format. Expected YYYY-MM-DD or MM/DD/YYYY', value: order.order_date });
  }

  // Quantity is OPTIONAL for the lite flow. Some Connex orders have no y³ chip
  // (placeholder / non-CY orders); those still match by order_code + order_date,
  // we just can't quantity-compare them — so warn instead of failing the batch.
  const hasQty = order.qty !== undefined && order.qty !== null && order.qty !== '';
  const hasOrderedQty = order.ordered_qty !== undefined && order.ordered_qty !== null && order.ordered_qty !== '';
  if (!hasQty && !hasOrderedQty) {
    warnings.push({ row: rowIndex, field: 'qty/ordered_qty', message: 'No quantity provided — quantity will not be compared for this order', value: null });
  }

  // Optional: status — warn (don't fail) on unknown values
  if (order.status && !normalizeStatus(order.status)) {
    warnings.push({ row: rowIndex, field: 'status', message: `Unknown status value. Expected one of: ${VALID_STATUSES.join(', ')}`, value: order.status });
  }

  return { isValid: errors.length === 0, errors, warnings };
}

/**
 * Validate and sanitize all orders for the LITE flow.
 * Reuses sanitizeOrder() so the output shape matches the full flow
 * (absent product_code/customer_name become empty strings, which the lite
 * comparison treats as "not compared").
 *
 * @param {array} orders - Array of raw order objects
 * @returns {object} Validation result with sanitized orders
 */
function validateAndSanitizeLiteOrders(orders) {
  const allErrors = [];
  const allWarnings = [];
  let validCount = 0;

  for (let i = 0; i < orders.length; i++) {
    const result = validateLiteOrder(orders[i], i + 1);
    if (result.isValid) validCount++;
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  if (allErrors.length > 0) {
    return {
      isValid: false,
      errors: allErrors,
      warnings: allWarnings,
      validationSummary: {
        totalRows: orders.length,
        validRows: validCount,
        errorCount: allErrors.length,
        warningCount: allWarnings.length
      },
      sanitizedOrders: []
    };
  }

  const sanitizedOrders = orders.map((order) => {
    const s = sanitizeOrder(order);
    // sanitizeOrder defaults missing quantities to 0; for the lite flow keep them
    // null so the comparison knows to SKIP qty (vs. treating 0 as a real value).
    const hasQty = order.qty !== undefined && order.qty !== null && order.qty !== '';
    const hasOrderedQty = order.ordered_qty !== undefined && order.ordered_qty !== null && order.ordered_qty !== '';
    if (!hasQty && !hasOrderedQty) {
      s.ordered_qty = null;
      s.delivered_qty = null;
    }
    return s;
  });

  const dates = sanitizedOrders.map(o => o.order_date).filter(Boolean).sort();
  const dateRange = dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : null;

  return {
    isValid: true,
    errors: [],
    warnings: allWarnings,
    validationSummary: {
      totalRows: orders.length,
      validRows: validCount,
      errorCount: 0,
      warningCount: allWarnings.length,
      dateRange
    },
    sanitizedOrders
  };
}

module.exports = {
  validateRequestPayload,
  validateOrder,
  validateOrders,
  validateDateFormat,
  validateTimeFormat,
  normalizeStatus,
  normalizeBoolean,
  parseQuantity,
  sanitizeOrder,
  validateAndSanitizeOrders,
  validateLiteOrder,
  validateAndSanitizeLiteOrders
};


