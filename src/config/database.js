/**
 * Database clients for the tenant's own Postgres.
 *
 * These used to be hosted-client-library instances pointed at a PostgREST
 * gateway. They now build SQL and run it on the direct connection pool
 * (services/database/postgresClient), which removes the HTTP hop.
 *
 * The chainable surface is unchanged (`.from(t).select().eq()...`), so callers
 * did not have to change.
 *
 * Note on the two accessors: the previous split was an anon-key client that
 * respected row-level security and a service-key client that bypassed it. A
 * direct pool connects as one database role, so both now return the same
 * client. The role in DATABASE_URL decides what is visible — keep that role
 * least-privileged rather than relying on the distinction here.
 */

const { QueryBuilder, RpcBuilder } = require('./queryBuilder.js');
const { authAdmin } = require('./authAdmin.js');

function makeClient(schema) {
  return {
    from: (table) => new QueryBuilder(schema, table),
    rpc: (fn, args) => new RpcBuilder(schema, fn, args),
    schema: (s) => makeClient(s),
    // `auth.admin.*` used to reach a hosted auth service; it now runs SQL
    // against this tenant's own auth.users.
    auth: { admin: authAdmin },
  };
}

let client = null;

function getDb() {
  if (!client) client = makeClient('public');
  return client;
}

/** Retained name for call-site compatibility; see the note above. */
function getDbAdmin() {
  return getDb();
}

module.exports = {
  getDb,
  getDbAdmin,
};
