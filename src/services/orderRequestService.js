const { getSupabaseAdmin } = require('../config/database');

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
  const supabase = getSupabaseAdmin();

  // For contractor filtering, use userIds array (handles UUID migration)
  // Falls back to [userId] if userIds not provided (backward compatibility)
  const contractorIds = userIds && userIds.length > 0 ? userIds : (userId ? [userId] : []);

  // --- DB-level counts in parallel (head:true = no rows transferred) ---
  const buildCountQuery = () => {
    let q = supabase.from('order_entities').select('*', { count: 'exact', head: true });
    if (!isAdmin && userType !== 'producer' && contractorIds.length > 0) {
      q = q.in('user_id', contractorIds);
    }
    return q;
  };

  const [totalRes, pendingRes, submittedRes, approvedRes, rejectedRes] = await Promise.all([
    buildCountQuery(),
    buildCountQuery().eq('status', 'pending'),
    buildCountQuery().eq('status', 'submitted'),
    buildCountQuery().eq('status', 'approved'),
    buildCountQuery().in('status', ['rejected', 'canceled']),
  ]);

  const countError = totalRes.error || pendingRes.error || submittedRes.error || approvedRes.error || rejectedRes.error;
  if (countError) throw new Error(`Failed to fetch counts: ${countError.message}`);

  const counts = {
    total: totalRes.count || 0,
    pending: pendingRes.count || 0,
    submitted: submittedRes.count || 0,
    approved: approvedRes.count || 0,
    rejected: rejectedRes.count || 0,
  };

  // --- Build paginated data query ---
  let query = supabase.from('order_entities').select('*', { count: 'exact' });

  // Scope by user if not admin/producer (contractor sees only their own)
  if (!isAdmin && userType !== 'producer' && contractorIds.length > 0) {
    query = query.in('user_id', contractorIds);
  }

  // Status filter
  if (status && status !== 'all') {
    if (status === 'rejected') {
      query = query.in('status', ['rejected', 'canceled']);
    } else {
      query = query.eq('status', status);
    }
  }

  // Search filter
  if (search && search.trim()) {
    const q = search.trim();
    query = query.or(
      `job_name.ilike.%${q}%,company_name.ilike.%${q}%,job_address.ilike.%${q}%,job_city.ilike.%${q}%,concrete_product_name.ilike.%${q}%,po_number.ilike.%${q}%`
    );
  }

  // Ordering and pagination
  const offset = (page - 1) * limit;
  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) throw new Error(`Failed to fetch order requests: ${error.message}`);

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
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('order_entities')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw new Error(`Order request not found: ${error.message}`);
  return tz ? formatOrderRow(data, tz, tenantTz) : data;
}

// Create order request
async function createOrderRequest(input, tenantTz = null) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('order_entities')
    .insert({
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
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create order request: ${error.message}`);
  return data;
}

// Update order request
async function updateOrderRequest(id, input, tenantTz = null) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('order_entities')
    .update({
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
    })
    .eq('id', id);

  if (error) throw new Error(`Failed to update order request: ${error.message}`);
  return { id };
}

// Update status
async function updateOrderRequestStatus(id, status) {
  const validStatuses = ['pending', 'submitted', 'approved', 'rejected', 'canceled'];
  if (!validStatuses.includes(status)) {
    throw new Error('Invalid status');
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('order_entities')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new Error(`Failed to update status: ${error.message}`);
  return { id, status };
}

// Update verification fields
async function updateOrderVerification(id, data, tenantTz = null) {
  const supabase = getSupabaseAdmin();
  const updatePayload = { updated_at: new Date().toISOString() };

  if (data.order_number !== undefined) updatePayload.order_number = data.order_number || null;
  if (data.order_status !== undefined) updatePayload.order_status = data.order_status;
  if (data.on_job_date !== undefined) updatePayload.on_job_date = data.on_job_date;
  if (data.on_job_time !== undefined) {
    const dateForConversion = data.on_job_date || updatePayload.on_job_date;
    updatePayload.on_job_time = convertTimeToUtc(dateForConversion, data.on_job_time, tenantTz);
  }

  const { error } = await supabase
    .from('order_entities')
    .update(updatePayload)
    .eq('id', id);

  if (error) throw new Error(`Failed to update verification: ${error.message}`);
  return { id };
}

// Get messages for an order request
async function getMessages(orderEntityId, tz = null) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('order_entity_messages')
    .select('*')
    .eq('order_entity_id', orderEntityId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to fetch messages: ${error.message}`);
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
  const supabase = getSupabaseAdmin();

  // Fetch sender name server-side
  const { data: userProfile } = await supabase
    .from('users')
    .select('full_name, email')
    .eq('id', senderId)
    .single();

  const senderName = userProfile?.full_name || userProfile?.email || 'Unknown User';

  const { data, error } = await supabase
    .from('order_entity_messages')
    .insert({
      order_entity_id: orderEntityId,
      sender_id: senderId,
      sender_name: senderName,
      sender_role: senderRole,
      message_text: messageText.trim(),
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to send message: ${error.message}`);
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
async function fetchAllBatched(supabase, table, selectFields, filters, orderField, batchSize = 1000) {
  let all = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase.from(table).select(selectFields);
    if (filters) query = filters(query);
    query = query.order(orderField, { ascending: true }).range(offset, offset + batchSize - 1);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to fetch ${table}: ${error.message}`);
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

  const supabase = getSupabaseAdmin();

  // Run ALL 5 fetches in parallel
  const [regions, customers, projects, admixtureRaw, otherRaw] = await Promise.all([
    // 1. Regions (small table - single query)
    supabase
      .from('regions')
      .select('code, description')
      .order('description', { ascending: true })
      .then(({ data, error }) => {
        if (error) throw new Error(`Failed to fetch regions: ${error.message}`);
        return data || [];
      }),

    // 2. Customers (large table - batched)
    fetchAllBatched(supabase, 'customers', 'code, name',
      (q) => q.or('inactive.is.null,inactive.eq.false'), 'name'),

    // 3. Projects (large table - batched)
    fetchAllBatched(supabase, 'projects',
      'id, code, name, customer_code, customer_name, delivery_addr1, delivery_addr2, delivery_addr3, contact, phone',
      null, 'name'),

    // 4. Admixture products (matches web query exactly - no .order() before limit)
    supabase
      .from('order_products')
      .select('item_code, description')
      .eq('is_mix', false)
      .not('item_code', 'is', null)
      .or('description.ilike.%admix%,description.ilike.%retard%,description.ilike.%mrwra%,description.ilike.%calcium%,description.ilike.%accelerat%')
      .limit(2000)
      .then(({ data }) => data || []),

    // 5. Other products (matches web query exactly - no .order() before limit)
    supabase
      .from('order_products')
      .select('item_code, description')
      .eq('is_mix', false)
      .not('item_code', 'is', null)
      .limit(2000)
      .then(({ data }) => data || []),
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

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('orders')
    .select('order_id, order_code, customer_code, customer_name, order_date, project_name, delivery_addr1, delivery_addr2, delivery_addr3, ordered_by_name, ordered_by_phone, pricing_plant_code, zone_name')
    .eq('project_code', projectCode.trim())
    .order('order_date', { ascending: false })
    .limit(50);

  if (error) throw new Error(`Failed to fetch orders by project code: ${error.message}`);

  return data || [];
}

// Search orders by code (for referenced order dropdown)
async function searchOrders(searchTerm) {
  if (!searchTerm || searchTerm.trim().length < 2) {
    return [];
  }

  const supabase = getSupabaseAdmin();
  const term = searchTerm.trim();

  // Use prefix match for order_code (index-friendly) and contains for customer_name
  const { data, error } = await supabase
    .from('orders')
    .select('order_id, order_code, customer_code, customer_name, order_date, project_name, delivery_addr1, delivery_addr2, delivery_addr3, ordered_by_name, ordered_by_phone, pricing_plant_code, zone_name')
    .or(`order_code.ilike.${term}%,customer_name.ilike.%${term}%`)
    .limit(50);

  if (error) throw new Error(`Failed to search orders: ${error.message}`);

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
  const supabase = getSupabaseAdmin();
  const BATCH_SIZE = 1000;
  const needed = uniqueOffset + limit + 1;
  const seen = new Map();
  let dbOffset = 0;
  let exhausted = false;

  while (seen.size < needed && !exhausted) {
    let query = supabase
      .from('order_products')
      .select('item_code, description, slump')
      .eq('is_mix', true)
      .not('item_code', 'is', null);

    if (search.trim()) {
      const words = search.trim().split(/\s+/)
        .map((w) => w.replace(/^[^a-zA-Z0-9]+$/, ''))
        .filter((w) => w.length > 0);
      for (const w of words) {
        query = query.or(`item_code.ilike.%${w}%,description.ilike.%${w}%`);
      }
    }

    const { data, error } = await query
      .order('item_code')
      .range(dbOffset, dbOffset + BATCH_SIZE - 1);

    if (error) break;
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

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('order_entities')
    .select('id, job_name, on_job_date, company_name, company_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw new Error(`Failed to fetch recent order entities: ${error.message}`);

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
