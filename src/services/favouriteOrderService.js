/**
 * Favourite Order Service
 *
 * Business logic for toggling and retrieving user favourite orders.
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');

/**
 * Toggle favourite status for an order.
 * If the order is already favourited, it removes it (unfavourite).
 * If the order is not favourited, it adds it (favourite).
 *
 * @param {string} userId - The authenticated user's ID
 * @param {string} orderId - The order ID to toggle
 * @returns {object} { is_favourite: boolean, message: string }
 */
async function toggleFavourite(userId, orderId) {
  // orders.order_id is a varchar UUID in this tenant's DB, so order_id is text
  // (not a bigint). Validate it's a non-empty value and compare as text.
  const orderIdStr = String(orderId ?? '').trim();
  if (!orderIdStr) {
    throw new Error('Invalid order_id: must be a non-empty value');
  }

  // Try to delete first — if it existed, we unfavourited it (1 query instead of 2)
  const deleteResult = await executeDirectSQL(
    `DELETE FROM user_favourite_orders WHERE user_id = $1 AND order_id = $2 RETURNING id`,
    [userId, orderIdStr]
  );

  if (deleteResult.data.length > 0) {
    return {
      is_favourite: false,
      message: 'Order removed from favourites'
    };
  }

  // Did not exist — add it (with ON CONFLICT for race-condition safety)
  await executeDirectSQL(
    `INSERT INTO user_favourite_orders (user_id, order_id) VALUES ($1, $2)
     ON CONFLICT (user_id, order_id) DO NOTHING`,
    [userId, orderIdStr]
  );

  return {
    is_favourite: true,
    message: 'Order added to favourites'
  };
}

/**
 * Get all favourite orders for a user with order details.
 *
 * @param {string} userId - The authenticated user's ID
 * @param {object} userAccess - User access control data
 * @returns {object} { favourites: array, total: number }
 */
async function getFavourites(userId, userAccess) {
  // Build access control WHERE clause
  let accessFilter = '';
  const params = [userId];
  let paramIndex = 2;

  if (userAccess && !userAccess.isAdmin) {
    const accessOrParts = [];

    if (userAccess.allowedPlants && userAccess.allowedPlants.length > 0) {
      accessOrParts.push(`EXISTS (
        SELECT 1 FROM order_products op2
        JOIN order_product_schedules ops2 ON ops2.order_product_id = op2.id
        WHERE op2.order_id = o.order_id
        AND ops2.plant_code = ANY($${paramIndex}::text[])
      )`);
      params.push(userAccess.allowedPlants);
      paramIndex++;
    }

    if (userAccess.allowedCustomerIds && userAccess.allowedCustomerIds.length > 0) {
      accessOrParts.push(`o.customer_id = ANY($${paramIndex}::text[])`);
      params.push(userAccess.allowedCustomerIds);
      paramIndex++;
    }

    if (userAccess.allowedProjectCodes && userAccess.allowedProjectCodes.length > 0) {
      accessOrParts.push(`o.project_code = ANY($${paramIndex}::text[])`);
      params.push(userAccess.allowedProjectCodes);
      paramIndex++;
    }

    if (accessOrParts.length > 0) {
      accessFilter += ` AND (${accessOrParts.join(' OR ')})`;
    }
  }

  const result = await executeDirectSQL(
    `SELECT
        f.id AS favourite_id,
        f.created_at AS favourited_at,
        o.order_id,
        o.order_code,
        o.order_date,
        o.customer_name,
        o.project_name,
        COALESCE(o.delivery_addr1, '') ||
          CASE WHEN o.delivery_addr2 IS NOT NULL AND o.delivery_addr2 != '' THEN ', ' || o.delivery_addr2 ELSE '' END ||
          CASE WHEN o.delivery_addr3 IS NOT NULL AND o.delivery_addr3 != '' THEN ', ' || o.delivery_addr3 ELSE '' END
          AS delivery_address,
        o.current_status,
        o.removed,
        o.remove_reason_code,
        COALESCE(prod.ordered_qty, 0) AS ordered_qty,
        COALESCE(prod.delivered_qty, 0) AS delivered_qty,
        COALESCE(prod.ordered_qty, 0) - COALESCE(prod.delivered_qty, 0) AS remaining_qty
      FROM user_favourite_orders f
      JOIN orders o ON o.order_id = f.order_id
      LEFT JOIN (
        SELECT
          order_id,
          SUM(order_qty) AS ordered_qty,
          SUM(delv_qty) AS delivered_qty
        FROM order_products
        WHERE (order_qty_unit = 'YDQ' AND is_mix = true)
        GROUP BY order_id
      ) prod ON prod.order_id = o.order_id
      WHERE f.user_id = $1
        ${accessFilter}
      ORDER BY f.created_at DESC`,
    params
  );

  // Map status codes to display names
  const STATUS_CODE_MAP = {
    '0': 'Normal',
    '1': 'Will Call',
    '2': 'Weather Permitting',
    '3': 'Hold Delivery',
    '4': 'Completed',
    '5': 'Wait List'
  };

  const favourites = result.data.map(row => {
    let status;
    if (row.remove_reason_code) {
      status = 'Canceled';
    } else if (row.delivered_qty > 0 && row.delivered_qty < row.ordered_qty && String(row.current_status) === '0') {
      status = 'In Progress';
    } else {
      status = STATUS_CODE_MAP[String(row.current_status)] || 'Normal';
    }

    return {
      favourite_id: row.favourite_id,
      favourited_at: row.favourited_at,
      order_id: row.order_id,
      order_code: row.order_code,
      order_date: row.order_date,
      customer_name: row.customer_name,
      project_name: row.project_name,
      delivery_address: row.delivery_address,
      ordered_qty: parseFloat(row.ordered_qty) || 0,
      delivered_qty: parseFloat(row.delivered_qty) || 0,
      remaining_qty: parseFloat(row.remaining_qty) || 0,
      status
    };
  });

  return {
    favourites,
    total: favourites.length
  };
}

/**
 * Get all favourite order IDs for a user (lightweight lookup).
 *
 * @param {string} userId - The authenticated user's ID
 * @returns {Set<number>} Set of favourite order IDs
 */
async function getFavouriteOrderIds(userId) {
  const result = await executeDirectSQL(
    `SELECT order_id FROM user_favourite_orders WHERE user_id = $1`,
    [userId]
  );

  return new Set(result.data.map(row => row.order_id));
}

module.exports = {
  toggleFavourite,
  getFavourites,
  getFavouriteOrderIds
};
