/**
 * Revalidated Order Update Service
 *
 * After re-validation via Command Cloud API, this service updates confirmed mismatched
 * orders in the Truckast database:
 * - Confirmed orders: API differs from Truckast (update Truckast to match API value)
 * - Resolved orders: API matches Truckast (no update needed, DB already correct)
 * This ensures Truckast DB stays in sync with Command Cloud as the source of truth.
 *
 * Field-to-table mapping:
 *   orders table:        customer_name, delivery_addr1, current_status, removed
 *   order_products:      item_code, order_qty (ordered_qty), delv_qty (delivered_qty)
 *   order_product_schedules: start_time, plant_code
 */

const { executeDirectSQL } = require('../../utils/postgresExecutor');
const { fetchSystemOrders, buildSystemOrdersMap, getOrderStatusCategory } = require('../orderComparisonService');

// Status name to numeric code mapping (inverse of comparison service)
const STATUS_NAME_TO_CODE = {
  'cancelled': 0,
  'canceled': 0,
  'normal': 1,
  'hold': 2,
  'hold delivery': 2,
  'will call': 3,
  'completed': 4,
  'weather permitting': 5
};

/**
 * Extract resolved orders from re-validation results
 *
 * @param {object} revalidationResults - Results from revalidateMismatchedOrders()
 * @returns {array} Array of resolved order objects with their resolved fields
 */
function extractResolvedOrders(revalidationResults) {
  if (!revalidationResults || !revalidationResults.orders) {
    return [];
  }

  return revalidationResults.orders.filter(order => order.order_status === 'resolved');
}

/**
 * Extract ALL revalidated orders that have fresh API data (both resolved and confirmed).
 * Confirmed orders need Truckast DB updated to match the API value.
 *
 * @param {object} revalidationResults - Results from revalidateMismatchedOrders()
 * @returns {array} Array of order objects with fresh data
 */
function extractOrdersWithFreshData(revalidationResults) {
  if (!revalidationResults || !revalidationResults.orders) {
    return [];
  }

  return revalidationResults.orders.filter(order => order.fresh_data_found !== false);
}

/**
 * Build update operations from revalidated orders
 * Groups updates by table (orders, order_products, order_product_schedules)
 * - Resolved diffs: API matches Truckast, update with scraped_value
 * - Confirmed diffs: API differs from Truckast, update with fresh_system_value (API value)
 *
 * @param {array} orders - Array of revalidated order objects
 * @returns {object} { orderUpdates, productUpdates, scheduleUpdates }
 */
function buildUpdateOperations(orders) {
  const orderUpdates = [];     // updates for `orders` table
  const productUpdates = [];   // updates for `order_products` table
  const scheduleUpdates = [];  // updates for `order_product_schedules` table

  for (const order of orders) {
    const { order_code, order_date } = order;
    if (!order_code || !order_date) continue;

    // Only update confirmed diffs (API differs from Truckast → update Truckast to match API)
    // Resolved diffs are skipped: API matches Truckast, so DB already has the correct value
    const updatableFields = (order.differences || []).filter(
      d => d.revalidation_status === 'confirmed'
    );

    if (updatableFields.length === 0) continue;

    // Categorize fields by target table
    const orderTableFields = {};
    const productTableFields = {};
    const scheduleTableFields = {};

    for (const diff of updatableFields) {
      // For confirmed diffs, use the fresh API value (source of truth)
      const updateValue = diff.fresh_system_value;

      switch (diff.field) {
        case 'customer_name':
          orderTableFields.customer_name = updateValue;
          break;
        case 'delivery_address':
          // delivery_address is stored across 3 columns in orders table.
          // The API returns DeliveryAddr1/2/3 separately but we receive the
          // combined value here. Split it back: first part → addr1, second → addr2,
          // remainder → addr3. If fewer parts, clear the unused columns so stale
          // data from old addr2/addr3 doesn't persist.
          {
            const addrParts = updateValue ? updateValue.split(',').map(p => p.trim()) : [''];
            orderTableFields.delivery_addr1 = addrParts[0] || '';
            orderTableFields.delivery_addr2 = addrParts[1] || '';
            orderTableFields.delivery_addr3 = addrParts.slice(2).join(', ') || '';
          }
          break;
        case 'status':
          // Convert status name to numeric code
          const statusStr = updateValue ? String(updateValue).trim().toLowerCase() : 'normal';
          orderTableFields.current_status = STATUS_NAME_TO_CODE[statusStr] ?? 1;
          break;
        case 'ordered_qty':
          productTableFields.order_qty = updateValue != null ? parseFloat(updateValue) : null;
          break;
        case 'delivered_qty':
          productTableFields.delv_qty = updateValue != null ? parseFloat(updateValue) : null;
          break;
        case 'product_code':
          productTableFields.item_code = updateValue;
          break;
        case 'start_time':
          // start_time column is `timestamp with time zone`, so we must combine
          // the order_date with the HH:MM time string to build a full timestamp.
          // e.g. order_date="2026-03-18", updateValue="12:00" → "2026-03-18 12:00:00"
          if (updateValue && /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(updateValue).trim())) {
            const timeStr = String(updateValue).trim();
            const timePart = timeStr.includes(':') && timeStr.split(':').length === 2
              ? `${timeStr}:00` : timeStr;
            scheduleTableFields.start_time = `${order_date} ${timePart}`;
          } else {
            scheduleTableFields.start_time = updateValue;
          }
          break;
        case 'plant_code':
          scheduleTableFields.plant_code = updateValue;
          break;
        // has_notes is read-only (derived from order_notes table), skip
      }
    }

    if (Object.keys(orderTableFields).length > 0) {
      orderUpdates.push({ order_code, order_date, fields: orderTableFields });
    }
    if (Object.keys(productTableFields).length > 0) {
      productUpdates.push({ order_code, order_date, fields: productTableFields, product_code: order.product_code });
    }
    if (Object.keys(scheduleTableFields).length > 0) {
      scheduleUpdates.push({ order_code, order_date, fields: scheduleTableFields, product_code: order.product_code });
    }
  }

  return { orderUpdates, productUpdates, scheduleUpdates };
}

/**
 * Bulk update resolved fields in the orders table
 *
 * @param {array} updates - Array of { order_code, order_date, fields }
 * @returns {Promise<number>} Number of orders updated
 */
async function bulkUpdateOrders(updates) {
  if (updates.length === 0) return 0;

  let totalUpdated = 0;

  for (const update of updates) {
    const { order_code, order_date, fields } = update;
    const columns = Object.keys(fields);
    if (columns.length === 0) continue;

    // Build SET clause dynamically
    const setClauses = columns.map((col, idx) => `${col} = $${idx + 3}`);
    const values = columns.map(col => fields[col]);

    const sql = `
      UPDATE orders
      SET ${setClauses.join(', ')}
      WHERE UPPER(TRIM(order_code)) = UPPER(TRIM($1))
        AND order_date >= $2::date
        AND order_date < ($2::date + INTERVAL '1 day')
      RETURNING order_id
    `;

    const params = [order_code, order_date, ...values];

    try {
      const result = await executeDirectSQL(sql, params);
      if (result.success && result.data && result.data.length > 0) {
        totalUpdated += result.data.length;
        const updatedIds = result.data.map(r => r.order_id).join(', ');
        console.log(`      ✅ [orders] Updated order ${order_code} (${order_date}) → order_id(s): ${updatedIds} | fields: ${JSON.stringify(fields)}`);
      } else {
        console.warn(`      ⚠️ [orders] No rows matched for order ${order_code} (${order_date})`);
      }
    } catch (error) {
      console.error(`      ❌ [orders] Failed to update order ${order_code} (${order_date}):`, error.message);
    }
  }

  return totalUpdated;
}

/**
 * Bulk update resolved fields in the order_products table
 *
 * @param {array} updates - Array of { order_code, order_date, fields, product_code }
 * @returns {Promise<number>} Number of products updated
 */
async function bulkUpdateOrderProducts(updates) {
  if (updates.length === 0) return 0;

  let totalUpdated = 0;

  for (const update of updates) {
    const { order_code, order_date, fields, product_code } = update;
    const columns = Object.keys(fields);
    if (columns.length === 0) continue;

    // Build SET clause dynamically
    const setClauses = columns.map((col, idx) => `${col} = $${idx + 3}`);
    const values = columns.map(col => fields[col]);

    // Update order_products matching order + product code (CY mix products)
    let sql;
    let params;

    if (product_code) {
      sql = `
        UPDATE order_products op
        SET ${setClauses.join(', ')}
        FROM orders o
        WHERE o.order_id = op.order_id
          AND UPPER(TRIM(o.order_code)) = UPPER(TRIM($1))
          AND o.order_date >= $2::date
          AND o.order_date < ($2::date + INTERVAL '1 day')
          AND UPPER(TRIM(op.item_code)) LIKE UPPER(TRIM($${values.length + 3})) || '%'
          AND UPPER(op.order_qty_unit) = 'YDQ'
          AND op.is_mix = true
        RETURNING op.id
      `;
      params = [order_code, order_date, ...values, product_code];
    } else {
      // No product_code filter - update first CY mix product
      sql = `
        UPDATE order_products op
        SET ${setClauses.join(', ')}
        FROM orders o
        WHERE o.order_id = op.order_id
          AND UPPER(TRIM(o.order_code)) = UPPER(TRIM($1))
          AND o.order_date >= $2::date
          AND o.order_date < ($2::date + INTERVAL '1 day')
          AND UPPER(op.order_qty_unit) = 'YDQ'
          AND op.is_mix = true
        RETURNING op.id
      `;
      params = [order_code, order_date, ...values];
    }

    try {
      const result = await executeDirectSQL(sql, params);
      if (result.success && result.data && result.data.length > 0) {
        totalUpdated += result.data.length;
        const updatedIds = result.data.map(r => r.id).join(', ');
        console.log(`      ✅ [order_products] Updated for order ${order_code} (${order_date}) → product_id(s): ${updatedIds} | fields: ${JSON.stringify(fields)}`);
      } else {
        console.warn(`      ⚠️ [order_products] No rows matched for order ${order_code} (${order_date}), product: ${product_code || 'any CY mix'}`);
      }
    } catch (error) {
      console.error(`      ❌ [order_products] Failed for order ${order_code} (${order_date}):`, error.message);
    }
  }

  return totalUpdated;
}

/**
 * Bulk update resolved fields in the order_product_schedules table
 *
 * @param {array} updates - Array of { order_code, order_date, fields, product_code }
 * @returns {Promise<number>} Number of schedules updated
 */
async function bulkUpdateOrderSchedules(updates) {
  if (updates.length === 0) return 0;

  let totalUpdated = 0;

  for (const update of updates) {
    const { order_code, order_date, fields, product_code } = update;
    const columns = Object.keys(fields);
    if (columns.length === 0) continue;

    // Build SET clause dynamically
    const setClauses = columns.map((col, idx) => `${col} = $${idx + 3}`);
    const values = columns.map(col => fields[col]);

    // Update schedules for matching order + product
    let sql;
    let params;

    if (product_code) {
      sql = `
        UPDATE order_product_schedules ops
        SET ${setClauses.join(', ')}
        FROM order_products op
        JOIN orders o ON o.order_id = op.order_id
        WHERE ops.order_product_id = op.id
          AND UPPER(TRIM(o.order_code)) = UPPER(TRIM($1))
          AND o.order_date >= $2::date
          AND o.order_date < ($2::date + INTERVAL '1 day')
          AND UPPER(TRIM(op.item_code)) LIKE UPPER(TRIM($${values.length + 3})) || '%'
          AND UPPER(op.order_qty_unit) = 'YDQ'
          AND op.is_mix = true
        RETURNING ops.id
      `;
      params = [order_code, order_date, ...values, product_code];
    } else {
      sql = `
        UPDATE order_product_schedules ops
        SET ${setClauses.join(', ')}
        FROM order_products op
        JOIN orders o ON o.order_id = op.order_id
        WHERE ops.order_product_id = op.id
          AND UPPER(TRIM(o.order_code)) = UPPER(TRIM($1))
          AND o.order_date >= $2::date
          AND o.order_date < ($2::date + INTERVAL '1 day')
          AND UPPER(op.order_qty_unit) = 'YDQ'
          AND op.is_mix = true
        RETURNING ops.id
      `;
      params = [order_code, order_date, ...values];
    }

    try {
      const result = await executeDirectSQL(sql, params);
      if (result.success && result.data && result.data.length > 0) {
        totalUpdated += result.data.length;
        const updatedIds = result.data.map(r => r.id).join(', ');
        console.log(`      ✅ [order_schedules] Updated for order ${order_code} (${order_date}) → schedule_id(s): ${updatedIds} | fields: ${JSON.stringify(fields)}`);
      } else {
        console.warn(`      ⚠️ [order_schedules] No rows matched for order ${order_code} (${order_date}), product: ${product_code || 'any CY mix'}`);
      }
    } catch (error) {
      console.error(`      ❌ [order_schedules] Failed for order ${order_code} (${order_date}):`, error.message);
    }
  }

  return totalUpdated;
}

/**
 * Update resolved orders in Truckast database
 *
 * Takes re-validation results, extracts resolved orders, and bulk-updates
 * the corresponding fields in the database so future comparisons won't
 * flag these orders as mismatched.
 *
 * @param {object} revalidationResults - Results from revalidateMismatchedOrders()
 * @returns {Promise<object>} Update summary
 */
async function updateResolvedOrdersInDatabase(revalidationResults) {
  // Update confirmed mismatched orders with fresh API data
  // - Confirmed: API differs from Truckast (update Truckast to match API value)
  // - Resolved: API matches Truckast (skipped, DB already correct)
  const ordersToUpdate = extractOrdersWithFreshData(revalidationResults);

  if (ordersToUpdate.length === 0) {
    return {
      resolved_count: 0,
      orders_updated: 0,
      products_updated: 0,
      schedules_updated: 0
    };
  }

  const resolvedCount = ordersToUpdate.filter(o => o.order_status === 'resolved').length;
  const confirmedCount = ordersToUpdate.filter(o => o.order_status === 'confirmed').length;
  console.log(`\n📝 Updating ${ordersToUpdate.length} revalidated order(s) in Truckast database (${resolvedCount} resolved, ${confirmedCount} confirmed)...`);

  // Log each order with its fields BEFORE updating
  for (const order of ordersToUpdate) {
    const confirmedFields = (order.differences || []).filter(d => d.revalidation_status === 'confirmed');
    const resolvedFields = (order.differences || []).filter(d => d.revalidation_status === 'resolved');
    console.log(`\n   🔧 Order ${order.order_code} (${order.order_date}) [${order.order_status}] - ${confirmedFields.length} confirmed field(s) to update, ${resolvedFields.length} resolved field(s) skipped:`);
    for (const diff of confirmedFields) {
      console.log(`      • ${diff.field} [confirmed]: DB was="${diff.initial_system_value}" → updating to="${diff.fresh_system_value}" (API="${diff.fresh_system_value}")`);
    }
    for (const diff of resolvedFields) {
      console.log(`      • ${diff.field} [resolved]: DB="${diff.initial_system_value}" matches API="${diff.fresh_system_value}" — no update needed`);
    }
  }

  // Build update operations grouped by table
  const { orderUpdates, productUpdates, scheduleUpdates } = buildUpdateOperations(ordersToUpdate);

  console.log(`\n   Orders table: ${orderUpdates.length} update(s)`);
  console.log(`   Order products table: ${productUpdates.length} update(s)`);
  console.log(`   Order schedules table: ${scheduleUpdates.length} update(s)`);

  // Execute updates
  const ordersUpdated = await bulkUpdateOrders(orderUpdates);
  const productsUpdated = await bulkUpdateOrderProducts(productUpdates);
  const schedulesUpdated = await bulkUpdateOrderSchedules(scheduleUpdates);

  const summary = {
    resolved_count: ordersToUpdate.length,
    orders_updated: ordersUpdated,
    products_updated: productsUpdated,
    schedules_updated: schedulesUpdated
  };

  console.log(`\n✅ Revalidated order updates complete: ${ordersUpdated} orders, ${productsUpdated} products, ${schedulesUpdated} schedules`);

  return summary;
}

/**
 * Re-fetch ALL revalidated orders from Truckast DB after resolved orders have been
 * updated, and attach `after_update_system_value` to each difference.
 *
 * This allows the email to show a 4th line ("After Truckast Updated") on the
 * confirmed/mismatched orders that are actually displayed in the email table,
 * showing the current DB state after resolved orders were updated.
 *
 * @param {object} revalidationResults - Results from revalidateMismatchedOrders()
 * @returns {Promise<object>} Same revalidationResults with after_update_system_value attached
 */
async function attachAfterUpdateValues(revalidationResults) {
  if (!revalidationResults || !revalidationResults.orders || revalidationResults.orders.length === 0) {
    return revalidationResults;
  }

  const allOrders = revalidationResults.orders;

  // Collect order codes and date range from ALL revalidated orders
  const orderCodes = allOrders.map(o => o.order_code);
  const dates = allOrders.map(o => o.order_date).filter(Boolean);
  const minDate = dates.length > 0 ? dates.sort()[0] : null;
  const maxDate = dates.length > 0 ? dates.sort()[dates.length - 1] : null;

  if (!minDate || !maxDate) {
    console.warn('⚠️ Could not determine date range for re-fetch — skipping after-update values');
    return revalidationResults;
  }

  console.log(`\n🔍 Re-fetching ${orderCodes.length} revalidated order(s) from Truckast DB after update...`);

  try {
    const systemOrderRows = await fetchSystemOrders(orderCodes, minDate, maxDate);
    const systemOrdersMap = buildSystemOrdersMap(systemOrderRows);

    for (const order of allOrders) {
      // Build match key the same way as buildSystemOrdersMap
      const orderCode = String(order.order_code).trim().toUpperCase();
      // Normalize date
      let normalizedDate = order.order_date;
      if (normalizedDate instanceof Date) {
        const year = normalizedDate.getUTCFullYear();
        const month = String(normalizedDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(normalizedDate.getUTCDate()).padStart(2, '0');
        normalizedDate = `${year}-${month}-${day}`;
      }
      const matchKey = `${orderCode}_${normalizedDate}`;
      const updatedSystemOrder = systemOrdersMap.get(matchKey);

      if (!updatedSystemOrder) {
        console.warn(`  ⚠️ Could not re-fetch order ${order.order_code} (${order.order_date}) after update`);
        continue;
      }

      // Compute the status category for the updated order
      const statusCategory = updatedSystemOrder.status_category || getOrderStatusCategory(updatedSystemOrder);

      // Attach after_update_system_value to ALL differences (not just resolved)
      for (const diff of (order.differences || [])) {
        switch (diff.field) {
          case 'customer_name':
            diff.after_update_system_value = updatedSystemOrder.customer_name;
            break;
          case 'delivery_address':
            diff.after_update_system_value = updatedSystemOrder.delivery_address;
            break;
          case 'product_code':
            diff.after_update_system_value = updatedSystemOrder.product_code;
            break;
          case 'ordered_qty':
            diff.after_update_system_value = updatedSystemOrder.ordered_qty;
            break;
          case 'delivered_qty':
            diff.after_update_system_value = updatedSystemOrder.delivered_qty;
            break;
          case 'start_time':
            diff.after_update_system_value = updatedSystemOrder.start_time;
            break;
          case 'plant_code':
            diff.after_update_system_value = updatedSystemOrder.plant_code;
            break;
          case 'status':
            diff.after_update_system_value = statusCategory;
            break;
          case 'cancelled':
            diff.after_update_system_value = updatedSystemOrder.removed;
            break;
          default:
            diff.after_update_system_value = null;
        }
      }

      console.log(`  ✅ Attached after-update values for order ${order.order_code} (${order.order_status})`);
    }
  } catch (error) {
    console.error(`  ❌ Failed to re-fetch orders after update: ${error.message}`);
    // Non-fatal — email will just not show the 4th line for these orders
  }

  return revalidationResults;
}

/**
 * Transform a Command Cloud API boolean value to PostgreSQL boolean.
 * Command Cloud returns 'true'/'false' strings or actual booleans.
 *
 * @param {*} value - The value to transform
 * @returns {boolean} PostgreSQL-compatible boolean
 */
function transformBoolean(value) {
  if (value === true || value === '1') return true;
  if (typeof value === 'string' && value.toLowerCase() === 'true') return true;
  return false;
}

/**
 * Insert resolved missing orders into the Truckast database.
 *
 * For each missing order that was found in the Command Cloud API, inserts the order
 * along with its products and schedules into the orders, order_products, and
 * order_product_schedules tables. Uses ON CONFLICT DO UPDATE (upsert) to handle
 * edge cases where the order may already partially exist.
 *
 * @param {object} missingRevalidationResults - Results from revalidateMissingOrders()
 * @returns {Promise<object>} Insert summary
 */
async function insertResolvedMissingOrdersInDatabase(missingRevalidationResults) {
  if (!missingRevalidationResults || !missingRevalidationResults.orders) {
    return { orders_inserted: 0, products_inserted: 0, schedules_inserted: 0 };
  }

  const resolvedOrders = missingRevalidationResults.orders.filter(
    o => o.revalidation_status === 'resolved' && o.raw_api_order
  );

  if (resolvedOrders.length === 0) {
    return { orders_inserted: 0, products_inserted: 0, schedules_inserted: 0 };
  }

  console.log(`\n📝 Inserting ${resolvedOrders.length} resolved missing order(s) into Truckast database...`);

  let totalOrdersInserted = 0;
  let totalProductsInserted = 0;
  let totalSchedulesInserted = 0;

  for (const order of resolvedOrders) {
    const raw = order.raw_api_order;
    const orderId = raw.OrderID;

    if (!orderId) {
      console.warn(`  ⚠️ Skipping order ${order.order_code} - no OrderID in API response`);
      continue;
    }

    console.log(`\n   🔧 Inserting order ${order.order_code} (OrderID: ${orderId})...`);

    // Step 1: Insert into orders table
    try {
      const orderSql = `
        INSERT INTO orders (
          order_id, created_date, order_date, update_time, order_code, order_type,
          order_type_description, customer_id, customer_code, customer_name,
          customer_job, payment_form, project_id, project_code, project_name,
          lot_block_number, purchase_order, job_number,
          delivery_addr1, delivery_addr2, delivery_addr3,
          instruction_addr1, instruction_addr2, instruction_addr3,
          instruction_addr4, instruction_addr5, instruction_addr6,
          map_page, zone_code, zone_name,
          current_status, removed, remove_reason_code,
          hauler_code, hauler_name, price_category_code, price_category_name,
          pricing_plant_code, tax_code, taxable,
          taken_by_employee_id, taken_by_employee_code,
          ordered_by_name, ordered_by_phone, recipient_email,
          salesman_id, salesman_code, salesman_name,
          latitude, longitude, usage_code, usage_short,
          removed_by, confirmed_by, reviewed
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18,
          $19, $20, $21,
          $22, $23, $24,
          $25, $26, $27,
          $28, $29, $30,
          $31, $32, $33,
          $34, $35, $36, $37,
          $38, $39, $40,
          $41, $42,
          $43, $44, $45,
          $46, $47, $48,
          $49, $50, $51, $52,
          $53, $54, $55
        )
        ON CONFLICT (order_id) DO UPDATE SET
          customer_name = EXCLUDED.customer_name,
          delivery_addr1 = EXCLUDED.delivery_addr1,
          delivery_addr2 = EXCLUDED.delivery_addr2,
          delivery_addr3 = EXCLUDED.delivery_addr3,
          current_status = EXCLUDED.current_status,
          removed = EXCLUDED.removed,
          remove_reason_code = EXCLUDED.remove_reason_code,
          update_time = EXCLUDED.update_time
        RETURNING order_id
      `;

      const orderParams = [
        orderId,                                          // $1 order_id
        raw.CreatedDate || new Date().toISOString(),      // $2 created_date (NOT NULL)
        raw.OrderDate || new Date().toISOString(),        // $3 order_date (NOT NULL)
        raw.UpdateTime || new Date().toISOString(),       // $4 update_time (NOT NULL)
        raw.OrderCode || order.order_code || '',          // $5 order_code (NOT NULL)
        raw.OrderType != null ? parseInt(raw.OrderType) : 0, // $6 order_type (NOT NULL, default 0)
        raw.OrderTypeDescription || '',                   // $7 order_type_description (NOT NULL)
        raw.CustomerID || 0,                              // $8 customer_id (NOT NULL)
        raw.CustomerCode || '',                           // $9 customer_code (NOT NULL)
        raw.CustomerName || order.customer_name || '',    // $10 customer_name (NOT NULL)
        raw.CustomerJob || null,                          // $11 customer_job
        raw.PaymentForm || null,                          // $12 payment_form
        raw.ProjectID || null,                            // $13 project_id
        raw.ProjectCode || null,                          // $14 project_code
        raw.ProjectName || null,                          // $15 project_name
        raw.LotBlockNumber || null,                       // $16 lot_block_number
        raw.PurchaseOrder || null,                        // $17 purchase_order
        raw.JobNumber || null,                            // $18 job_number
        raw.DeliveryAddr1 || null,                        // $19 delivery_addr1
        raw.DeliveryAddr2 || null,                        // $20 delivery_addr2
        raw.DeliveryAddr3 || null,                        // $21 delivery_addr3
        raw.InstructionAddr1 || null,                     // $22 instruction_addr1
        raw.InstructionAddr2 || null,                     // $23 instruction_addr2
        raw.InstructionAddr3 || null,                     // $24 instruction_addr3
        raw.InstructionAddr4 || null,                     // $25 instruction_addr4
        raw.InstructionAddr5 || null,                     // $26 instruction_addr5
        raw.InstructionAddr6 || null,                     // $27 instruction_addr6
        raw.MapPage || null,                              // $28 map_page
        raw.ZoneCode || null,                             // $29 zone_code
        raw.ZoneName || null,                             // $30 zone_name
        raw.CurrentStatus != null ? parseInt(raw.CurrentStatus) : 0, // $31 current_status
        transformBoolean(raw.Removed),                    // $32 removed
        raw.RemoveReasonCode || null,                     // $33 remove_reason_code
        raw.HaulerCode || null,                           // $34 hauler_code
        raw.HaulerName || null,                           // $35 hauler_name
        raw.PriceCategoryCode || null,                    // $36 price_category_code
        raw.PriceCategoryName || null,                    // $37 price_category_name
        raw.PricingPlantCode || null,                     // $38 pricing_plant_code
        raw.TaxCode || '',                                // $39 tax_code (NOT NULL)
        transformBoolean(raw.Taxable),                    // $40 taxable
        raw.TakenByEmployeeID || null,                    // $41 taken_by_employee_id
        raw.TakenByEmployeeCode || null,                  // $42 taken_by_employee_code
        raw.OrderedByName || null,                        // $43 ordered_by_name
        raw.OrderedByPhone || null,                       // $44 ordered_by_phone
        raw.RecipientEmail || null,                       // $45 recipient_email
        raw.SalesmanID || null,                           // $46 salesman_id
        raw.SalesmanCode || null,                         // $47 salesman_code
        raw.SalesmanName || null,                         // $48 salesman_name
        raw.Latitude || null,                             // $49 latitude
        raw.Longitude || null,                            // $50 longitude
        raw.UsageCode || null,                            // $51 usage_code
        raw.UsageShort || null,                           // $52 usage_short
        raw.RemovedBy || null,                            // $53 removed_by
        raw.ConfirmedBy || null,                          // $54 confirmed_by
        transformBoolean(raw.Reviewed)                    // $55 reviewed
      ];

      const orderResult = await executeDirectSQL(orderSql, orderParams);
      if (orderResult.success && orderResult.data && orderResult.data.length > 0) {
        totalOrdersInserted++;
        console.log(`      ✅ [orders] Inserted/updated order ${order.order_code} (order_id: ${orderId})`);
      } else {
        console.warn(`      ⚠️ [orders] No rows returned for order ${order.order_code}`);
        continue;
      }
    } catch (orderError) {
      console.error(`      ❌ [orders] Failed to insert order ${order.order_code}: ${orderError.message}`);
      continue;
    }

    // Step 2: Insert products
    const productData = raw.Products?.Product;
    if (productData) {
      const productList = Array.isArray(productData) ? productData : [productData];

      for (const prod of productList) {
        const productId = prod.ProductID;
        const itemId = prod.ItemID;

        if (!productId || !itemId) {
          console.warn(`      ⚠️ Skipping product - missing ProductID or ItemID`);
          continue;
        }

        try {
          const productSql = `
            INSERT INTO order_products (
              order_id, product_id, item_id, item_code, description, short_description,
              is_mix, is_assoc, price, price_unit,
              order_qty, order_qty_unit, load_qty, delv_qty, delv_qty_unit,
              slump, trim_percent, comments, usage_code, usage_name,
              taxable, trade_discountable
            )
            VALUES (
              $1, $2, $3, $4, $5, $6,
              $7, $8, $9, $10,
              $11, $12, $13, $14, $15,
              $16, $17, $18, $19, $20,
              $21, $22
            )
            ON CONFLICT (order_id, product_id, item_id) DO UPDATE SET
              item_code = EXCLUDED.item_code,
              order_qty = EXCLUDED.order_qty,
              delv_qty = EXCLUDED.delv_qty,
              order_qty_unit = EXCLUDED.order_qty_unit
            RETURNING id
          `;

          const productParams = [
            orderId,                                                    // $1 order_id
            productId,                                                  // $2 product_id
            itemId,                                                     // $3 item_id
            prod.ItemCode || '',                                        // $4 item_code (NOT NULL)
            prod.Description || '',                                     // $5 description (NOT NULL)
            prod.ShortDescription || '',                                // $6 short_description (NOT NULL)
            transformBoolean(prod.IsMix),                               // $7 is_mix (NOT NULL)
            transformBoolean(prod.IsAssoc),                             // $8 is_assoc (NOT NULL)
            prod.Price != null ? parseFloat(prod.Price) : 0,            // $9 price (NOT NULL)
            prod.PriceUnit || '',                                       // $10 price_unit (NOT NULL)
            prod.OrderQty != null ? parseFloat(prod.OrderQty) : 0,     // $11 order_qty (NOT NULL)
            prod.OrderQtyUnit || '',                                    // $12 order_qty_unit (NOT NULL)
            prod.LoadQty != null ? parseFloat(prod.LoadQty) : 0,        // $13 load_qty (NOT NULL)
            prod.DelvQty != null ? parseFloat(prod.DelvQty) : 0,       // $14 delv_qty (NOT NULL)
            prod.DelvQtyUnit || '',                                     // $15 delv_qty_unit (NOT NULL)
            prod.Slump || null,                                         // $16 slump
            prod.TrimPercent || null,                                   // $17 trim_percent
            prod.Comments || null,                                      // $18 comments
            prod.UsageCode || null,                                     // $19 usage_code
            prod.UsageName || null,                                     // $20 usage_name
            transformBoolean(prod.Taxable),                             // $21 taxable (NOT NULL)
            transformBoolean(prod.TradeDiscountable)                    // $22 trade_discountable (NOT NULL)
          ];

          const productResult = await executeDirectSQL(productSql, productParams);
          if (productResult.success && productResult.data && productResult.data.length > 0) {
            const orderProductId = productResult.data[0].id;
            totalProductsInserted++;
            console.log(`      ✅ [order_products] Inserted product ${prod.ItemCode || productId} (id: ${orderProductId})`);

            // Step 3: Insert schedules for this product
            const scheduleData = prod.Schedules?.Schedule;
            if (scheduleData) {
              const scheduleList = Array.isArray(scheduleData) ? scheduleData : [scheduleData];

              for (const sched of scheduleList) {
                const productScheduleId = sched.ProductScheduleID;
                if (!productScheduleId) {
                  console.warn(`      ⚠️ Skipping schedule - missing ProductScheduleID`);
                  continue;
                }

                try {
                  const scheduleSql = `
                    INSERT INTO order_product_schedules (
                      order_product_id, product_schedule_id, plant_id, plant_code,
                      start_time, schedule_qty, schedule_delv_qty, hold_qty,
                      truck_type_id, truck_type_code, truck_type_name,
                      load_qty, job_wash_time,
                      pouring_method_code, pouring_method_short,
                      unload_rate_per_hour, distance,
                      time_to_job, time_to_plant, truck_space,
                      unload_time, delivery_rate_per_hour,
                      trucks_required, number_of_loads
                    )
                    VALUES (
                      $1, $2, $3, $4,
                      $5, $6, $7, $8,
                      $9, $10, $11,
                      $12, $13,
                      $14, $15,
                      $16, $17,
                      $18, $19, $20,
                      $21, $22,
                      $23, $24
                    )
                    ON CONFLICT (order_product_id, product_schedule_id) DO UPDATE SET
                      plant_code = EXCLUDED.plant_code,
                      start_time = EXCLUDED.start_time,
                      schedule_qty = EXCLUDED.schedule_qty
                    RETURNING id
                  `;

                  const scheduleParams = [
                    orderProductId,                                                     // $1
                    productScheduleId,                                                  // $2 (NOT NULL)
                    sched.PlantID || 0,                                                 // $3 plant_id (NOT NULL)
                    sched.PlantCode || '',                                              // $4 plant_code (NOT NULL)
                    sched.StartTime || new Date().toISOString(),                        // $5 start_time (NOT NULL)
                    sched.ScheduleQty != null ? parseFloat(sched.ScheduleQty) : 0,     // $6 schedule_qty (NOT NULL)
                    sched.ScheduleDelvQty != null ? parseFloat(sched.ScheduleDelvQty) : 0, // $7 schedule_delv_qty (NOT NULL)
                    sched.HoldQty != null ? parseFloat(sched.HoldQty) : 0,             // $8 hold_qty (NOT NULL)
                    sched.TruckTypeID || 0,                                            // $9 truck_type_id (NOT NULL)
                    sched.TruckTypeCode || '',                                         // $10 truck_type_code (NOT NULL)
                    sched.TruckTypeName || '',                                         // $11 truck_type_name (NOT NULL)
                    sched.LoadQty != null ? parseFloat(sched.LoadQty) : 0,             // $12 load_qty (NOT NULL)
                    sched.JobWashTime != null ? parseInt(sched.JobWashTime) : 0,       // $13 job_wash_time (NOT NULL)
                    sched.PouringMethodCode || null,                                    // $14
                    sched.PouringMethodShort || null,                                   // $15
                    sched.UnloadRatePerHour != null ? parseFloat(sched.UnloadRatePerHour) : null, // $16
                    sched.Distance != null ? parseFloat(sched.Distance) : null,         // $17
                    sched.TimeToJob != null ? parseInt(sched.TimeToJob) : 0,           // $18 time_to_job (NOT NULL)
                    sched.TimeToPlant ?? null,                                          // $19
                    sched.TruckSpace ?? null,                                           // $20
                    sched.UnloadTime != null ? parseInt(sched.UnloadTime) : 0,         // $21 unload_time (NOT NULL)
                    sched.DeliveryRatePerHour != null ? parseFloat(sched.DeliveryRatePerHour) : 0, // $22 (NOT NULL)
                    sched.TrucksRequired != null ? parseFloat(sched.TrucksRequired) : 0, // $23 (NOT NULL)
                    sched.NumberOfLoads != null ? parseInt(sched.NumberOfLoads) : 0     // $24 (NOT NULL)
                  ];

                  const scheduleResult = await executeDirectSQL(scheduleSql, scheduleParams);
                  if (scheduleResult.success && scheduleResult.data && scheduleResult.data.length > 0) {
                    totalSchedulesInserted++;
                    console.log(`      ✅ [order_product_schedules] Inserted schedule ${productScheduleId} (plant: ${sched.PlantCode || 'N/A'})`);
                  }
                } catch (scheduleError) {
                  console.error(`      ❌ [order_product_schedules] Failed: ${scheduleError.message}`);
                }
              }
            }
          }
        } catch (productError) {
          console.error(`      ❌ [order_products] Failed to insert product ${prod.ItemCode || productId}: ${productError.message}`);
        }
      }
    }
  }

  const summary = {
    orders_inserted: totalOrdersInserted,
    products_inserted: totalProductsInserted,
    schedules_inserted: totalSchedulesInserted
  };

  console.log(`\n✅ Missing order inserts complete: ${totalOrdersInserted} orders, ${totalProductsInserted} products, ${totalSchedulesInserted} schedules`);

  return summary;
}

module.exports = {
  updateResolvedOrdersInDatabase,
  insertResolvedMissingOrdersInDatabase,
  attachAfterUpdateValues,
  extractResolvedOrders,
  extractOrdersWithFreshData,
  buildUpdateOperations
};
