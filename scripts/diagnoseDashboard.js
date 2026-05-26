require('dotenv').config();
const { executeDirectSQL } = require('../src/utils/postgresExecutor');
const { loadUserAccessData } = (() => {
  const m = require('../src/middleware/auth');
  return { loadUserAccessData: null };
})();

const USER_ID = process.argv[2] || 'a4e036da-b592-441e-814f-d18b9275c3b3';

(async () => {
  console.log('=== Diagnostic for user:', USER_ID, '===\n');

  // 1. Admin check
  const admin = await executeDirectSQL(`
    SELECT r.code, r.name, r.role_type, r.is_active
    FROM user_roles ur
    INNER JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = $1
  `, [USER_ID]);
  console.log('user_roles / roles:', JSON.stringify(admin.data, null, 2));

  // 2. Direct plants
  const directPlants = await executeDirectSQL(`
    SELECT DISTINCT p.code
    FROM user_roles ur
    INNER JOIN roles r ON r.id = ur.role_id
    INNER JOIN role_plants rp ON rp.role_id = r.id
    INNER JOIN plants p ON p.id = rp.plant_id
    WHERE ur.user_id = $1 AND r.is_active = true
      AND r.role_type IN ('region_role','plant_role','mixed_role')
      AND p.code IS NOT NULL AND TRIM(p.code) != ''
  `, [USER_ID]);
  console.log('\nDirect plant codes:', directPlants.data?.map(r => r.code));

  // 3. Zone-based plants
  const zones = await executeDirectSQL(`
    SELECT DISTINCT rr.zone_name
    FROM user_roles ur
    INNER JOIN roles r ON r.id = ur.role_id
    INNER JOIN role_regions rr ON rr.role_id = r.id
    WHERE ur.user_id = $1 AND r.is_active = true
      AND r.role_type IN ('region_role','plant_role','mixed_role')
      AND rr.zone_name IS NOT NULL AND TRIM(rr.zone_name) != ''
  `, [USER_ID]);
  console.log('Zone names:', zones.data?.map(r => r.zone_name));

  // 4. Customer IDs
  const customers = await executeDirectSQL(`
    SELECT customer_id FROM user_customers WHERE user_id = $1 AND customer_id IS NOT NULL
  `, [USER_ID]);
  console.log('Customer IDs:', customers.data?.map(r => r.customer_id));

  // 5. How many orders exist today (CST) regardless of user
  const todayOrders = await executeDirectSQL(`
    SELECT COUNT(*) AS total
    FROM orders
    WHERE order_date >= (CURRENT_DATE AT TIME ZONE 'America/Chicago')::date
      AND order_date <  (CURRENT_DATE AT TIME ZONE 'America/Chicago')::date + INTERVAL '1 day'
  `, []);
  console.log('\nTotal orders "today" in DB (CST):', todayOrders.data?.[0]?.total);

  // 6. Recent order_date distribution
  const recent = await executeDirectSQL(`
    SELECT DATE(order_date) AS d, COUNT(*) AS n
    FROM orders
    WHERE order_date >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(order_date)
    ORDER BY d DESC
  `, []);
  console.log('Orders per day (last 7):', recent.data);

  // 7. order_products filter survivors
  const opCount = await executeDirectSQL(`
    SELECT COUNT(*) AS n
    FROM orders o
    INNER JOIN order_products op ON op.order_id = o.order_id
      AND (op.order_qty_unit = 'YDQ' AND op.is_mix = true)
    WHERE o.order_date >= NOW() - INTERVAL '2 days'
  `, []);
  console.log('Last-2-day orders passing YDQ+is_mix filter:', opCount.data?.[0]?.n);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
