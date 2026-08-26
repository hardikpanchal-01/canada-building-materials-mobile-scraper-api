/**
 * PostgREST-compatible query builder (CNPG / direct Postgres).
 *
 * Accumulates a plain query descriptor via the same chainable API the code used
 * against the old REST client (`.from().select().eq().order().single()` …) and
 * runs it through an injected executor that turns it into parameterized SQL over
 * the node-postgres pool. It is thenable, so
 *   `await client.from('x').select()...`
 * resolves to `{ data, error, count }` exactly like the previous client.
 *
 * Ported (CommonJS) from the estate frontend `src/db/query-builder.ts`.
 */

class QueryBuilder {
  /**
   * @param {(d: object) => Promise<{data:any,error:any,count?:number|null}>} exec
   * @param {string} schema
   * @param {string} table
   */
  constructor(exec, schema, table) {
    this.exec = exec;
    this.d = {
      schema,
      table,
      op: 'select',
      columns: '*',
      filters: [],
      orders: [],
      returning: false,
      single: null,
      head: false,
    };
  }

  // ---- op starters ----
  select(columns = '*', opts) {
    if (this.d.op === 'select') {
      this.d.columns = columns;
    } else {
      // .select() after a mutation → RETURNING those columns
      this.d.returning = true;
      this.d.columns = columns;
    }
    if (opts && opts.count) this.d.count = opts.count;
    if (opts && opts.head) this.d.head = true;
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
    if (opts && opts.onConflict) this.d.onConflict = opts.onConflict;
    if (opts && opts.ignoreDuplicates) this.d.ignoreDuplicates = true;
    return this;
  }

  delete() {
    this.d.op = 'delete';
    return this;
  }

  // ---- filters ----
  addFilter(op, column, value, negate = false) {
    this.d.filters.push({ op, column, value, negate });
    return this;
  }
  eq(c, v) { return this.addFilter('eq', c, v); }
  neq(c, v) { return this.addFilter('neq', c, v); }
  gt(c, v) { return this.addFilter('gt', c, v); }
  gte(c, v) { return this.addFilter('gte', c, v); }
  lt(c, v) { return this.addFilter('lt', c, v); }
  lte(c, v) { return this.addFilter('lte', c, v); }
  like(c, v) { return this.addFilter('like', c, v); }
  ilike(c, v) { return this.addFilter('ilike', c, v); }
  in(c, v) { return this.addFilter('in', c, v); }
  is(c, v) { return this.addFilter('is', c, v); }
  contains(c, v) { return this.addFilter('contains', c, v); }
  overlaps(c, v) { return this.addFilter('overlaps', c, v); }
  or(filters) { return this.addFilter('or', '', filters); }
  not(c, op, v) {
    // supports `.not('col','is',null)`, `.not('col','in','(a,b,c)')`, `.not('col','eq',v)`
    return this.addFilter(op || 'eq', c, v, true);
  }

  // ---- shaping ----
  order(column, opts) {
    this.d.orders.push({
      column,
      ascending: !(opts && opts.ascending === false),
      nullsFirst: opts ? opts.nullsFirst : undefined,
    });
    return this;
  }
  limit(n) { this.d.limit = n; return this; }
  range(from, to) { this.d.rangeFrom = from; this.d.rangeTo = to; return this; }

  // generic PostgREST filter: .filter('col','eq',val) / negated via 'not.<op>'
  filter(column, operator, value) {
    if (String(operator).startsWith('not.')) {
      return this.addFilter(String(operator).slice(4), column, value, true);
    }
    return this.addFilter(operator, column, value);
  }
  match(obj) {
    for (const [k, v] of Object.entries(obj)) this.addFilter('eq', k, v);
    return this;
  }

  single() { this.d.single = 'single'; this.d.returning = true; return this; }
  maybeSingle() { this.d.single = 'maybe'; this.d.returning = true; return this; }

  // no-op passthroughs for methods that don't affect our SQL
  throwOnError() { return this; }
  abortSignal() { return this; }
  returns() { return this; }

  descriptor() { return this.d; }

  // ---- thenable ----
  then(onfulfilled, onrejected) {
    return this.exec(this.d).then(
      (r) => (onfulfilled ? onfulfilled(r) : r),
      onrejected
    );
  }
  catch(onrejected) { return this.then(undefined, onrejected); }
  finally(onfinally) { return this.then().finally(onfinally); }
}

module.exports = { QueryBuilder };
