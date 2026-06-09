/**
 * KPI Registry — canonical mapping from natural-language KPI requests
 * to the exact Supabase query that answers them.
 *
 * Replaces the 300-line prose schema in system-prompt.ts with structured,
 * type-checked, schema-verified entries. Every column reference here was
 * validated against live DB on 2026-05-01 (see scripts/validate-kpi-mapping.ts
 * and docs/research/db-validation-results.md).
 *
 * Stage 1 of the implementation plan in
 * ~/.claude/plans/cheerful-enchanting-pine.md
 *
 * Two cross-references the registry MUST keep in sync with:
 *   - ORDER_STATUS / STATUS_LABELS in src/types/orderStatus.ts (canonical
 *     order status enum)
 *   - STATUS_TO_TIME_FIELD / STATUS_KEY_TO_DISPLAY in
 *     src/types/dispatchMonitoring.ts (canonical ticket lifecycle ↔ column
 *     mapping)
 *
 * To validate the registry against live DB, run:
 *     npx tsx --env-file=.env scripts/check-kpi-registry.ts
 */

// Mirrors ORDER_STATUS from src/types/orderStatus.ts (canonical order status enum).
// Inlined here because that module lives outside src/lib/ai; values reproduced exactly.
const ORDER_STATUS = {
  NORMAL: 0,
  WILL_CALL: 1,
  WEATHER_PERMITTING: 2,
  HOLD: 3,
  COMPLETED: 4,
  WAIT_LIST: 5,
};

// ============================================================================
// Constants — derived from live DB inspection (Stage 0a results)
// ============================================================================

/** order_qty_unit / delv_qty_unit observed values: CY (57.2%), ea, tn, lb, ds. */
export const CY_UNIT_FILTER = {
  column: "delv_qty_unit",
  operator: "eq",
  value: "CY",
  rationale: "Excludes non-concrete line items (rebar, blocks, accessories) — required for accurate yardage.",
};

/** Mix-only filter for order/ticket products. is_mix=true means concrete. */
export const IS_MIX_FILTER = {
  column: "is_mix",
  operator: "eq",
  value: true,
  rationale: "Filters to concrete-mix products only (excludes rebar, fittings, fees).",
};

/**
 * Standard "exclude removed" filter. Note: registry uses simple `removed=false`
 * because Stage 0a verified that all removed=true rows have a remove_reason_code
 * (compound and naive filters returned identical counts: 4,434 = 4,434).
 */
export const NOT_REMOVED_FILTER = {
  column: "removed",
  operator: "neq",
  value: true,
  rationale: "Excludes cancelled/voided records.",
};

// ============================================================================
// The registry
// ============================================================================

export const KPI_REGISTRY = [
  // --------------------------------------------------------------------------
  // VOLUME / QUANTITY (the wrong-column bug zone)
  // --------------------------------------------------------------------------
  {
    id: "delivered_cy",
    name: "Total CY delivered",
    description: "Total cubic yards of concrete delivered in a time window. Uses v_tickets_with_cy view which pre-aggregates CY-only delv_qty per ticket.",
    synonyms: [
      "yards delivered", "cy delivered", "cubic yards delivered", "volume delivered",
      "total yards", "total cy", "total volume", "yards", "cy", "cubic yards",
      "volume", "concrete delivered", "delivered quantity", "delivered qty",
      "yardage", "delivery volume", "ready-mix volume", "rmc volume",
    ],
    roles: ["dispatcher", "plant", "executive"],
    unit: "CY",
    table: "v_tickets_with_cy",
    aggregation: "sum",
    valueColumn: "delivered_cy",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    examples: [
      { question: "How many yards did we deliver last week?" },
      { question: "Total CY delivered yesterday" },
      { question: "Volume this month" },
    ],
    notes: [
      "v_tickets_with_cy.delivered_cy is pre-aggregated SUM of ticket_products.delv_qty WHERE delv_qty_unit='CY'.",
      "tickets.amount is DOLLARS, not CY — never use it as the volume column.",
      "Stage 0a result: 8,447.75 CY in last 7 days; ASP $185.68/CY (matches industry ~$160-200).",
    ],
  },
  {
    id: "delivered_cy_by_customer",
    name: "CY delivered by customer",
    description: "Total CY grouped by customer. Top-N answers 'biggest customers by volume'.",
    synonyms: [
      "yards by customer", "cy by customer", "volume by customer",
      "top customers", "biggest customers", "largest customers",
      "customer volume", "customer mix", "customer breakdown",
      "yards per customer", "delivery by customer",
      "top 10 customers by quantity", "top customers by quantity",
    ],
    roles: ["dispatcher", "executive"],
    unit: "CY",
    table: "v_tickets_with_cy",
    aggregation: "sum",
    valueColumn: "delivered_cy",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    defaultGroupBy: "customer_name",
    examples: [
      { question: "Top 10 customers by volume last week" },
      { question: "Which customer ordered the most yards this month?" },
      { question: "Last week's top 10 customers by quantity" },
    ],
    notes: [
      "Groups by customer_name (denormalized on tickets) for human-readable chart labels.",
      "If you need the canonical key (e.g. for click-through filtering), the view also exposes customer_code.",
    ],
  },
  {
    id: "delivered_cy_by_plant",
    name: "CY delivered by plant",
    description: "Total CY grouped by the plant that loaded the truck.",
    synonyms: [
      "yards by plant", "cy by plant", "volume by plant", "plant production",
      "plant volume", "plant yards", "plant breakdown", "plant comparison",
    ],
    roles: ["dispatcher", "plant", "executive"],
    unit: "CY",
    table: "v_tickets_with_cy",
    aggregation: "sum",
    valueColumn: "delivered_cy",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    defaultGroupBy: "plant_name",
    examples: [
      { question: "Which plant produced the most yards yesterday?" },
      { question: "Plant comparison this week" },
      { question: "Last week's plant-wise order comparison" },
    ],
    notes: [
      "Groups by plant_name (loading plant). Code is plant_code; never use pricing_plant_code (that's from orders).",
      "Stage 0a result: 23 plants delivered CY in last 7 days (out of 67 in DB).",
    ],
  },
  {
    id: "delivered_cy_by_project",
    name: "CY delivered by project",
    description: "Total CY grouped by project. For 'which jobs got the most concrete'.",
    synonyms: [
      "yards by project", "yards by job", "yards by site",
      "project volume", "job volume", "biggest projects",
      "top projects", "project breakdown",
    ],
    roles: ["dispatcher", "executive"],
    unit: "CY",
    table: "v_tickets_with_cy",
    aggregation: "sum",
    valueColumn: "delivered_cy",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    defaultGroupBy: "project_name",
    examples: [
      { question: "Top 5 projects by volume this month" },
      { question: "Which jobs got the most concrete last week?" },
    ],
    notes: ["Groups by project_name for readable chart labels. View also exposes project_code and project_id."],
  },
  {
    id: "delivered_cy_by_mix_design",
    name: "CY delivered by mix design",
    description: "Total CY grouped by primary mix design (item_code). For 'what mixes are we pouring most'.",
    synonyms: [
      "yards by mix", "yards by mix design", "yards by item",
      "mix mix", "mix design breakdown", "product mix",
      "yards per mix", "top mixes",
    ],
    roles: ["plant", "executive"],
    unit: "CY",
    table: "v_tickets_with_cy",
    aggregation: "sum",
    valueColumn: "delivered_cy_mix_only",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    defaultGroupBy: "primary_mix_item_code",
    examples: [
      { question: "Top mix designs this month" },
      { question: "Which mix did we pour most last week?" },
    ],
    notes: ["Uses delivered_cy_mix_only (excludes rebar/fittings) and the per-ticket primary mix item_code."],
  },
  {
    id: "avg_load_size",
    name: "Average load size",
    description: "Average CY per ticket. Industry benchmark: 8.3 CY (NRMCA 2020).",
    synonyms: [
      "average load size", "avg load size", "average yards per load",
      "yards per load", "average load", "avg load",
    ],
    roles: ["dispatcher", "plant"],
    unit: "CY",
    table: "v_tickets_with_cy",
    aggregation: "avg",
    valueColumn: "delivered_cy",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    examples: [
      { question: "Average load size this week" },
      { question: "Average yards per truckload yesterday" },
    ],
    notes: ["Stage 0a result: 8.77 CY in last 7d (within 6% of 8.3 NRMCA benchmark)."],
  },

  // --------------------------------------------------------------------------
  // REVENUE (where tickets.amount IS the right column)
  // --------------------------------------------------------------------------
  {
    id: "total_revenue",
    name: "Total revenue (pre-tax)",
    description: "Sum of tickets.amount in window. NOTE: tickets.amount is DOLLARS, not CY.",
    synonyms: [
      "revenue", "total revenue", "sales", "total sales",
      "income", "gross", "pre-tax revenue", "amount", "dollars",
      "$", "money", "billing",
    ],
    roles: ["executive"],
    unit: "USD",
    table: "tickets",
    aggregation: "sum",
    valueColumn: "amount",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    examples: [
      { question: "Total revenue last month" },
      { question: "How much did we bill last week?" },
    ],
    notes: [
      "Stage 0a: $1,568,575.23 over 7d. Use tickets.total_amount for revenue WITH tax.",
    ],
  },
  {
    id: "total_revenue_with_tax",
    name: "Total revenue (with tax & discounts)",
    description: "Sum of tickets.total_amount in window. Includes tax and trade discounts.",
    synonyms: [
      "revenue with tax", "gross revenue", "billed amount",
      "invoice total", "total billing", "total amount",
    ],
    roles: ["executive"],
    unit: "USD",
    table: "tickets",
    aggregation: "sum",
    valueColumn: "total_amount",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    examples: [
      { question: "Total billed amount this month" },
    ],
  },
  {
    id: "asp_per_cy",
    name: "Average selling price per CY",
    description: "Total revenue divided by CY delivered. Industry benchmark: $160-200/CY.",
    synonyms: [
      "asp", "average selling price", "price per yard",
      "$/cy", "$ per cy", "revenue per yard", "ASP per CY",
      "average price per cubic yard",
    ],
    roles: ["executive"],
    unit: "USD",
    table: "tickets",
    aggregation: "sum", // computed from two queries; compiler handles the ratio
    valueColumn: "amount",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    requiresJoin: true,
    examples: [
      { question: "Average price per yard last month" },
      { question: "ASP this week" },
    ],
    notes: [
      "Computed: sum(tickets.amount) / sum(ticket_products.delv_qty WHERE delv_qty_unit='CY').",
      "Stage 0a: $185.68/CY in last 7d (matches industry $160-200).",
      "Registry compiler runs two queries and divides; AI shouldn't try to express this as a single sum/avg.",
    ],
  },

  // --------------------------------------------------------------------------
  // FLEET / DRIVER / TRUCK
  // --------------------------------------------------------------------------
  {
    id: "orders_count",
    name: "Orders count",
    description: "Number of distinct orders in the time window. NOT the same as ticket/load count — one order can have many tickets.",
    synonyms: [
      "total orders", "orders count", "how many orders", "order count",
      "number of orders", "orders placed", "orders received",
    ],
    roles: ["dispatcher", "executive"],
    unit: "count",
    table: "orders",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    examples: [
      { question: "Total orders last week" },
      { question: "How many orders did we get yesterday?" },
    ],
    notes: ["Distinct from tickets_count: 1 order can produce many tickets (loads)."],
  },
  {
    id: "tickets_count",
    name: "Tickets / loads count",
    description: "Number of delivery tickets (loads) in window.",
    synonyms: [
      "tickets count", "loads count", "trips count", "deliveries count",
      "how many loads", "how many tickets", "how many deliveries",
      "number of loads", "load count", "total tickets", "total loads",
      "total deliveries", "ticket count", "trip count",
    ],
    roles: ["dispatcher", "plant"],
    unit: "loads",
    table: "tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    examples: [
      { question: "How many loads went out today?" },
      { question: "Total tickets last week" },
    ],
  },
  {
    id: "active_trucks",
    name: "Active trucks (period)",
    description: "Distinct trucks with at least one ticket in the window.",
    synonyms: [
      "active trucks", "trucks running", "trucks active", "trucks ran",
      "distinct trucks", "unique trucks", "fleet active", "trucks used",
      "how many trucks", "trucks worked", "fleet utilization count",
    ],
    roles: ["dispatcher", "executive"],
    unit: "trucks",
    table: "tickets",
    aggregation: "count_distinct",
    valueColumn: "truck_code",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    examples: [
      { question: "How many trucks ran this week?" },
      { question: "Active fleet today" },
    ],
    notes: ["Stage 0a: 185 active trucks in last 7d (out of 1,061 total)."],
  },
  {
    id: "active_drivers",
    name: "Active drivers (period)",
    description: "Distinct drivers with at least one ticket in the window. Prefer driver_code (stable) over driver_name.",
    synonyms: [
      "active drivers", "drivers working", "drivers active", "drivers worked",
      "distinct drivers", "unique drivers", "drivers on shift",
      "how many drivers", "driver count",
    ],
    roles: ["dispatcher", "executive"],
    unit: "drivers",
    table: "tickets",
    aggregation: "count_distinct",
    valueColumn: "driver_code",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    examples: [
      { question: "How many drivers worked yesterday?" },
      { question: "Unique drivers last week" },
    ],
  },
  {
    id: "tickets_by_truck",
    name: "Tickets by truck",
    description: "Ticket counts grouped by truck. Shows top trucks by load count for the time window.",
    synonyms: [
      "tickets by truck", "loads by truck", "truck breakdown", "trucks with loads",
      "truck activity", "truck loads", "deliveries by truck", "trips by truck",
      "top trucks",
    ],
    roles: ["dispatcher"],
    unit: "loads",
    table: "tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    defaultGroupBy: "truck_code",
    examples: [
      { question: "Top trucks by load count today" },
      { question: "Which trucks have the most loads?" },
    ],
    notes: ["Groups by truck_code. Shows top 10 by default in charts."],
  },
  {
    id: "active_trucks_list",
    name: "All Active Trucks",
    description: "Complete list of all active trucks with their load counts. Renders as a data table showing every truck that ran in the time window.",
    synonyms: [
      "all trucks", "active truck list", "truck list", "list of trucks",
      "list all trucks", "show all trucks", "every truck", "complete truck list",
      "all active trucks", "trucks running", "full truck list",
      "which trucks", "show trucks",
    ],
    roles: ["dispatcher"],
    unit: "loads",
    table: "tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    defaultGroupBy: "truck_code",
    displayAs: "data-table",
    examples: [
      { question: "Show me all active trucks today" },
      { question: "List all trucks with their loads" },
      { question: "Which trucks are running today?" },
      { question: "Complete list of trucks" },
    ],
    notes: ["Renders as data-table showing ALL trucks, not limited to top 10."],
  },

  // --------------------------------------------------------------------------
  // CYCLE / TIMING
  // --------------------------------------------------------------------------
  {
    id: "avg_full_cycle_time",
    name: "Average full cycle time",
    description: "Average minutes from ticket print to truck back at plant. Matches daily_intelligence.avg_round_trip_minutes.",
    synonyms: [
      "cycle time", "round trip time", "round trip", "full cycle",
      "average cycle time", "avg cycle", "trip time", "turn time",
    ],
    roles: ["dispatcher", "plant"],
    unit: "minutes",
    table: "tickets",
    aggregation: "avg",
    // valueColumn is computed: at_plant_time - printed_time. Compiler emits EXTRACT(EPOCH FROM ...)/60.
    valueColumn: "EXTRACT(EPOCH FROM (at_plant_time - printed_time))/60",
    dateColumn: "order_date",
    requiredFilters: [
      NOT_REMOVED_FILTER,
      { column: "printed_time", operator: "is_not_null" },
      { column: "at_plant_time", operator: "is_not_null" },
    ],
    examples: [
      { question: "Average cycle time this week" },
      { question: "Average round trip yesterday" },
    ],
    notes: [
      "Stage 0a: 109.7 min avg over 998-ticket sample, last 7d.",
      "For per-day grouping, this matches daily_intelligence.avg_round_trip_minutes — registry compiler should prefer reading from daily_intelligence when window is full days only.",
    ],
  },
  {
    id: "avg_pour_rate_pct",
    name: "Average pour rate",
    description: "Average per-order pour rate (% of scheduled). Pour rate % = (actual CY/hr ÷ scheduled CY/hr) × 100. Uses capped values (max 200%) to keep the average robust to data-quality outliers.",
    synonyms: [
      "pour rate",
      "average pour rate",
      "avg pour rate",
      "ordered pour rate",
      "pour rate percentage",
      "pour rate %",
      "poured rate",
      "yesterday pour rate",
      "daily pour rate",
      "pour performance",
    ],
    roles: ["dispatcher", "plant", "executive"],
    unit: "%",
    table: "v_pour_rate_per_order",
    aggregation: "avg",
    valueColumn: "pour_rate_pct_capped",
    dateColumn: "order_date",
    requiredFilters: [],
    examples: [
      { question: "What was yesterday's average pour rate?" },
      { question: "Average pour rate this week" },
      { question: "Show ordered pour rate for today" },
    ],
    notes: [
      "v_pour_rate_per_order already filters to multi-ticket orders (>=2 tickets), >=10 pour-min, and >0 CY — single-truck pours have meaningless 'rate' math.",
      "Uses pour_rate_pct_capped (capped at 200%) for the AVG so isolated data-quality outliers can't dominate.",
      "Pour rate is a PERCENTAGE of scheduled, not CY/HR.",
      "Performance bands: ≥90% Excellent · 60-89% Fair · <60% Below Target. See companion 'count' KPIs.",
    ],
  },
  {
    id: "pour_rate_excellent_count",
    name: "Excellent pour rate orders (≥90%)",
    description: "Count of orders whose pour rate met or exceeded 90% of scheduled rate (Excellent band).",
    synonyms: [
      "excellent pour rate",
      "orders with excellent pour rate",
      "excellent pour count",
      "high pour performance",
      "orders meeting pour rate target",
      "on-target pour rate orders",
    ],
    roles: ["dispatcher", "plant", "executive"],
    unit: "count",
    table: "v_pour_rate_per_order",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      { column: "is_excellent", operator: "eq", value: true, rationale: "Only orders in the Excellent band (>=90%)." },
    ],
    examples: [
      { question: "How many orders had excellent pour rate yesterday?" },
      { question: "Excellent pour rate count this week" },
    ],
    notes: ["Uses precomputed boolean is_excellent on v_pour_rate_per_order."],
  },
  {
    id: "pour_rate_fair_count",
    name: "Fair pour rate orders (60-89%)",
    description: "Count of orders whose pour rate fell between 60% and 89% (Fair band).",
    synonyms: [
      "fair pour rate",
      "orders with fair pour rate",
      "fair pour count",
      "average pour performance",
    ],
    roles: ["dispatcher", "plant", "executive"],
    unit: "count",
    table: "v_pour_rate_per_order",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      { column: "is_fair", operator: "eq", value: true, rationale: "Only orders in the Fair band (60-89%)." },
    ],
    examples: [
      { question: "How many orders had fair pour rate yesterday?" },
    ],
    notes: ["Uses precomputed boolean is_fair on v_pour_rate_per_order."],
  },
  {
    id: "pour_rate_below_target_count",
    name: "Below-target pour rate orders (<60%)",
    description: "Count of orders whose pour rate was below 60% (Below Target band).",
    synonyms: [
      "below target pour rate",
      "underperforming pour rate",
      "orders below pour rate target",
      "pour rate below 60",
      "poor pour performance",
    ],
    roles: ["dispatcher", "plant", "executive"],
    unit: "count",
    table: "v_pour_rate_per_order",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      { column: "is_below_target", operator: "eq", value: true, rationale: "Only orders in the Below Target band (<60%)." },
    ],
    examples: [
      { question: "How many orders missed the pour rate target yesterday?" },
      { question: "Below target pour rate count this week" },
    ],
    notes: ["Uses precomputed boolean is_below_target on v_pour_rate_per_order."],
  },
  {
    id: "pour_rate_by_plant",
    name: "Pour rate by plant",
    description: "Average pour rate % grouped by plant. Uses capped values to keep results robust.",
    synonyms: [
      "pour rate by plant",
      "plant pour rate",
      "pour rate per plant",
      "pour performance by plant",
    ],
    roles: ["dispatcher", "plant", "executive"],
    unit: "%",
    table: "v_pour_rate_per_order",
    aggregation: "avg",
    valueColumn: "pour_rate_pct_capped",
    dateColumn: "order_date",
    requiredFilters: [],
    defaultGroupBy: "pricing_plant_code",
    examples: [
      { question: "Pour rate by plant yesterday" },
      { question: "Which plant had the best pour rate this week?" },
    ],
    notes: ["Group key is orders.pricing_plant_code (the plant the order was priced/scheduled at)."],
  },
  {
    id: "pour_rate_for_specific_order",
    name: "Pour rate for a specific order",
    description:
      "Pour rate % for a single order, identified by order_code AND a date window. Returns the same pour_rate_pct_capped (max 200%) used by the average KPI, so the answer is identical to the row that would feed avg_pour_rate_pct for that order.",
    synonyms: [
      "pour rate for order",
      "pour rate of order",
      "pour rate for order code",
      "order pour rate",
      "what was the pour rate for order",
      "pour rate for specific order",
      "single order pour rate",
      "this order's pour rate",
      "pour rate for order number",
      "pour rate of order number",
      // Catch user phrasings where the order reference is downstream of "pour rate":
      //   "pour rate ... and order code = X"  /  "pour rate ... with order code X"
      "and order code",
      "with order code",
      "pour rate and order code",
    ],
    roles: ["dispatcher", "plant", "executive"],
    unit: "%",
    table: "v_pour_rate_per_order",
    aggregation: "avg",
    valueColumn: "pour_rate_pct_capped",
    dateColumn: "order_date",
    requiredFilters: [],
    examples: [
      {
        question: "What was the pour rate for order 23401 on April 14?",
        expectedFilters: { order_code: "23401", order_date: "2026-04-14" },
      },
      {
        question: "Pour rate for order code 23401 yesterday",
        expectedFilters: { order_code: "23401" },
      },
      {
        question: "Show me the pour rate of order number 18250 from last Monday",
        expectedFilters: { order_code: "18250" },
      },
    ],
    notes: [
      "MUST add a filter on order_code (eq) AND a date filter on order_date together. order_code is REUSED across years in this DB — filtering by order_code alone returns multiple historical orders.",
      "If the user says 'for order X yesterday', emit BOTH filters: { column: 'order_code', op: 'eq', value: 'X' } AND { column: 'order_date', op: 'gte', value: 'YYYY-MM-DD' } + { column: 'order_date', op: 'lt', value: 'YYYY-MM-DD next day' }.",
      "Returns the capped pct (max 200%); raw uncapped pct is in pour_rate_pct on the same view if needed for diagnostics.",
      "If the order has only one ticket, <10 pour minutes, or 0 CY delivered, the row is excluded from this view by design — the AI should report 'no pour rate available for that order' rather than fabricating a value.",
    ],
  },
  {
    id: "avg_pour_time",
    name: "Average pour time (on-job duration)",
    description: "Average minutes between truck arriving on-job and washing — substitute for end_unload (which is 100% NULL).",
    synonyms: [
      "pour time", "on-job time", "on job duration",
      "unloading time", "discharge time", "average pour duration",
      "ticket time on job", "time on job", "average ticket time on job",
      "average ticket time", "average time on job",
    ],
    roles: ["dispatcher", "driver"],
    unit: "minutes",
    table: "tickets",
    aggregation: "avg",
    valueColumn: "EXTRACT(EPOCH FROM (wash_time - on_job_time))/60",
    dateColumn: "order_date",
    requiredFilters: [
      NOT_REMOVED_FILTER,
      { column: "on_job_time", operator: "is_not_null" },
      { column: "wash_time", operator: "is_not_null" },
    ],
    examples: [
      { question: "Average pour time this week" },
      { question: "How long does pouring take on average?" },
    ],
    notes: [
      "tickets.end_unload is 100% NULL in production — DO NOT use it. wash_time − on_job_time is the next-best substitute (24% of tickets lack wash_time).",
      "Stage 0a: 41.5 min avg over 1000-ticket sample.",
    ],
  },

  // --------------------------------------------------------------------------
  // LATE / ON-TIME
  // --------------------------------------------------------------------------
  {
    id: "late_tickets_count",
    name: "Late tickets count",
    description: "Number of tickets that arrived on-job AFTER scheduled time. Uses v_late_tickets view.",
    synonyms: [
      "late tickets", "late deliveries", "late loads", "late trucks",
      "delayed deliveries", "behind schedule", "behind", "late count",
      "how many late", "tardy", "past due",
    ],
    roles: ["dispatcher"],
    unit: "loads",
    table: "v_late_tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [],
    examples: [
      { question: "How many late tickets this week?" },
      { question: "Total late trucks last week" },
      { question: "Last 7 days late trucks with driver names" },
    ],
    notes: [
      "v_late_tickets view encapsulates the rule: on_job_time > scheduled_on_job_time. Defined in migration 20260429000005.",
      "Stage 0a: 1,737 late tickets in last 7d.",
    ],
  },
  {
    id: "avg_lateness_minutes",
    name: "Average lateness in minutes",
    description: "Average lateness_minutes for late tickets. Lateness = on_job_time − scheduled_on_job_time when positive.",
    synonyms: [
      "average lateness", "avg lateness", "how late",
      "lateness minutes", "average delay", "avg delay",
    ],
    roles: ["dispatcher"],
    unit: "minutes",
    table: "v_late_tickets",
    aggregation: "avg",
    valueColumn: "lateness_minutes",
    dateColumn: "order_date",
    requiredFilters: [],
    examples: [
      { question: "Average lateness in minutes" },
      { question: "How late are we on average?" },
    ],
    notes: ["Stage 0a: 27.7 min avg over 1000-ticket sample."],
  },
  {
    id: "late_tickets_by_driver",
    name: "Late tickets by driver",
    description: "Late ticket counts grouped by driver. For 'which drivers are most often late'.",
    synonyms: [
      "late drivers", "late by driver", "drivers with most late",
      "top late drivers", "drivers behind schedule",
      "late trucks with driver names", "late tickets with driver",
      "late drivers by name", "late trucks by driver",
    ],
    roles: ["dispatcher"],
    unit: "loads",
    table: "v_late_tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [],
    defaultGroupBy: "driver_name",
    examples: [
      { question: "Top 10 late drivers" },
      { question: "Which drivers were late most often last week?" },
    ],
    notes: ["Group by driver_name for display; if cardinality matters, prefer driver_code."],
  },
  {
    id: "late_tickets_by_plant",
    name: "Late tickets by plant",
    description: "Late ticket counts grouped by plant.",
    synonyms: [
      "late by plant", "late plants", "which plants are late",
      "plant lateness", "late tickets per plant",
    ],
    roles: ["dispatcher", "plant"],
    unit: "loads",
    table: "v_late_tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [],
    defaultGroupBy: "plant_code",
    examples: [
      { question: "Late tickets by plant this week" },
    ],
  },

  // --------------------------------------------------------------------------
  // STATUS (uses category logic, not raw current_status)
  // --------------------------------------------------------------------------
  {
    id: "open_orders",
    name: "Open orders count",
    description: "Orders not yet completed or cancelled. Status codes 0,1,2,3,5 EXCLUDING removed=true.",
    synonyms: [
      "open orders", "active orders", "pending orders",
      "in-progress orders", "ongoing orders", "live orders",
      "running orders", "current orders",
    ],
    roles: ["dispatcher"],
    unit: "count",
    table: "orders",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      NOT_REMOVED_FILTER,
      { column: "current_status", operator: "neq", value: ORDER_STATUS.COMPLETED, rationale: "Excludes Completed orders (status code 4)." },
    ],
    examples: [
      { question: "How many open orders right now?" },
      { question: "Active orders today" },
    ],
    notes: [
      "Open = NOT removed AND current_status != 4 (COMPLETED). For more nuance use the order_status_category KPI.",
    ],
  },
  {
    id: "completed_orders",
    name: "Completed orders count",
    description: "Orders with current_status = 4 (COMPLETED) AND removed=false.",
    synonyms: [
      "completed orders", "finished orders", "done orders",
      "delivered orders", "closed orders",
    ],
    roles: ["dispatcher", "executive"],
    unit: "count",
    table: "orders",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      NOT_REMOVED_FILTER,
      { column: "current_status", operator: "eq", value: ORDER_STATUS.COMPLETED, rationale: "Status code 4 = COMPLETED." },
    ],
    examples: [
      { question: "Completed orders this week" },
      { question: "How many orders finished today?" },
    ],
  },
  {
    id: "cancelled_orders",
    name: "Cancelled orders count",
    description: "Orders cancelled / removed. Note: cancellation is removed=true, NOT a status code. Stage 0a verified all removed=true rows have a remove_reason_code.",
    synonyms: [
      "cancelled orders", "canceled orders", "removed orders",
      "voided orders", "killed orders", "dropped orders", "lost orders",
    ],
    roles: ["dispatcher", "executive"],
    unit: "count",
    table: "orders",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      { column: "removed", operator: "eq", value: true, rationale: "Cancellation = removed=true. Stage 0a confirmed all such rows have remove_reason_code." },
    ],
    examples: [
      { question: "Cancelled orders this week" },
      { question: "How many orders got cancelled?" },
    ],
    notes: [
      "Spelling: UI uses 'Cancelled' (orders) and 'Canceled' (tickets). Synonym dictionary accepts both.",
      "Stage 0a: 4,434 cancelled orders in 30d; compound vs naive predicate identical.",
    ],
  },
  {
    id: "will_call_orders",
    name: "Will-Call orders count",
    description: "Orders with current_status = 1 (WILL_CALL).",
    synonyms: [
      "will call", "will-call", "wc orders", "will call orders",
      "pending release", "awaiting release",
    ],
    roles: ["dispatcher"],
    unit: "count",
    table: "orders",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      NOT_REMOVED_FILTER,
      { column: "current_status", operator: "eq", value: ORDER_STATUS.WILL_CALL, rationale: "Status code 1 = WILL_CALL." },
    ],
    examples: [
      { question: "Will-call orders today" },
      { question: "How many WC orders for tomorrow?" },
    ],
  },

  // --------------------------------------------------------------------------
  // TICKET STATUS (lifecycle-timestamp-based, NOT tickets.current_status)
  // --------------------------------------------------------------------------
  {
    id: "tickets_by_status",
    name: "Tickets by status code",
    description: "Breakdown of tickets by their current integer status code (0=Normal, 1=Will Call, 2=Weather Permitting, 3=Hold, 4=Completed).",
    synonyms: [
      "tickets by status", "ticket status breakdown", "ticket status",
      "ticket breakdown", "tickets breakdown", "tickets status",
      "ticket status summary", "status of tickets", "ticket distribution",
    ],
    roles: ["dispatcher"],
    unit: "loads",
    table: "tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    defaultGroupBy: "current_status",
    examples: [
      { question: "Tickets by status this month" },
      { question: "Show ticket status breakdown" },
    ],
    notes: ["Status codes: 0=Normal, 1=Will Call, 2=Weather Permitting, 3=Hold, 4=Completed."],
  },
  {
    id: "tickets_at_plant",
    name: "Tickets currently at plant",
    description: "Tickets with at_plant_time set (truck has returned to plant). UI label: 'At Plant'.",
    synonyms: [
      "trucks at plant", "tickets at plant", "trucks back",
      "trucks returned", "at plant", "back at plant",
      "tickets are at the plant", "trucks at the plant", "tickets at the plant",
    ],
    roles: ["dispatcher"],
    unit: "loads",
    table: "tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      NOT_REMOVED_FILTER,
      { column: "at_plant_time", operator: "is_not_null" },
    ],
    examples: [
      { question: "How many trucks are at the plant?" },
      { question: "Tickets at plant today" },
    ],
    notes: ["Lifecycle status mapped via STATUS_TO_TIME_FIELD in src/types/dispatchMonitoring.ts. UI label 'At Plant' = at_plant_time IS NOT NULL."],
  },
  {
    id: "tickets_at_job",
    name: "Tickets currently at job",
    description: "Tickets that arrived on-job but haven't started pouring (or beyond). UI label: 'At Job'.",
    synonyms: [
      "trucks at job", "tickets at job", "trucks on site",
      "at jobsite", "at job site", "on job",
    ],
    roles: ["dispatcher"],
    unit: "loads",
    table: "tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      NOT_REMOVED_FILTER,
      { column: "on_job_time", operator: "is_not_null" },
      { column: "unload_time", operator: "is_null" },
    ],
    examples: [
      { question: "How many trucks at the job right now?" },
    ],
    notes: ["UI label 'At Job' maps to on_job_time DB column (not 'at_job_time')."],
  },
  {
    id: "tickets_pouring",
    name: "Tickets currently pouring",
    description: "Tickets that have started unloading but haven't washed yet. UI label: 'Pouring'.",
    synonyms: ["trucks pouring", "pouring now", "actively pouring", "discharging"],
    roles: ["dispatcher"],
    unit: "loads",
    table: "tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      NOT_REMOVED_FILTER,
      { column: "unload_time", operator: "is_not_null" },
      { column: "wash_time", operator: "is_null" },
      { column: "to_plant_time", operator: "is_null" },
      { column: "at_plant_time", operator: "is_null" },
    ],
    examples: [
      { question: "How many trucks pouring right now?" },
    ],
    notes: ["'Pouring' = unload_time set (start of pour). end_unload is 100% NULL — never use."],
  },

  // --------------------------------------------------------------------------
  // QUALITY / WATER (newly verified working columns)
  // --------------------------------------------------------------------------
  {
    id: "tickets_with_water_added",
    name: "Tickets with water added on job",
    description: "Tickets where the driver added water at the jobsite. Quality / specification flag.",
    synonyms: [
      "water added", "water added on job", "jobsite water",
      "extra water", "water additions",
    ],
    roles: ["plant", "driver"],
    unit: "loads",
    table: "tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      NOT_REMOVED_FILTER,
      { column: "water_added_on_job", operator: "gt", value: 0, rationale: "Excludes tickets with 0 or null jobsite water." },
    ],
    examples: [
      { question: "Tickets with water added on job last week" },
      { question: "How many loads had jobsite water?" },
    ],
    notes: ["Stage 0a: 888 tickets in last 7d had water_added_on_job > 0. Column is populated for this tenant."],
  },

  // --------------------------------------------------------------------------
  // BILLING / CREDIT (net-new from DB inspection)
  // --------------------------------------------------------------------------
  {
    id: "tickets_invoiced_pct",
    name: "% of tickets invoiced",
    description: "Percentage of (non-removed) tickets with invoiced=true.",
    synonyms: [
      "invoiced percentage", "% invoiced", "invoiced rate",
      "billing rate", "invoiced tickets",
    ],
    roles: ["executive"],
    unit: "%",
    table: "tickets",
    aggregation: "count", // compiler emits two-stage: count(invoiced=true)/count(*)
    dateColumn: "order_date",
    requiredFilters: [NOT_REMOVED_FILTER],
    examples: [
      { question: "What percentage of tickets are invoiced?" },
    ],
    notes: ["Stage 0a: 15.6% in 30d. Most tickets NOT yet invoiced — likely externally invoiced. Confirm with finance team before publishing this KPI."],
  },
  {
    id: "suspended_tickets",
    name: "Suspended tickets count",
    description: "Tickets flagged as suspended (typically credit hold).",
    synonyms: [
      "suspended tickets", "credit hold tickets", "held tickets",
      "tickets on hold", "frozen tickets",
    ],
    roles: ["executive"],
    unit: "loads",
    table: "tickets",
    aggregation: "count",
    dateColumn: "order_date",
    requiredFilters: [
      { column: "suspended", operator: "eq", value: true },
    ],
    examples: [
      { question: "Suspended tickets this month" },
    ],
    notes: ["Stage 0a: 0 suspended tickets in 30d for this tenant. Rare event."],
  },

  // --------------------------------------------------------------------------
  // DAILY INTELLIGENCE — read pre-computed cron values for parity
  // --------------------------------------------------------------------------
  {
    id: "daily_late_orders",
    name: "Late Orders KPI card (Daily Intelligence)",
    description: "Cron-computed Late Orders total from daily_intelligence table. Matches the production card exactly.",
    synonyms: [
      "late orders", "late orders card", "today's late orders",
      "late orders kpi",
    ],
    roles: ["dispatcher"],
    unit: "count",
    table: "daily_intelligence",
    aggregation: "sum",
    valueColumn: "late_orders_total",
    dateColumn: "report_date",
    requiredFilters: [
      { column: "company_code", operator: "eq", value: "ALL", rationale: "Aggregated across all plants." },
    ],
    examples: [
      { question: "Late orders today" },
      { question: "Show me Late Orders KPI" },
    ],
    notes: ["Reads from daily_intelligence — pre-computed by external cron. Threshold via kpi_parameters table."],
  },
  {
    id: "daily_avg_round_trip",
    name: "Avg Round Trip KPI card (Daily Intelligence)",
    description: "Cron-computed average round trip minutes for the day. Matches production card.",
    synonyms: [
      "avg round trip", "average round trip", "average cycle today",
    ],
    roles: ["dispatcher"],
    unit: "minutes",
    table: "daily_intelligence",
    aggregation: "avg",
    valueColumn: "avg_round_trip_minutes",
    dateColumn: "report_date",
    requiredFilters: [],
    examples: [
      { question: "Average round trip today" },
      { question: "Avg cycle time today" },
    ],
    notes: ["Stage 0a parity check showed no recent rows for some plants — investigate cron freshness."],
  },

  // --------------------------------------------------------------------------
  // OUT-OF-SCOPE (explicitly mark these so AI says 'not available')
  // --------------------------------------------------------------------------
  {
    id: "_oos_gross_margin",
    name: "Gross margin per CY (out-of-scope)",
    description: "Cost data not in current schema. AI must respond with 'this KPI requires cost data we do not currently track'.",
    synonyms: ["gross margin", "margin per yard", "profit per cy"],
    roles: ["executive"],
    unit: "USD",
    table: "tickets",
    aggregation: "sum",
    dateColumn: "order_date",
    requiredFilters: [],
    examples: [
      { question: "Gross margin per yard" },
    ],
    notes: ["tickets.cost_amount column EXISTS but is sparsely populated. Promote to in-scope after a feasibility check on data quality."],
    outOfScope: true,
  },
];

// ============================================================================
// Helpers
// ============================================================================

/** Returns the KPI def with the given id, or undefined. */
export function getKpiById(id) {
  return KPI_REGISTRY.find((k) => k.id === id);
}

/** Returns KPIs whose synonyms include `term` (lowercase exact match). */
export function findKpisBySynonym(term) {
  const lower = term.toLowerCase().trim();
  return KPI_REGISTRY.filter((k) => k.synonyms.includes(lower));
}

/** Returns all KPIs for a given role. */
export function getKpisByRole(role) {
  return KPI_REGISTRY.filter((k) => k.roles.includes(role) && !k.outOfScope);
}

/** Returns KPIs that touch the named DB column (for schema-drift checks). */
export function getKpisReferencingColumn(columnName) {
  return KPI_REGISTRY.filter((k) => {
    if (k.valueColumn === columnName) return true;
    if (k.dateColumn === columnName) return true;
    if (k.defaultGroupBy === columnName) return true;
    return k.requiredFilters.some((f) => f.column === columnName);
  });
}

/** Returns the set of columns this KPI references on its primary table. */
export function getReferencedColumns(kpi) {
  const cols = new Set();
  if (kpi.valueColumn) cols.add(kpi.valueColumn);
  if (kpi.dateColumn) cols.add(kpi.dateColumn);
  if (kpi.defaultGroupBy) cols.add(kpi.defaultGroupBy);
  for (const f of kpi.requiredFilters) cols.add(f.column);
  return cols;
}
