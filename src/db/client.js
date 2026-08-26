/**
 * Data client factory — the in-repo replacement for the old data-API client.
 *
 * Ordinary table access (`.from().select()/.insert()/.update()/.upsert()/
 * .delete()` with the full filter surface) runs on DIRECT Postgres via the
 * query builder + executor. Database functions (`.rpc`), the GoTrue auth admin
 * surface (`.auth`) and object storage (`.storage`) are served by the thin
 * fetch clients in restFetch.js against the tenant's self-hosted gateway, so
 * their behaviour is preserved exactly with no `@supabase/*` dependency.
 *
 * The returned object mirrors the surface the code already uses:
 *   client.from(table)…            -> pg
 *   client.schema(name).from(t)…   -> pg (runtime schema switch)
 *   client.rpc(fn, params)         -> fetch (rest gateway)
 *   client.auth.*                  -> fetch (auth gateway)
 *   client.storage.from(bucket)…   -> fetch (storage gateway)
 */

const { QueryBuilder } = require('./queryBuilder');
const { executeQuery } = require('./executeQuery');
const { makeRpc, makeAuth, makeStorage } = require('./restFetch');

/**
 * @param {object} cfg
 * @param {import('pg').Pool|null} cfg.pool   Postgres pool for table access
 * @param {string} [cfg.schema]               default schema (default 'public')
 * @param {string} [cfg.restUrl]              rest/auth/storage gateway base URL
 * @param {string} [cfg.serviceKey]           service-role key (admin/rpc/storage)
 * @param {string} [cfg.anonKey]              anon key (sign-in grant)
 */
function makeClient(cfg = {}) {
  const pool = cfg.pool || null;
  const defaultSchema = cfg.schema || 'public';
  const exec = (d) => executeQuery(d, pool);

  const restBase = { url: cfg.restUrl, serviceKey: cfg.serviceKey, anonKey: cfg.anonKey };

  const client = {
    from(table) {
      return new QueryBuilder(exec, defaultSchema, table);
    },
    schema(name) {
      return {
        from(table) {
          return new QueryBuilder(exec, name, table);
        },
        rpc: makeRpc({ ...restBase, schema: name }),
      };
    },
    rpc: makeRpc({ ...restBase, schema: defaultSchema }),
    auth: makeAuth(restBase),
    storage: makeStorage(restBase),
  };

  return client;
}

module.exports = { makeClient };
