/**
 * PostgreSQL Client
 *
 * Simplified connection pool for PostgreSQL database.
 * Provides basic connection management without cron-specific features.
 */

const pg = require('pg');
const { Pool } = pg;

// Get database URL from environment.
// Strip any `sslmode=...` from the URL: pg-connection-string treats
// sslmode=require/prefer/verify-ca as verify-full, which would override the
// `ssl` option below and reject the in-cluster CloudNativePG self-signed cert.
// We manage TLS ourselves via the `ssl` option instead.
const RAW_DATABASE_URL = process.env.DATABASE_URL || process.env.DB_POOL_URL;
let DATABASE_URL = RAW_DATABASE_URL;
let SSL_DISABLED = false;
if (RAW_DATABASE_URL) {
  try {
    const u = new URL(RAW_DATABASE_URL);
    SSL_DISABLED = u.searchParams.get('sslmode') === 'disable';
    u.searchParams.delete('sslmode');
    DATABASE_URL = u.toString();
  } catch (e) {
    DATABASE_URL = RAW_DATABASE_URL;
  }
}

// Query timeout configuration (default: 30 seconds)
const QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT_MS) || 30000;

// Only create pool if DATABASE_URL is configured
let pool = null;

if (DATABASE_URL) {
  /**
   * PostgreSQL connection pool
   *
   * Configuration:
   * - max: Maximum number of connections (20)
   * - idleTimeoutMillis: Close idle connections after 60s (the pooler closes idle conns; we release first to avoid "Connection terminated unexpectedly")
   * - connectionTimeoutMillis: Fail connection attempts after 15 seconds
   */
  pool = new Pool({
    connectionString: DATABASE_URL,
    min: process.env.DISABLE_REALTIME === 'true' ? 0 : 2,
    max: process.env.DISABLE_REALTIME === 'true' ? 1 : 5,
    idleTimeoutMillis: process.env.DISABLE_REALTIME === 'true' ? 500 : 60000,
    connectionTimeoutMillis: process.env.DISABLE_REALTIME === 'true' ? 30000 : 15000,
    statement_timeout: QUERY_TIMEOUT_MS,  // Kill queries exceeding this time
    // SSL: accept the server cert without CA verification (the in-cluster
    // CloudNativePG server presents a self-signed cert; the provider uses its own
    // chain). Only fully disable TLS when the URL explicitly says sslmode=disable.
    ssl: SSL_DISABLED ? false : { rejectUnauthorized: false }
  });

  // Log pool errors (short message only; full dump is noisy for "Connection terminated unexpectedly")
  pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err.message || err);
  });

  // Log when connections are acquired (debug mode only)
  if (process.env.NODE_ENV === 'development') {
    pool.on('connect', () => {
      console.log('PostgreSQL: New connection established');
    });
  }
} else {
  console.warn('⚠️  DATABASE_URL not configured - PostgreSQL features will be unavailable');
}

/**
 * Test database connection
 *
 * @returns {Promise<boolean>} True if connection successful
 */
async function testConnection() {
  if (!pool) {
    return false;
  }

  let client = null;
  try {
    client = await pool.connect();
    await client.query('SELECT 1 as connected');
    client.release();
    return true;
  } catch (error) {
    console.error('Database connection test failed:', error.message);
    if (client) {
      try {
        client.release();
      } catch (e) {
        // Ignore release error
      }
    }
    return false;
  }
}

/**
 * Get pool statistics for monitoring
 *
 * @returns {object} Pool statistics
 */
function getPoolStats() {
  if (!pool) {
    return {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      status: 'not_configured'
    };
  }
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount
  };
}

/**
 * Close the connection pool gracefully
 *
 * @returns {Promise<void>}
 */
async function closePool() {
  if (!pool) {
    return;
  }
  try {
    await pool.end();
    console.log('PostgreSQL pool closed');
  } catch (error) {
    console.error('Error closing pool:', error);
    throw error;
  }
}

/**
 * Get the pool instance
 * @returns {Pool|null} The pool instance or null if not configured
 */
function getPool() {
  return pool;
}

module.exports = {
  pool,
  testConnection,
  getPoolStats,
  closePool,
  getPool,
  QUERY_TIMEOUT_MS
};


