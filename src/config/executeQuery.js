/**
 * Turns a query descriptor into SQL and runs it on the direct Postgres pool.
 *
 * This replaces the PostgREST round-trip the hosted client library used to make.
 * The result shape is deliberately identical — `{ data, error, count, status }` —
 * so the ~190 existing call sites need no changes.
 *
 * Scope note: this service only ever selects plain column lists (no PostgREST
 * embedded resources such as `orders(id,code)` or `roles!inner(...)`), so this
 * executor deliberately does not implement embeds. If an embed is ever added it
 * will fail loudly on the identifier check rather than silently return wrong
 * rows.
 */

const { getPool } = require('../services/database/postgresClient.js');

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ident(name) {
  const n = String(name).trim();
  if (!IDENT.test(n)) throw new Error(`Invalid identifier: ${name}`);
  return `"${n}"`;
}

/** Qualified column: "a.b" -> "a"."b"; plain -> "col". */
function col(name) {
  return String(name)
    .split('.')
    .map((p) => ident(p))
    .join('.');
}

/** A select item, supporting PostgREST aliasing `alias:column`. */
function selectCol(spec) {
  const s = String(spec).trim();
  const m = s.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
  if (m) return `${col(m[2].trim())} AS ${ident(m[1])}`;
  return col(s);
}

function relation(schema, table) {
  return `${ident(schema)}.${ident(table)}`;
}

function pushParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

// Ops that may appear inside a PostgREST or-string ("col.op.value").
const OR_STRING_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is', 'contains',
]);

/**
 * Split a PostgREST or-string into its `col.op.value` conditions.
 *
 * Two kinds of comma have to survive the split:
 *  - `col.in.(a,b,c)` — separators inside the parenthesised list, handled by
 *    tracking paren depth.
 *  - a comma inside a plain value, e.g. `name.ilike.%ACME, INC%`. There is no
 *    delimiter to track, so a chunk only starts a new condition when it looks
 *    like `col.<known-op>.…`; anything else is re-joined onto the previous one.
 */
function splitOrString(s) {
  const chunks = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(s)) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { chunks.push(cur); cur = ''; }
    else cur += ch;
  }
  chunks.push(cur);

  const parts = [];
  for (const chunk of chunks) {
    const op = chunk.split('.')[1];
    const startsCondition = op !== undefined && OR_STRING_OPS.has(op.trim());
    if (startsCondition || parts.length === 0) {
      if (chunk.trim()) parts.push(chunk.trim());
    } else {
      parts[parts.length - 1] += `,${chunk}`;
    }
  }
  return parts;
}

/** PostgREST wraps a value in double quotes when it contains reserved chars. */
function unquote(v) {
  const s = String(v);
  return s.length > 1 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/**
 * Coerce or-string scalars to JS values.
 *
 * Numeric-looking values are deliberately left as strings: an untyped string
 * parameter is resolved against the target column, so '123' works for both an
 * integer id and a text code. Sending a JS number pins the parameter to a
 * numeric type, and comparing that against a text column (plant and customer
 * codes are numeric-looking strings) fails with
 * "operator does not exist: text = integer".
 */
function coerce(v) {
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function renderFilter(f, params) {
  const neg = (s) => (f.negate ? `NOT (${s})` : s);

  // `or` carries its columns inside the or-string, so the filter's own `column`
  // is empty. Handle it before quoting anything — quoting "" throws.
  if (f.op === 'or') {
    const rendered = splitOrString(f.value).map((p) => {
      const [pcol, pop, ...rest] = p.split('.');
      const raw = rest.join('.');
      const value =
        pop === 'in' && raw.startsWith('(') && raw.endsWith(')')
          ? raw.slice(1, -1).split(',').map((v) => coerce(unquote(v.trim())))
          : coerce(unquote(raw));
      return renderFilter({ op: pop, column: pcol, value }, params);
    });
    if (rendered.length === 0) return neg('true');
    return neg(`(${rendered.join(' OR ')})`);
  }

  const c = col(f.column);
  switch (f.op) {
    case 'eq':   return neg(`${c} = ${pushParam(params, f.value)}`);
    case 'neq':  return neg(`${c} <> ${pushParam(params, f.value)}`);
    case 'gt':   return neg(`${c} > ${pushParam(params, f.value)}`);
    case 'gte':  return neg(`${c} >= ${pushParam(params, f.value)}`);
    case 'lt':   return neg(`${c} < ${pushParam(params, f.value)}`);
    case 'lte':  return neg(`${c} <= ${pushParam(params, f.value)}`);
    case 'like': return neg(`${c} LIKE ${pushParam(params, f.value)}`);
    case 'ilike':return neg(`${c} ILIKE ${pushParam(params, f.value)}`);
    case 'in': {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      // An empty IN () is a syntax error; PostgREST matches nothing here.
      if (arr.length === 0) return neg('false');
      const ph = arr.map((v) => pushParam(params, v)).join(', ');
      return neg(`${c} IN (${ph})`);
    }
    case 'is': {
      if (f.value === null) return neg(`${c} IS NULL`);
      if (f.value === true) return neg(`${c} IS TRUE`);
      if (f.value === false) return neg(`${c} IS FALSE`);
      return neg(`${c} IS ${pushParam(params, f.value)}`);
    }
    case 'contains':
      return neg(`${c} @> ${pushParam(params, JSON.stringify(f.value))}`);
    default:
      throw new Error(`Unsupported filter op: ${f.op}`);
  }
}

function whereConds(d, params) {
  return d.filters.map((f) => renderFilter(f, params));
}

function buildWhere(d, params) {
  const conds = whereConds(d, params);
  return conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
}

function orderLimitClause(d) {
  let text = '';
  if (d.orders.length) {
    const ord = d.orders
      .map(
        (o) =>
          `${col(o.column)} ${o.ascending ? 'ASC' : 'DESC'} NULLS ${
            o.nullsFirst ? 'FIRST' : 'LAST'
          }`
      )
      .join(', ');
    text += ` ORDER BY ${ord}`;
  }
  if (d.rangeFrom != null && d.rangeTo != null) {
    const limit = d.rangeTo - d.rangeFrom + 1;
    text += ` LIMIT ${Math.max(0, limit)} OFFSET ${Math.max(0, d.rangeFrom)}`;
  } else if (d.limit != null) {
    text += ` LIMIT ${Math.max(0, d.limit)}`;
  }
  return text;
}

function buildSelect(d) {
  const params = [];
  const specs = String(d.columns || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cols =
    specs.length === 0 || (specs.length === 1 && specs[0] === '*')
      ? '*'
      : specs.map((s) => selectCol(s)).join(', ');
  let text = `SELECT ${cols} FROM ${relation(d.schema, d.table)}`;
  text += buildWhere(d, params);
  text += orderLimitClause(d);
  return { text, params };
}

function columnsOf(rows) {
  const set = new Set();
  for (const row of rows) for (const k of Object.keys(row || {})) set.add(k);
  return [...set];
}

function normalizeValue(v) {
  // PostgREST treats an undefined field as null; match that.
  if (v === undefined) return null;
  // Plain objects destined for json/jsonb are stringified here because
  // node-postgres would otherwise send "[object Object]". Arrays are left alone
  // so they map onto Postgres array columns.
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
    return JSON.stringify(v);
  }
  return v;
}

function buildInsert(d, upsert) {
  const rows = Array.isArray(d.values) ? d.values : [d.values ?? {}];
  const cols = columnsOf(rows);
  const params = [];
  const valuesSql = rows
    .map((row) => {
      const r = row || {};
      const ph = cols.map((c) =>
        c in r ? pushParam(params, normalizeValue(r[c])) : 'DEFAULT'
      );
      return `(${ph.join(', ')})`;
    })
    .join(', ');
  let text = `INSERT INTO ${relation(d.schema, d.table)} (${cols
    .map(ident)
    .join(', ')}) VALUES ${valuesSql}`;
  if (upsert) {
    const conflictCols = d.onConflict
      ? d.onConflict.split(',').map((s) => s.trim())
      : [];
    const conflict = conflictCols.map((s) => ident(s)).join(', ');
    if (d.ignoreDuplicates || !conflict) {
      text += ` ON CONFLICT ${conflict ? `(${conflict}) ` : ''}DO NOTHING`;
    } else {
      const setCols = cols.filter((c) => !conflictCols.includes(c));
      const setList = (setCols.length ? setCols : cols)
        .map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`)
        .join(', ');
      text += ` ON CONFLICT (${conflict}) DO UPDATE SET ${setList}`;
    }
  }
  if (d.returning) text += ' RETURNING *';
  return { text, params };
}

function buildUpdate(d) {
  const params = [];
  const row = d.values ?? {};
  const setList = Object.keys(row)
    .map((k) => `${ident(k)} = ${pushParam(params, normalizeValue(row[k]))}`)
    .join(', ');
  let text = `UPDATE ${relation(d.schema, d.table)} SET ${setList}`;
  text += buildWhere(d, params);
  if (d.returning) text += ' RETURNING *';
  return { text, params };
}

function buildDelete(d) {
  const params = [];
  let text = `DELETE FROM ${relation(d.schema, d.table)}`;
  text += buildWhere(d, params);
  if (d.returning) text += ' RETURNING *';
  return { text, params };
}

function shape(rows, d) {
  // `.single()` demands exactly one row; `.maybeSingle()` tolerates none.
  if (d.single === 'single') {
    if (rows.length !== 1) {
      return {
        data: null,
        error: {
          message:
            rows.length === 0
              ? 'JSON object requested, multiple (or no) rows returned'
              : `Expected 1 row, got ${rows.length}`,
          code: 'PGRST116',
        },
        status: 406,
      };
    }
    return { data: rows[0], error: null, status: 200 };
  }
  if (d.single === 'maybe') {
    return { data: rows[0] ?? null, error: null, status: 200 };
  }
  return { data: rows, error: null, status: 200 };
}

async function executeQuery(d, getPoolOverride) {
  try {
    let parts;
    switch (d.op) {
      case 'select': parts = buildSelect(d); break;
      case 'insert': parts = buildInsert(d, false); break;
      case 'upsert': parts = buildInsert(d, true); break;
      case 'update': parts = buildUpdate(d); break;
      case 'delete': parts = buildDelete(d); break;
      default: throw new Error(`Unsupported operation: ${d.op}`);
    }

    const pool = (getPoolOverride || getPool)();

    // A mutation without .select()/.single() returns no rows, matching PostgREST.
    const wantsRows = d.op === 'select' || d.returning;

    let count = null;
    if (d.op === 'select' && d.count) {
      const cParams = [];
      const cText =
        `SELECT count(*)::int AS n FROM ${relation(d.schema, d.table)}` +
        buildWhere(d, cParams);
      const cRes = await pool.query(cText, cParams);
      count = cRes.rows[0]?.n ?? 0;
    }

    // `head: true` asks for the count only.
    if (d.head) {
      return { data: null, error: null, count, status: 200 };
    }

    const res = await pool.query(parts.text, parts.params);
    const rows = wantsRows ? res.rows : [];
    const out = shape(rows, d);
    return { ...out, count };
  } catch (e) {
    return {
      data: null,
      error: {
        message: e instanceof Error ? e.message : String(e),
        code: e?.code,
        details: e?.detail,
        hint: e?.hint,
      },
      count: null,
      status: 500,
    };
  }
}

async function executeRpc(d, getPoolOverride) {
  try {
    const params = [];
    const names = Object.keys(d.args || {});
    const argSql = names
      .map((n) => `${ident(n)} => ${pushParam(params, d.args[n])}`)
      .join(', ');
    const text = `SELECT * FROM ${ident(d.schema)}.${ident(d.rpc)}(${argSql})`;
    const pool = (getPoolOverride || getPool)();
    const res = await pool.query(text, params);
    let rows = res.rows;

    // A function returning a scalar comes back as `{ <fnname>: value }`;
    // PostgREST returns the value itself.
    if (rows.length && Object.keys(rows[0]).length === 1) {
      const only = Object.keys(rows[0])[0];
      if (only === d.rpc) rows = rows.map((r) => r[only]);
    }

    return shape(rows, d);
  } catch (e) {
    return {
      data: null,
      error: {
        message: e instanceof Error ? e.message : String(e),
        code: e?.code,
        details: e?.detail,
        hint: e?.hint,
      },
      status: 500,
    };
  }
}

module.exports = { executeQuery, executeRpc };
