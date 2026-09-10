/**
 * Auth PostgreSQL Configuration
 *
 * Direct PostgreSQL connection for the central auth database (auth_tenant schema:
 * tenants, users, tenant_users, auth_codes, login_attempts).
 *
 * CENTRAL_AUTH_DATABASE_URL (or AUTH_DATABASE_URL) is required for central auth
 * queries. If not set, executeAuthSQL will throw rather than silently failing.
 */

const pg = require('pg');
const { Pool } = pg;

const RAW_AUTH_DATABASE_URL = process.env.CENTRAL_AUTH_DATABASE_URL || process.env.AUTH_DATABASE_URL;
const QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT_MS) || 30000;

// Strip any `sslmode=...` from the URL so pg-connection-string doesn't force
// verify-full (which would reject the in-cluster CloudNativePG self-signed cert);
// TLS is controlled by the `ssl` option below.
let AUTH_DATABASE_URL = RAW_AUTH_DATABASE_URL;
let AUTH_SSL_DISABLED = false;
if (RAW_AUTH_DATABASE_URL) {
  try {
    const u = new URL(RAW_AUTH_DATABASE_URL);
    AUTH_SSL_DISABLED = u.searchParams.get('sslmode') === 'disable';
    u.searchParams.delete('sslmode');
    AUTH_DATABASE_URL = u.toString();
  } catch (e) {
    AUTH_DATABASE_URL = RAW_AUTH_DATABASE_URL;
  }
}

let authPool = null;

if (AUTH_DATABASE_URL) {
  authPool = new Pool({
    connectionString: AUTH_DATABASE_URL,
    min: 1,
    max: 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 15000,
    statement_timeout: QUERY_TIMEOUT_MS,
    // Accept the CloudNativePG self-signed cert; only fully disable TLS when
    // the URL explicitly said sslmode=disable.
    ssl: AUTH_SSL_DISABLED ? false : { rejectUnauthorized: false },
    // Central-auth tables live in the auth_tenant schema
    options: '-c search_path=auth_tenant,public',
  });

  authPool.on('error', (err) => {
    console.error('Auth PostgreSQL pool error:', err.message || err);
  });

  console.log('✅ Auth PostgreSQL pool configured (CENTRAL_AUTH_DATABASE_URL)');
} else {
  console.warn('⚠️  Auth database URL not configured — auth features will be unavailable.');
}

/**
 * Whether direct PostgreSQL is enabled for the auth database
 * @returns {boolean}
 */
function isAuthPostgresEnabled() {
  return authPool !== null;
}

/**
 * Execute a SQL query against the auth database with retry on transient failure
 *
 * @param {string} sqlQuery - SQL with $1, $2... placeholders
 * @param {array} params - Parameter values
 * @param {object} options - { maxRetries }
 * @returns {Promise<object>} { success: true, data: rows, rowCount, command }
 */
async function executeAuthSQL(sqlQuery, params = [], options = {}) {
  const { maxRetries = 3 } = options;

  if (!authPool) {
    throw new Error('Auth PostgreSQL pool not configured. Please set CENTRAL_AUTH_DATABASE_URL or AUTH_DATABASE_URL.');
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await authPool.query(sqlQuery, params);
      return {
        success: true,
        data: result.rows,
        rowCount: result.rowCount,
        command: result.command
      };
    } catch (error) {
      lastError = error;

      const isTimeout = error.message.includes('timeout') ||
                        error.message.includes('canceling statement') ||
                        error.code === '57014';
      if (isTimeout) {
        console.error(`Auth SQL query timed out (attempt ${attempt}/${maxRetries})`);
        throw error;
      }

      const isNonRetryable = error.code && (
        error.code.startsWith('42') ||
        error.code.startsWith('23')
      );
      if (isNonRetryable) {
        throw error;
      }

      console.error(`Auth SQL attempt ${attempt}/${maxRetries} failed:`, error.message);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw lastError || new Error('Failed to execute auth SQL query after all retries');
}

/**
 * Close the auth pool gracefully
 */
async function closeAuthPool() {
  if (!authPool) return;
  try {
    await authPool.end();
    console.log('Auth PostgreSQL pool closed');
  } catch (error) {
    console.error('Error closing auth pool:', error);
  }
}

module.exports = {
  isAuthPostgresEnabled,
  executeAuthSQL,
  closeAuthPool
};
