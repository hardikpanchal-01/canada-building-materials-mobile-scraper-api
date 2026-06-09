/**
 * Stage 2 — System prompt generator.
 *
 * Replaces the hand-written schema/KPI/status sections of the system prompt
 * with content generated deterministically from:
 *   - KPI_REGISTRY (src/lib/ai/kpi-registry.ts) — canonical KPI definitions
 *   - ORDER_STATUS / STATUS_LABELS (src/types/orderStatus.ts) — canonical order status enum
 *   - STATUS_TO_TIME_FIELD / STATUS_KEY_TO_DISPLAY (src/types/dispatchMonitoring.ts)
 *     — canonical ticket lifecycle ↔ column mapping (when available)
 *
 * The hand-written policy sections (mandatory flow, query rules, filter
 * transparency, dashboard guidelines, etc.) live in system-prompt.ts and
 * use this generator to inject schema + KPI + status content.
 *
 * Why generated, not hand-written: the hand-written prompt drifted from
 * reality (used `tickets.amount` as the volume column when it's actually
 * dollars; documented `current_status` as a text enum when it's integer;
 * referenced columns that don't exist). Generated content stays in sync
 * with the registry — and the registry is validated against live DB by
 * scripts/check-kpi-registry.ts in CI.
 */

import { KPI_REGISTRY } from "./kpi-registry.mjs";
import {
  STATUS_LABELS,
  PRE_POUR_STATUSES,
  IN_PROCESS_STATUSES,
} from "./orderStatus.mjs";

// ============================================================================
// Section 1 — Database Schema (generated from registry's referenced columns)
// ============================================================================

/**
 * Returns the schema section for the prompt. Lists every column the
 * registry references on each table, organized by table. Implies a
 * "if it's not listed here, don't query it" contract.
 */
export function generateSchemaSection() {
  const cols = collectColumnsByTable();

  const lines = [];
  lines.push("## Database Schema — Verified Columns");
  lines.push("");
  lines.push(
    "Below are EVERY column the AI is permitted to reference, grouped by table. " +
      "Each column has been verified to exist in the live database. **Never reference a column not on this list — queries against unknown columns return zero rows silently.**"
  );
  lines.push("");

  Array.from(cols.entries()).forEach(([table, columnSet]) => {
    const columns = Array.from(columnSet).sort();
    lines.push(`### \`${table}\``);
    lines.push(`- ${columns.map((c) => `\`${c}\``).join(", ")}`);
    lines.push("");
  });

  // Explicit "do not use" callouts for the columns the previous prompt
  // claimed existed but don't:
  lines.push("### Columns the previous prompt claimed but that DO NOT exist");
  lines.push("");
  lines.push(
    "Do NOT reference these on the `tickets` table — they will silently return zero rows:"
  );
  lines.push(
    "- `slump` (lives on `ticket_products.slump` and `order_products.slump`, not on `tickets`)"
  );
  lines.push("- `truck_ahead` (does not exist anywhere)");
  lines.push(
    "- `special_instructions` (does not exist on tickets; instructions are on `tickets.instruction_addr1`–`instruction_addr6`)"
  );
  lines.push(
    "- `total_quantity`, `ordered_qty`, `delivered_qty` (these are computed at the API layer; on raw tables use `order_products.order_qty` and `ticket_products.delv_qty` with their `_unit` filter)"
  );
  lines.push("");

  // Master-table column-name trap
  lines.push("### Master-table column names (subtle but important)");
  lines.push("");
  lines.push(
    "When joining to a master table, the column names are unprefixed — `customers.code`, `customers.name`, `plants.code`, `trucks.code`, `items.code`. The prefixed forms (`customer_code`, `truck_code`, `item_code`) only exist on child tables (orders, tickets, ticket_products). This trips up queries against the master tables."
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Walks the registry and collects, per table, every column referenced by any
 * KPI's valueColumn/dateColumn/defaultGroupBy/requiredFilters. Handles dotted
 * references like "tickets.order_date" by attributing them to the right table.
 */
function collectColumnsByTable() {
  const out = new Map();

  function add(table, column) {
    if (!table || !column) return;
    if (!out.has(table)) out.set(table, new Set());
    out.get(table).add(column);
  }

  function ref(ref, defaultTable) {
    if (!ref) return;
    // Skip computed expressions (handled separately)
    if (/[() *+/-]/.test(ref) && !ref.includes(".")) {
      // It's a SQL expression — extract bare identifiers
      const matches = ref.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
      const sqlNoise = new Set([
        "EXTRACT",
        "EPOCH",
        "FROM",
        "INTERVAL",
        "CAST",
        "AS",
        "AND",
        "OR",
        "NOT",
        "NULL",
        "TRUE",
        "FALSE",
        "TIMESTAMP",
      ]);
      for (const m of matches) {
        if (!sqlNoise.has(m.toUpperCase()) && isNaN(Number(m))) {
          add(defaultTable, m);
        }
      }
      return;
    }
    if (ref.includes(".")) {
      const [t, c] = ref.split(".", 2);
      add(t, c);
    } else {
      add(defaultTable, ref);
    }
  }

  for (const k of KPI_REGISTRY) {
    if (k.outOfScope) continue;
    if (k.valueColumn) ref(k.valueColumn, k.table);
    if (k.dateColumn) ref(k.dateColumn, k.table);
    if (k.defaultGroupBy) ref(k.defaultGroupBy, k.table);
    for (const f of k.requiredFilters) {
      ref(f.column, k.table);
      if (f.operator.endsWith("_col") && typeof f.value === "string") {
        ref(f.value, k.table);
      }
    }
  }

  return out;
}

// ============================================================================
// Section 2 — KPI Catalog (the heart of the prompt — generated from registry)
// ============================================================================

export function generateKpiCatalogSection() {
  const lines = [];
  lines.push(
    "## Available KPIs (use these as your reference — do NOT invent new ones)"
  );
  lines.push("");
  lines.push(
    "Each KPI below lists its canonical id, the user phrasings (synonyms) that should resolve to it, and the exact query template. " +
      "When the user's question matches any synonym, use the listed `table`, `aggregation`, `valueColumn`, `requiredFilters`, etc. exactly. " +
      "**If a question doesn't match any KPI here, ask the user to clarify rather than guessing.**"
  );
  lines.push("");

  const inScope = KPI_REGISTRY.filter((k) => !k.outOfScope);
  const outOfScope = KPI_REGISTRY.filter((k) => k.outOfScope);

  for (const k of inScope) {
    lines.push(formatKpiEntry(k));
    lines.push("");
  }

  if (outOfScope.length > 0) {
    lines.push("### Out-of-scope KPIs (data not currently tracked)");
    lines.push("");
    for (const k of outOfScope) {
      lines.push(`- **${k.name}** (\`${k.id}\`) — ${k.description}`);
    }
    lines.push("");
    lines.push(
      'If the user asks about an out-of-scope KPI, respond plainly: *"This KPI requires data we do not currently track. Available related fields: …"* — do NOT generate a misleading dashboard.'
    );
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Compact one-block-per-KPI format. Goal: total prompt under ~3000 tokens
 * for the KPI catalog while preserving everything the LLM needs to:
 *   1. Recognize the user's phrasing → KPI id
 *   2. Reproduce the query plan
 */
function formatKpiEntry(k) {
  // Build the query summary as a single line of pseudo-SQL
  const filterParts = k.requiredFilters.map((f) => {
    if (f.operator === "is_null") return `${f.column} IS NULL`;
    if (f.operator === "is_not_null") return `${f.column} IS NOT NULL`;
    if (f.operator.endsWith("_col"))
      return `${f.column} ${shortOp(f.operator)} ${f.value}`;
    if (f.value === undefined || f.value === null)
      return `${f.column} ${f.operator}`;
    const v = typeof f.value === "string" ? `'${f.value}'` : String(f.value);
    return `${f.column} ${shortOp(f.operator)} ${v}`;
  });
  const filtersStr =
    filterParts.length > 0 ? ` WHERE ${filterParts.join(" AND ")}` : "";

  const valueExpr = k.valueColumn ?? "*";
  const aggExpr = `${k.aggregation.toUpperCase()}(${valueExpr})`;
  const groupByStr = k.defaultGroupBy ? ` GROUP BY ${k.defaultGroupBy}` : "";
  const outerStr = k.outerMethod
    ? ` -> ${k.outerMethod.toUpperCase()} over groups`
    : "";
  const dateFmtStr = k.dateFormat ? ` (date trunc: ${k.dateFormat})` : "";

  const lines = [];
  lines.push(`- **\`${k.id}\`** (${k.unit}) — ${k.name}: ${k.description}`);
  lines.push(
    `  - **synonyms:** ${k.synonyms
      .slice(0, 8)
      .map((s) => `"${s}"`)
      .join(
        ", "
      )}${k.synonyms.length > 8 ? `, …(+${k.synonyms.length - 8})` : ""}`
  );
  lines.push(
    `  - **query:** \`${aggExpr} FROM ${k.table}${filtersStr}${groupByStr}${outerStr}${dateFmtStr}\`${k.requiresJoin ? " (joined; compiler handles)" : ""} — date column: \`${k.dateColumn}\``
  );
  if (k.examples.length > 0) {
    const ex = k.examples[0];
    const filterHint = ex.expectedFilters
      ? ` → expected filters: ${JSON.stringify(ex.expectedFilters)}`
      : "";
    lines.push(`  - **example:** "${ex.question}"${filterHint}`);
  }
  // Surface mandatory-rule notes (those starting with MUST/REQUIRED/ALWAYS) so
  // the AI sees the constraint inline, not just the query shape.
  const mandatoryNotes = (k.notes ?? []).filter((n) =>
    /^(must\b|required\b|always\b)/i.test(n)
  );
  for (const note of mandatoryNotes) {
    lines.push(`  - **rule:** ${note}`);
  }
  return lines.join("\n");
}

/** Maps registry filter operators to short symbols for the inline query summary. */
function shortOp(op) {
  const map = {
    eq: "=",
    neq: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    like: "LIKE",
    ilike: "ILIKE",
    in: "IN",
    eq_col: "=",
    neq_col: "!=",
    gt_col: ">",
    gte_col: ">=",
    lt_col: "<",
    lte_col: "<=",
  };
  return map[op] ?? op;
}

// ============================================================================
// Section 3 — Status enums (from canonical types files)
// ============================================================================

export function generateStatusSection() {
  const lines = [];
  lines.push("## Status Mappings (canonical)");
  lines.push("");
  lines.push("### Order status (`orders.current_status` — INTEGER)");
  lines.push("");
  lines.push(
    "From `src/types/orderStatus.ts:STATUS_LABELS`. Source of truth for filtering by order status."
  );
  lines.push("");
  lines.push("| Code | Label |");
  lines.push("|---|---|");
  for (const [code, label] of Object.entries(STATUS_LABELS)) {
    lines.push(`| ${code} | ${label} |`);
  }
  lines.push("");
  lines.push(
    "**Cancellation is NOT a status code.** It is `orders.removed = true`. Stage 0a verified: every removed=true order has a `remove_reason_code`, so the simple filter is reliable."
  );
  lines.push("");
  lines.push(
    `Pre-Pour codes: ${PRE_POUR_STATUSES.join(", ")} (orders without delivered quantity). ` +
      `In-Process codes: ${IN_PROCESS_STATUSES.join(", ")} (orders with delivered quantity).`
  );
  lines.push("");

  lines.push(
    "### Ticket status (derived from lifecycle timestamps, NOT `tickets.current_status`)"
  );
  lines.push("");
  lines.push(
    "Ticket status in the UI is computed from which lifecycle timestamp is the most recent non-null. " +
      "`tickets.current_status` is INTEGER in the DB but the API/UI replaces it with a string from `computeTicketStatus()`. " +
      "Direct DB queries get the integer (mostly 0/3/4 in practice). " +
      "**To filter by ticket status, use timestamp IS NOT NULL conditions on the corresponding column** — see the relevant `tickets_*` KPIs in the catalog."
  );
  lines.push("");
  lines.push(
    "Mapping (from `STATUS_TO_TIME_FIELD` in `src/types/dispatchMonitoring.ts`):"
  );
  lines.push("");
  lines.push("| UI label | DB timestamp column |");
  lines.push("|---|---|");
  lines.push("| Ticketed | `printed_time` |");
  lines.push("| Loading | `load_time` |");
  lines.push("| Loaded | `loaded_time` |");
  lines.push("| To Job | `to_job_time` |");
  lines.push("| At Job | `on_job_time` |");
  lines.push("| Pouring | `unload_time` (start of pour) |");
  lines.push("| Washing | `wash_time` |");
  lines.push("| To Plant | `to_plant_time` |");
  lines.push("| At Plant | `at_plant_time` |");
  lines.push("| Canceled | `remove_reason_code IS NOT NULL` |");
  lines.push("");
  lines.push(
    '**`tickets.end_unload` is 100% NULL in production — never use it.** For "pour duration" use `wash_time − on_job_time`.'
  );
  lines.push("");
  lines.push(
    '**UI label "At Job" maps to DB column `on_job_time`** (not `at_job_time`). This is a common confusion source.'
  );
  lines.push("");

  return lines.join("\n");
}

// ============================================================================
// Section 4 — Volume bug callout (corrects the wrong-column bug)
// ============================================================================

export function generateVolumeBugCallout() {
  return `# 🚨 CRITICAL: NEVER use \`tickets.amount\` for "yards" / "CY" / "volume" / "delivered quantity"

\`tickets.amount\` is **DOLLARS** (pre-tax revenue), NOT cubic yards. Verified against live DB on 2026-05-01: ratio of \`tickets.amount\` to delivered CY is **$186/CY** (industry ASP).

If you see yourself writing this for a volume question, **STOP**:

\`\`\`json
❌ WRONG (returns dollars labeled as yards):
{ "table": "tickets", "aggregate": { "method": "sum", "valueColumn": "amount" } }
\`\`\`

The CORRECT pattern for ANY question containing "yards", "cubic yards", "CY", "volume", "delivered quantity", "qty per X":

\`\`\`json
✅ RIGHT (returns actual cubic yards):
{
  "table": "ticket_products",
  "aggregate": { "method": "sum", "valueColumn": "delv_qty" },
  "filters": [
    { "column": "delv_qty_unit", "operator": "eq", "value": "CY" }
  ]
}
\`\`\`

For "yards by customer / plant / project / mix design", add a \`groupBy\` on the corresponding column from \`tickets\` (the FK joins automatically through \`ticket_id\` business code). See the \`delivered_cy_by_customer\`, \`delivered_cy_by_plant\`, \`delivered_cy_by_project\` KPIs in the catalog.

**Revenue questions** ("how much did we bill", "ASP", "$ per CY", "total sales") DO use \`tickets.amount\` — that's the correct column for revenue. See \`total_revenue\` and \`asp_per_cy\` KPIs.

**Mandatory rule:** before EVERY \`generateDashboard\` call, call \`resolveKpi\` first with the user's question. It returns the EXACT \`table\`, \`valueColumn\`, and \`requiredFilters\` to use — copy them verbatim. Skipping this step is how the wrong-column bug returned in production. Do NOT skip it.
`;
}
