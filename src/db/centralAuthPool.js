/**
 * Dedicated Postgres pool for the SHARED central-auth database (schema
 * `auth_tenant`). This is a DIFFERENT cluster from the tenant's own database, so
 * it cannot reuse the main pool. Connection string comes from
 * CENTRAL_AUTH_DATABASE_URL (added to the deployment secret).
 *
 * If CENTRAL_AUTH_DATABASE_URL is not set, getCentralAuthPool() returns null and
 * the auth_tenant client falls back to the gateway URL — so a missing value
 * degrades rather than hard-crashes on import.
 */

const { Pool } = require('pg');

const QUERY_TIMEOUT_MS = parseInt(process.env.DB_QUERY_TIMEOUT_MS) || 30000;

let pool = null;
let initialized = false;

function getCentralAuthPool() {
  if (initialized) return pool;
  initialized = true;

  const url = process.env.CENTRAL_AUTH_DATABASE_URL || process.env.AUTH_DATABASE_URL;
  if (!url) {
    console.warn('⚠️  CENTRAL_AUTH_DATABASE_URL not set — auth_tenant queries will fall back to the auth gateway.');
    return null;
  }

  // CNPG uses a self-signed CA; the connection strings use sslmode=no-verify.
  // Mirror the main pool: TLS on, hostname/CA verification off.
  const needsSsl = /sslmode=(require|prefer|no-verify|verify)/.test(url) || /central|amazonaws|\.internal/.test(url);

  pool = new Pool({
    connectionString: url,
    min: 1,
    max: 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 15000,
    statement_timeout: QUERY_TIMEOUT_MS,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
  });

  pool.on('error', (err) => {
    console.error('Central-auth pool error:', err.message || err);
  });

  return pool;
}

module.exports = { getCentralAuthPool };
