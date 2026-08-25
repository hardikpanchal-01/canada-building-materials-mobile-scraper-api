const { executeDirectSQL } = require('../utils/postgresExecutor');

// Columns for order_entities reads:
// - on_job_date is a DATE column → cast to text so consumers get "YYYY-MM-DD" strings (they call .split('-'))
// - quantity is NUMERIC → cast to float8 so consumers get a number (node-pg returns numeric as string)
// Appended after * so the casted values override the raw columns in the result row.
const ORDER_ENTITY_SELECT = '*, on_job_date::text AS on_job_date, quantity::float8 AS quantity';

// on_job_time is a TIME column; convertTimeToUtc may produce a UTC ISO string
// ("2026-05-18T19:30:00.000Z") which Postgres' time parser rejects because of the 'T'
// separator. Replacing 'T' with a space makes it parseable and stores the UTC time
// component (same value the database stored). Plain legacy times ("14:30", "6:29 PM") pass through unchanged.
const ON_JOB_TIME_CAST = (p) => `replace(${p}::text, 'T', ' ')::time`;

// Fallback timezone when no tenant/user timezone is available
const FALLBACK_TZ = 'America/Chicago';

/**
 * Format an ISO timestamp to the user's timezone.
 * e.g. "2026-02-18T18:40:00Z" → "02/18/2026, 12:40 PM"
 */
function formatDateTimeTo12h(dateTimeStr, tz) {
  if (!dateTimeStr) return null;
  const date = new Date(dateTimeStr);
  if (isNaN(date.getTime())) return dateTimeStr;
  const timeZone = tz?.iana || FALLBACK_TZ;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

/**
 * Convert on_job_time (plain time like "12:40") from the tenant's stored timezone
 * to the user's selected timezone.
 * Combines on_job_date + on_job_time → creates datetime in tenant tz → converts to user tz.
 * Returns "HH:MM AM/PM" e.g. "01:40 PM"
 *
 * @param {string} onJobDate - date string like "2026-05-18"
 * @param {string} onJobTime - time string like "12:40" or "6:29 PM"
 * @param {Object} tz - user's timezone { iana: "America/New_York" }
 * @param {Object} tenantTz - tenant's timezone { iana: "America/Chicago" } (storage tz)
 */
function convertOnJobTime(onJobDate, onJobTime, tz, tenantTz) {
  if (!onJobTime) return null;
  const userTimeZone = tz?.iana || FALLBACK_TZ;

  // NEW FORMAT: UTC ISO string (e.g., "2026-05-18T19:30:00.000Z")
  // Stored as UTC — just format directly in user's timezone (always correct)
  if (isUtcIso(onJobTime)) {
    const date = new Date(onJobTime);
    if (isNaN(date.getTime())) return onJobTime;
    return new Intl.DateTimeFormat('en-US', {
      timeZone: userTimeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(date);
  }

  // LEGACY FORMAT: plain time string (e.g., "14:30", "2:30 PM")
  // Assumed to be in tenant's timezone — convert to user's timezone
  const storedTimeZone = tenantTz?.iana || FALLBACK_TZ;

  // If user tz and stored tz are the same, no conversion needed — just format
  if (userTimeZone === storedTimeZone) {
    return formatPlainTime(onJobTime);
  }

  const str = String(onJobTime).trim();
  let hours, minutes;

  const match12h = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (match12h) {
    let h = parseInt(match12h[1], 10);
    minutes = parseInt(match12h[2], 10);
    const period = match12h[3].toUpperCase();
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    hours = h;
  } else {
    const match24h = str.match(/^(\d{1,2}):(\d{2})/);
    if (!match24h) return onJobTime;
    hours = parseInt(match24h[1], 10);
    minutes = parseInt(match24h[2], 10);
  }

  const dateStr = onJobDate || new Date().toISOString().slice(0, 10);
  const [y, m, d] = dateStr.split('-').map(Number);
  const naiveUtc = new Date(Date.UTC(y, m - 1, d, hours, minutes, 0));
  if (isNaN(naiveUtc.getTime())) return onJobTime;

  const storedOffset = getUtcOffsetMs(storedTimeZone, naiveUtc);
  const realUtc = new Date(naiveUtc.getTime() - storedOffset);

  return new Intl.DateTimeFormat('en-US', {
    timeZone: userTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(realUtc);
}

/**
 * Format a plain time string to 12h format without timezone conversion.
 */
function formatPlainTime(timeStr) {
  if (!timeStr) return null;
  const str = String(timeStr).trim();
  const match12h = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (match12h) return str; // already 12h format

  const match24h = str.match(/^(\d{1,2}):(\d{2})/);
  if (!match24h) return timeStr;
  const h = parseInt(match24h[1], 10);
  const m = match24h[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${String(h12).padStart(2, '0')}:${m} ${ampm}`;
}

/**
 * Get UTC offset in milliseconds for a timezone on a given date.
 */
function getUtcOffsetMs(timeZone, date) {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = date.toLocaleString('en-US', { timeZone });
  return new Date(tzStr) - new Date(utcStr);
}

/**
 * Check if a string is a UTC ISO timestamp (e.g., "2026-05-18T19:30:00.000Z").
 */
function isUtcIso(str) {
  return typeof str === 'string' && str.includes('T');
}

/**
 * Convert on_job_date + on_job_time (plain time) + tenantTz → UTC ISO string.
 * Used at storage time so the exact moment is preserved regardless of future tz changes.
 */
function convertTimeToUtc(onJobDate, onJobTime, tenantTz) {
  if (!onJobTime || !onJobDate) return onJobTime;
  // If already UTC ISO, return as-is
  if (isUtcIso(onJobTime)) return onJobTime;

  const storedTimeZone = tenantTz?.iana || FALLBACK_TZ;
  const str = String(onJobTime).trim();
  let hours, minutes;

  const match12h = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (match12h) {
    let h = parseInt(match12h[1], 10);
    minutes = parseInt(match12h[2], 10);
    const period = match12h[3].toUpperCase();
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    hours = h;
  } else {
    const match24h = str.match(/^(\d{1,2}):(\d{2})/);
    if (!match24h) return onJobTime;
    hours = parseInt(match24h[1], 10);
    minutes = parseInt(match24h[2], 10);
  }

  const [y, m, d] = onJobDate.split('-').map(Number);
  const naiveUtc = new Date(Date.UTC(y, m - 1, d, hours, minutes, 0));
  if (isNaN(naiveUtc.getTime())) return onJobTime;

  const storedOffset = getUtcOffsetMs(storedTimeZone, naiveUtc);
  const realUtc = new Date(naiveUtc.getTime() - storedOffset);
  return realUtc.toISOString();
}

/**
 * Convert a UTC ISO on_job_time back to a plain HH:MM time string in a target timezone.
 * Used for edit forms — the frontend needs a simple time for the time picker.
 */
function convertUtcToPlainTime(utcIso, tenantTz) {
  if (!utcIso) return null;
  if (!isUtcIso(utcIso)) return formatPlainTime(utcIso); // legacy plain time, format to 12h
  const date = new Date(utcIso);
  if (isNaN(date.getTime())) return utcIso;
  const timeZone = tenantTz?.iana || FALLBACK_TZ;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * Format time fields on an order request row.
 * - on_job_time: converted from tenant's stored timezone to user's timezone
 * - created_at/updated_at: converted to user's timezone (real UTC timestamps)
 *
 * @param {Object} row - order request row from DB
 * @param {Object} tz - user's timezone { iana: "America/New_York" }
 * @param {Object} tenantTz - tenant's timezone { iana: "America/Chicago" } (storage tz)
 */
function formatOrderRow(row, tz, tenantTz) {
  if (!row) return row;
  return {
    ...row,
    on_job_time: convertOnJobTime(row.on_job_date, row.on_job_time, tz, tenantTz),
    on_job_time_raw: convertUtcToPlainTime(row.on_job_time, tenantTz),
    created_at: formatDateTimeTo12h(row.created_at, tz),
    updated_at: formatDateTimeTo12h(row.updated_at, tz),
  };
}

// Get order requests with pagination, filtering, and search
async function getOrderRequests({ userId, userIds, isAdmin, userType, page = 1, limit = 15, status, search, tz, tenantTz } = {}) {
  // For contractor filtering, use userIds array (handles UUID migration)
  // Falls back to [userId] if userIds not provided (backward compatibility)
  const contractorIds = userIds && userIds.length > 0 ? userIds : (userId ? [userId] : []);

  // Scope by user if not admin/producer (contractor sees only their own)
  const scopeByUser = !isAdmin && userType !== 'producer' && contractorIds.length > 0;

  // --- DB-level counts in a single aggregated query (no rows transferred) ---
  let counts;
  try {
    const countParams = [];
    let countWhere = '';
    if (scopeByUser) {
      countParams.push(contractorIds);
      countWhere = ' WHERE user_id = ANY($1::uuid[])';
    }
    const countResult = await executeDirectSQL(
      `SELECT
         count(*)::int AS total,
         (count(*) FILTER (WHERE status = 'pending'))::int AS pending,
         (count(*) FILTER (WHERE status = 'submitted'))::int AS submitted,
         (count(*) FILTER (WHERE status = 'approved'))::int AS approved,
         (count(*) FILTER (WHERE status IN ('rejected', 'canceled')))::int AS rejected
       FROM order_entities${countWhere}`,
      countParams
    );
    const c = countResult.data[0] || {};
    counts = {
      total: c.total || 0,
      pending: c.pending || 0,
      submitted: c.submitted || 0,
      approved: c.approved || 0,
      rejected: c.rejected || 0,
    };
  } catch (countError) {
    throw new Error(`Failed to fetch counts: ${countError.message}`);
  }

  // --- Build paginated data query ---
  const conds = [];
  const params = [];

  if (scopeByUser) {
    params.push(contractorIds);
    conds.push(`user_id = ANY($${params.length}::uuid[])`);
  }

  // Status filter
  if (status && status !== 'all') {
    if (status === 'rejected') {
      conds.push(`status IN ('rejected', 'canceled')`);
    } else {
      params.push(status);
      conds.push(`status = $${params.length}`);
    }
  }

  // Search filter
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    const p = `$${params.length}`;
    conds.push(
      `(job_name ILIKE ${p} OR company_name ILIKE ${p} OR job_address ILIKE ${p} OR job_city ILIKE ${p} OR concrete_product_name ILIKE ${p} OR po_number ILIKE ${p})`
    );
  }

  const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';

  // Ordering and pagination
  const offset = (page - 1) * limit;

  let data, count;
  try {
    const dataParams = params.concat([limit, offset]);
    const [dataResult, filteredCountResult] = await Promise.all([
      executeDirectSQL(
        `SELECT ${ORDER_ENTITY_SELECT} FROM order_entities${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        dataParams
      ),
      executeDirectSQL(
        `SELECT count(*)::int AS count FROM order_entities${where}`,
        params
      ),
    ]);
    data = dataResult.data;
    count = (filteredCountResult.data[0] || {}).count;
  } catch (error) {
    throw new Error(`Failed to fetch order requests: ${error.message}`);
  }

  const total = count || 0;
  const totalPages = Math.ceil(total / limit);

  return {
    orders: (data || []).map(row => formatOrderRow(row, tz, tenantTz)),
    counts,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      has_next: page < totalPages,
    },
  };
}

// Get single order request by ID
async function getOrderRequestById(id, tz = null, tenantTz = null) {
  let data;
  try {
    const result = await executeDirectSQL(
      `SELECT ${ORDER_ENTITY_SELECT} FROM order_entities WHERE id = $1 LIMIT 1`,
      [id]
    );
    data = result.data[0] || null;
  } catch (error) {
    throw new Error(`Order request not found: ${error.message}`);
  }

  // .single() errored when no row matched — keep throwing in that case
  if (!data) throw new Error('Order request not found: no rows returned');
  return tz ? formatOrderRow(data, tz, tenantTz) : data;
}

// Create order request
async function createOrderRequest(input, tenantTz = null) {
  const row = {
    user_id: input.user_id,
    order_type: input.order_type || 'without_project',
    project_code: input.project_code || null,
    project_name: input.project_name || null,
    company_id: input.company_id,
    company_name: input.company_name || null,
    referenced_order: input.referenced_order || null,
    region_code: input.region_code || null,
    region_name: input.region_name || null,
    customer_job_number: input.customer_job_number || null,
    usage_code: input.usage_code || null,
    usage_name: input.usage_name || null,
    pour_method_code: input.pour_method_code || null,
    pour_method_name: input.pour_method_name || null,
    po_number: input.po_number || null,
    order_status: input.order_status ?? 0,
    on_job_date: input.on_job_date,
    on_job_time: convertTimeToUtc(input.on_job_date, input.on_job_time, tenantTz),
    job_name: input.job_name || null,
    plant_code: input.plant_code || null,
    plant_name: input.plant_name || null,
    job_address: input.job_address,
    job_city: input.job_city,
    job_state: input.job_state || null,
    job_zip_code: input.job_zip_code || null,
    job_contact_name: input.job_contact_name,
    job_contact_phone: input.job_contact_phone,
    driver_instructions: input.driver_instructions || null,
    know_mix_code: input.know_mix_code ?? false,
    concrete_product_code: input.concrete_product_code || null,
    concrete_product_name: input.concrete_product_name || null,
    concrete_product_text: input.concrete_product_text || null,
    psi: input.psi || null,
    rock_size: input.rock_size || null,
    air_non_air: input.air_non_air || null,
    fly_ash: input.fly_ash || null,
    quantity: input.quantity || null,
    truck_spacing: input.truck_spacing || null,
    spacing_type: input.spacing_type || 'minutes',
    slump: input.slump || null,
    concrete_notes: input.concrete_notes || null,
    call_back_load: input.call_back_load || null,
    pumped: input.pumped ?? false,
    pump_type: input.pumped ? (input.pump_type || null) : null,
    admixture_product_code: input.admixture_product_code || null,
    admixture_product_name: input.admixture_product_name || null,
    admixture_notes: input.admixture_notes || null,
    other_product_code: input.other_product_code || null,
    other_product_name: input.other_product_name || null,
    other_notes: input.other_notes || null,
  };

  const columns = Object.keys(row);
  const params = Object.values(row);
  const placeholders = columns.map((col, i) =>
    col === 'on_job_time' ? ON_JOB_TIME_CAST(`$${i + 1}`) : `$${i + 1}`
  );

  try {
    const result = await executeDirectSQL(
      `INSERT INTO order_entities (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
      params
    );
    return result.data[0];
  } catch (error) {
    throw new Error(`Failed to create order request: ${error.message}`);
  }
}

// Update order request
async function updateOrderRequest(id, input, tenantTz = null) {
  const row = {
      order_type: input.order_type || 'without_project',
      project_code: input.project_code || null,
      project_name: input.project_name || null,
      company_id: input.company_id,
      company_name: input.company_name || null,
      referenced_order: input.referenced_order || null,
      region_code: input.region_code || null,
      region_name: input.region_name || null,
      customer_job_number: input.customer_job_number || null,
      usage_code: input.usage_code || null,
      usage_name: input.usage_name || null,
      pour_method_code: input.pour_method_code || null,
      pour_method_name: input.pour_method_name || null,
      po_number: input.po_number || null,
      order_status: input.order_status ?? 0,
      on_job_date: input.on_job_date,
      on_job_time: convertTimeToUtc(input.on_job_date, input.on_job_time, tenantTz),
      job_name: input.job_name || null,
      plant_code: input.plant_code || null,
      plant_name: input.plant_name || null,
      job_address: input.job_address,
      job_city: input.job_city,
      job_state: input.job_state || null,
      job_zip_code: input.job_zip_code || null,
      job_contact_name: input.job_contact_name,
      job_contact_phone: input.job_contact_phone,
      driver_instructions: input.driver_instructions || null,
      know_mix_code: input.know_mix_code ?? false,
      concrete_product_code: input.concrete_product_code || null,
      concrete_product_name: input.concrete_product_name || null,
      concrete_product_text: input.concrete_product_text || null,
      psi: input.psi || null,
      rock_size: input.rock_size || null,
      air_non_air: input.air_non_air || null,
      fly_ash: input.fly_ash || null,
      quantity: input.quantity || null,
      truck_spacing: input.truck_spacing || null,
      spacing_type: input.spacing_type || 'minutes',
      slump: input.slump || null,
      concrete_notes: input.concrete_notes || null,
      call_back_load: input.call_back_load || null,
      pumped: input.pumped ?? false,
      pump_type: input.pumped ? (input.pump_type || null) : null,
      admixture_product_code: input.admixture_product_code || null,
      admixture_product_name: input.admixture_product_name || null,
      admixture_notes: input.admixture_notes || null,
      other_product_code: input.other_product_code || null,
      other_product_name: input.other_product_name || null,
      other_notes: input.other_notes || null,
      updated_at: new Date().toISOString(),
  };

  const columns = Object.keys(row);
  const params = Object.values(row);
  const setClauses = columns.map((col, i) =>
    col === 'on_job_time' ? `${col} = ${ON_JOB_TIME_CAST(`$${i + 1}`)}` : `${col} = $${i + 1}`
  );
  params.push(id);

  try {
    await executeDirectSQL(
      `UPDATE order_entities SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
      params
    );
  } catch (error) {
    throw new Error(`Failed to update order request: ${error.message}`);
  }
  return { id };
}

// Update status
async function updateOrderRequestStatus(id, status) {
  const validStatuses = ['pending', 'submitted', 'approved', 'rejected', 'canceled'];
  if (!validStatuses.includes(status)) {
    throw new Error('Invalid status');
  }

  try {
    await executeDirectSQL(
      `UPDATE order_entities SET status = $1, updated_at = $2 WHERE id = $3`,
      [status, new Date().toISOString(), id]
    );
  } catch (error) {
    throw new Error(`Failed to update status: ${error.message}`);
  }
  return { id, status };
}

// Update verification fields
async function updateOrderVerification(id, data, tenantTz = null) {
  const updatePayload = { updated_at: new Date().toISOString() };

  if (data.order_number !== undefined) updatePayload.order_number = data.order_number || null;
  if (data.order_status !== undefined) updatePayload.order_status = data.order_status;
  if (data.on_job_date !== undefined) updatePayload.on_job_date = data.on_job_date;
  if (data.on_job_time !== undefined) {
    const dateForConversion = data.on_job_date || updatePayload.on_job_date;
    updatePayload.on_job_time = convertTimeToUtc(dateForConversion, data.on_job_time, tenantTz);
  }

  const columns = Object.keys(updatePayload);
  const params = Object.values(updatePayload);
  const setClauses = columns.map((col, i) =>
    col === 'on_job_time' ? `${col} = ${ON_JOB_TIME_CAST(`$${i + 1}`)}` : `${col} = $${i + 1}`
  );
  params.push(id);

  try {
    await executeDirectSQL(
      `UPDATE order_entities SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
      params
    );
  } catch (error) {
    throw new Error(`Failed to update verification: ${error.message}`);
  }
  return { id };
}

// Get messages for an order request
async function getMessages(orderEntityId, tz = null) {
  let data;
  try {
    const result = await executeDirectSQL(
      `SELECT * FROM order_entity_messages WHERE order_entity_id = $1 ORDER BY created_at ASC`,
      [orderEntityId]
    );
    data = result.data;
  } catch (error) {
    throw new Error(`Failed to fetch messages: ${error.message}`);
  }
  const messages = data || [];
  if (tz) {
    return messages.map(msg => ({
      ...msg,
      created_at: formatDateTimeTo12h(msg.created_at, tz),
    }));
  }
  return messages;
}

// Send a message
async function sendMessage(orderEntityId, senderId, messageText, senderRole, tz = null) {
  // Fetch sender name server-side (lookup errors are ignored, same as before)
  let userProfile = null;
  try {
    const userResult = await executeDirectSQL(
      `SELECT full_name, email FROM users WHERE id = $1 LIMIT 1`,
      [senderId]
    );
    userProfile = userResult.data[0] || null;
  } catch {
    userProfile = null;
  }

  const senderName = userProfile?.full_name || userProfile?.email || 'Unknown User';

  let data;
  try {
    const result = await executeDirectSQL(
      `INSERT INTO order_entity_messages (order_entity_id, sender_id, sender_name, sender_role, message_text)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [orderEntityId, senderId, senderName, senderRole, messageText.trim()]
    );
    data = result.data[0];
  } catch (error) {
    throw new Error(`Failed to send message: ${error.message}`);
  }
  if (tz) {
    return { ...data, created_at: formatDateTimeTo12h(data.created_at, tz) };
  }
  return data;
}

// Simple in-memory cache for form data (refreshes every 5 minutes)
let formDataCache = null;
let formDataCacheTime = 0;
const FORM_DATA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Batch-fetch helper for large tables
// whereClause is a plain SQL condition (no user input — internal callers only)
async function fetchAllBatched(table, selectFields, whereClause, orderField, batchSize = 1000) {
  let all = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let data;
    try {
      const result = await executeDirectSQL(
        `SELECT ${selectFields} FROM ${table}${whereClause ? ` WHERE ${whereClause}` : ''} ORDER BY ${orderField} ASC LIMIT $1 OFFSET $2`,
        [batchSize, offset]
      );
      data = result.data;
    } catch (error) {
      throw new Error(`Failed to fetch ${table}: ${error.message}`);
    }
    if (data && data.length > 0) {
      all = all.concat(data);
      offset += batchSize;
      hasMore = data.length === batchSize;
    } else {
      hasMore = false;
    }
  }
  return all;
}

// Get form data (regions, customers, projects, admixture & other products)
async function getFormData() {
  // Return cached data if still fresh
  if (formDataCache && (Date.now() - formDataCacheTime) < FORM_DATA_CACHE_TTL) {
    return formDataCache;
  }

  // Run ALL 5 fetches in parallel
  const [regions, customers, projects, admixtureRaw, otherRaw] = await Promise.all([
    // 1. Regions (small table - single query)
    executeDirectSQL(`SELECT code, description FROM regions ORDER BY description ASC`)
      .then((result) => result.data || [])
      .catch((error) => {
        throw new Error(`Failed to fetch regions: ${error.message}`);
      }),

    // 2. Customers (large table - batched)
    fetchAllBatched('customers', 'code, name',
      '(inactive IS NULL OR inactive = false)', 'name'),

    // 3. Projects (large table - batched)
    fetchAllBatched('projects',
      'id, code, name, customer_code, customer_name, delivery_addr1, delivery_addr2, delivery_addr3, contact, phone',
      null, 'name'),

    // 4. Admixture products (matches web query exactly - no ORDER BY before limit)
    executeDirectSQL(
      `SELECT item_code, description FROM order_products
       WHERE is_mix = false AND item_code IS NOT NULL
         AND (description ILIKE ANY($1::text[]))
       LIMIT 2000`,
      [['%admix%', '%retard%', '%mrwra%', '%calcium%', '%accelerat%']]
    )
      .then((result) => result.data || [])
      .catch(() => []),

    // 5. Other products (matches web query exactly - no ORDER BY before limit)
    executeDirectSQL(
      `SELECT item_code, description FROM order_products
       WHERE is_mix = false AND item_code IS NOT NULL
       LIMIT 2000`
    )
      .then((result) => result.data || [])
      .catch(() => []),
  ]);

  // Deduplicate admixture products by item_code
  // Label format matches web: description only (or code if no description)
  const admixturesSeen = new Map();
  for (const row of admixtureRaw) {
    if (!row.item_code) continue;
    if (!admixturesSeen.has(row.item_code)) {
      const desc = row.description || '';
      admixturesSeen.set(row.item_code, { value: row.item_code, label: desc || row.item_code });
    }
  }

  // Deduplicate other products by item_code
  const otherSeen = new Map();
  for (const row of otherRaw) {
    if (!row.item_code) continue;
    if (!otherSeen.has(row.item_code)) {
      const desc = row.description || '';
      otherSeen.set(row.item_code, { value: row.item_code, label: desc || row.item_code });
    }
  }

  const result = {
    regions,
    customers,
    projects,
    admixtureProducts: Array.from(admixturesSeen.values()).sort((a, b) => a.value.localeCompare(b.value)),
    otherProducts: Array.from(otherSeen.values()).sort((a, b) => a.value.localeCompare(b.value)),
  };

  // Cache the result
  formDataCache = result;
  formDataCacheTime = Date.now();

  return result;
}

// Get orders by project code (for auto-filling referenced order when project is selected)
async function getOrdersByProjectCode(projectCode) {
  if (!projectCode || !projectCode.trim()) {
    return [];
  }

  let data;
  try {
    const result = await executeDirectSQL(
      `SELECT order_id, order_code, customer_code, customer_name, order_date, project_name, delivery_addr1, delivery_addr2, delivery_addr3, ordered_by_name, ordered_by_phone, pricing_plant_code, zone_name
       FROM orders
       WHERE project_code = $1
       ORDER BY order_date DESC
       LIMIT 50`,
      [projectCode.trim()]
    );
    data = result.data;
  } catch (error) {
    throw new Error(`Failed to fetch orders by project code: ${error.message}`);
  }

  return data || [];
}

// Search orders by code (for referenced order dropdown)
async function searchOrders(searchTerm) {
  if (!searchTerm || searchTerm.trim().length < 2) {
    return [];
  }

  const term = searchTerm.trim();

  // Use prefix match for order_code (index-friendly) and contains for customer_name
  let data;
  try {
    const result = await executeDirectSQL(
      `SELECT order_id, order_code, customer_code, customer_name, order_date, project_name, delivery_addr1, delivery_addr2, delivery_addr3, ordered_by_name, ordered_by_phone, pricing_plant_code, zone_name
       FROM orders
       WHERE (order_code ILIKE $1 OR customer_name ILIKE $2)
       LIMIT 50`,
      [`${term}%`, `%${term}%`]
    );
    data = result.data;
  } catch (error) {
    throw new Error(`Failed to search orders: ${error.message}`);
  }

  // Deduplicate by order_code
  const seen = new Map();
  (data || []).forEach((o) => {
    if (o.order_code && !seen.has(o.order_code)) {
      seen.set(o.order_code, o);
    }
  });

  return Array.from(seen.values());
}

// Search mix products
async function searchProducts(search = '', uniqueOffset = 0, limit = 50) {
  const BATCH_SIZE = 1000;
  const needed = uniqueOffset + limit + 1;
  const seen = new Map();
  let dbOffset = 0;
  let exhausted = false;

  // Build filter conditions once (each search word must match item_code OR description)
  const conds = ['is_mix = true', 'item_code IS NOT NULL'];
  const filterParams = [];
  if (search.trim()) {
    const words = search.trim().split(/\s+/)
      .map((w) => w.replace(/^[^a-zA-Z0-9]+$/, ''))
      .filter((w) => w.length > 0);
    for (const w of words) {
      filterParams.push(`%${w}%`);
      const p = `$${filterParams.length}`;
      conds.push(`(item_code ILIKE ${p} OR description ILIKE ${p})`);
    }
  }

  while (seen.size < needed && !exhausted) {
    let data;
    try {
      const result = await executeDirectSQL(
        `SELECT item_code, description, slump FROM order_products
         WHERE ${conds.join(' AND ')}
         ORDER BY item_code
         LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
        filterParams.concat([BATCH_SIZE, dbOffset])
      );
      data = result.data;
    } catch (error) {
      break;
    }
    if (!data || data.length === 0) { exhausted = true; break; }

    for (const row of data) {
      if (!row.item_code) continue;
      const desc = row.description || '';
      const label = desc ? `${row.item_code} - ${desc}` : row.item_code;
      const key = `${row.item_code}|${label.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.set(key, { value: row.item_code, label, slump: row.slump });
      }
    }

    if (data.length < BATCH_SIZE) { exhausted = true; break; }
    dbOffset += BATCH_SIZE;
  }

  const all = Array.from(seen.values());
  const products = all.slice(uniqueOffset, uniqueOffset + limit);
  const hasMore = all.length > uniqueOffset + limit;

  return { products, hasMore };
}

// Get recent order entities for referenced order dropdown
async function getRecentOrderEntities(userId) {
  if (!userId) return [];

  let data;
  try {
    const result = await executeDirectSQL(
      `SELECT id, job_name, on_job_date::text AS on_job_date, company_name, company_id
       FROM order_entities
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId]
    );
    data = result.data;
  } catch (error) {
    throw new Error(`Failed to fetch recent order entities: ${error.message}`);
  }

  return (data || []).map((o) => ({
    id: o.id,
    display: `OE-${o.id.slice(0, 6).toUpperCase()} — ${o.job_name || o.company_name || o.on_job_date}`,
    company_id: o.company_id,
  }));
}

module.exports = {
  getOrderRequests,
  getOrderRequestById,
  createOrderRequest,
  updateOrderRequest,
  updateOrderRequestStatus,
  updateOrderVerification,
  getMessages,
  sendMessage,
  getFormData,
  getOrdersByProjectCode,
  searchOrders,
  searchProducts,
  getRecentOrderEntities,
};
