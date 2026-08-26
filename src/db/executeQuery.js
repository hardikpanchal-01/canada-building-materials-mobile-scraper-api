/**
 * Server-side executor: turns a query descriptor (produced by queryBuilder.js)
 * into parameterized SQL and runs it via node-postgres. Returns a
 * PostgREST-compatible `{ data, error, count }` so existing call sites that
 * destructure `{ data, error }` keep working unchanged.
 *
 * Supported: select / insert / update / upsert / delete, filters
 * (eq/neq/gt/gte/lt/lte/like/ilike/in/is/contains/overlaps/or, optional
 * negate), order / limit / range, single / maybeSingle, exact count,
 * head-only count.
 *
 * Ported (CommonJS) from the estate frontend `src/db/execute-query.ts`, trimmed
 * to this API's surface (no embedded selects — verified none are used).
 */

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ident(name) {
  const n = String(name).trim();
  if (!IDENT.test(n)) throw new Error(`Invalid identifier: ${name}`);
  return `"${n}"`;
}

// Qualified column: "a.b" -> "a"."b"; plain -> "col"
function col(name) {
  return String(name)
    .split('.')
    .map((p) => ident(p))
    .join('.');
}

// A select item, supporting PostgREST column aliasing `alias:column`.
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

// PostgREST or-string scalars -> JS values.
function coerce(v) {
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !isNaN(Number(v))) return Number(v);
  return v;
}

// Parse an IN value: a real array, or a PostgREST string form "(a,b,c)".
function inList(value) {
  if (Array.isArray(value)) return value;
  const s = String(value).trim();
  const inner = s.startsWith('(') && s.endsWith(')') ? s.slice(1, -1) : s;
  if (inner === '') return [];
  return inner.split(',').map((t) => coerce(t.trim()));
}

function renderFilter(f, params) {
  // Handle `or` first — its column is empty (the OR-string carries the columns),
  // so computing col(f.column) here would throw on the empty identifier.
  if (f.op === 'or') {
    // value is a PostgREST or-string: "col.op.val,col2.op2.val2"
    const parts = String(f.value).split(',');
    const rendered = parts.map((p) => {
      const [pcol, pop, ...rest] = p.split('.');
      const pval = rest.join('.');
      // PostgREST wildcards use `*`; SQL LIKE/ILIKE use `%`.
      const isLike = pop === 'like' || pop === 'ilike';
      const coerced = isLike ? String(pval).replace(/\*/g, '%') : coerce(pval);
      return renderFilter({ op: pop, column: pcol, value: coerced }, params);
    });
    const joined = `(${rendered.join(' OR ')})`;
    return f.negate ? `NOT (${joined})` : joined;
  }
  const c = col(f.column);
  const neg = (s) => (f.negate ? `NOT (${s})` : s);
  switch (f.op) {
    case 'eq':
      return neg(`${c} = ${pushParam(params, f.value)}`);
    case 'neq':
      return neg(`${c} <> ${pushParam(params, f.value)}`);
    case 'gt':
      return neg(`${c} > ${pushParam(params, f.value)}`);
    case 'gte':
      return neg(`${c} >= ${pushParam(params, f.value)}`);
    case 'lt':
      return neg(`${c} < ${pushParam(params, f.value)}`);
    case 'lte':
      return neg(`${c} <= ${pushParam(params, f.value)}`);
    case 'like':
      return neg(`${c} LIKE ${pushParam(params, f.value)}`);
    case 'ilike':
      return neg(`${c} ILIKE ${pushParam(params, f.value)}`);
    case 'in': {
      const arr = inList(f.value);
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
      // jsonb/array containment: col @> value
      return neg(`${c} @> ${pushParam(params, JSON.stringify(f.value))}`);
    case 'overlaps':
      // array overlap: col && value
      return neg(`${c} && ${pushParam(params, f.value)}`);
    default:
      throw new Error(`Unsupported filter op: ${f.op}`);
  }
}

function buildWhere(d, params) {
  const conds = d.filters.map((f) => renderFilter(f, params));
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
  const raw = (d.columns || '*').trim();
  const cols =
    raw === '' || raw === '*'
      ? '*'
      : raw
          .split(',')
          .map((s) => selectCol(s))
          .join(', ');
  let text = `SELECT ${cols} FROM ${relation(d.schema, d.table)}`;
  text += buildWhere(d, params);
  text += orderLimitClause(d);
  return { text, params };
}

function columnsOf(values) {
  const set = new Set();
  for (const row of values) for (const k of Object.keys(row)) set.add(k);
  return [...set];
}

function buildInsert(d, upsert) {
  const rows = Array.isArray(d.values) ? d.values : [d.values ?? {}];
  const cols = columnsOf(rows);
  const params = [];
  if (cols.length === 0) {
    // INSERT ... DEFAULT VALUES for an empty object
    let t = `INSERT INTO ${relation(d.schema, d.table)} DEFAULT VALUES`;
    if (d.returning) t += ` RETURNING *`;
    return { text: t, params };
  }
  const valuesSql = rows
    .map((row) => {
      const ph = cols.map((c) => (c in row ? pushParam(params, row[c]) : 'DEFAULT'));
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
      const setList = cols
        .filter((c) => !conflictCols.includes(c))
        .map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`)
        .join(', ');
      text += ` ON CONFLICT (${conflict}) DO UPDATE SET ${
        setList ||
        cols.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')
      }`;
    }
  }
  if (d.returning) text += ` RETURNING *`;
  return { text, params };
}

function buildUpdate(d) {
  const params = [];
  const row = d.values ?? {};
  const setList = Object.keys(row)
    .map((k) => `${ident(k)} = ${pushParam(params, row[k])}`)
    .join(', ');
  let text = `UPDATE ${relation(d.schema, d.table)} SET ${setList}`;
  text += buildWhere(d, params);
  if (d.returning) text += ` RETURNING *`;
  return { text, params };
}

function buildDelete(d) {
  const params = [];
  let text = `DELETE FROM ${relation(d.schema, d.table)}`;
  text += buildWhere(d, params);
  if (d.returning) text += ` RETURNING *`;
  return { text, params };
}

/**
 * @param {object} d  query descriptor
 * @param {{ query: (text: string, params?: any[]) => Promise<{rows:any[]}> }} pool
 */
async function executeQuery(d, pool) {
  try {
    if (!pool) {
      return { data: null, error: { message: 'Database pool not configured' } };
    }

    // head:true → caller only wants the count, never the rows.
    if (d.op === 'select' && d.head) {
      const cparams = [];
      const cwhere = buildWhere(d, cparams);
      const ctext = `SELECT count(*)::int AS n FROM ${relation(d.schema, d.table)}${cwhere}`;
      const cres = await pool.query(ctext, cparams);
      return { data: null, error: null, count: cres.rows[0]?.n ?? 0 };
    }

    let parts;
    switch (d.op) {
      case 'select':
        parts = buildSelect(d);
        break;
      case 'insert':
        parts = buildInsert(d, false);
        break;
      case 'upsert':
        parts = buildInsert(d, true);
        break;
      case 'update':
        parts = buildUpdate(d);
        break;
      case 'delete':
        parts = buildDelete(d);
        break;
      default:
        return { data: null, error: { message: `Unsupported op: ${d.op}` } };
    }

    const result = await pool.query(parts.text, parts.params);
    const rows = result.rows;

    let count = null;
    if (d.op === 'select' && d.count === 'exact') {
      const cparams = [];
      const cwhere = buildWhere(d, cparams);
      const ctext = `SELECT count(*)::int AS n FROM ${relation(d.schema, d.table)}${cwhere}`;
      const cres = await pool.query(ctext, cparams);
      count = cres.rows[0]?.n ?? 0;
    }

    if (d.single === 'single') {
      if (rows.length !== 1) {
        return {
          data: null,
          error: {
            message:
              rows.length === 0
                ? 'JSON object requested, multiple (or no) rows returned'
                : 'Results contain more than one row',
            code: 'PGRST116',
          },
          count,
        };
      }
      return { data: rows[0], error: null, count };
    }
    if (d.single === 'maybe') {
      return { data: rows[0] ?? null, error: null, count };
    }

    return { data: rows, error: null, count };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { data: null, error: { message, code: e && e.code } };
  }
}

module.exports = { executeQuery };
