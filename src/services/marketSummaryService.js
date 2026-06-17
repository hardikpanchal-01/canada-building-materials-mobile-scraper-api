/**
 * Market Summary Service
 *
 * Provides company, region, and plant-level order aggregations
 * for the dashboard market summary section.
 *
 * Uses a shared filtered_orders CTE with the same exclusion/access
 * rules as all other order queries.
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');
const { buildExclusionConditions } = require('./dashboardShared');

/**
 * Build the shared filtered_orders CTE SQL and params
 * @param {string} dateFrom - Start date YYYY-MM-DD
 * @param {string} dateTo - End date YYYY-MM-DD
 * @param {Array} exclusionPatterns - Exclusion patterns
 * @param {object} userAccess - User access control
 * @returns {{ cteSql: string, params: any[] }}
 */
function buildFilteredOrdersCTE(dateFrom, dateTo, exclusionPatterns, userAccess) {
  let whereConditions = [
    'o.order_date >= $1::date AND o.order_date < ($2::date + INTERVAL \'1 day\')'
  ];

  let queryParams = [dateFrom, dateTo];

  // Exclusion patterns
  const { conditions: exclusionConds, params: exclusionParams } =
    buildExclusionConditions(exclusionPatterns, 3);
  whereConditions = whereConditions.concat(exclusionConds);
  queryParams = queryParams.concat(exclusionParams);

  let paramIndex = 3 + exclusionParams.length;

  // Access control
  if (userAccess && !userAccess.isAdmin) {
    const accessOrConditions = [];

    if (userAccess.allowedPlants && userAccess.allowedPlants.length > 0) {
      const placeholders = userAccess.allowedPlants.map((_, i) => `$${paramIndex + i}::text`).join(', ');
      accessOrConditions.push(`EXISTS (SELECT 1 FROM order_products op_ac INNER JOIN order_product_schedules ops_ac ON ops_ac.order_product_id = op_ac.id WHERE op_ac.order_id = o.order_id AND (op_ac.order_qty_unit IN ('YDQ', 'CY', 'm3', 'M3') AND op_ac.is_mix = true) AND ops_ac.plant_code::text IN (${placeholders}))`);
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

  // Order eligibility: ANY order that has at least one product line — mirrors the
  // web's getAllSummaryData (counts orders with products, NOT is_mix-gated, because
  // the COMMANDseries sync has historically mis-set is_mix on valid concrete lines).
  // Volume (Production & Delivery) still counts only concrete volume lines, keyed
  // off the UOM (m3/CY), exactly like the web's computeCY() helper.
  const cteSql = `WITH filtered_orders AS (
    SELECT
      o.order_id,
      o.pricing_plant_code,
      o.removed,
      o.remove_reason_code,
      SUM(CASE WHEN NOT (o.removed = true AND o.remove_reason_code IS NOT NULL
          AND TRIM(o.remove_reason_code) <> '')
          AND op.order_qty_unit IN ('m3', 'M3', 'CY', 'YDQ')
        THEN COALESCE(op.order_qty, 0) ELSE 0 END) as total_cy,
      SUM(CASE WHEN NOT (o.removed = true AND o.remove_reason_code IS NOT NULL
          AND TRIM(o.remove_reason_code) <> '')
          AND op.order_qty_unit IN ('m3', 'M3', 'CY', 'YDQ')
        THEN COALESCE(op.delv_qty, 0) ELSE 0 END) as used_cy,
      BOOL_OR(o.removed = true AND o.remove_reason_code IS NOT NULL
          AND TRIM(o.remove_reason_code) <> '') as is_cancelled
    FROM orders o
    INNER JOIN order_products op ON op.order_id = o.order_id
    WHERE ${whereConditions.join(' AND ')}
    GROUP BY o.order_id, o.pricing_plant_code, o.removed, o.remove_reason_code
  )`;

  return { cteSql, params: queryParams };
}

/**
 * Fetch all three summary levels (company, region, plant) in a single
 * database round-trip.  The filtered_orders CTE is evaluated once and
 * then aggregated three ways via UNION ALL.
 *
 * Column mapping across the three legs:
 *   summary_type | id         | code       | name            | extra_name
 *   -------------|------------|------------|-----------------|------------
 *   company      | c.id       | c.code     | c.name          | NULL
 *   region       | r.id       | NULL       | r.description   | NULL
 *   plant        | p.id       | p.code     | p.description   | r.description
 */
async function getCombinedSummary(dateFrom, dateTo, exclusionPatterns, userAccess) {
  const { cteSql, params } = buildFilteredOrdersCTE(dateFrom, dateTo, exclusionPatterns, userAccess);

  const sql = `${cteSql}
    SELECT 'company' as summary_type,
      c.id, c.code, c.name, NULL as extra_name,
      COUNT(*) as total_orders,
      COUNT(*) FILTER (WHERE NOT fo.is_cancelled) as active_orders,
      COUNT(*) FILTER (WHERE fo.is_cancelled) as cancelled_orders,
      ROUND(SUM(fo.total_cy)::numeric, 2) as total_cy,
      ROUND(SUM(fo.used_cy)::numeric, 2) as used_cy
    FROM filtered_orders fo
    JOIN plants p ON p.code = fo.pricing_plant_code
    JOIN companies c ON c.code = p.company_code
    GROUP BY c.id, c.code, c.name

    UNION ALL

    SELECT 'region' as summary_type,
      r.id, NULL as code, r.description as name, NULL as extra_name,
      COUNT(*) as total_orders,
      COUNT(*) FILTER (WHERE NOT fo.is_cancelled) as active_orders,
      COUNT(*) FILTER (WHERE fo.is_cancelled) as cancelled_orders,
      ROUND(SUM(fo.total_cy)::numeric, 2) as total_cy,
      ROUND(SUM(fo.used_cy)::numeric, 2) as used_cy
    FROM filtered_orders fo
    JOIN plants p ON p.code = fo.pricing_plant_code
    JOIN regions r ON r.id = p.region_id
    GROUP BY r.id, r.description

    UNION ALL

    SELECT 'plant' as summary_type,
      p.id, p.code, p.description as name, r.description as extra_name,
      COUNT(*) as total_orders,
      COUNT(*) FILTER (WHERE NOT fo.is_cancelled) as active_orders,
      COUNT(*) FILTER (WHERE fo.is_cancelled) as cancelled_orders,
      ROUND(SUM(fo.total_cy)::numeric, 2) as total_cy,
      ROUND(SUM(fo.used_cy)::numeric, 2) as used_cy
    FROM filtered_orders fo
    JOIN plants p ON p.code = fo.pricing_plant_code
    LEFT JOIN regions r ON r.id = p.region_id
    GROUP BY p.id, p.code, p.description, r.description

    UNION ALL

    SELECT 'tenant' as summary_type,
      '0' as id, '0' as code, NULL as name, NULL as extra_name,
      COUNT(*) as total_orders,
      COUNT(*) FILTER (WHERE NOT fo.is_cancelled) as active_orders,
      COUNT(*) FILTER (WHERE fo.is_cancelled) as cancelled_orders,
      ROUND(SUM(fo.total_cy)::numeric, 2) as total_cy,
      ROUND(SUM(fo.used_cy)::numeric, 2) as used_cy
    FROM filtered_orders fo`;

  const result = await executeDirectSQL(sql, params);
  const rows = result.data || [];

  // Split the combined result set by summary_type
  const companies = [];
  const regions = [];
  const plants = [];
  let tenantAgg = null; // tenant-wide aggregate (no plant join) — used when orders carry no pricing_plant_code

  for (const row of rows) {
    const totalOrders = parseInt(row.total_orders) || 0;
    const activeOrders = parseInt(row.active_orders) || 0;
    const cancelledOrders = parseInt(row.cancelled_orders) || 0;
    const totalCY = parseFloat(row.total_cy) || 0;
    const usedCY = parseFloat(row.used_cy) || 0;

    switch (row.summary_type) {
      case 'company':
        companies.push({
          id: row.id,
          code: row.code,
          name: row.name,
          totalOrders, activeOrders, cancelledOrders, totalCY, usedCY
        });
        break;

      case 'region':
        regions.push({
          id: row.id,
          name: row.name,
          totalOrders, activeOrders, cancelledOrders, totalCY, usedCY
        });
        break;

      case 'plant':
        plants.push({
          id: row.id,
          code: row.code,
          name: row.name,
          regionName: row.extra_name || null,
          totalOrders, activeOrders, cancelledOrders, totalCY, usedCY,
          weather: null
        });
        break;

      case 'tenant':
        tenantAgg = { totalOrders, activeOrders, cancelledOrders, totalCY, usedCY };
        break;
    }
  }

  // The `companies` table is empty for this tenant and every plant carries
  // company_code '0', so the company JOIN above yields nothing. Mirror the web,
  // which presents a single tenant-level "company" aggregate. Synthesize it from
  // the per-plant rows: each order maps to exactly one plant via
  // pricing_plant_code, so summing plant counts gives distinct-order totals.
  // CBM orders carry no pricing_plant_code (and plants use placeholder code '0'),
  // so the plant/company JOINs above yield nothing. Mirror the web's single
  // tenant-level "company" card: prefer summing the per-plant rows when present,
  // otherwise fall back to the tenant-wide aggregate computed straight from the
  // eligible orders (no plant join required).
  if (companies.length === 0) {
    let agg = null;
    if (plants.length > 0) {
      agg = plants.reduce((a, p) => ({
        totalOrders: a.totalOrders + p.totalOrders,
        activeOrders: a.activeOrders + p.activeOrders,
        cancelledOrders: a.cancelledOrders + p.cancelledOrders,
        totalCY: a.totalCY + p.totalCY,
        usedCY: a.usedCY + p.usedCY
      }), { totalOrders: 0, activeOrders: 0, cancelledOrders: 0, totalCY: 0, usedCY: 0 });
    } else if (tenantAgg && tenantAgg.totalOrders > 0) {
      agg = tenantAgg;
    }

    if (agg) {
      companies.push({
        id: '0',
        code: '0',
        name: process.env.PRODUCER_NAME || process.env.TENANT_NAME || 'Company',
        totalOrders: agg.totalOrders,
        activeOrders: agg.activeOrders,
        cancelledOrders: agg.cancelledOrders,
        totalCY: parseFloat(agg.totalCY.toFixed(2)),
        usedCY: parseFloat(agg.usedCY.toFixed(2))
      });
    }
  }

  // Sort each group to match original ordering
  companies.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  regions.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  plants.sort((a, b) => b.totalOrders - a.totalOrders); // ORDER BY COUNT(*) DESC

  // Batch fetch weather for all plants
  const plantIds = plants.map(p => p.id).filter(Boolean);
  if (plantIds.length > 0) {
    try {
      const weatherSql = `
        SELECT DISTINCT ON (pw.plant_id)
          pw.plant_id, pw.temperature_fahrenheit, pw.humidity,
          pw.wind_speed, pw.weather_condition, pw.weather_icon
        FROM plant_weather pw
        WHERE pw.plant_id = ANY($1::int[])
        ORDER BY pw.plant_id, pw.fetched_at DESC`;

      const weatherResult = await executeDirectSQL(weatherSql, [plantIds]);
      const weatherMap = new Map();
      for (const w of (weatherResult.data || [])) {
        weatherMap.set(w.plant_id, {
          temperature_fahrenheit: w.temperature_fahrenheit != null ? parseFloat(w.temperature_fahrenheit) : null,
          humidity: w.humidity != null ? parseFloat(w.humidity) : null,
          wind_speed_mph: w.wind_speed != null ? parseFloat(w.wind_speed) : null,
          condition: w.weather_condition || null,
          icon: w.weather_icon || null
        });
      }

      for (const plant of plants) {
        plant.weather = weatherMap.get(plant.id) || null;
      }
    } catch (err) {
      console.warn('Could not fetch plant weather:', err.message);
    }
  }

  return { companies, regions, plants };
}

/**
 * Get full market summary (company + region + plant) using a single
 * combined query.  The filtered_orders CTE is evaluated once and then
 * aggregated at three levels via UNION ALL, reducing from 3 DB
 * round-trips to 1 (plus 1 for plant weather).
 *
 * @param {string} dateFrom - Start date YYYY-MM-DD
 * @param {string} dateTo - End date YYYY-MM-DD
 * @param {Array} exclusionPatterns - Exclusion patterns
 * @param {object} userAccess - User access control
 * @returns {Promise<{ companies: Array, regions: Array, plants: Array }>}
 */
async function getMarketSummary(dateFrom, dateTo, exclusionPatterns, userAccess) {
  return getCombinedSummary(dateFrom, dateTo, exclusionPatterns, userAccess);
}

module.exports = {
  getMarketSummary
};
