/**
 * Comparison Database Service
 *
 * Stores order comparison results in the database.
 */

const { executeDirectSQL } = require('../../utils/postgresExecutor');

/**
 * Store comparison result in database
 *
 * @param {string} batchId - Batch ID
 * @param {object} comparisonSummary - Comparison summary object
 * @param {object} fullComparisonResult - Full comparison result
 * @returns {Promise<number|null>} Database record ID or null if not stored
 */
async function storeComparisonResult(batchId, comparisonSummary, fullComparisonResult) {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  const insertSQL = `
    INSERT INTO order_comparison_results (
      batch_id,
      comparison_summary,
      full_comparison_result,
      created_at
    ) VALUES ($1, $2, $3, NOW())
    RETURNING id
  `;

  const params = [
    batchId,
    JSON.stringify(comparisonSummary),
    JSON.stringify(fullComparisonResult)
  ];

  try {
    const result = await executeDirectSQL(insertSQL, params);

    if (!result.success || !result.data || result.data.length === 0) {
      throw new Error('Insert returned no data');
    }

    const recordId = result.data[0].id;
    console.log(`Comparison result stored with id: ${recordId}`);
    return recordId;

  } catch (error) {
    // Check if table doesn't exist - silently skip (table is optional)
    if (error.message && error.message.includes('does not exist')) {
      // Silently skip - table is optional, comparison and email will still work
      return null;
    }

    // Log other errors but don't fail the API
    console.error('Error storing comparison result:', error);
    return null;
  }
}

module.exports = {
  storeComparisonResult
};


