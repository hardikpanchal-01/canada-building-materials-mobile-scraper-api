import { supabaseServer } from "./_supabase.mjs";
import { BLOCKED_TABLES } from "./sql-safety.mjs";
import { getAiRequestContext } from "./audit-log.mjs";

/**
 * Tables that carry a `customer_id` and can therefore be safely scoped to a
 * contractor's own customers. Every other AI-queryable table (master tables,
 * product/schedule child tables, daily_intelligence) has no customer_id, so a
 * contractor query against them is denied rather than returning everyone's data.
 */
const CONTRACTOR_SCOPED_TABLES = new Set([
  "orders",
  "tickets",
  "v_late_tickets",
  "v_tickets_with_cy",
  "v_pour_rate_per_order",
]);

/**
 * Row-level security for contractor users. Producers/admins are unaffected.
 * For a contractor, force a `customer_id IN (their customers)` filter onto every
 * query — regardless of what the model asked — and deny tables that can't be
 * scoped. Fail-closed: a contractor with no customers matches nothing.
 *
 * The scope is read from the per-request AsyncLocalStorage context set in
 * dashboard-chat.mjs, so the model can never bypass it.
 */
function applyContractorScope(params) {
  const scope = getAiRequestContext().customerScope;
  if (!scope || scope.userType !== "contractor") return params;

  if (!CONTRACTOR_SCOPED_TABLES.has(params.table)) {
    throw new Error(
      `Access to '${params.table}' is not available for your account.`,
    );
  }

  const ids = Array.isArray(scope.customerIds)
    ? scope.customerIds.filter((v) => v !== null && v !== undefined && `${v}`.length > 0)
    : [];
  // Fail-closed: no assigned customers -> a value that matches no real id.
  const value = ids.length > 0 ? ids.join(",") : "-1";

  const scopeFilter = { column: "customer_id", operator: "in", value };
  return { ...params, filters: [...(params.filters ?? []), scopeFilter] };
}

/**
 * Stage 3: Structured error thrown when a column reference is rejected by
 * the server-side _ai_validate_columns helper. tools.ts catches this and
 * surfaces it to the AI for self-correction on retry.
 */
export class UnknownColumnError extends Error {
  code = "unknown_column";
  constructor(message) {
    super(message);
    this.name = "UnknownColumnError";
  }
}

/**
 * Stage 3: Pre-flight column validation. Calls the _ai_validate_columns RPC
 * (added in migration 20260501000002) before any aggregate / select_rows /
 * count query. If the RPC isn't yet deployed (PGRST202 "function not found"),
 * skips validation gracefully so the codebase works against pre-migration
 * environments too.
 */
async function validateColumns(table, columns) {
  const cleaned = columns.filter((c) => typeof c === "string" && c.trim().length > 0);
  if (cleaned.length === 0) return;

  const { error } = await supabaseServer.rpc("_ai_validate_columns", {
    p_table: table,
    p_columns: cleaned,
  });
  if (!error) return;

  // Migration not yet applied — RPC missing. Skip validation silently.
  if (error.code === "PGRST202" || /function .* does not exist/i.test(error.message)) {
    return;
  }

  // Real validation failure — surface as structured error
  if (error.code === "22023" || /unknown_column/.test(error.message)) {
    throw new UnknownColumnError(error.message);
  }

  // Any other error: rethrow as-is (network failure etc.)
  throw new Error(`column validation: ${error.message}`);
}

/**
 * Extracts every distinct column name referenced by a filter array.
 * Includes column-compare values (which are themselves column names).
 */
function collectFilterColumns(filters) {
  const out = new Set();
  for (const f of filters ?? []) {
    if (f.column) out.add(f.column);
    if (f.operator.endsWith("_col") && typeof f.value === "string" && f.value.length > 0) {
      out.add(f.value);
    }
  }
  return Array.from(out);
}

const COLUMN_COMPARE_OPS = new Set([
  "eq_col", "neq_col", "gt_col", "gte_col", "lt_col", "lte_col",
]);

function hasColumnCompareFilter(filters) {
  return (filters ?? []).some((f) => COLUMN_COMPARE_OPS.has(f.operator));
}

export async function executeTableQuery(
  params
) {
  if (BLOCKED_TABLES.includes(params.table)) {
    throw new Error(`Access to table '${params.table}' is not allowed`);
  }
  params = applyContractorScope(params);

  // Stage 3: pre-validate column references on tables and select expressions.
  const selectCols = params.select && params.select !== "*"
    ? params.select.split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
    : [];
  await validateColumns(params.table, [
    ...selectCols,
    params.order?.column,
    params.groupBy,
    ...collectFilterColumns(params.filters),
  ]);

  // PostgREST/supabase-js has no native column-vs-column filter syntax. When
  // any filter uses a column-compare operator, route through the
  // ai_select_rows RPC which builds the SQL server-side with %I/%I.
  if (hasColumnCompareFilter(params.filters)) {
    return executeRowsViaRpc(params);
  }

  let query = supabaseServer.from(params.table).select(params.select || "*");

  if (params.filters) {
    for (const f of params.filters) {
      switch (f.operator) {
        case "eq":
          query = query.eq(f.column, f.value);
          break;
        case "neq":
          query = query.neq(f.column, f.value);
          break;
        case "gt":
          query = query.gt(f.column, f.value);
          break;
        case "gte":
          query = query.gte(f.column, f.value);
          break;
        case "lt":
          query = query.lt(f.column, f.value);
          break;
        case "lte":
          query = query.lte(f.column, f.value);
          break;
        case "like":
          query = query.like(f.column, String(f.value));
          break;
        case "ilike":
          query = query.ilike(f.column, String(f.value));
          break;
        case "is":
          if (f.value === null || f.value === undefined || f.value === "null") {
            query = query.is(f.column, null);
          } else if (typeof f.value === "boolean") {
            query = query.is(f.column, f.value);
          } else {
            query = query.eq(f.column, f.value);
          }
          break;
        case "is_null":
          query = query.is(f.column, null);
          break;
        case "is_not_null":
          query = query.not(f.column, "is", null);
          break;
        case "in":
          query = query.in(f.column, String(f.value).split(","));
          break;
        default:
          if (f.value !== undefined) query = query.eq(f.column, f.value);
      }
    }
  }

  if (params.order) {
    query = query.order(params.order.column, {
      ascending: params.order.ascending ?? false,
    });
  }

  query = query.limit(params.limit || 10);

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const rows = data ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

function filtersToJsonb(filters) {
  if (!filters || filters.length === 0) return [];
  return filters.map((f) => ({
    column: f.column,
    operator: f.operator,
    value: f.value === undefined ? null : f.value,
  }));
}

/**
 * Routes executeTableQuery through the ai_select_rows RPC when filters
 * include column-compare operators (eq_col, gt_col, etc.). PostgREST has
 * no native syntax for column-vs-column predicates, so we let Postgres
 * build the WHERE clause via the RPC's safe identifier-only path.
 */
async function executeRowsViaRpc(
  params,
) {
  const { data, error } = await supabaseServer.rpc("ai_select_rows", {
    p_table: params.table,
    p_filters: filtersToJsonb(params.filters),
    p_select: params.select ?? "*",
    p_order_col: params.order?.column ?? null,
    p_order_asc: params.order?.ascending ?? false,
    p_limit: params.limit ?? 10,
  });

  if (error) {
    throw new Error(`ai_select_rows: ${error.message}`);
  }

  // ai_select_rows returns SETOF JSONB — each row is already a json object.
  const rows = (data ?? []) ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

export async function executeAggregate(
  params
) {
  if (BLOCKED_TABLES.includes(params.table)) {
    throw new Error(`Access to table '${params.table}' is not allowed`);
  }
  params = applyContractorScope(params);

  // Stage 3: pre-validate every column reference. Throws UnknownColumnError
  // with structured "available columns" hint if any column is invalid.
  await validateColumns(params.table, [
    params.valueColumn,
    params.groupBy,
    ...collectFilterColumns(params.filters),
  ]);

  const { data, error } = await supabaseServer.rpc("ai_aggregate", {
    p_table: params.table,
    p_filters: filtersToJsonb(params.filters),
    p_group_by: params.groupBy ?? null,
    p_method: params.method,
    p_value_col: params.valueColumn ?? null,
    p_date_format: params.dateFormat ?? null,
    p_sort: params.sort ?? null,
    p_limit: params.limit ?? 500,
    p_top_n: params.topN ?? null,
    p_outer_method: params.outerMethod ?? null,
  });

  if (error) {
    throw new Error(`ai_aggregate: ${error.message}`);
  }

  const rows = (data ?? []).map(
    (r) => ({ key: r.key, value: Number(r.value) })
  );
  return { rows };
}

export async function executeCount(params) {
  if (BLOCKED_TABLES.includes(params.table)) {
    throw new Error(`Access to table '${params.table}' is not allowed`);
  }
  params = applyContractorScope(params);

  // Stage 3: pre-validate filter column references.
  await validateColumns(params.table, collectFilterColumns(params.filters));

  const { data, error } = await supabaseServer.rpc("ai_count", {
    p_table: params.table,
    p_filters: filtersToJsonb(params.filters),
  });

  if (error) {
    throw new Error(`ai_count: ${error.message}`);
  }

  return Number(data ?? 0);
}
