import { tool, generateText } from "ai";
import { z } from "zod";
import {
  executeTableQuery,
  executeAggregate,
} from "./query-executor.mjs";
import { BLOCKED_TABLES } from "./sql-safety.mjs";
import { supabaseServer } from "./_supabase.mjs";
import { resolveRelativeDateRange } from "./date-resolver.mjs";
import { withAuditLog } from "./audit-log.mjs";
import { model } from "./provider.mjs";
import { resolveKpi as nlResolveKpi, getKpiDef } from "./nl-resolver.mjs";
import { suggestTemplate, expandTemplate } from "./dashboard-templates.mjs";
import { KPI_REGISTRY, NOT_REMOVED_FILTER } from "./kpi-registry.mjs";

const COLUMN_COMPARE_OPS = [
  "eq_col", "neq_col", "gt_col", "gte_col", "lt_col", "lte_col",
];
const SQL_IDENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const filterSchema = z
  .object({
    column: z.string(),
    operator: z.enum([
      "eq", "neq", "gt", "gte", "lt", "lte",
      "like", "ilike", "is", "in", "is_null", "is_not_null",
      "eq_col", "neq_col", "gt_col", "gte_col", "lt_col", "lte_col",
    ]),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .refine(
    (f) => {
      if (
        COLUMN_COMPARE_OPS.includes(f.operator)
      ) {
        return typeof f.value === "string" && SQL_IDENT_REGEX.test(f.value);
      }
      return true;
    },
    {
      message:
        "column-compare operators (eq_col, gt_col, etc.) require value to be a valid SQL identifier (column name)",
    },
  );

const aggregateConfigSchema = z.object({
  groupBy: z.string().optional().describe(
    "Column to group rows by. Omit for total aggregation (e.g. KPI count)."
  ),
  method: z.enum(["count", "count_distinct", "sum", "avg"]).describe(
    "Aggregation method. Use count_distinct (with valueColumn) for 'unique X' KPIs — never use count + groupBy to fake it."
  ),
  valueColumn: z.string().optional().describe(
    "Column to sum/avg/count_distinct over (required for sum, avg, count_distinct)."
  ),
  dateFormat: z.enum(["date", "month", "year"]).optional().describe(
    "For date columns: truncate to date/month/year (in America/Chicago) before grouping."
  ),
  sort: z.enum(["key_asc", "key_desc", "value_asc", "value_desc"]).optional()
    .describe("Sort result by key or value."),
  topN: z.number().int().positive().optional().describe(
    "Return top-N keys plus an 'Other' bucket. Use for pie charts with many categories."
  ),
  outerMethod: z.enum(["avg", "max", "min", "sum"]).optional().describe(
    "Second-stage aggregation over the grouped buckets. Use for 'avg/max/min/sum-per-day' KPIs: groupBy='order_date', method='count', dateFormat='date', outerMethod='avg'/'max'/'min'. Requires groupBy."
  ),
});

const widgetSchema = z.object({
  id: z.string(),
  type: z.enum([
    "bar-chart",
    "horizontal-bar-chart",
    "stacked-bar-chart",
    "line-chart",
    "pie-chart",
    "area-chart",
    "scatter-chart",
    "radar-chart",
    "treemap",
    "radial-bar-chart",
    "composed-chart",
    "kpi-card",
    "data-table",
    "text-summary",
  ]),
  title: z.string(),
  description: z.string().optional(),
  gridPosition: z.object({
    x: z.number().min(0).max(11),
    y: z.number().min(0),
    w: z.number().min(1).max(12),
    h: z.number().min(1).max(8),
  }),
  config: z
    .object({
      xAxis: z.string().optional(),
      yAxis: z.string().optional(),
      groupBy: z.string().optional(),
      colorScheme: z.string().optional(),
      valueFormat: z.enum(["number", "percentage", "currency", "compact"]).optional(),
    })
    .optional(),
  query: z.object({
    table: z.string(),
    select: z.string().optional(),
    filters: z.array(filterSchema).optional(),
    order: z.object({
      column: z.string(),
      ascending: z.boolean().optional(),
    }).optional(),
    limit: z.number().optional(),
  }),
  aggregate: aggregateConfigSchema.optional(),
  kpiId: z.string().optional().describe(
    "Optional: the canonical KPI id from the registry (e.g. 'delivered_cy_by_plant'). When set, the server auto-fills any missing aggregate fields (valueColumn, groupBy, dateFormat, outerMethod) and merges in requiredFilters from the registry. Always include this when the widget answers a registry KPI — it's the safety net against dropped fields."
  ),
});

/**
 * Auto-fill missing aggregate fields and required filters from the registry.
 * Two layers:
 *   1) If `widget.kpiId` resolves, use that KPI def as the source of truth.
 *   2) Otherwise apply table-level defaults for known views (currently
 *      v_tickets_with_cy → valueColumn='delivered_cy' for sum/avg) so a
 *      free-form widget that landed on the right table doesn't render empty
 *      because the model dropped `valueColumn`.
 * Filter-merging is conservative: existing filters on the same column are
 * kept, registry filters are only added when no filter for that column exists.
 */
function hardenWidgetFromRegistry(widget) {
  if (
    widget.type === "text-summary" ||
    (widget.type === "kpi-card" && !widget.aggregate && !widget.kpiId)
  ) {
    return widget;
  }

  const kpi = widget.kpiId ? KPI_REGISTRY.find((k) => k.id === widget.kpiId) : undefined;

  let table = widget.query.table;
  let aggregate = widget.aggregate;
  const filters = [...(widget.query.filters ?? [])];
  const filterColumns = new Set(filters.map((f) => f.column));

  if (kpi) {
    const isChart = widget.type !== "kpi-card" && widget.type !== "data-table";

    // When kpiId is set the registry is authoritative: override the table
    // (catches Flash emitting `tickets` instead of `v_tickets_with_cy`) and
    // overwrite the aggregation method + valueColumn (catches Flash picking
    // `count` for a KPI that should `sum delivered_cy`). The groupBy is
    // overridden only if the model emitted a known-wrong column for this KPI
    // (e.g. plant_id when defaultGroupBy is plant_name); if the model picked
    // a plausibly different grouping column we leave it alone.
    if (table !== kpi.table) {
      console.warn(`[harden] widget ${widget.id} kpiId=${kpi.id} table override: ${table} → ${kpi.table}`);
      table = kpi.table;
    }
    const merged = { ...(aggregate ?? { method: kpi.aggregation }) };
    if (merged.method !== kpi.aggregation) {
      console.warn(`[harden] widget ${widget.id} kpiId=${kpi.id} method override: ${merged.method} → ${kpi.aggregation}`);
      merged.method = kpi.aggregation;
    }
    if (kpi.valueColumn && merged.valueColumn !== kpi.valueColumn) {
      console.warn(`[harden] widget ${widget.id} kpiId=${kpi.id} valueColumn override: ${merged.valueColumn ?? "(none)"} → ${kpi.valueColumn}`);
      merged.valueColumn = kpi.valueColumn;
    }
    if (isChart) {
      if (!merged.groupBy && kpi.defaultGroupBy) {
        merged.groupBy = kpi.defaultGroupBy;
      } else if (kpi.defaultGroupBy && merged.groupBy && merged.groupBy !== kpi.defaultGroupBy) {
        // Detect the "Flash picked plant_id/plant_code instead of plant_name"
        // pattern: if the model's groupBy is a related id/code variant of
        // the canonical column, override to defaultGroupBy.
        const canonical = kpi.defaultGroupBy.replace(/_name$/, "");
        if (merged.groupBy === `${canonical}_id` || merged.groupBy === `${canonical}_code`) {
          console.warn(`[harden] widget ${widget.id} kpiId=${kpi.id} groupBy normalized: ${merged.groupBy} → ${kpi.defaultGroupBy}`);
          merged.groupBy = kpi.defaultGroupBy;
        }
      }
    }
    if (!merged.dateFormat && kpi.dateFormat) {
      merged.dateFormat = kpi.dateFormat;
    }
    if (!merged.outerMethod && kpi.outerMethod) {
      merged.outerMethod = kpi.outerMethod;
    }
    aggregate = merged;

    for (const rf of kpi.requiredFilters) {
      if (!filterColumns.has(rf.column)) {
        filters.push({
          column: rf.column,
          operator: rf.operator,
          ...(rf.value !== undefined && rf.value !== null ? { value: rf.value } : {}),
        });
        filterColumns.add(rf.column);
      }
    }
  }

  if (table === "v_tickets_with_cy" && aggregate) {
    if ((aggregate.method === "sum" || aggregate.method === "avg") && !aggregate.valueColumn) {
      aggregate = { ...aggregate, valueColumn: "delivered_cy" };
    }
    if (!filterColumns.has(NOT_REMOVED_FILTER.column)) {
      filters.push({
        column: NOT_REMOVED_FILTER.column,
        operator: NOT_REMOVED_FILTER.operator,
        value: NOT_REMOVED_FILTER.value,
      });
      filterColumns.add(NOT_REMOVED_FILTER.column);
    }
  }

  const unchanged =
    table === widget.query.table &&
    aggregate === widget.aggregate &&
    filters.length === (widget.query.filters?.length ?? 0);
  if (unchanged) return widget;

  return {
    ...widget,
    aggregate,
    query: { ...widget.query, table, filters },
  };
}

/** Map template defaultWindow → resolveRelativeDateRange phrase. */
const WINDOW_TO_PHRASE = {
  today: "today",
  yesterday: "yesterday",
  last_7_days: "last 7 days",
  this_month: "this month",
  last_month: "last month",
};

/** Pick a sensible chart type from the KPI shape. */
function chartTypeForKpi(kpi) {
  // Allow explicit override via displayAs field
  if (kpi.displayAs) return kpi.displayAs;
  if (!kpi.defaultGroupBy) return "kpi-card";
  // Grouping by a date column → trend line; otherwise horizontal bars
  // (works for any cardinality and the y-axis labels stay readable).
  if (kpi.dateFormat) return "line-chart";
  return "horizontal-bar-chart";
}

/**
 * Build complete, ready-to-render widgets from a template. The LLM is
 * expected to forward the returned array verbatim into generateDashboard
 * — no rebuilding, no editing. Date range, filters, aggregate config,
 * groupBy, grid positions all decided here from the registry.
 */
function buildPrebuiltWidgets(
  template,
  kpis,
) {
  const phrase = WINDOW_TO_PHRASE[template.defaultWindow];
  const range = phrase ? resolveRelativeDateRange(phrase) : null;

  const kpiCardKpis = kpis.filter((k) => !k.defaultGroupBy);
  const chartKpis = kpis.filter((k) => !!k.defaultGroupBy);

  const widgets = [];
  // KPI cards: fill the FULL 12-column row, even when card count doesn't
  // divide evenly. Distribute the leftover columns to the leftmost cards
  // (5 KPIs → widths 3,3,2,2,2 = 12). h=1 row (90 px outer / ~58 px
  // inner) keeps the card compact — title + hero number, no description.
  const cardHeight = 1;
  const total = kpiCardKpis.length;
  const baseWidth = total > 0 ? Math.max(2, Math.floor(12 / total)) : 3;
  const extraCols = total > 0 ? Math.max(0, 12 - baseWidth * total) : 0;
  let x = 0;
  kpiCardKpis.forEach((kpi, i) => {
    const w = baseWidth + (i < extraCols ? 1 : 0);
    widgets.push(buildWidget(kpi, "kpi-card", { x, y: 0, w, h: cardHeight }, range));
    x += w;
    if (x >= 12) x = 0;
  });

  // Charts start where the KPI cards end vertically (y = cardHeight).
  let y = cardHeight;
  if (chartKpis.length === 1) {
    widgets.push(buildWidget(chartKpis[0], chartTypeForKpi(chartKpis[0]), { x: 0, y, w: 12, h: 4 }, range));
  } else {
    let cx = 0;
    for (const kpi of chartKpis) {
      widgets.push(buildWidget(kpi, chartTypeForKpi(kpi), { x: cx, y, w: 6, h: 4 }, range));
      cx += 6;
      if (cx >= 12) { cx = 0; y += 4; }
    }
  }
  return widgets;
}

/**
 * Convert a registry KPI name into a clean display title.
 * Strips technical noise ("KPI card", "(Daily Intelligence)", "(period)")
 * and Title-Cases lowercase tokens so charts read like a presentation.
 */
function cleanKpiTitle(name) {
  const stripped = name
    .replace(/\s*\(Daily Intelligence\)\s*/gi, "")
    .replace(/\s*KPI card\s*/gi, "")
    .replace(/\s*\(period\)\s*/gi, "")
    .trim();
  return stripped.replace(/\b([a-z])([a-z]+)\b/g, (m, first, rest) => {
    // Don't title-case short connectors
    if (/^(by|of|the|and|or|in|on|for|per|to|a)$/i.test(m)) return m.toLowerCase();
    return first.toUpperCase() + rest;
  });
}

function buildWidget(
  kpi,
  type,
  gridPosition,
  range,
) {
  const filters = kpi.requiredFilters.map((f) => ({
    column: f.column,
    operator: f.operator,
    ...(f.value !== undefined && f.value !== null ? { value: f.value } : {}),
  }));
  if (range) {
    filters.push({ column: kpi.dateColumn, operator: "gte", value: range.startDate });
    filters.push({ column: kpi.dateColumn, operator: "lt", value: range.endDate });
  }

  // Determine if this is a chart with potentially many categories (not a date grouping)
  // Add topN: 10 to limit results and keep charts readable (except for data-tables)
  const isDataTable = type === "data-table";
  const isChartWithManyCategories =
    type !== "kpi-card" &&
    !isDataTable &&
    kpi.defaultGroupBy &&
    !kpi.dateFormat &&
    !kpi.defaultGroupBy.includes("date");

  const aggregate = {
    method: kpi.aggregation,
    ...(kpi.valueColumn ? { valueColumn: kpi.valueColumn } : {}),
    ...(type !== "kpi-card" && kpi.defaultGroupBy ? { groupBy: kpi.defaultGroupBy } : {}),
    ...(kpi.dateFormat ? { dateFormat: kpi.dateFormat } : {}),
    ...(kpi.outerMethod ? { outerMethod: kpi.outerMethod } : {}),
    ...(type !== "kpi-card" ? { sort: "value_desc" } : {}),
    // Limit to top 10 for charts with many categories (but not for data-tables)
    ...(isChartWithManyCategories ? { topN: 10 } : {}),
  };

  // No date / window in the per-widget description — the dashboard title
  // already shows the date once at the top, and repeating "05/19/2026
  // (Today (Chicago))" under every card is visual noise. KPI cards get
  // no description at all (clean: title + number); chart cards get a
  // short hint about ordering so users know what they're looking at.
  const cleanTitle = cleanKpiTitle(kpi.name);
  const description = type === "kpi-card"
    ? ""
    : isDataTable
      ? "Complete list, sorted by load count"
      : isChartWithManyCategories
        ? "Top 10, sorted highest to lowest"
        : "Sorted highest to lowest";

  return {
    id: `${kpi.id}-${gridPosition.x}-${gridPosition.y}`,
    type,
    title: cleanTitle,
    description,
    gridPosition,
    kpiId: kpi.id,
    query: { table: kpi.table, filters },
    aggregate,
  };
}

function rowsToFilters(filters) {
  return filters;
}

/**
 * JS-side aggregation. Kept as a last-resort fallback if the ai_aggregate RPC
 * fails (e.g. column not yet in allow-list). Operates on rows already fetched.
 */
function aggregateRowsFallback(
  rows,
  config
) {
  const groups = new Map();
  const keyColumn = config.groupBy ?? "key";

  for (const row of rows) {
    let key = config.groupBy ? String(row[config.groupBy] ?? "Unknown") : "total";

    if (config.groupBy && config.dateFormat && key.length >= 10) {
      if (config.dateFormat === "date") key = key.substring(0, 10);
      else if (config.dateFormat === "month") key = key.substring(0, 7);
      else if (config.dateFormat === "year") key = key.substring(0, 4);
    }

    if (!groups.has(key)) groups.set(key, { count: 0, sum: 0 });
    const g = groups.get(key);
    g.count++;
    if (config.valueColumn) {
      const val = Number(row[config.valueColumn]);
      if (!isNaN(val)) g.sum += val;
    }
  }

  let result = Array.from(groups.entries()).map(([key, g]) => {
    const value =
      config.method === "count" ? g.count :
      config.method === "sum" ? g.sum :
      config.method === "avg" ? (g.count > 0 ? g.sum / g.count : 0) : g.count;
    return { [keyColumn]: key, value };
  });

  if (config.sort === "key_asc") result.sort((a, b) => String(a[keyColumn]).localeCompare(String(b[keyColumn])));
  else if (config.sort === "key_desc") result.sort((a, b) => String(b[keyColumn]).localeCompare(String(a[keyColumn])));
  else if (config.sort === "value_asc") result.sort((a, b) => a.value - b.value);
  else if (config.sort === "value_desc") result.sort((a, b) => b.value - a.value);

  if (config.topN && result.length > config.topN) {
    const top = result.slice(0, config.topN);
    const otherSum = result.slice(config.topN).reduce((s, r) => s + r.value, 0);
    if (otherSum > 0) {
      top.push({ [keyColumn]: "Other", value: otherSum });
    }
    result = top;
  }

  return result;
}

export const tools = {
  resolveDateRange: tool({
    description:
      "Resolve a relative date phrase ('today', 'yesterday', 'last week', 'last 7 days', 'this month', 'last month', 'this year', 'last 30 days') into precise start and end ISO timestamps in America/Chicago. You MUST call this tool for any relative date the user mentions before constructing filters — never compute date strings yourself.\n\nReturn fields and how to use them:\n- `start` / `end` — ISO timestamps with Chicago offset. Use ONLY for filtering `timestamptz` columns. Half-open: filter as `gte: start`, `lt: end`.\n- `startDate` / `endDate` — `YYYY-MM-DD`. Use ONLY for filtering `date` columns and as raw tool inputs.\n- `displayStart` / `displayEnd` / `displayLabel` — `MM/DD/YYYY` form. Use these whenever you mention the date range to the user — in your thinking, dashboard titles, widget descriptions, insights, follow-ups, and the closing summary.\n\nHard rule: NEVER show the user `startDate`/`endDate`/`start`/`end` (those are ISO/SQL formats) and NEVER write long-form dates like 'April 24, 2026'. Always copy `displayStart`/`displayEnd`/`displayLabel` verbatim into user-facing prose.",
    inputSchema: z.object({
      phrase: z.string().describe(
        "The relative date phrase as the user said it, e.g. 'last week', 'yesterday', 'this month'."
      ),
    }),
    execute: withAuditLog("resolveDateRange", async ({ phrase }) => {
      const range = resolveRelativeDateRange(phrase);
      if (!range) {
        return {
          success: false,
          error: `Could not resolve phrase '${phrase}'. Supported: today, yesterday, last week, last 7 days, this week, this month, last month, this year, last 30 days, last 90 days.`,
        };
      }
      return { success: true, ...range };
    }),
  }),

  resolveKpi: tool({
    description:
      "REQUIRED before generateDashboard. Looks up the user's question in the canonical KPI registry and returns the exact table, valueColumn, requiredFilters, dateColumn, and aggregation method to use. The registry is validated against live DB; trust its output. Use the returned 'queryTemplate' verbatim in your generateDashboard widgets. If 'needsDisambiguation' is true, ask the user to pick from 'ambiguities' instead of guessing.",
    inputSchema: z.object({
      question: z.string().describe(
        "The user's question, verbatim. Example: 'How many yards did we deliver last week?'",
      ),
    }),
    execute: withAuditLog("resolveKpi", async ({ question }) => {
      const r = nlResolveKpi(question);
      if (!r.matched) {
        return {
          success: false,
          matched: null,
          ambiguities: r.ambiguities,
          needsDisambiguation: true,
          guidance:
            "No KPI in the registry matches this question. Ask the user to rephrase or pick from the listed ambiguities.",
        };
      }

      const kpi = getKpiDef(r.matched.kpiId);
      if (!kpi) {
        return { success: false, error: `resolved id '${r.matched.kpiId}' not found in registry` };
      }

      // Build the exact query template the AI should use in generateDashboard.
      // This is the canonical answer — the AI does NOT need to invent table/column choices.
      // For chart-type KPIs (with groupBy but no date grouping), add topN:10 to limit
      // results and keep the chart readable (e.g. late_tickets_by_driver with 30+ drivers).
      const isChartWithManyCategories =
        kpi.defaultGroupBy &&
        !kpi.dateFormat &&
        !kpi.defaultGroupBy.includes("date");

      const queryTemplate = {
        table: kpi.table,
        aggregate: {
          method: kpi.aggregation,
          ...(kpi.valueColumn && !/[() *+/\-]/.test(kpi.valueColumn) ? { valueColumn: kpi.valueColumn } : {}),
          ...(kpi.defaultGroupBy ? { groupBy: kpi.defaultGroupBy } : {}),
          ...(kpi.dateFormat ? { dateFormat: kpi.dateFormat } : {}),
          ...(kpi.outerMethod ? { outerMethod: kpi.outerMethod } : {}),
          ...(isChartWithManyCategories ? { topN: 10, sort: "value_desc" } : {}),
        },
        requiredFilters: kpi.requiredFilters.map((f) => ({
          column: f.column,
          operator: f.operator,
          ...(f.value !== undefined && f.value !== null ? { value: f.value } : {}),
        })),
        dateColumn: kpi.dateColumn,
      };

      return {
        success: true,
        matched: {
          kpiId: kpi.id,
          name: kpi.name,
          unit: kpi.unit,
          confidence: r.matched.confidence,
          matchedSynonyms: r.matched.matchedSynonyms,
        },
        queryTemplate,
        notes: kpi.notes ?? [],
        examples: kpi.examples,
        ambiguities: r.ambiguities,
        needsDisambiguation: r.needsDisambiguation,
      };
    }),
  }),

  suggestTemplate: tool({
    description:
      "For VAGUE questions like 'How are we doing today?' or 'Show me an overview', returns a curated pre-built dashboard. The response includes `prebuiltWidgets` — a complete, ready-to-render widget array (table, filters with date range, aggregate config, groupBy, grid positions, and kpiId all set from the registry). You MUST forward `prebuiltWidgets` verbatim into generateDashboard.widgets. Do not edit, rebuild, or omit any field. If no template matches, the tool returns `{success: false, matched: null}` — fall back to resolveKpi.",
    inputSchema: z.object({
      question: z.string(),
    }),
    execute: withAuditLog("suggestTemplate", async ({ question }) => {
      const t = suggestTemplate(question);
      if (!t) {
        return { success: false, matched: null };
      }
      const kpiDefs = expandTemplate(t);
      const kpis = kpiDefs.map((k) => ({
        id: k.id,
        name: k.name,
        unit: k.unit,
        table: k.table,
        aggregation: k.aggregation,
        valueColumn: k.valueColumn,
        dateColumn: k.dateColumn,
        requiredFilters: k.requiredFilters,
        defaultGroupBy: k.defaultGroupBy,
      }));
      const prebuiltWidgets = buildPrebuiltWidgets(t, kpiDefs);
      return {
        success: true,
        matched: {
          id: t.id,
          name: t.name,
          description: t.description,
          defaultWindow: t.defaultWindow,
          audience: t.audience,
          kpis,
          prebuiltWidgets,
        },
      };
    }),
  }),

  aggregateData: tool({
    description:
      "Run a server-side SQL aggregation (COUNT/SUM/AVG with optional GROUP BY) against an allow-listed table. ALWAYS use this for chart data and KPI totals — never aggregate in JS. Date truncation happens in America/Chicago. Supports a topN parameter that auto-buckets the rest as 'Other' (use for pie charts with >8 categories).",
    inputSchema: z.object({
      table: z.string().describe(
        "Table name (e.g. 'orders', 'tickets', 'customers')."
      ),
      filters: z.array(filterSchema).optional().describe(
        "Filters to apply BEFORE aggregating."
      ),
      groupBy: z.string().optional().describe(
        "Column to group by. Omit for a single overall total."
      ),
      method: z.enum(["count", "count_distinct", "sum", "avg"]).describe(
        "count = COUNT(*), count_distinct = COUNT(DISTINCT valueColumn) (use for 'unique X' totals), sum = SUM(valueColumn), avg = AVG(valueColumn)."
      ),
      valueColumn: z.string().optional().describe(
        "Column to operate on. Required for sum, avg, AND count_distinct."
      ),
      dateFormat: z.enum(["date", "month", "year"]).optional().describe(
        "If groupBy is a timestamp column, truncate to day/month/year in Chicago time."
      ),
      sort: z.enum(["key_asc", "key_desc", "value_asc", "value_desc"]).optional()
        .describe("Sort result rows."),
      limit: z.number().int().positive().optional().describe("Default 500."),
      topN: z.number().int().positive().optional().describe(
        "Return top-N rows + an 'Other' bucket (recommended for pie charts with many categories)."
      ),
      outerMethod: z.enum(["avg", "max", "min", "sum"]).optional().describe(
        "Second-stage aggregation. For 'avg/max/min orders per day': groupBy='order_date', method='count', dateFormat='date', outerMethod='avg' (or 'max', 'min'). Returns one row with the answer."
      ),
      explanation: z.string().describe(
        "Brief explanation of what this aggregation answers."
      ),
    }),
    execute: withAuditLog("aggregateData", async ({ explanation, ...rest }) => {
      try {
        const params = {
          table: rest.table,
          filters: rowsToFilters(rest.filters),
          groupBy: rest.groupBy,
          method: rest.method,
          valueColumn: rest.valueColumn,
          dateFormat: rest.dateFormat,
          sort: rest.sort,
          limit: rest.limit,
          topN: rest.topN,
          outerMethod: rest.outerMethod,
        };
        const { rows } = await executeAggregate(params);
        return {
          success: true,
          explanation,
          rows,
          totalRows: rows.length,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Aggregation failed",
        };
      }
    }),
  }),

  planDashboard: tool({
    description:
      "Analyze a user question and plan the optimal dashboard layout. Call this AFTER queryDatabase has returned a sample so you know the data shape, and BEFORE generateDashboard.",
    inputSchema: z.object({
      question: z.string().describe("The user's question or request"),
      dataType: z.enum([
        "ranking",
        "trend",
        "comparison",
        "distribution",
        "correlation",
        "overview",
      ]).describe("The type of analysis the question requires"),
      entities: z.array(z.string()).describe("Key entities mentioned (customers, plants, trucks, etc.)"),
      timeRange: z.boolean().describe("Whether the question involves time-series data"),
      numCategories: z.enum(["few", "moderate", "many"]).describe(
        "Expected number of categories: few (2-5), moderate (6-15), many (16+)"
      ),
    }),
    execute: withAuditLog("planDashboard", async ({ dataType, timeRange, numCategories }) => {
      let layout;
      let chartTypes;
      let kpiCount;

      if (dataType === "trend" && timeRange) {
        layout = "D";
        chartTypes = ["line-chart", "bar-chart"];
        kpiCount = 4;
      } else if (dataType === "ranking") {
        if (numCategories === "many") {
          layout = "B";
          chartTypes = ["treemap", "horizontal-bar-chart"];
        } else {
          layout = "A";
          chartTypes = ["horizontal-bar-chart", "bar-chart"];
        }
        kpiCount = 4;
      } else if (dataType === "comparison") {
        layout = "E";
        chartTypes = ["radar-chart", "horizontal-bar-chart", "bar-chart"];
        kpiCount = 4;
      } else if (dataType === "distribution") {
        layout = "B";
        chartTypes = ["treemap", "pie-chart"];
        kpiCount = 3;
      } else if (dataType === "correlation") {
        layout = "A";
        chartTypes = ["scatter-chart", "bar-chart"];
        kpiCount = 4;
      } else if (dataType === "overview") {
        layout = "C";
        chartTypes = ["bar-chart", "line-chart", "pie-chart"];
        kpiCount = 4;
      } else {
        layout = "A";
        chartTypes = ["bar-chart", "line-chart"];
        kpiCount = 4;
      }

      const layouts = {
        A: {
          kpis: [{ x: 0, y: 0, w: 3, h: 1 }, { x: 3, y: 0, w: 3, h: 1 }, { x: 6, y: 0, w: 3, h: 1 }, { x: 9, y: 0, w: 3, h: 1 }],
          charts: [{ x: 0, y: 1, w: 6, h: 4 }, { x: 6, y: 1, w: 6, h: 4 }],
        },
        B: {
          kpis: [{ x: 0, y: 0, w: 3, h: 1 }, { x: 3, y: 0, w: 3, h: 1 }, { x: 6, y: 0, w: 3, h: 1 }, { x: 9, y: 0, w: 3, h: 1 }],
          charts: [{ x: 0, y: 1, w: 8, h: 4 }, { x: 8, y: 1, w: 4, h: 4 }],
        },
        C: {
          kpis: [{ x: 0, y: 0, w: 3, h: 1 }, { x: 3, y: 0, w: 3, h: 1 }, { x: 6, y: 0, w: 3, h: 1 }, { x: 9, y: 0, w: 3, h: 1 }],
          charts: [{ x: 0, y: 1, w: 4, h: 3 }, { x: 4, y: 1, w: 4, h: 3 }, { x: 8, y: 1, w: 4, h: 3 }],
        },
        D: {
          kpis: [{ x: 0, y: 4, w: 3, h: 1 }, { x: 3, y: 4, w: 3, h: 1 }, { x: 6, y: 4, w: 3, h: 1 }, { x: 9, y: 4, w: 3, h: 1 }],
          charts: [{ x: 0, y: 0, w: 12, h: 4 }],
        },
        E: {
          kpis: [{ x: 0, y: 0, w: 3, h: 1 }, { x: 3, y: 0, w: 3, h: 1 }, { x: 6, y: 0, w: 3, h: 1 }, { x: 9, y: 0, w: 3, h: 1 }],
          charts: [{ x: 0, y: 1, w: 6, h: 4 }, { x: 6, y: 1, w: 6, h: 2 }, { x: 6, y: 3, w: 6, h: 2 }],
        },
      };

      const selectedLayout = layouts[layout] || layouts.A;

      return {
        layout,
        dataType,
        recommendedChartTypes: chartTypes,
        kpiCount: Math.min(kpiCount, selectedLayout.kpis.length),
        gridPositions: {
          kpis: selectedLayout.kpis.slice(0, kpiCount),
          charts: selectedLayout.charts,
        },
        notes: `Use layout ${layout}. KPIs on ${layout === "D" ? "bottom" : "top"}, ${selectedLayout.charts.length} chart(s). Recommended charts: ${chartTypes.join(", ")}.`,
      };
    }),
  }),

  queryDatabase: tool({
    description:
      "Fetch raw rows from a single table (no aggregation). Use this to peek at data shape before building a dashboard. For chart data and totals, use aggregateData instead.",
    inputSchema: z.object({
      table: z.string().describe("Table name (e.g. 'orders', 'tickets', 'customers')"),
      select: z.string().optional().describe(
        "Comma-separated columns to select. Use '*' for all columns."
      ),
      filters: z.array(filterSchema).optional().describe("Array of filters to apply"),
      order: z.object({
        column: z.string(),
        ascending: z.boolean().optional(),
      }).optional().describe("Order results by column"),
      limit: z.number().optional().describe("Max rows to return (default 10)"),
      explanation: z.string().describe("Brief explanation of what this query does"),
    }),
    execute: withAuditLog("queryDatabase", async ({ table, select, filters, order, limit, explanation }) => {
      try {
        const { columns, rows } = await executeTableQuery({
          table,
          select,
          filters: rowsToFilters(filters),
          order,
          limit,
        });
        return {
          success: true,
          explanation,
          columns,
          rows: rows.slice(0, 100),
          totalRows: rows.length,
          truncated: rows.length > 100,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Query failed",
        };
      }
    }),
  }),

  generateDashboard: tool({
    description:
      "Generate a full dashboard layout with multiple widgets. Each widget has a chart type, grid position, a query, and an aggregate config. Chart widgets are aggregated server-side via ai_aggregate; KPI widgets fetch a single row.",
    inputSchema: z.object({
      title: z.string().describe("Dashboard title"),
      widgets: z.array(widgetSchema).describe("Array of widget configurations"),
    }),
    execute: withAuditLog("generateDashboard", async (input) => {
      const { title, widgets: rawWidgets } = input;
      // Harden every widget from the registry before executing. This is the
      // safety net for Flash dropping `valueColumn`, `groupBy`, or
      // requiredFilters — the chart that should have rendered "CY by plant"
      // with delivered_cy summed was returning empty because the model
      // emitted a sum aggregate without a valueColumn. The KPI registry
      // knows the canonical answer; trust it.
      const widgets = rawWidgets.map(hardenWidgetFromRegistry);
      const widgetResults = await Promise.all(
        widgets.map(async (widget) => {
          if (widget.type === "text-summary") {
            return { ...widget, sql: "", data: { text: widget.description || "" } };
          }

          const isKpi = widget.type === "kpi-card";
          const isDataTable = widget.type === "data-table";

          try {
            // KPI widgets MUST aggregate. If the model forgot the aggregate
            // config, default to count(*) over the widget's filters — never
            // fall back to "first row's last column" (which surfaces random
            // text values like "pending" instead of a real total).
            if (isKpi) {
              let agg = widget.aggregate ?? { method: "count" };

              // Two-stage path: "avg/max/min orders per day" KPIs. The inner
              // stage groups (e.g. by order_date with dateFormat='date') and
              // the outer stage aggregates the bucket values. Pass groupBy
              // and dateFormat through; ai_aggregate handles both stages.
              if (agg.outerMethod) {
                if (!agg.groupBy) {
                  // outerMethod requires groupBy; without one this can't
                  // be computed. Fall back to the inner method only.
                  agg = { ...agg, outerMethod: undefined };
                } else {
                  const { rows: aggRows } = await executeAggregate({
                    table: widget.query.table,
                    filters: rowsToFilters(widget.query.filters),
                    groupBy: agg.groupBy,
                    method: agg.method,
                    valueColumn: agg.valueColumn,
                    dateFormat: agg.dateFormat,
                    outerMethod: agg.outerMethod,
                    limit: 1,
                  });
                  const total = aggRows[0]?.value ?? 0;
                  return {
                    ...widget,
                    sql: "",
                    data: {
                      columns: ["value"],
                      rows: [{ value: total }],
                      totalRows: 1,
                    },
                  };
                }
              }

              // Defensive correction: if the model used `count + groupBy` to
              // try to count unique values of `groupBy`, that's wrong (it
              // returns one row per group, not a single total). Rewrite to
              // count_distinct over the same column so the KPI shows the
              // real number of unique groups.
              if (agg.method === "count" && agg.groupBy) {
                agg = {
                  method: "count_distinct",
                  valueColumn: agg.groupBy,
                };
              }

              const { rows: aggRows } = await executeAggregate({
                table: widget.query.table,
                filters: rowsToFilters(widget.query.filters),
                // KPIs never group — they always return one number.
                groupBy: undefined,
                method: agg.method,
                valueColumn: agg.valueColumn,
                dateFormat: undefined,
                sort: undefined,
                limit: 1,
              });
              // With no groupBy, ai_aggregate returns at most one row whose
              // value is the answer. Don't sum across rows here.
              const total = aggRows[0]?.value ?? 0;
              return {
                ...widget,
                sql: "",
                data: {
                  columns: ["value"],
                  rows: [{ value: total }],
                  totalRows: 1,
                },
              };
            }

            // data-table widgets and any other widget without aggregate
            // config: fetch raw rows.
            if (isDataTable || !widget.aggregate) {
              const { rows } = await executeTableQuery({
                table: widget.query.table,
                select: widget.query.select,
                filters: rowsToFilters(widget.query.filters),
                order: widget.query.order,
                limit: widget.query.limit ?? 500,
              });
              const finalColumns = rows.length > 0 ? Object.keys(rows[0]) : [];
              return {
                ...widget,
                sql: "",
                data: {
                  columns: finalColumns,
                  rows: rows.slice(0, 500),
                  totalRows: rows.length,
                },
              };
            }

            // Chart widgets: aggregate server-side via ai_aggregate.
            const agg = widget.aggregate;

            // Safety net: for horizontal-bar-chart widgets with groupBy but no topN,
            // default to topN:10 so we don't render charts with 30+ overlapping labels.
            const needsTopNLimit =
              (widget.type === "horizontal-bar-chart" || widget.type === "bar-chart") &&
              agg.groupBy &&
              !agg.dateFormat &&
              !agg.groupBy.includes("date") &&
              !agg.topN;
            const effectiveTopN = needsTopNLimit ? 10 : agg.topN;
            const effectiveSort = needsTopNLimit && !agg.sort ? "value_desc" : agg.sort;

            try {
              const { rows: aggRows } = await executeAggregate({
                table: widget.query.table,
                filters: rowsToFilters(widget.query.filters),
                groupBy: agg.groupBy,
                method: agg.method,
                valueColumn: agg.valueColumn,
                dateFormat: agg.dateFormat,
                sort: effectiveSort,
                limit: widget.query.limit ?? 500,
                topN: effectiveTopN,
              });

              // Surface keys in a shape the chart components understand.
              const keyColumn = agg.groupBy ?? "key";
              const reshaped = aggRows.map((r) => ({
                [keyColumn]: r.key,
                value: r.value,
              }));
              return {
                ...widget,
                sql: "",
                data: {
                  columns: reshaped.length > 0 ? Object.keys(reshaped[0]) : [],
                  rows: reshaped,
                  totalRows: reshaped.length,
                },
              };
            } catch (aggError) {
              // Fallback: fetch raw rows and aggregate in JS so a stale RPC
              // doesn't break the dashboard. This path is intentionally lossy
              // (limited to widget.query.limit rows) but keeps the user moving.
              console.warn(
                "[ai_aggregate] RPC failed, falling back to JS aggregation:",
                aggError instanceof Error ? aggError.message : aggError
              );
              const { rows } = await executeTableQuery({
                table: widget.query.table,
                select: widget.query.select,
                filters: rowsToFilters(widget.query.filters),
                order: widget.query.order,
                limit: widget.query.limit ?? 500,
              });
              const finalRows = aggregateRowsFallback(rows, agg);
              return {
                ...widget,
                sql: "",
                data: {
                  columns: finalRows.length > 0 ? Object.keys(finalRows[0]) : [],
                  rows: finalRows.slice(0, 500),
                  totalRows: finalRows.length,
                },
              };
            }
          } catch (error) {
            return {
              ...widget,
              sql: "",
              data: null,
              error: error instanceof Error ? error.message : "Query failed",
            };
          }
        })
      );

      return { title, widgets: widgetResults };
    }),
  }),

  analyzeData: tool({
    description:
      "Compute summary statistics (sum/avg/min/max/median) for a numeric column from already-fetched rows.",
    inputSchema: z.object({
      data: z.array(z.record(z.string(), z.unknown())).describe("The data rows to analyze"),
      analysisType: z.enum(["summary", "trend", "comparison", "distribution"]),
      valueColumn: z.string().describe("The column containing numeric values"),
      groupColumn: z.string().optional().describe("Column to group by"),
      title: z.string().describe("Title for the analysis"),
    }),
    execute: withAuditLog("analyzeData", async (input) => {
      const { data, analysisType, valueColumn, groupColumn, title } = input;
      const values = data
        .map((row) => Number(row[valueColumn]))
        .filter((v) => !isNaN(v));

      if (values.length === 0) {
        return { title, analysisType, error: "No numeric values found" };
      }

      const sum = values.reduce((a, b) => a + b, 0);
      const avg = sum / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const sorted = [...values].sort((a, b) => a - b);
      const median =
        sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];

      const stats = { count: values.length, sum, avg, min, max, median };

      let groupStats;
      if (groupColumn) {
        groupStats = {};
        for (const row of data) {
          const group = String(row[groupColumn] ?? "Unknown");
          const val = Number(row[valueColumn]);
          if (isNaN(val)) continue;
          if (!groupStats[group]) groupStats[group] = { count: 0, sum: 0, avg: 0 };
          groupStats[group].count++;
          groupStats[group].sum += val;
        }
        for (const g of Object.keys(groupStats)) {
          groupStats[g].avg = groupStats[g].sum / groupStats[g].count;
        }
      }

      return { title, analysisType, stats, groupStats };
    }),
  }),

  generateInsights: tool({
    description:
      "After generateDashboard, call this ONCE to surface 2-3 notable findings (e.g. 'Plant 12 had 3x the weekly average on Monday'). The tool internally invokes the model to read the widget data and return concise callouts. CRITICAL: pass the ACTUAL row data from each widget — the tool computes verified facts from it and forces the LLM to use only those facts (no placeholders, no fabricated numbers).",
    inputSchema: z.object({
      title: z.string().describe("The dashboard's title — use as context."),
      widgetSummaries: z.array(
        z.object({
          widgetId: z.string(),
          widgetTitle: z.string(),
          widgetType: z.string(),
          rows: z.array(z.record(z.string(), z.unknown())).describe(
            "First ~30 rows of the widget's data. Send only what's needed."
          ),
        })
      ),
    }),
    execute: withAuditLog("generateInsights", async (input) => {
      const { title, widgetSummaries } = input;
      try {
        // Pre-compute ground-truth facts for each widget so the LLM can't
        // invent percentages or use "Customer X" placeholders.
        const computedFacts = widgetSummaries.map((w) => {
          const rows = w.rows.slice(0, 30);
          // Extract numeric values + their keys for ranking analysis
          const numeric = [];
          for (const r of rows) {
            // Find the canonical "value" — most widgets use {key, value} from ai_aggregate
            // Some use other shapes (data_table). We probe for likely numeric columns.
            const keys = Object.keys(r);
            let value = null;
            let keyName = "";
            if ("value" in r && typeof r.value === "number") {
              value = r.value;
              keyName = "key" in r ? String(r.key) : "(unknown)";
            } else if ("value" in r && typeof r.value === "string" && !isNaN(Number(r.value))) {
              value = Number(r.value);
              keyName = "key" in r ? String(r.key) : "(unknown)";
            } else {
              // Find the first numeric-ish column
              for (const k of keys) {
                const v = r[k];
                if (typeof v === "number") { value = v; break; }
                if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) {
                  value = Number(v); break;
                }
              }
              keyName = String(r[keys[0]] ?? "(unknown)");
            }
            if (value !== null && !isNaN(value)) {
              numeric.push({ key: keyName, value, raw: r });
            }
          }

          if (numeric.length === 0) {
            return { widgetId: w.widgetId, widgetTitle: w.widgetTitle, kind: "no-numeric", rowCount: rows.length };
          }

          const total = numeric.reduce((s, n) => s + n.value, 0);
          const sorted = [...numeric].sort((a, b) => b.value - a.value);
          const top = sorted[0];
          const bottom = sorted[sorted.length - 1];
          const avg = total / numeric.length;
          const topShare = total > 0 ? Math.round((top.value / total) * 1000) / 10 : 0;
          const top3Share = total > 0
            ? Math.round((sorted.slice(0, 3).reduce((s, n) => s + n.value, 0) / total) * 1000) / 10
            : 0;

          return {
            widgetId: w.widgetId,
            widgetTitle: w.widgetTitle,
            widgetType: w.widgetType,
            rowCount: numeric.length,
            total: Math.round(total * 100) / 100,
            avg: Math.round(avg * 100) / 100,
            top: { key: top.key, value: top.value, sharePct: topShare },
            top3: sorted.slice(0, 3).map((n) => ({ key: n.key, value: n.value })),
            top3SharePct: top3Share,
            bottom: { key: bottom.key, value: bottom.value },
            // First 5 rows verbatim for the LLM to quote
            sample: sorted.slice(0, 5).map((n) => ({ key: n.key, value: n.value })),
          };
        });

        const { text } = await generateText({
          model,
          system: [
            "You are an analytics insight writer.",
            "You will receive a list of widgets along with PRE-COMPUTED FACTS for each (top, top3, total, avg, share percentages).",
            "Your insights MUST cite values directly from the provided FACTS. Never invent numbers, percentages, or entity names.",
            "Never use placeholder names like 'Customer X' or 'Plant 12' — always use the actual key names from the FACTS (e.g. 'THE FRICKS COMPANY').",
            "Each insight ≤ 22 words, references concrete values that appear in the FACTS.",
            "Return ONLY a JSON array of {title, severity, widgetId} where severity is 'info'|'warning'|'alert'.",
            "No prose, no markdown fences, no explanation outside the JSON.",
            "If the facts are uninteresting (uniform values, single row, etc.), return fewer than 3 insights — empty array is valid.",
          ].join(" "),
          prompt: [
            `Dashboard: "${title}"`,
            "",
            "FACTS (use ONLY these — do not fabricate beyond them):",
            JSON.stringify(computedFacts, null, 2),
            "",
            "Write 2-3 insights using only the values above. Each insight cites a real key name and number from the FACTS.",
          ].join("\n"),
          providerOptions: {
            google: {
              thinkingConfig: { thinkingBudget: 1024 },
            },
          },
        });
        const cleaned = text
          .trim()
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```\s*$/i, "");
        try {
          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed)) {
            return { success: true, insights: parsed.slice(0, 3) };
          }
        } catch {
          /* fall through */
        }
        return {
          success: true,
          insights: [{ title: text.trim().slice(0, 200), severity: "info" }],
        };
      } catch (err) {
        return {
          success: false,
          insights: [],
          error: err instanceof Error ? err.message : "insights failed",
        };
      }
    }),
  }),

  suggestFollowUps: tool({
    description:
      "After generateInsights, call this ONCE to propose 3 next questions a user might want to ask, specific to what was shown.",
    inputSchema: z.object({
      originalQuestion: z.string(),
      dashboardTitle: z.string(),
      insights: z.array(z.string()).describe("Insight titles from generateInsights."),
    }),
    execute: withAuditLog("suggestFollowUps", async ({ originalQuestion, dashboardTitle, insights }) => {
      try {
        const { text } = await generateText({
          model,
          system:
            "Propose 3 follow-up questions a user might ask given a dashboard they just saw. Each question ≤ 12 words, action-oriented, references the specific dashboard contents. Return ONLY a JSON array of strings, no prose, no fences.",
          prompt: `User asked: "${originalQuestion}"\nDashboard: "${dashboardTitle}"\nFindings:\n- ${insights.join("\n- ")}`,
          providerOptions: {
            google: {
              thinkingConfig: { thinkingBudget: 512 },
            },
          },
        });
        const cleaned = text
          .trim()
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```\s*$/i, "");
        try {
          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed)) {
            return { success: true, followUps: parsed.slice(0, 3).map(String) };
          }
        } catch {
          /* fall through */
        }
        return { success: true, followUps: [] };
      } catch (err) {
        return {
          success: false,
          followUps: [],
          error: err instanceof Error ? err.message : "followUps failed",
        };
      }
    }),
  }),

  getSchemaInfo: tool({
    description:
      "Discover the columns of an allow-listed table. Use only when unsure about a column name — the system prompt already lists most columns.",
    inputSchema: z.object({
      tableName: z.string().optional().describe(
        "Specific table name to get columns for, or omit to be reminded to use the prompt schema."
      ),
    }),
    execute: withAuditLog("getSchemaInfo", async ({ tableName }) => {
      if (tableName && BLOCKED_TABLES.includes(tableName)) {
        return { success: false, error: `Access to table '${tableName}' is not allowed` };
      }

      try {
        if (tableName) {
          const { data, error } = await supabaseServer
            .from(tableName)
            .select("*")
            .limit(1);

          if (error) {
            return { success: false, error: error.message };
          }

          const columns = data && data.length > 0 ? Object.keys(data[0]) : [];
          return { success: true, table: tableName, columns };
        }

        return {
          success: true,
          note: "Use the schema from the system prompt. Call this tool with a specific tableName to discover its columns.",
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get schema",
        };
      }
    }),
  }),
};
