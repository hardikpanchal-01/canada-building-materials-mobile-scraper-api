/**
 * Scan History Service
 *
 * CRUD operations for user-scoped QR scan history.
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');

const TABLE = 'scan_history';

/**
 * Get paginated scan records for a user, newest first.
 * @param {string} userId
 * @param {number} page - 1-based page number (default 1)
 * @param {number} limit - records per page (default 20, max 100)
 */
async function getHistory(userId, page = 1, limit = 20) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
  const offset = (pageNum - 1) * limitNum;

  // Fetch paginated records + exact total count
  let data = null;
  let count = null;
  let error = null;
  try {
    const countResult = await executeDirectSQL(
      `SELECT count(*)::int AS count FROM ${TABLE} WHERE user_id = $1`,
      [userId]
    );
    count = countResult.data[0]?.count ?? 0;

    const dataResult = await executeDirectSQL(
      `SELECT * FROM ${TABLE} WHERE user_id = $1 ORDER BY "timestamp" DESC LIMIT $2 OFFSET $3`,
      [userId, limitNum, offset]
    );
    data = dataResult.data;
  } catch (e) {
    error = e;
  }

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

  let data;
  try {
    const result = await executeDirectSQL(
      `INSERT INTO ${TABLE} (user_id, scan_id, data, type, "timestamp", label, verified, tk_data, api_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
       ON CONFLICT (user_id, scan_id)
       DO UPDATE SET
         data = EXCLUDED.data,
         type = EXCLUDED.type,
         "timestamp" = EXCLUDED."timestamp",
         label = EXCLUDED.label,
         verified = EXCLUDED.verified,
         tk_data = EXCLUDED.tk_data,
         api_data = EXCLUDED.api_data
       RETURNING *`,
      [
        row.user_id, row.scan_id, row.data, row.type, row.timestamp,
        row.label, row.verified,
        row.tk_data != null ? JSON.stringify(row.tk_data) : null,
        row.api_data != null ? JSON.stringify(row.api_data) : null,
      ]
    );
    data = result.data[0];
  } catch (error) {
    console.error('[ScanHistory] saveScan error:', error.message);
    throw new Error('Failed to save scan record');
  }

  return mapRowToRecord(data);
}

/**
 * Delete a single scan record by client scan_id.
 */
async function deleteScan(userId, scanId) {
  let count;
  try {
    const result = await executeDirectSQL(
      `DELETE FROM ${TABLE} WHERE user_id = $1 AND scan_id = $2`,
      [userId, scanId]
    );
    count = result.rowCount;
  } catch (error) {
    console.error('[ScanHistory] deleteScan error:', error.message);
    throw new Error('Failed to delete scan record');
  }

  return { deleted: count || 1 };
}

/**
 * Clear all scan history for a user.
 */
async function clearHistory(userId) {
  let count;
  try {
    const result = await executeDirectSQL(
      `DELETE FROM ${TABLE} WHERE user_id = $1`,
      [userId]
    );
    count = result.rowCount;
  } catch (error) {
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
    // pg returns bigint columns as strings; mobile app expects a numeric timestamp
    timestamp: row.timestamp != null ? Number(row.timestamp) : row.timestamp,
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
