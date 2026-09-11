/**
 * Daily Intelligence + ODP data endpoints.
 * Queries PostgreSQL directly.
 */
const { executeDirectSQL } = require('../utils/postgresExecutor');

async function getDailyIntelligence(req, res) {
  try {
    const { report_date, scope, plant_code, region_name } = req.query;

    let query = `SELECT * FROM daily_intelligence WHERE company_code = 'ALL'`;
    const params = [];

    if (report_date) {
      params.push(report_date);
      query += ` AND report_date = $${params.length}`;
    }

    // scope controls filtering logic (same as the old hook):
    // company = no plant/region filter, plant = filter by plant_code, region = filter by region_name
    if (scope === 'company' || !scope) {
      query += ` AND plant_code IS NULL AND region_name IS NULL`;
    } else if (scope === 'plant' && plant_code) {
      params.push(plant_code);
      query += ` AND plant_code = $${params.length}`;
    } else if (scope === 'region' && region_name) {
      query += ` AND plant_code IS NULL`;
      params.push(region_name);
      query += ` AND region_name = $${params.length}`;
    } else {
      query += ` AND plant_code IS NULL AND region_name IS NULL`;
    }

    query += ` ORDER BY report_date DESC LIMIT 50`;

    const result = await executeDirectSQL(query, params);
    // Mobile app expects a single object for the matched scope, not an array
    const rows = result.data || [];
    return res.json({ success: true, data: rows[0] || null });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function getODPData(req, res) {
  try {
    const { order_ids, order_date } = req.query;

    if (!order_ids) {
      return res.status(400).json({ success: false, message: 'order_ids is required' });
    }

    const ids = order_ids.split(',').map(id => String(id).trim()).filter(id => id.length > 0);
    if (ids.length === 0) {
      return res.json({ success: true, data: { tickets: [], orderProducts: [] } });
    }

    // Tickets with is_mix ticket_products
    const ticketsResult = await executeDirectSQL(
      `SELECT t.ticket_id, t.ticket_code, t.truck_code, t.scheduled_on_job_time, t.on_job_time,
              t.wash_time, t.to_plant_time, t.remove_reason_code, t.order_code,
              tp.id as tp_id, tp.ticket_id as tp_ticket_id, tp.is_mix, tp.load_qty
       FROM tickets t
       LEFT JOIN ticket_products tp ON tp.ticket_id = t.ticket_id AND tp.is_mix = true
       WHERE t.order_id = ANY($1::bigint[])
       ORDER BY t.ticket_id`, [`{${ids.join(',')}}`]
    );

    // Order products with schedules
    const opResult = await executeDirectSQL(
      `SELECT op.id, op.order_id, op.is_mix,
              ops.id as schedule_id, ops.order_product_id, ops.schedule_qty, ops.start_time,
              ops.delivery_rate_per_hour, ops.truck_space, ops.number_of_loads, ops.load_qty
       FROM order_products op
       LEFT JOIN order_product_schedules ops ON ops.order_product_id = op.id
       WHERE op.order_id = ANY($1::bigint[])
       ORDER BY op.id`, [`{${ids.join(',')}}`]
    );

    return res.json({
      success: true,
      data: {
        tickets: ticketsResult.data || [],
        orderProducts: opResult.data || [],
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = { getDailyIntelligence, getODPData };
