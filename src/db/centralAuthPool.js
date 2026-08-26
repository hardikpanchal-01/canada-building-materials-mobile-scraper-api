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

  // central-auth runs on CNPG with a SELF-SIGNED CA. Newer node-postgres treats a
  // connection-string `sslmode` (require/prefer/verify-ca) as an alias for
  // `verify-full`, which rejects the self-signed chain and overrides an `ssl`
  // option. So STRIP sslmode from the string and make our explicit TLS-no-verify
  // config authoritative (the estate's proven fix — see the remove-supabase
  // runbook). TLS stays ON; only hostname/CA verification is disabled.
  const connectionString = url
    .replace(/([?&])sslmode=[^&]*/gi, '$1')
    .replace(/[?&]$/, '')
    .replace(/\?&/, '?');

  pool = new Pool({
    connectionString,
    min: 1,
    max: 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 15000,
    statement_timeout: QUERY_TIMEOUT_MS,
    ssl: { rejectUnauthorized: false },
  });

  pool.on('error', (err) => {
    console.error('Central-auth pool error:', err.message || err);
  });

  return pool;
}

module.exports = { getCentralAuthPool };
