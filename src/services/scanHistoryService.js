/**
 * Scan History Service
 *
 * CRUD operations for user-scoped QR scan history.
 */

const { getSupabaseAdmin } = require('../config/database');

const TABLE = 'scan_history';

/**
 * Get paginated scan records for a user, newest first.
 * @param {string} userId
 * @param {number} page - 1-based page number (default 1)
 * @param {number} limit - records per page (default 20, max 100)
 */
async function getHistory(userId, page = 1, limit = 20) {
  const supabase = getSupabaseAdmin();
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
  const offset = (pageNum - 1) * limitNum;

  // Single query: fetch paginated records + exact total count
  const { data, count, error } = await supabase
    .from(TABLE)
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('timestamp', { ascending: false })
    .range(offset, offset + limitNum - 1);

  console.log('[ScanHistory] getHistory — userId:', userId, '| records:', data?.length, '| count:', count, '| page:', pageNum, '| offset:', offset, '| limit:', limitNum, '| error:', error?.message);

  if (error) {
    console.error('[ScanHistory] getHistory error:', error.message);
    throw new Error('Failed to fetch scan history');
  }

  const total = count ?? 0;
  const totalPages = Math.ceil(total / limitNum);

  return {
    records: (data || []).map(mapRowToRecord),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      total_pages: totalPages,
      has_next: pageNum < totalPages,
      has_prev: pageNum > 1,
    },
  };
}

/**
 * Save a new scan record.
 */
async function saveScan(userId, record) {
  const supabase = getSupabaseAdmin();

  const row = {
    user_id: userId,
    scan_id: record.id,
    data: record.data,
    type: record.type || 'qr',
    timestamp: record.timestamp,
    label: record.label || null,
    verified: record.verified || null,
    tk_data: record.tkData || null,
    api_data: record.apiData || null,
  };

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(row, { onConflict: 'user_id,scan_id' })
    .select()
    .single();

  if (error) {
    console.error('[ScanHistory] saveScan error:', error.message);
    throw new Error('Failed to save scan record');
  }

  return mapRowToRecord(data);
}

/**
 * Delete a single scan record by client scan_id.
 */
async function deleteScan(userId, scanId) {
  const supabase = getSupabaseAdmin();

  const { error, count } = await supabase
    .from(TABLE)
    .delete()
    .eq('user_id', userId)
    .eq('scan_id', scanId);

  if (error) {
    console.error('[ScanHistory] deleteScan error:', error.message);
    throw new Error('Failed to delete scan record');
  }

  return { deleted: count || 1 };
}

/**
 * Clear all scan history for a user.
 */
async function clearHistory(userId) {
  const supabase = getSupabaseAdmin();

  const { error, count } = await supabase
    .from(TABLE)
    .delete()
    .eq('user_id', userId);

  if (error) {
    console.error('[ScanHistory] clearHistory error:', error.message);
    throw new Error('Failed to clear scan history');
  }

  return { deleted: count || 0 };
}

/**
 * Map a database row to the ScanRecord shape expected by the mobile app.
 */
function mapRowToRecord(row) {
  return {
    id: row.scan_id,
    data: row.data,
    type: row.type,
    timestamp: row.timestamp,
    label: row.label || undefined,
    verified: row.verified || undefined,
    tkData: row.tk_data || undefined,
    apiData: row.api_data || undefined,
  };
}

module.exports = {
  getHistory,
  saveScan,
  deleteScan,
  clearHistory,
};
