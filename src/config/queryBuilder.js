/**
 * PostgREST-compatible query builder over the direct Postgres pool.
 *
 * This service used the hosted client library purely as a PostgREST SDK pointed at
 * our own in-cluster gateway. This builder keeps the identical chainable shape
 * (`.from(t).select().eq().order().single()`) so the existing call sites
 * work unchanged, but resolves against `pgClient` instead of going out over HTTP.
 *
 * It is thenable, so `await client.from('x').select('*').eq('a', 1)` resolves to
 * `{ data, error, count }` exactly as before.
 */

const { executeQuery, executeRpc } = require('./executeQuery.js');

/** Thenable builder for `.rpc(fn, args)`. */
class RpcBuilder {
  // `getPool` lets a caller aim this at a different database (the central auth
  // pool); omitted, it resolves against this tenant's own pool.
  constructor(schema, fn, args, getPool) {
    this.d = { rpc: fn, schema, args: args ?? {}, single: null };
    this.getPool = getPool;
  }

  single() {
    this.d.single = 'single';
    return this;
  }

  maybeSingle() {
    this.d.single = 'maybe';
    return this;
  }

  // `.select()` after an rpc is a no-op in PostgREST; keep it chainable.
  select() {
    return this;
  }

  then(onfulfilled, onrejected) {
    return executeRpc(this.d, this.getPool).then(onfulfilled, onrejected);
  }
}

class QueryBuilder {
  // `getPool` lets a caller aim this at a different database (the central auth
  // pool); omitted, it resolves against this tenant's own pool.
  constructor(schema, table, getPool) {
    this.getPool = getPool;
    this.d = {
      schema,
      table,
      op: 'select',
      columns: '*',
      filters: [],
      orders: [],
      returning: false,
      single: null,
    };
  }

  // ---- operations ----

  select(columns = '*', opts) {
    if (this.d.op === 'select') {
      this.d.columns = columns;
      if (opts?.count) this.d.count = opts.count;
      if (opts?.head) this.d.head = true;
    } else {
      // `.select()` after a mutation means RETURNING those columns
      this.d.returning = true;
      this.d.columns = columns;
    }
    return this;
  }

  insert(values) {
    this.d.op = 'insert';
    this.d.values = values;
    return this;
  }

  update(values) {
    this.d.op = 'update';
    this.d.values = values;
    return this;
  }

  upsert(values, opts) {
    this.d.op = 'upsert';
    this.d.values = values;
    if (opts?.onConflict) this.d.onConflict = opts.onConflict;
    if (opts?.ignoreDuplicates) this.d.ignoreDuplicates = true;
    return this;
  }

  delete() {
    this.d.op = 'delete';
    return this;
  }

  // ---- filters ----

  _push(op, column, value, negate = false) {
    this.d.filters.push({ op, column, value, negate });
    return this;
  }

  eq(c, v) { return this._push('eq', c, v); }
  neq(c, v) { return this._push('neq', c, v); }
  gt(c, v) { return this._push('gt', c, v); }
  gte(c, v) { return this._push('gte', c, v); }
  lt(c, v) { return this._push('lt', c, v); }
  lte(c, v) { return this._push('lte', c, v); }
  like(c, v) { return this._push('like', c, v); }
  ilike(c, v) { return this._push('ilike', c, v); }
  in(c, v) { return this._push('in', c, v); }
  is(c, v) { return this._push('is', c, v); }
  contains(c, v) { return this._push('contains', c, v); }

  /** PostgREST or-string, e.g. "a.eq.1,b.is.null". */
  or(expr) { return this._push('or', '', expr); }

  /** `.not('col', 'is', null)` / `.not('col', 'eq', 5)` */
  not(column, op, value) { return this._push(op, column, value, true); }

  /**
   * `.filter(col, op, value)` — the generic form. PostgREST passes the operator
   * as a string, and callers here use the same names as the dedicated helpers.
   */
  filter(column, op, value) { return this._push(op, column, value); }

  /** `.match({a: 1, b: 2})` — shorthand for chained .eq() calls. */
  match(obj) {
    for (const [k, v] of Object.entries(obj || {})) this._push('eq', k, v);
    return this;
  }

  // ---- shaping ----

  order(column, opts) {
    this.d.orders.push({
      column,
      ascending: opts?.ascending !== false,
      nullsFirst: opts?.nullsFirst,
    });
    return this;
  }

  limit(n) {
    this.d.limit = n;
    return this;
  }

  range(from, to) {
    this.d.rangeFrom = from;
    this.d.rangeTo = to;
    return this;
  }

  single() {
    this.d.single = 'single';
    this.d.returning = true;
    return this;
  }

  maybeSingle() {
    this.d.single = 'maybe';
    this.d.returning = true;
    return this;
  }

  /** Present for API compatibility; errors are already surfaced in `error`. */
  throwOnError() {
    this.d.throwOnError = true;
    return this;
  }

  descriptor() {
    return this.d;
  }

  // ---- thenable ----

  then(onfulfilled, onrejected) {
    return executeQuery(this.d, this.getPool).then(onfulfilled, onrejected);
  }
}

module.exports = { QueryBuilder, RpcBuilder };
