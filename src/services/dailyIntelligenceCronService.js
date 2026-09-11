/**
 * Daily Intelligence Cron Service for CBM
 * Ported from Dolese cron (ESM → CommonJS).
 * Computes daily intelligence metrics from orders/tickets data every 2 minutes.
 */
const { executeDirectSQL } = require('../utils/postgresExecutor');

const MODULE_NAME = 'daily_intelligence';
const CDT_TIMEZONE = 'America/Chicago';

const DEFAULT_CONFIG = {
  stuck_at_job_idle_minutes: 5,
  congested_sites_truck_threshold: 3,
  slow_plants_output_pct: 0.70,
  late_orders_delivery_rate_fallback: 12,
  late_orders_slow_expected_pct: 20,
  late_orders_slow_actual_factor: 0.5,
  slow_plants_min_count: 2,
  round_trip_valid_min_minutes: 10,
  round_trip_valid_max_minutes: 480,
  max_detail_array_size: 200,
  late_orders_not_started_buffer_minutes: 5,
  business_hours_start_cdt: 5,
  business_hours_end_cdt: 20,
};

// ─── Database helpers ──────────────────────────────────────────

async function upsertRow(row) {
  const sql = `
    INSERT INTO daily_intelligence (
      report_date, company_code, plant_code, region_name,
      late_orders_total, late_not_started, late_slow_progress, late_past_finish, late_orders_details,
      stuck_at_job_total, stuck_at_job_details,
      slow_plants_total, slow_plants_details,
      congested_sites_total, congested_sites_details,
      avg_round_trip_minutes, avg_round_trip_display, prev_day_avg_round_trip_minutes,
      round_trip_change_percent, round_trip_sample_count,
      weather_risk_total, weather_risk_severe, weather_risk_very_high, weather_risk_high, weather_risk_moderate, weather_risk_details,
      status_pre_pour, status_in_process, status_completed, status_canceled,
      top_products, computed_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,NOW()
    )
    ON CONFLICT (report_date, company_code, COALESCE(plant_code, ''), COALESCE(region_name, ''))
    DO UPDATE SET
      late_orders_total=EXCLUDED.late_orders_total, late_not_started=EXCLUDED.late_not_started,
      late_slow_progress=EXCLUDED.late_slow_progress, late_past_finish=EXCLUDED.late_past_finish,
      late_orders_details=EXCLUDED.late_orders_details,
      stuck_at_job_total=EXCLUDED.stuck_at_job_total, stuck_at_job_details=EXCLUDED.stuck_at_job_details,
      slow_plants_total=EXCLUDED.slow_plants_total, slow_plants_details=EXCLUDED.slow_plants_details,
      congested_sites_total=EXCLUDED.congested_sites_total, congested_sites_details=EXCLUDED.congested_sites_details,
      avg_round_trip_minutes=EXCLUDED.avg_round_trip_minutes, avg_round_trip_display=EXCLUDED.avg_round_trip_display,
      prev_day_avg_round_trip_minutes=EXCLUDED.prev_day_avg_round_trip_minutes,
      round_trip_change_percent=EXCLUDED.round_trip_change_percent, round_trip_sample_count=EXCLUDED.round_trip_sample_count,
      weather_risk_total=EXCLUDED.weather_risk_total, weather_risk_severe=EXCLUDED.weather_risk_severe,
      weather_risk_very_high=EXCLUDED.weather_risk_very_high, weather_risk_high=EXCLUDED.weather_risk_high,
      weather_risk_moderate=EXCLUDED.weather_risk_moderate, weather_risk_details=EXCLUDED.weather_risk_details,
      status_pre_pour=EXCLUDED.status_pre_pour, status_in_process=EXCLUDED.status_in_process,
      status_completed=EXCLUDED.status_completed, status_canceled=EXCLUDED.status_canceled,
      top_products=EXCLUDED.top_products, computed_at=NOW()
    RETURNING id`;
  const params = [
    row.report_date, row.company_code || 'ALL', row.plant_code || null, row.region_name || null,
    row.late_orders_total||0, row.late_not_started||0, row.late_slow_progress||0, row.late_past_finish||0,
    JSON.stringify(row.late_orders_details||[]),
    row.stuck_at_job_total||0, JSON.stringify(row.stuck_at_job_details||[]),
    row.slow_plants_total||0, JSON.stringify(row.slow_plants_details||[]),
    row.congested_sites_total||0, JSON.stringify(row.congested_sites_details||[]),
    row.avg_round_trip_minutes??null, row.avg_round_trip_display??null, row.prev_day_avg_round_trip_minutes??null,
    row.round_trip_change_percent??null, row.round_trip_sample_count||0,
    row.weather_risk_total||0, row.weather_risk_severe||0, row.weather_risk_very_high||0, row.weather_risk_high||0, row.weather_risk_moderate||0,
    JSON.stringify(row.weather_risk_details||[]),
    row.status_pre_pour||0, row.status_in_process||0, row.status_completed||0, row.status_canceled||0,
    JSON.stringify(row.top_products||[]),
  ];
  return executeDirectSQL(sql, params);
}

async function loadConfig() {
  try {
    const result = await executeDirectSQL('SELECT config_key, config_value, default_value, data_type FROM daily_intelligence_config');
    const config = {};
    for (const row of (result.data || [])) {
      const raw = row.config_value ?? row.default_value;
      config[row.config_key] = row.data_type === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
    }
    return config;
  } catch { return {}; }
}

// ─── Data fetchers ─────────────────────────────────────────────

// Shared WHERE clause for excluded_order_patterns
const EXCLUSION_FILTERS = `
  AND EXISTS (SELECT 1 FROM order_products op1 WHERE op1.order_id = o.order_id)
  AND EXISTS (SELECT 1 FROM order_products op2 WHERE op2.order_id = o.order_id AND op2.order_qty_unit = 'CY')
  AND NOT EXISTS (SELECT 1 FROM excluded_order_patterns eop WHERE eop.type='customer' AND eop.active=true AND LOWER(o.customer_name) LIKE '%'||LOWER(eop.pattern)||'%')
  AND NOT EXISTS (SELECT 1 FROM excluded_order_patterns eop WHERE eop.type='delivery_address' AND eop.active=true AND LOWER(o.delivery_addr1) LIKE '%'||LOWER(eop.pattern)||'%')
  AND NOT EXISTS (SELECT 1 FROM order_products op3 JOIN excluded_order_patterns eop ON eop.type='product' AND eop.active=true AND LOWER(op3.item_code) LIKE '%'||LOWER(eop.pattern)||'%' WHERE op3.order_id = o.order_id)`;

async function fetchOrderData(reportDate) {
  const sql = `
    SELECT o.order_id, o.order_code, o.order_date, o.current_status, o.removed, o.remove_reason_code,
      o.weather_data, o.customer_name, o.pricing_plant_code AS plant_code,
      op.id AS order_product_id, op.item_code, op.order_qty, op.order_qty_unit, op.delv_qty, op.is_mix,
      ops.start_time, ops.delivery_rate_per_hour
    FROM orders o
    LEFT JOIN order_products op ON op.order_id = o.order_id
    LEFT JOIN order_product_schedules ops ON ops.order_product_id = op.id
    WHERE o.order_date >= $1::date AND o.order_date < ($1::date + INTERVAL '1 day') ${EXCLUSION_FILTERS}
    ORDER BY o.order_id, op.id`;
  const r = await executeDirectSQL(sql, [reportDate]);
  return r.data || [];
}

async function fetchTicketData(reportDate) {
  const sql = `
    SELECT t.ticket_id, t.ticket_code, t.order_code, t.order_id, t.truck_code, t.plant_code,
      t.delivery_addr1, t.amount, t.printed_time, t.load_time, t.loaded_time,
      t.to_job_time, t.on_job_time, t.unload_time, t.end_unload, t.wash_time,
      t.to_plant_time, t.at_plant_time, t.remove_reason_code
    FROM tickets t
    WHERE t.order_date >= $1::date AND t.order_date < ($1::date + INTERVAL '1 day')
      AND EXISTS (SELECT 1 FROM orders o WHERE o.order_id = t.order_id ${EXCLUSION_FILTERS})
    ORDER BY t.order_code, t.printed_time`;
  const r = await executeDirectSQL(sql, [reportDate]);
  return r.data || [];
}

async function fetchPlantsAndRegions() {
  const r = await executeDirectSQL(`SELECT p.code, p.description AS plant_name, r.code AS region_code, r.description AS region_name FROM plants p LEFT JOIN regions r ON r.id = p.region_id ORDER BY p.code`);
  const plants = r.data || [];
  const regionMap = new Map();
  for (const p of plants) if (p.region_name && !regionMap.has(p.region_name)) regionMap.set(p.region_name, { code: p.region_code, name: p.region_name });
  return { plants, regions: Array.from(regionMap.values()) };
}

async function fetchPrevDayRoundTrip(reportDate, config) {
  const sql = `
    SELECT AVG(EXTRACT(EPOCH FROM (t.at_plant_time - t.printed_time))/60) AS avg_minutes, COUNT(*) AS sample_count
    FROM tickets t
    WHERE t.order_date >= ($1::date - INTERVAL '1 day') AND t.order_date < $1::date
      AND t.printed_time IS NOT NULL AND t.at_plant_time IS NOT NULL
      AND (t.remove_reason_code IS NULL OR TRIM(t.remove_reason_code)='')
      AND EXTRACT(EPOCH FROM (t.at_plant_time - t.printed_time))/60 BETWEEN $2 AND $3
      AND EXISTS (SELECT 1 FROM orders o WHERE o.order_id = t.order_id ${EXCLUSION_FILTERS})`;
  const r = await executeDirectSQL(sql, [reportDate, config.round_trip_valid_min_minutes, config.round_trip_valid_max_minutes]);
  const row = r.data?.[0];
  return { avg_minutes: row?.avg_minutes ? parseFloat(row.avg_minutes) : null, sample_count: parseInt(row?.sample_count || '0', 10) };
}

// ─── KPI computations ──────────────────────────────────────────

function formatTimeHHMM(date) {
  if (!date) return null;
  try { const d = new Date(date); return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`; } catch { return null; }
}

function computeLateOrders(orderRows, tickets, nowCdt, config) {
  const normalizeToToday = (st) => { const d = new Date(st); return new Date(Date.UTC(nowCdt.getUTCFullYear(), nowCdt.getUTCMonth(), nowCdt.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())); };
  const ordersMap = new Map();
  for (const r of orderRows) {
    if (!ordersMap.has(r.order_id)) ordersMap.set(r.order_id, { order_id:r.order_id, order_code:r.order_code, current_status:r.current_status, removed:r.removed, remove_reason_code:r.remove_reason_code, customer_name:r.customer_name, plant_code:r.plant_code, start_time:r.start_time?normalizeToToday(r.start_time):null, delivery_rate_per_hour:r.delivery_rate_per_hour, ordered_qty:0, delv_qty:0 });
    const o = ordersMap.get(r.order_id);
    if (r.is_mix && r.order_qty_unit === 'CY') { o.ordered_qty += parseFloat(r.order_qty||0); o.delv_qty += parseFloat(r.delv_qty||0); }
    if (r.start_time) { const st = normalizeToToday(r.start_time); if (!o.start_time || st < o.start_time) { o.start_time = st; o.delivery_rate_per_hour = r.delivery_rate_per_hour; } }
  }
  const orderTickets = new Map();
  for (const t of tickets) { if (!t.remove_reason_code || t.remove_reason_code.trim()==='') { if (!orderTickets.has(t.order_code)) orderTickets.set(t.order_code, []); orderTickets.get(t.order_code).push(t); } }
  let late_not_started=0, late_slow_progress=0, late_past_finish=0; const lateDetails = [];
  for (const order of ordersMap.values()) {
    if (order.removed && order.remove_reason_code && order.remove_reason_code.trim()!=='') continue;
    if (order.current_status === 4) continue;
    if (order.ordered_qty > 0 && order.delv_qty >= order.ordered_qty * 0.98) continue;
    if (!order.start_time) continue;
    const orderTix = orderTickets.get(order.order_code) || [];
    const hasLoaded = orderTix.some(t => t.load_time);
    const rate = parseFloat(order.delivery_rate_per_hour) || config.late_orders_delivery_rate_fallback;
    const estFinish = order.ordered_qty > 0 && rate > 0 ? new Date(order.start_time.getTime() + (order.ordered_qty/rate)*3600000) : null;
    if (!hasLoaded) {
      if (nowCdt > new Date(order.start_time.getTime() + config.late_orders_not_started_buffer_minutes*60000)) { late_not_started++; lateDetails.push({ order_code:order.order_code, order_id:order.order_id, reason:'not_started', start_time:formatTimeHHMM(order.start_time), customer_name:order.customer_name||null }); }
    } else {
      if (estFinish && nowCdt > estFinish) { late_past_finish++; lateDetails.push({ order_code:order.order_code, order_id:order.order_id, reason:'past_finish', start_time:formatTimeHHMM(order.start_time), estimated_finish:formatTimeHHMM(estFinish), customer_name:order.customer_name||null }); }
      else if (estFinish && order.ordered_qty > 0) { const totalMs = estFinish.getTime()-order.start_time.getTime(); const elapsedMs = nowCdt.getTime()-order.start_time.getTime(); if (totalMs>0 && elapsedMs>0) { const expPct = (elapsedMs/totalMs)*100; const actPct = (order.delv_qty/order.ordered_qty)*100; if (expPct > config.late_orders_slow_expected_pct && actPct < expPct*config.late_orders_slow_actual_factor) { late_slow_progress++; lateDetails.push({ order_code:order.order_code, order_id:order.order_id, reason:'slow_progress', start_time:formatTimeHHMM(order.start_time), delivered_pct:Math.round(actPct), expected_pct:Math.round(expPct), customer_name:order.customer_name||null }); } } }
    }
  }
  return { late_orders_total: late_not_started+late_slow_progress+late_past_finish, late_not_started, late_slow_progress, late_past_finish, late_orders_details: lateDetails.slice(0,config.max_detail_array_size) };
}

function computeStuckAtJob(tickets, nowCdt, config) {
  const details = [];
  for (const t of tickets) {
    if (t.remove_reason_code && t.remove_reason_code.trim()!=='') continue;
    if (!t.on_job_time) continue;
    if (t.to_plant_time || t.at_plant_time) continue;
    const ref = t.unload_time ? new Date(t.unload_time) : new Date(t.on_job_time);
    const idle = (nowCdt.getTime()-ref.getTime())/60000;
    if (idle > config.stuck_at_job_idle_minutes) details.push({ order_code:t.order_code, order_id:t.order_id, truck_code:t.truck_code, idle_minutes:Math.round(idle), delivery_addr:t.delivery_addr1||null });
  }
  return { stuck_at_job_total: details.length, stuck_at_job_details: details.slice(0,config.max_detail_array_size) };
}

function computeSlowPlants(tickets, plants, config) {
  const plantOutput = new Map(), plantOrders = new Map();
  for (const t of tickets) { if ((t.remove_reason_code&&t.remove_reason_code.trim()!=='')||!t.at_plant_time||!t.plant_code) continue; plantOutput.set(t.plant_code,(plantOutput.get(t.plant_code)||0)+parseFloat(t.amount||0)); if (!plantOrders.has(t.plant_code)) plantOrders.set(t.plant_code, new Set()); if (t.order_code) plantOrders.get(t.plant_code).add(t.order_code); }
  const active = Array.from(plantOutput.entries()).filter(([,cy])=>cy>0);
  if (active.length < config.slow_plants_min_count) return { slow_plants_total:0, slow_plants_details:[] };
  const avg = active.reduce((s,[,cy])=>s+cy,0)/active.length;
  const details = [];
  for (const [code,cy] of active) { if (cy < avg*config.slow_plants_output_pct) { const pi = plants.find(p=>p.code===code); details.push({ plant_code:code, plant_name:pi?.plant_name||code, output_cy:Math.round(cy*100)/100, avg_output_cy:Math.round(avg*100)/100, order_codes:Array.from(plantOrders.get(code)||[]) }); } }
  return { slow_plants_total: details.length, slow_plants_details: details };
}

function computeCongestedSites(tickets, config) {
  const siteMap = new Map();
  for (const t of tickets) { if ((t.remove_reason_code&&t.remove_reason_code.trim()!=='')||!t.delivery_addr1||!(t.to_job_time||t.on_job_time)||t.at_plant_time) continue; const a=t.delivery_addr1.trim(); if(!siteMap.has(a)) siteMap.set(a,{trucks:new Set(),orderCodes:new Set()}); const s=siteMap.get(a); if(t.truck_code)s.trucks.add(t.truck_code); if(t.order_code)s.orderCodes.add(t.order_code); }
  const details = [];
  for (const [addr,site] of siteMap) if (site.trucks.size >= config.congested_sites_truck_threshold) details.push({ delivery_addr1:addr, truck_count:site.trucks.size, order_codes:Array.from(site.orderCodes) });
  return { congested_sites_total: details.length, congested_sites_details: details };
}

function computeAvgRoundTrip(tickets, prevDay, config) {
  const trips = [];
  for (const t of tickets) { if ((t.remove_reason_code&&t.remove_reason_code.trim()!=='')||!t.printed_time||!t.at_plant_time) continue; const m=(new Date(t.at_plant_time).getTime()-new Date(t.printed_time).getTime())/60000; if (m>=config.round_trip_valid_min_minutes&&m<=config.round_trip_valid_max_minutes) trips.push(m); }
  if (!trips.length) return { avg_round_trip_minutes:null, avg_round_trip_display:null, prev_day_avg_round_trip_minutes:prevDay.avg_minutes, round_trip_change_percent:null, round_trip_sample_count:0 };
  const avg = trips.reduce((s,m)=>s+m,0)/trips.length;
  const hrs = Math.floor(avg/60), mins = Math.round(avg%60);
  let change = null;
  if (prevDay.avg_minutes && prevDay.avg_minutes > 0) change = Math.round(((avg-prevDay.avg_minutes)/prevDay.avg_minutes)*10000)/100;
  return { avg_round_trip_minutes:Math.round(avg*100)/100, avg_round_trip_display:hrs>0?`${hrs}h ${mins}m`:`${mins}m`, prev_day_avg_round_trip_minutes:prevDay.avg_minutes?Math.round(prevDay.avg_minutes*100)/100:null, round_trip_change_percent:change, round_trip_sample_count:trips.length };
}

function computeWeatherRisk(orderRows, config) {
  const seen = new Set(); let severe=0,veryHigh=0,high=0,moderate=0; const details=[];
  for (const r of orderRows) { if (seen.has(r.order_id)) continue; seen.add(r.order_id); if (r.removed&&r.remove_reason_code&&r.remove_reason_code.trim()!=='') continue; if (!r.weather_data) continue; const wd = typeof r.weather_data==='string'?JSON.parse(r.weather_data):r.weather_data; const rate=parseFloat(wd?.evaporation_rate); if (isNaN(rate)) continue; let sev=null; if(rate>=0.4){severe++;sev='severe';}else if(rate>=0.3){veryHigh++;sev='very_high';}else if(rate>=0.2){high++;sev='high';}else if(rate>=0.1){moderate++;sev='moderate';} if(sev) details.push({order_code:r.order_code,order_id:r.order_id,severity:sev,evaporation_rate:Math.round(rate*100)/100,customer_name:r.customer_name||null}); }
  return { weather_risk_total:severe+veryHigh+high+moderate, weather_risk_severe:severe, weather_risk_very_high:veryHigh, weather_risk_high:high, weather_risk_moderate:moderate, weather_risk_details:details.slice(0,config.max_detail_array_size) };
}

function computeStatusCounts(orderRows, tickets) {
  const ordersMap = new Map();
  for (const r of orderRows) { if (!ordersMap.has(r.order_id)) ordersMap.set(r.order_id, { order_id:r.order_id, order_code:r.order_code, current_status:r.current_status, removed:r.removed, remove_reason_code:r.remove_reason_code, ordered_qty:0, delv_qty:0 }); const o=ordersMap.get(r.order_id); if(r.is_mix&&r.order_qty_unit==='CY'){o.ordered_qty+=parseFloat(r.order_qty||0);o.delv_qty+=parseFloat(r.delv_qty||0);} }
  const tixMap = new Map();
  for (const t of tickets) { if (t.remove_reason_code&&t.remove_reason_code.trim()!=='') continue; if (!tixMap.has(t.order_code)) tixMap.set(t.order_code,[]); tixMap.get(t.order_code).push(t); }
  let prePour=0,inProcess=0,completed=0,canceled=0;
  for (const o of ordersMap.values()) { if(o.removed&&o.remove_reason_code&&o.remove_reason_code.trim()!==''){canceled++;continue;} if(o.current_status===4){completed++;continue;} const tix=tixMap.get(o.order_code)||[]; if(tix.some(t=>t.load_time)){const allDone=o.ordered_qty>0&&(o.ordered_qty-o.delv_qty)<=0.02;const last=tix[tix.length-1];if(allDone&&last?.at_plant_time)completed++;else inProcess++;}else{prePour++;} }
  return { status_pre_pour:prePour, status_in_process:inProcess, status_completed:completed, status_canceled:canceled };
}

function computeTopProducts(orderRows) {
  const first = new Map();
  for (const r of orderRows) { if (r.removed&&r.remove_reason_code&&r.remove_reason_code.trim()!=='') continue; if (!r.item_code) continue; if (!first.has(r.order_id)) first.set(r.order_id, r.item_code); }
  const counts = new Map();
  for (const ic of first.values()) counts.set(ic,(counts.get(ic)||0)+1);
  return { top_products: Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([item_code,count])=>({item_code,count})) };
}

// ─── Scope KPI builder ─────────────────────────────────────────

function computeKPIsForScope(reportDate, companyCode, plantCode, regionName, orders, tickets, plantsRegions, prevDayRT, nowUtc, nowCdt, config) {
  const row = { report_date: reportDate, company_code: companyCode, plant_code: plantCode, region_name: regionName };
  const safe = (fn, fallback) => { try { Object.assign(row, fn()); } catch (e) { console.error(`[${MODULE_NAME}] KPI failed for ${plantCode||regionName||'company'}:`, e.message); Object.assign(row, fallback); } };
  safe(() => computeLateOrders(orders, tickets, nowCdt, config), { late_orders_total:0, late_not_started:0, late_slow_progress:0, late_past_finish:0, late_orders_details:[] });
  safe(() => computeStuckAtJob(tickets, nowCdt, config), { stuck_at_job_total:0, stuck_at_job_details:[] });
  safe(() => computeSlowPlants(tickets, plantsRegions.plants, config), { slow_plants_total:0, slow_plants_details:[] });
  safe(() => computeCongestedSites(tickets, config), { congested_sites_total:0, congested_sites_details:[] });
  safe(() => computeAvgRoundTrip(tickets, prevDayRT, config), { avg_round_trip_minutes:null, avg_round_trip_display:null, prev_day_avg_round_trip_minutes:null, round_trip_change_percent:null, round_trip_sample_count:0 });
  safe(() => computeWeatherRisk(orders, config), { weather_risk_total:0, weather_risk_severe:0, weather_risk_very_high:0, weather_risk_high:0, weather_risk_moderate:0, weather_risk_details:[] });
  safe(() => computeStatusCounts(orders, tickets), { status_pre_pour:0, status_in_process:0, status_completed:0, status_canceled:0 });
  safe(() => computeTopProducts(orders), { top_products:[] });
  return row;
}

// ─── Main computation ──────────────────────────────────────────

let _isRunning = false;

async function computeDailyIntelligence() {
  if (_isRunning) { console.log(`[${MODULE_NAME}] Already running, skipping`); return; }

  // Skip off-hours (only run at :00 and :30 outside business hours)
  const cdtNow = new Date(new Date().toLocaleString('en-US', { timeZone: CDT_TIMEZONE }));
  const hour = cdtNow.getHours(), minute = cdtNow.getMinutes();
  const isBizHours = hour >= DEFAULT_CONFIG.business_hours_start_cdt && hour < DEFAULT_CONFIG.business_hours_end_cdt;
  if (!isBizHours && minute !== 0 && minute !== 30) return;

  _isRunning = true;
  const start = Date.now();
  try {
    const dateResult = await executeDirectSQL(`SELECT (NOW() AT TIME ZONE 'America/Chicago')::date AS report_date`);
    const reportDate = dateResult.data[0].report_date;

    const dbConfig = await loadConfig();
    const config = { ...DEFAULT_CONFIG, ...dbConfig };

    const [orders, tickets, plantsRegions, prevDayRT] = await Promise.all([
      fetchOrderData(reportDate), fetchTicketData(reportDate),
      fetchPlantsAndRegions(), fetchPrevDayRoundTrip(reportDate, config),
    ]);

    console.log(`[${MODULE_NAME}] Fetched: ${orders.length} orders, ${tickets.length} tickets, ${plantsRegions.plants.length} plants`);

    const nowUtc = new Date();
    const cdtParts = new Date(nowUtc.toLocaleString('en-US', { timeZone: CDT_TIMEZONE }));
    const nowCdt = new Date(Date.UTC(cdtParts.getFullYear(), cdtParts.getMonth(), cdtParts.getDate(), cdtParts.getHours(), cdtParts.getMinutes(), cdtParts.getSeconds()));

    const rows = [];
    rows.push(computeKPIsForScope(reportDate, 'ALL', null, null, orders, tickets, plantsRegions, prevDayRT, nowUtc, nowCdt, config));

    const activePlants = new Set();
    for (const o of orders) if (o.plant_code) activePlants.add(o.plant_code);
    for (const t of tickets) if (t.plant_code) activePlants.add(t.plant_code);
    for (const pc of activePlants) rows.push(computeKPIsForScope(reportDate, 'ALL', pc, null, orders.filter(o=>o.plant_code===pc), tickets.filter(t=>t.plant_code===pc), plantsRegions, prevDayRT, nowUtc, nowCdt, config));

    const activeRegions = new Set();
    for (const pc of activePlants) { const p = plantsRegions.plants.find(x=>x.code===pc); if (p?.region_name) activeRegions.add(p.region_name); }
    for (const rn of activeRegions) { const rpc = plantsRegions.plants.filter(p=>p.region_name===rn).map(p=>p.code); rows.push(computeKPIsForScope(reportDate, 'ALL', null, rn, orders.filter(o=>rpc.includes(o.plant_code)), tickets.filter(t=>rpc.includes(t.plant_code)), plantsRegions, prevDayRT, nowUtc, nowCdt, config)); }

    let success = 0, failed = 0;
    for (const row of rows) { try { await upsertRow(row); success++; } catch (e) { failed++; console.error(`[${MODULE_NAME}] Upsert failed:`, e.message); } }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[${MODULE_NAME}] Done: ${success} upserted, ${failed} failed, ${rows.length} scopes in ${elapsed}s`);
  } catch (error) {
    console.error(`[${MODULE_NAME}] Computation failed:`, error.message);
  } finally {
    _isRunning = false;
  }
}

// ─── Interval management ───────────────────────────────────────

let _intervalId = null;

function startDailyIntelligenceCron() {
  if (_intervalId) { console.log(`[${MODULE_NAME}] Already running`); return; }
  const intervalMs = 2 * 60 * 1000; // 2 minutes
  console.log(`[${MODULE_NAME}] Starting cron (every 2 minutes)`);
  // Run immediately, then every 2 minutes
  computeDailyIntelligence().catch(e => console.error(`[${MODULE_NAME}] Initial run failed:`, e.message));
  _intervalId = setInterval(() => computeDailyIntelligence().catch(e => console.error(`[${MODULE_NAME}] Run failed:`, e.message)), intervalMs);
  _intervalId.unref();
}

function stopDailyIntelligenceCron() {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; console.log(`[${MODULE_NAME}] Stopped`); }
}

module.exports = { startDailyIntelligenceCron, stopDailyIntelligenceCron, computeDailyIntelligence };
