/**
 * Central auth database client.
 *
 * Reads `auth_tenant.users` in the SHARED central auth database — a different
 * database from this tenant's own, so it needs its own connection pool.
 *
 * This used to be a hosted-client-library instance pointed at a PostgREST
 * gateway. It now connects directly, which needs CENTRAL_AUTH_DATABASE_URL to be
 * set. The old AUTH_* gateway URL and keys are no longer used.
 */

const pg = require('pg');
const { Pool } = pg;
const { QueryBuilder, RpcBuilder } = require('./queryBuilder.js');

const AUTH_SCHEMA = 'auth_tenant';

let authPool = null;

function getAuthPool() {
  if (!authPool) {
    const connectionString = process.env.CENTRAL_AUTH_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'Central auth database is not configured. Please set CENTRAL_AUTH_DATABASE_URL in your .env file.'
      );
    }
    authPool = new Pool({
      connectionString,
      ssl:
        process.env.CENTRAL_AUTH_DATABASE_SSL === 'false'
          ? false
          : { rejectUnauthorized: false },
      max: parseInt(process.env.CENTRAL_AUTH_PG_POOL_MAX, 10) || 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    authPool.on('error', (err) => {
      console.error('Central auth pool error:', err.message);
    });
  }
  return authPool;
}

function makeAuthClient(schema) {
  return {
    from: (table) => new QueryBuilder(schema, table, getAuthPool),
    rpc: (fn, args) => new RpcBuilder(schema, fn, args, getAuthPool),
    schema: (s) => makeAuthClient(s),
  };
}

let authClient = null;

/**
 * Admin client for the central auth database.
 * Retained name for call-site compatibility.
 */
function getAuthDbAdmin() {
  if (!authClient) authClient = makeAuthClient(AUTH_SCHEMA);
  return authClient;
}

module.exports = {
  getAuthDbAdmin,
  getAuthPool,
};
