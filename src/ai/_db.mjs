/**
 * PostgreSQL-backed compatibility client for the AI Assistant engine.
 *
 * Thin query-builder shim over the backend's shared pg pool (DATABASE_URL).
 * The shared RPCs (ai_aggregate, ai_select_rows, ai_count,
 * _ai_validate_columns, ai_record_feedback) and tables (ai_chat_threads,
 * ai_dashboards, ai_audit_log, …) all live in the tenant PostgreSQL
 * database, so the AI engine talks to the SAME data the web app uses.
 *
 * Implemented surface (only what src/ai/* uses):
 *   .from(t).select(cols).eq/neq/gt/gte/lt/lte/like/ilike/is/in/not
 *      .order(col, {ascending}).limit(n).single()/.maybeSingle()
 *   .from(t).insert(obj|arr).select(cols).single()
 *   .from(t).update(obj).eq(...).select(cols).single()
 *   .from(t).upsert(obj, {onConflict}).select(...)
 *   .from(t).delete().eq(...)
 *   .rpc(fn, namedArgs)
 *
 * Errors resolve as { data: null, error: { code, message } } — same contract
 * the callers already handle (including code 22023 / "does not exist" checks).
 */

import postgresClient from '../services/database/postgresClient.js';

const { getPool } = postgresClient;

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function quoteIdent(name) {
  const trimmed = String(name).trim();
  if (!IDENT_RE.test(trimmed)) {
    throw new Error(`invalid identifier: ${trimmed}`);
  }
  return `"${trimmed}"`;
}

function parseSelectList(cols) {
  const raw = (cols === undefined || cols === null || cols === '') ? '*' : String(cols);
  if (raw.trim() === '*') return '*';
  return raw
    .split(',')
    .map((c) => quoteIdent(c))
    .join(', ');
}

/** JSON-encode plain objects/arrays for jsonb columns (node-pg would map JS
 *  arrays to PG arrays otherwise, which breaks jsonb inserts). */
function writeValue(v) {
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    return { placeholderSuffix: '::jsonb', value: JSON.stringify(v) };
  }
  return { placeholderSuffix: '', value: v };
}

// How each known RPC returns data (PostgREST unwraps these automatically;
// we replicate that here). 'set' → array of rows, 'scalar' → single value.
const RPC_MODES = {
  ai_aggregate: 'set',
  ai_select_rows: 'set',
  ai_count: 'scalar',
  _ai_validate_columns: 'scalar',
  _ai_validate_column: 'scalar',
  ai_record_feedback: 'scalar',
};

class QueryBuilder {
  constructor(table) {
    this._table = table;
    this._action = 'select';
    this._selectCols = '*';
    this._returning = null;
    this._payload = null;
    this._onConflict = null;
    this._filters = [];
    this._order = [];
    this._limit = null;
    this._offset = null;
    this._single = false;
    this._maybeSingle = false;
  }

  select(cols, _opts) {
    if (this._action === 'select') {
      this._selectCols = parseSelectList(cols);
    } else {
      this._returning = parseSelectList(cols);
    }
    return this;
  }

  insert(rows) { this._action = 'insert'; this._payload = rows; return this; }
  update(obj) { this._action = 'update'; this._payload = obj; return this; }
  upsert(rows, opts) {
    this._action = 'upsert';
    this._payload = rows;
    this._onConflict = opts?.onConflict || null;
    return this;
  }
  delete() { this._action = 'delete'; return this; }

  _addFilter(sqlOp, column, value) {
    this._filters.push({ op: sqlOp, column, value });
    return this;
  }

  eq(c, v) { return this._addFilter('=', c, v); }
  neq(c, v) { return this._addFilter('<>', c, v); }
  gt(c, v) { return this._addFilter('>', c, v); }
  gte(c, v) { return this._addFilter('>=', c, v); }
  lt(c, v) { return this._addFilter('<', c, v); }
  lte(c, v) { return this._addFilter('<=', c, v); }
  like(c, v) { return this._addFilter('LIKE', c, v); }
  ilike(c, v) { return this._addFilter('ILIKE', c, v); }

  is(c, v) {
    if (v === null) return this._addFilter('IS NULL', c, undefined);
    if (v === true) return this._addFilter('IS TRUE', c, undefined);
    if (v === false) return this._addFilter('IS FALSE', c, undefined);
    return this._addFilter('=', c, v);
  }

  not(c, op, v) {
    if (op === 'is' && v === null) return this._addFilter('IS NOT NULL', c, undefined);
    throw new Error(`not(${op}) is not supported by the pg shim`);
  }

  in(c, values) { return this._addFilter('= ANY', c, Array.isArray(values) ? values : [values]); }

  order(column, opts) {
    this._order.push({ column, ascending: opts?.ascending !== false });
    return this;
  }

  limit(n) { this._limit = n; return this; }
  range(from, to) { this._offset = from; this._limit = to - from + 1; return this; }

  single() { this._single = true; return this; }
  maybeSingle() { this._maybeSingle = true; return this; }

  _buildWhere(params) {
    if (this._filters.length === 0) return '';
    const parts = this._filters.map((f) => {
      const col = quoteIdent(f.column);
      if (f.value === undefined) return `${col} ${f.op}`;
      if (f.op === '= ANY') {
        params.push(f.value);
        return `${col} = ANY($${params.length})`;
      }
      params.push(f.value);
      return `${col} ${f.op} $${params.length}`;
    });
    return ` WHERE ${parts.join(' AND ')}`;
  }

  _buildQuery() {
    const params = [];
    const table = quoteIdent(this._table);
    let sql;

    if (this._action === 'select') {
      sql = `SELECT ${this._selectCols} FROM ${table}`;
      sql += this._buildWhere(params);
      if (this._order.length > 0) {
        sql += ' ORDER BY ' + this._order
          .map((o) => `${quoteIdent(o.column)} ${o.ascending ? 'ASC' : 'DESC'}`)
          .join(', ');
      }
      if (this._limit != null) { params.push(this._limit); sql += ` LIMIT $${params.length}`; }
      if (this._offset != null) { params.push(this._offset); sql += ` OFFSET $${params.length}`; }
    } else if (this._action === 'insert' || this._action === 'upsert') {
      const rows = Array.isArray(this._payload) ? this._payload : [this._payload];
      if (rows.length === 0) throw new Error('insert requires at least one row');
      const columns = Object.keys(rows[0]);
      const colSql = columns.map((c) => quoteIdent(c)).join(', ');
      const valueTuples = rows.map((row) => {
        const placeholders = columns.map((c) => {
          const { placeholderSuffix, value } = writeValue(row[c]);
          params.push(value);
          return `$${params.length}${placeholderSuffix}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      sql = `INSERT INTO ${table} (${colSql}) VALUES ${valueTuples.join(', ')}`;
      if (this._action === 'upsert') {
        const conflictCols = (this._onConflict || '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        if (conflictCols.length === 0) throw new Error('upsert requires onConflict');
        const conflictSql = conflictCols.map((c) => quoteIdent(c)).join(', ');
        const updatable = columns.filter((c) => !conflictCols.includes(c));
        if (updatable.length === 0) {
          sql += ` ON CONFLICT (${conflictSql}) DO NOTHING`;
        } else {
          const setSql = updatable
            .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
            .join(', ');
          sql += ` ON CONFLICT (${conflictSql}) DO UPDATE SET ${setSql}`;
        }
      }
      if (this._returning) sql += ` RETURNING ${this._returning}`;
    } else if (this._action === 'update') {
      const columns = Object.keys(this._payload);
      if (columns.length === 0) throw new Error('update requires at least one column');
      const setSql = columns.map((c) => {
        const { placeholderSuffix, value } = writeValue(this._payload[c]);
        params.push(value);
        return `${quoteIdent(c)} = $${params.length}${placeholderSuffix}`;
      }).join(', ');
      sql = `UPDATE ${table} SET ${setSql}`;
      sql += this._buildWhere(params);
      if (this._returning) sql += ` RETURNING ${this._returning}`;
    } else if (this._action === 'delete') {
      sql = `DELETE FROM ${table}`;
      sql += this._buildWhere(params);
      if (this._returning) sql += ` RETURNING ${this._returning}`;
    } else {
      throw new Error(`unsupported action: ${this._action}`);
    }

    return { sql, params };
  }

  async _execute() {
    const pool = getPool();
    if (!pool) {
      return { data: null, error: { code: 'NO_POOL', message: 'DATABASE_URL not configured' }, count: null };
    }

    let built;
    try {
      built = this._buildQuery();
    } catch (err) {
      return { data: null, error: { code: 'SHIM_BUILD', message: err.message }, count: null };
    }

    try {
      const result = await pool.query(built.sql, built.params);
      let data = result.rows;

      const wantsRows = this._action === 'select' || this._returning;
      if (!wantsRows) data = null;

      if (data && (this._single || this._maybeSingle)) {
        if (data.length === 0) {
          if (this._single) {
            return {
              data: null,
              error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
              count: null,
            };
          }
          data = null;
        } else {
          data = data[0];
        }
      }

      return { data, error: null, count: result.rowCount };
    } catch (err) {
      return { data: null, error: { code: err.code || 'PG_ERROR', message: err.message }, count: null };
    }
  }

  then(resolve, reject) { return this._execute().then(resolve, reject); }
  catch(fn) { return this._execute().catch(fn); }
  finally(fn) { return this._execute().finally(fn); }
}

async function rpc(fnName, namedArgs = {}) {
  const pool = getPool();
  if (!pool) {
    return { data: null, error: { code: 'NO_POOL', message: 'DATABASE_URL not configured' } };
  }

  let call;
  const params = [];
  try {
    const fn = quoteIdent(fnName);
    const argSql = Object.entries(namedArgs).map(([key, value]) => {
      const argName = quoteIdent(key);
      const { placeholderSuffix, value: v } = writeValue(value);
      params.push(v);
      return `${argName} := $${params.length}${placeholderSuffix}`;
    });
    call = `SELECT * FROM ${fn}(${argSql.join(', ')})`;
  } catch (err) {
    return { data: null, error: { code: 'SHIM_BUILD', message: err.message } };
  }

  try {
    const result = await pool.query(call, params);
    const mode = RPC_MODES[fnName] || 'set';
    const rows = result.rows;

    // Single-column results named after the function are unwrapped the way
    // PostgREST does (SETOF jsonb → array of objects; scalar → plain value).
    const fields = result.fields?.map((f) => f.name) || (rows[0] ? Object.keys(rows[0]) : []);
    const singleFnColumn = fields.length === 1 && fields[0] === fnName;

    if (mode === 'scalar') {
      const value = rows.length > 0 ? (singleFnColumn ? rows[0][fnName] : rows[0][fields[0]]) : null;
      return { data: value, error: null };
    }

    const data = singleFnColumn ? rows.map((r) => r[fnName]) : rows;
    return { data, error: null };
  } catch (err) {
    return { data: null, error: { code: err.code || 'PG_ERROR', message: err.message } };
  }
}

/**
 * Look up a single auth.users row by email.
 * @returns {Promise<{id: string, email: string}|null>}
 */
export async function findUserByEmail(email) {
  const pool = getPool();
  if (!pool || !email) return null;
  const { rows } = await pool.query(
    'SELECT id, email FROM auth.users WHERE lower(email) = lower($1) AND deleted_at IS NULL LIMIT 1',
    [email]
  );
  return rows[0] || null;
}

/**
 * Look up auth.users rows for a set/array of ids.
 * @returns {Promise<Array<{id: string, email: string, raw_user_meta_data: object}>>}
 */
export async function findUsersByIds(ids) {
  const pool = getPool();
  const arr = Array.from(ids || []);
  if (!pool || arr.length === 0) return [];
  const { rows } = await pool.query(
    'SELECT id, email, raw_user_meta_data FROM auth.users WHERE id = ANY($1)',
    [arr]
  );
  return rows;
}

export const db = {
  from(table) { return new QueryBuilder(table); },
  rpc,
};

export default db;
