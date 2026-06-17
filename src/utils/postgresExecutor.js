/**
 * PostgreSQL Query Executor
 *
 * Simplified SQL execution utility with retry logic.
 * Uses pool.query() for automatic connection lifecycle management.
 */

const { getPool, QUERY_TIMEOUT_MS } = require('../services/database/postgresClient');

/**
 * Execute a SQL query with automatic retry on transient failure
 *
 * Uses pool.query() which automatically acquires, executes, and releases
 * the client — eliminating connection leak risk from manual acquire/release.
 * Statement-level timeout is configured on the pool (statement_timeout).
 *
 * @param {string} sqlQuery - SQL query string with $1, $2, etc. placeholders
 * @param {array} params - Parameter values for the query
 * @param {object} options - Optional settings
 * @param {number} options.maxRetries - Maximum retry attempts (default: 3)
 * @returns {Promise<object>} Query result with success flag, data, and metadata
 */
async function executeDirectSQL(sqlQuery, params = [], options = {}) {
  const { maxRetries = 3 } = options;
  const pool = getPool();

  if (!pool) {
    throw new Error('PostgreSQL pool not configured. Please set DATABASE_URL.');
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await pool.query(sqlQuery, params);

      return {
        success: true,
        data: result.rows,
        rowCount: result.rowCount,
        command: result.command
      };

    } catch (error) {
      lastError = error;

      // Don't retry timeout or cancellation errors — they indicate the query is too slow
      const isTimeout = error.message.includes('timeout') ||
                        error.message.includes('canceling statement') ||
                        error.code === '57014'; // PostgreSQL query_canceled

      if (isTimeout) {
        console.error(`SQL query timed out (attempt ${attempt}/${maxRetries})`);
        throw error;
      }

      // Don't retry syntax or constraint errors — they won't succeed on retry
      const isNonRetryable = error.code && (
        error.code.startsWith('42') || // Syntax/schema errors (42xxx)
        error.code.startsWith('23')    // Constraint violations (23xxx)
      );

      if (isNonRetryable) {
        throw error;
      }

      console.error(`SQL attempt ${attempt}/${maxRetries} failed:`, error.message);

      // If not the last attempt, wait before retrying (exponential backoff)
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw lastError || new Error('Failed to execute SQL query after all retries');
}

module.exports = {
  executeDirectSQL
};
