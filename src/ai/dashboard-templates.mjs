/**
 * Stage 6 — Pre-built dashboard templates.
 *
 * Curated layouts the AI can suggest when the user asks vague questions
 * like "How are we doing today?" or "Show me an overview". Each template
 * names a small set of registry KPIs and arranges them in a layout.
 *
 * The AI's suggestTemplate tool (registered in tools.ts) takes a free-text
 * question and returns the best-matching template id. The dashboard then
 * compiles the template's KPIs into widgets via the registry.
 *
 * To add a template: append to TEMPLATES below. KPI ids must exist in
 * src/lib/ai/kpi-registry.ts (CI-validated by check-kpi-registry.ts).
 */

import { KPI_REGISTRY } from "./kpi-registry.mjs";

export const TEMPLATES = [
  {
    id: "today_operations",
    name: "Today's Operations Overview",
    description:
      "Dispatcher snapshot: late orders, trucks waiting, slow plants, congested sites, plus today's volume and cycle time.",
    triggers: [
      "how are we doing today",
      "today's overview",
      "operations today",
      "ops snapshot",
      "live operations",
      "right now",
      "currently",
      "show me today",
      "what's happening today",
      "daily dispatch",
      "fleet performance",
      "daily dispatch fleet performance",
      "dispatch fleet performance",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "daily_late_orders",
      "tickets_count",
      "delivered_cy",
      "active_trucks",
      "daily_avg_round_trip",
      "delivered_cy_by_plant",
      "delivered_cy_by_project",
    ],
  },
  {
    id: "weekly_executive",
    name: "Weekly Executive View",
    description:
      "Top-line revenue, volume, ASP, top customers, and plant breakdown for the last 7 days. C-suite scope.",
    triggers: [
      "weekly executive",
      "executive view",
      "exec dashboard",
      "weekly performance",
      "weekly summary",
      "last week summary",
      "this week so far",
      "weekly overview",
    ],
    defaultWindow: "last_7_days",
    audience: "executive",
    kpiIds: [
      "total_revenue",
      "delivered_cy",
      "asp_per_cy",
      "orders_count",
      "delivered_cy_by_customer",
      "delivered_cy_by_plant",
    ],
  },
  {
    id: "dispatcher_board",
    name: "Dispatcher Operations Board",
    description:
      "Open orders, will-call queue, active fleet, today's tickets — the dispatcher's daily standup view.",
    triggers: [
      "dispatcher board",
      "dispatcher view",
      "dispatcher dashboard",
      "open orders today",
      "today's schedule",
      "dispatch overview",
      "schedule for today",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "open_orders",
      "will_call_orders",
      "active_trucks",
      "active_drivers",
      "tickets_at_plant",
      "tickets_at_job",
    ],
  },
  {
    id: "dispatcher_realtime_tracking",
    name: "Dispatcher Board - Real-Time Truck Tracking",
    description:
      "Live truck tracking dashboard: see exactly where every truck is in the delivery lifecycle — at plant, in transit, at job, pouring, or returning. Includes a list of all active trucks with their load counts.",
    triggers: [
      "real-time truck tracking",
      "realtime truck tracking",
      "real time truck tracking",
      "live truck tracking",
      "truck tracking",
      "track trucks",
      "track my trucks",
      "where are my trucks",
      "truck positions",
      "truck lifecycle",
      "delivery lifecycle",
      "truck pipeline",
      "fleet tracking",
      "live fleet tracking",
      "realtime fleet",
      "real-time fleet",
      "dispatcher tracking",
      "dispatch tracking",
      "live dispatch",
      "realtime dispatch",
      "truck status live",
      "live truck status",
      "trucks in transit",
      "trucks on route",
      "trucks en route",
      "truck locations live",
      "fleet positions",
      "monitor trucks",
      "truck monitoring",
      "fleet monitoring live",
      "list all trucks",
      "show all trucks",
      "all active trucks",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "tickets_at_plant",
      "tickets_at_job",
      "tickets_pouring",
      "active_trucks",
      "active_drivers",
      "tickets_count",
      "late_tickets_count",
      "avg_full_cycle_time",
      "tickets_by_truck",
      "active_trucks_list",
    ],
  },
  {
    id: "late_delivery_review",
    name: "Late Delivery Review (last 7 days)",
    description:
      "Lateness analysis: total late, average lateness, breakdown by driver and plant.",
    triggers: [
      "late delivery review",
      "lateness review",
      "late ticket analysis",
      "review late tickets",
      "late performance",
      "tardiness analysis",
    ],
    defaultWindow: "last_7_days",
    audience: "dispatcher",
    kpiIds: [
      "late_tickets_count",
      "avg_lateness_minutes",
      "late_tickets_by_driver",
      "late_tickets_by_plant",
    ],
  },
  {
    id: "plant_manager_view",
    name: "Plant Manager Daily View",
    description:
      "Per-plant production: yards delivered, average load size, mix design breakdown, quality flags (water added on job).",
    triggers: [
      "plant manager",
      "plant view",
      "plant production",
      "plant dashboard",
      "plant overview",
      "production today",
    ],
    defaultWindow: "today",
    audience: "plant",
    kpiIds: [
      "delivered_cy_by_plant",
      "avg_load_size",
      "delivered_cy_by_mix_design",
      "tickets_with_water_added",
      "avg_pour_time",
      "avg_full_cycle_time",
    ],
  },
  {
    id: "concrete_supply_performance",
    name: "Concrete Supply Performance",
    description:
      "Today's customer & client view: orders fulfilled, cubic yards delivered, on-time delivery rate, top customers, top projects — ideal for tracking daily supply commitments.",
    triggers: [
      "supply performance",
      "supply performance today",
      "today supply",
      "todays supply",
      "daily supply",
      "daily supply performance",
      "customer supply",
      "customer supply today",
      "supply by customer",
      "supply by project",
      "today's deliveries",
      "deliveries today",
      "today delivery status",
      "daily delivery status",
      "order fulfillment today",
      "fulfillment today",
      "my deliveries today",
      "how are deliveries today",
      "supply status today",
    ],
    defaultWindow: "today",
    audience: "all",
    kpiIds: [
      "orders_count",
      "delivered_cy",
      "tickets_count",
      "late_tickets_count",
      "delivered_cy_by_customer",
      "delivered_cy_by_project",
      "avg_load_size",
    ],
  },
  {
    id: "customer_service_quality",
    name: "Customer Service Quality Report",
    description:
      "Service quality focus: on-time vs late deliveries, average lateness, delivery cycle times — helps identify service improvement opportunities.",
    triggers: [
      "service quality",
      "customer service",
      "on time delivery",
      "on-time delivery",
      "delivery quality",
      "service report",
      "quality report",
      "customer satisfaction",
      "service level",
      "sla report",
      "service metrics",
      "how is our service",
      "are we on time",
      "late delivery report",
      "punctuality",
      "timeliness",
    ],
    defaultWindow: "last_7_days",
    audience: "all",
    kpiIds: [
      "tickets_count",
      "late_tickets_count",
      "avg_lateness_minutes",
      "avg_full_cycle_time",
      "late_tickets_by_plant",
      "late_tickets_by_driver",
    ],
  },
  {
    id: "supply_volume_analysis",
    name: "Supply Volume Analysis",
    description:
      "Volume-focused analysis: total CY delivered, breakdown by customer, project, plant, and mix design — understand where concrete is going.",
    triggers: [
      "volume analysis",
      "supply volume",
      "delivery volume",
      "concrete volume",
      "yards delivered",
      "cy delivered",
      "volume breakdown",
      "volume by customer",
      "volume by project",
      "where is concrete going",
      "volume report",
      "tonnage report",
      "quantity report",
      "how much concrete",
      "total yards",
      "total volume",
    ],
    defaultWindow: "last_7_days",
    audience: "all",
    kpiIds: [
      "delivered_cy",
      "tickets_count",
      "avg_load_size",
      "active_trucks",
      "delivered_cy_by_customer",
      "delivered_cy_by_plant",
      "delivered_cy_by_project",
    ],
  },
  // ============================================================================
  // NEW CONCRETE SUPPLY TEMPLATES
  // ============================================================================
  {
    id: "daily_sales_summary",
    name: "Daily Sales Summary",
    description:
      "Sales team daily view: today's revenue, orders, volume delivered, and top customers — track daily sales performance.",
    triggers: [
      "daily sales",
      "sales today",
      "today's sales",
      "sales summary",
      "sales report",
      "revenue today",
      "today's revenue",
      "how much did we sell",
      "sales performance",
      "daily revenue",
      "money today",
      "billing today",
    ],
    defaultWindow: "today",
    audience: "executive",
    kpiIds: [
      "total_revenue",
      "orders_count",
      "delivered_cy",
      "tickets_count",
      "delivered_cy_by_customer",
      "delivered_cy_by_plant",
    ],
  },
  {
    id: "top_customers_report",
    name: "Top Customers Report",
    description:
      "Customer analysis: who are the biggest customers by volume and revenue — identify key accounts.",
    triggers: [
      "top customers",
      "best customers",
      "biggest customers",
      "customer report",
      "customer analysis",
      "who buys most",
      "key accounts",
      "major customers",
      "customer ranking",
      "customer volume",
      "top 10 customers",
      "top buyers",
      "largest customers",
    ],
    defaultWindow: "last_7_days",
    audience: "executive",
    kpiIds: [
      "delivered_cy",
      "orders_count",
      "tickets_count",
      "total_revenue",
      "delivered_cy_by_customer",
      "delivered_cy_by_project",
    ],
  },
  {
    id: "fleet_utilization",
    name: "Fleet Utilization Report",
    description:
      "Fleet efficiency: active trucks, drivers, loads delivered, and cycle times — optimize fleet operations.",
    triggers: [
      "fleet utilization",
      "truck utilization",
      "fleet efficiency",
      "truck efficiency",
      "how many trucks",
      "trucks running",
      "fleet report",
      "truck report",
      "driver utilization",
      "fleet status",
      "truck status",
      "active fleet",
      "fleet performance",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "active_trucks",
      "active_drivers",
      "tickets_count",
      "delivered_cy",
      "avg_full_cycle_time",
      "avg_load_size",
    ],
  },
  {
    id: "yesterday_recap",
    name: "Yesterday's Recap",
    description:
      "Complete summary of yesterday's operations: orders, deliveries, volume, revenue, and any late deliveries.",
    triggers: [
      "yesterday",
      "yesterday's summary",
      "yesterday recap",
      "what happened yesterday",
      "yesterday's performance",
      "yesterday report",
      "yesterday's orders",
      "yesterday's deliveries",
      "how did we do yesterday",
      "yesterday's numbers",
    ],
    defaultWindow: "yesterday",
    audience: "all",
    kpiIds: [
      "orders_count",
      "delivered_cy",
      "tickets_count",
      "late_tickets_count",
      "delivered_cy_by_customer",
      "delivered_cy_by_plant",
      "avg_load_size",
    ],
  },
  {
    id: "monthly_performance",
    name: "Monthly Performance Report",
    description:
      "Month-to-date performance: total revenue, volume, orders, and breakdowns by customer and plant.",
    triggers: [
      "monthly performance",
      "this month",
      "month to date",
      "mtd",
      "monthly report",
      "monthly summary",
      "month performance",
      "how are we doing this month",
      "monthly sales",
      "monthly volume",
      "monthly revenue",
    ],
    defaultWindow: "this_month",
    audience: "executive",
    kpiIds: [
      "total_revenue",
      "delivered_cy",
      "orders_count",
      "tickets_count",
      "delivered_cy_by_customer",
      "delivered_cy_by_plant",
      "asp_per_cy",
    ],
  },
  {
    id: "driver_performance",
    name: "Driver Performance Report",
    description:
      "Driver analysis: loads per driver, late deliveries by driver, cycle times — identify top and underperforming drivers.",
    triggers: [
      "driver performance",
      "driver report",
      "driver analysis",
      "how are drivers doing",
      "driver efficiency",
      "best drivers",
      "worst drivers",
      "driver ranking",
      "driver metrics",
      "driver productivity",
      "driver stats",
    ],
    defaultWindow: "last_7_days",
    audience: "dispatcher",
    kpiIds: [
      "active_drivers",
      "tickets_count",
      "late_tickets_count",
      "avg_lateness_minutes",
      "late_tickets_by_driver",
      "avg_full_cycle_time",
    ],
  },
  {
    id: "mix_design_analysis",
    name: "Mix Design Analysis",
    description:
      "Product mix: which concrete mixes are most popular, volume by mix design — understand product demand.",
    triggers: [
      "mix design",
      "mix analysis",
      "product mix",
      "concrete mix",
      "which mixes",
      "popular mixes",
      "mix report",
      "mix breakdown",
      "mix design breakdown",
      "product analysis",
      "what mixes are we pouring",
      "mix types",
    ],
    defaultWindow: "last_7_days",
    audience: "plant",
    kpiIds: [
      "delivered_cy",
      "tickets_count",
      "avg_load_size",
      "delivered_cy_by_mix_design",
      "delivered_cy_by_plant",
    ],
  },
  {
    id: "project_delivery_status",
    name: "Project Delivery Status",
    description:
      "Project tracking: volume delivered to each project/job site, helps track job progress and commitments.",
    triggers: [
      "project status",
      "project deliveries",
      "job site status",
      "project report",
      "jobs report",
      "project tracking",
      "job tracking",
      "where are we delivering",
      "project volume",
      "job deliveries",
      "construction sites",
      "active projects",
      "active jobs",
    ],
    defaultWindow: "last_7_days",
    audience: "all",
    kpiIds: [
      "delivered_cy",
      "tickets_count",
      "orders_count",
      "avg_load_size",
      "delivered_cy_by_project",
      "delivered_cy_by_customer",
    ],
  },
  {
    id: "plant_comparison",
    name: "Plant Comparison Report",
    description:
      "Compare plant performance: volume by plant, cycle times, late deliveries — identify best and worst performing plants.",
    triggers: [
      "plant comparison",
      "compare plants",
      "plant vs plant",
      "plant performance",
      "which plant",
      "best plant",
      "worst plant",
      "plant ranking",
      "plant efficiency",
      "plant metrics",
      "plant stats",
    ],
    defaultWindow: "last_7_days",
    audience: "plant",
    kpiIds: [
      "delivered_cy",
      "tickets_count",
      "avg_load_size",
      "late_tickets_count",
      "delivered_cy_by_plant",
      "late_tickets_by_plant",
    ],
  },
  {
    id: "pour_rate_analysis",
    name: "Pour Rate Analysis",
    description:
      "Pour performance: average pour rate, excellent vs below-target pours — measure delivery efficiency at job sites.",
    triggers: [
      "pour rate",
      "pour performance",
      "pour analysis",
      "pouring rate",
      "pour speed",
      "how fast are we pouring",
      "pour efficiency",
      "unloading rate",
      "discharge rate",
      "pour metrics",
    ],
    defaultWindow: "last_7_days",
    audience: "dispatcher",
    kpiIds: [
      "avg_pour_rate_pct",
      "pour_rate_excellent_count",
      "pour_rate_fair_count",
      "pour_rate_below_target_count",
      "pour_rate_by_plant",
      "avg_pour_time",
    ],
  },
  // ============================================================================
  // NEW PRACTICAL PROMPTS FOR CONCRETE SUPPLIERS
  // ============================================================================
  {
    id: "morning_briefing",
    name: "Morning Dispatch Briefing",
    description:
      "Start your day right: see pending orders, will-call queue, available trucks and drivers — everything you need for morning dispatch planning.",
    triggers: [
      "morning briefing",
      "morning report",
      "morning dispatch",
      "start of day",
      "daily briefing",
      "dispatch briefing",
      "what do we have today",
      "whats on schedule",
      "today's schedule",
      "morning overview",
      "ready for today",
      "daily planning",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "open_orders",
      "will_call_orders",
      "active_trucks",
      "active_drivers",
      "tickets_at_plant",
      "delivered_cy_by_plant",
    ],
  },
  {
    id: "end_of_day_report",
    name: "End of Day Summary",
    description:
      "Daily wrap-up: total deliveries completed, volume delivered, any late deliveries, and revenue generated — perfect for daily reporting.",
    triggers: [
      "end of day",
      "eod report",
      "daily summary",
      "day end report",
      "close of day",
      "today's summary",
      "what did we deliver today",
      "daily wrap up",
      "daily wrapup",
      "day summary",
      "todays results",
      "how did today go",
    ],
    defaultWindow: "today",
    audience: "all",
    kpiIds: [
      "delivered_cy",
      "tickets_count",
      "orders_count",
      "late_tickets_count",
      "total_revenue",
      "delivered_cy_by_plant",
    ],
  },
  {
    id: "live_truck_status",
    name: "Live Truck Status",
    description:
      "Real-time fleet visibility: see how many trucks are at plant loading, in transit, at job site, or pouring — monitor your fleet right now.",
    triggers: [
      "live trucks",
      "truck status",
      "where are trucks",
      "truck locations",
      "fleet status",
      "trucks now",
      "trucks right now",
      "current trucks",
      "truck positions",
      "wheres my fleet",
      "fleet locations",
      "active trucks now",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "active_trucks",
      "tickets_at_plant",
      "tickets_at_job",
      "tickets_count",
      "delivered_cy",
      "avg_full_cycle_time",
    ],
  },
  {
    id: "pending_orders_view",
    name: "Pending Orders Dashboard",
    description:
      "Orders awaiting dispatch: open orders, will-call orders, and scheduled deliveries — manage your order backlog effectively.",
    triggers: [
      "pending orders",
      "open orders",
      "orders pending",
      "waiting orders",
      "orders to dispatch",
      "undelivered orders",
      "order backlog",
      "orders queue",
      "whats pending",
      "orders waiting",
      "scheduled orders",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "open_orders",
      "will_call_orders",
      "orders_count",
      "delivered_cy_by_customer",
      "delivered_cy_by_project",
    ],
  },
  {
    id: "cycle_time_report",
    name: "Cycle Time Analysis",
    description:
      "Delivery efficiency: average round-trip times, pour times, and plant loading times — identify bottlenecks and improve turnaround.",
    triggers: [
      "cycle time",
      "cycle times",
      "round trip time",
      "turnaround time",
      "delivery time",
      "how long are deliveries",
      "trip duration",
      "delivery duration",
      "time per delivery",
      "average cycle",
      "truck turnaround",
    ],
    defaultWindow: "last_7_days",
    audience: "dispatcher",
    kpiIds: [
      "avg_full_cycle_time",
      "avg_pour_time",
      "tickets_count",
      "delivered_cy",
      "late_tickets_count",
      "delivered_cy_by_plant",
    ],
  },
  {
    id: "revenue_tracking",
    name: "Revenue Tracking Dashboard",
    description:
      "Money matters: track daily and weekly revenue, average selling price, volume delivered, and top revenue-generating customers.",
    triggers: [
      "revenue tracking",
      "revenue report",
      "revenue dashboard",
      "how much revenue",
      "money made",
      "sales revenue",
      "billing report",
      "revenue by customer",
      "earnings report",
      "income report",
      "financial summary",
    ],
    defaultWindow: "last_7_days",
    audience: "executive",
    kpiIds: [
      "total_revenue",
      "delivered_cy",
      "asp_per_cy",
      "orders_count",
      "delivered_cy_by_customer",
      "delivered_cy_by_plant",
    ],
  },
  {
    id: "late_delivery_alert",
    name: "Late Delivery Alert Dashboard",
    description:
      "Service issues: identify late deliveries, average delay time, which drivers and plants have the most delays — fix problems fast.",
    triggers: [
      "late deliveries",
      "delivery delays",
      "delayed orders",
      "late orders",
      "whats running late",
      "delays today",
      "late trucks",
      "behind schedule",
      "delivery problems",
      "service issues",
      "late alert",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "late_tickets_count",
      "avg_lateness_minutes",
      "tickets_count",
      "late_tickets_by_driver",
      "late_tickets_by_plant",
    ],
  },
  {
    id: "customer_volume_report",
    name: "Customer Volume Report",
    description:
      "Customer insights: see which customers are ordering the most concrete, their delivery volumes, and order patterns.",
    triggers: [
      "customer volume",
      "volume by customer",
      "customer orders",
      "customer deliveries",
      "who is ordering",
      "customer breakdown",
      "customer analysis",
      "biggest orders",
      "customer metrics",
      "orders by customer",
    ],
    defaultWindow: "last_7_days",
    audience: "executive",
    kpiIds: [
      "delivered_cy",
      "orders_count",
      "tickets_count",
      "avg_load_size",
      "delivered_cy_by_customer",
      "delivered_cy_by_project",
    ],
  },
  // ============================================================================
  // UNIQUE POWERFUL PROMPT: DELIVERY EFFICIENCY ANALYSIS
  // ============================================================================
  {
    id: "delivery_efficiency_analysis",
    name: "Delivery Efficiency Analysis",
    description:
      "Operational efficiency focus: cycle times, load sizes, pour rates, truck utilization, and turnaround metrics — helps dispatchers and plant managers identify bottlenecks, optimize truck usage, and improve delivery speed without focusing on revenue.",
    triggers: [
      // Efficiency queries
      "delivery efficiency",
      "efficiency analysis",
      "efficiency report",
      "how efficient",
      "operational efficiency",
      "operations efficiency",
      // Cycle time queries
      "cycle time analysis",
      "cycle times",
      "round trip times",
      "turnaround time",
      "turnaround times",
      "how long are deliveries taking",
      "delivery times",
      "trip duration",
      "average cycle",
      // Load size queries
      "load size analysis",
      "average load size",
      "load sizes",
      "are we loading full trucks",
      "truck capacity usage",
      "load optimization",
      // Pour rate queries
      "pour rate analysis",
      "pour rates",
      "pouring efficiency",
      "pour performance",
      "how fast are we pouring",
      "unloading speed",
      "discharge rate",
      // Truck utilization queries
      "truck utilization",
      "fleet efficiency",
      "truck efficiency",
      "are trucks being used well",
      "truck productivity",
      "fleet productivity",
      // Bottleneck queries
      "bottleneck analysis",
      "where are bottlenecks",
      "what's slowing us down",
      "slow points",
      "delays analysis",
      "wait time analysis",
      // Optimization queries
      "optimize operations",
      "improve efficiency",
      "speed up deliveries",
      "reduce cycle time",
      "operational improvements",
    ],
    defaultWindow: "last_7_days",
    audience: "dispatcher",
    kpiIds: [
      // Core efficiency metrics (using pre-computed data that works)
      "daily_avg_round_trip",
      "avg_load_size",
      "avg_pour_rate_pct",
      // Pour quality breakdown by plant
      "pour_rate_by_plant",
      // Utilization metrics
      "active_trucks",
      "tickets_count",
      // Late delivery context
      "late_tickets_count",
    ],
  },
  // ============================================================================
  // HIGH PRIORITY PROMPT 1: ORDER STATUS SUMMARY
  // ============================================================================
  {
    id: "order_status_summary",
    name: "Order Status Summary",
    description:
      "Quick breakdown of all orders by status: open, completed, cancelled, will-call — essential for dispatchers to see the full picture at a glance.",
    triggers: [
      // Status breakdown queries (specific to orders - avoid generic "status breakdown")
      "order status summary",
      "orders by status",
      "order status breakdown",
      "show me all orders by status",
      "order breakdown",
      "orders breakdown",
      // Status count queries
      "how many orders by status",
      "order status count",
      "count orders by status",
      "order counts",
      // Quick status checks
      "order status today",
      "todays order status",
      "current order status",
      "order status overview",
      "order status report",
      // Specific status queries
      "how many open orders",
      "how many completed orders",
      "how many cancelled orders",
      "open vs completed",
      "order completion status",
      // Daily status
      "daily order status",
      "order status check",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "orders_count",
      "open_orders",
      "completed_orders",
      "cancelled_orders",
      "will_call_orders",
      "delivered_cy",
    ],
  },
  // ============================================================================
  // HIGH PRIORITY PROMPT 2: PROBLEM ORDERS DASHBOARD
  // ============================================================================
  {
    id: "problem_orders_dashboard",
    name: "Problem Orders Dashboard",
    description:
      "Identify orders needing immediate attention: will-call waiting, late deliveries, suspended tickets, and cancelled orders — helps dispatchers quickly spot and resolve issues.",
    triggers: [
      // Problem identification
      "problem orders",
      "orders with problems",
      "problematic orders",
      "orders needing attention",
      "orders with issues",
      "issue orders",
      "troubled orders",
      // Quick checks
      "any problems",
      "any issues with orders",
      "what orders have issues",
      "which orders need help",
      "orders to fix",
      "orders to check",
      // Stuck orders
      "stuck orders",
      "stalled orders",
      "delayed orders",
      "orders not moving",
      // Attention needed
      "attention needed",
      "needs attention",
      "orders requiring action",
      "action needed",
      "orders to resolve",
      // Daily check
      "problem check",
      "issue check",
      "order issues today",
      "problems today",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "will_call_orders",
      "late_tickets_count",
      "suspended_tickets",
      "cancelled_orders",
      "late_tickets_by_plant",
      "late_tickets_by_driver",
    ],
  },
  // ============================================================================
  // HIGH PRIORITY PROMPT 3: CUSTOMER DELIVERY PERFORMANCE
  // ============================================================================
  {
    id: "customer_delivery_performance",
    name: "Customer Delivery Performance",
    description:
      "Customer-specific delivery insights: volume delivered, order count, delivery performance by customer — essential for sales teams, contractors, and customer service.",
    triggers: [
      // Customer performance
      "customer performance",
      "customer delivery performance",
      "how is customer doing",
      "customer report",
      "customer delivery report",
      // Customer specific
      "deliveries by customer",
      "customer deliveries",
      "customer orders",
      "orders by customer",
      // Customer analysis
      "customer analysis",
      "analyze customer",
      "customer breakdown",
      "customer summary",
      // Customer service
      "customer service report",
      "customer status",
      "how are customers doing",
      "customer metrics",
      // Volume by customer
      "volume by customer",
      "yards by customer",
      "cy by customer",
      "quantity by customer",
      // Top customers
      "best customers",
      "top performing customers",
      "customer ranking",
      "customer leaderboard",
    ],
    defaultWindow: "last_7_days",
    audience: "all",
    kpiIds: [
      "delivered_cy_by_customer",
      "orders_count",
      "tickets_count",
      "delivered_cy",
      "late_tickets_count",
      "avg_load_size",
    ],
  },
  // ============================================================================
  // HIGH PRIORITY PROMPT 4: WILL CALL QUEUE MANAGEMENT
  // ============================================================================
  {
    id: "will_call_queue",
    name: "Will Call Queue Management",
    description:
      "Manage will-call orders: see how many customers are waiting to call, track will-call queue size, and monitor pending releases — critical for daily dispatch planning.",
    triggers: [
      // Will call specific
      "will call queue",
      "will-call queue",
      "will call orders",
      "will-call orders",
      "wc queue",
      "wc orders",
      // Queue management
      "whats in will call",
      "will call status",
      "will call count",
      "how many will call",
      "will call waiting",
      "customers waiting to call",
      // Pending release
      "pending release",
      "awaiting release",
      "orders awaiting call",
      "orders pending call",
      // Queue size
      "queue size",
      "will call backlog",
      "will call list",
      "will call report",
      // Release management
      "orders to release",
      "release queue",
      "pending orders",
      "waiting orders",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "will_call_orders",
      "open_orders",
      "orders_count",
      "delivered_cy_by_customer",
      "delivered_cy_by_plant",
    ],
  },
  // ============================================================================
  // HIGH PRIORITY PROMPT 5: HOLD ORDERS ANALYSIS
  // ============================================================================
  {
    id: "hold_orders_analysis",
    name: "Hold Orders Analysis",
    description:
      "Analyze orders and tickets on hold: suspended tickets, credit holds, and stuck orders — helps resolve blockers and get orders moving again.",
    triggers: [
      // Hold orders
      "hold orders",
      "orders on hold",
      "on hold orders",
      "held orders",
      "hold status",
      // Why on hold
      "why on hold",
      "hold reasons",
      "reason for hold",
      "why are orders held",
      "hold analysis",
      // Suspended
      "suspended orders",
      "suspended tickets",
      "credit hold",
      "credit holds",
      "frozen orders",
      // Stuck orders
      "stuck on hold",
      "orders stuck",
      "blocked orders",
      "orders blocked",
      // Resolution
      "orders to unhold",
      "release holds",
      "hold report",
      "hold summary",
      "hold review",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "suspended_tickets",
      "will_call_orders",
      "open_orders",
      "cancelled_orders",
      "late_tickets_count",
      "late_tickets_by_plant",
    ],
  },
  // ============================================================================
  // MEDIUM PRIORITY PROMPT 1: DAY-OVER-DAY COMPARISON
  // ============================================================================
  {
    id: "day_over_day_comparison",
    name: "Day-over-Day Comparison",
    description:
      "Compare today's performance to yesterday: orders, deliveries, volume, and late tickets — quick daily trend check for managers.",
    triggers: [
      // Comparison queries
      "compare today to yesterday",
      "today vs yesterday",
      "today versus yesterday",
      "yesterday comparison",
      "daily comparison",
      "day over day",
      "day-over-day",
      "dod comparison",
      // How are we doing
      "how are we doing compared to yesterday",
      "better than yesterday",
      "worse than yesterday",
      "compared to yesterday",
      // Trend queries
      "daily trend",
      "today trend",
      "yesterday vs today",
      "change from yesterday",
      "difference from yesterday",
    ],
    defaultWindow: "today",
    audience: "all",
    kpiIds: [
      "orders_count",
      "delivered_cy",
      "tickets_count",
      "late_tickets_count",
      "active_trucks",
      "avg_load_size",
    ],
  },
  // ============================================================================
  // MEDIUM PRIORITY PROMPT 2: WEEK-OVER-WEEK COMPARISON
  // ============================================================================
  {
    id: "week_over_week_comparison",
    name: "Week-over-Week Comparison",
    description:
      "Compare this week's performance to last week: volume trends, order counts, and delivery metrics — essential for weekly management reviews.",
    triggers: [
      // Week comparison
      "this week vs last week",
      "week over week",
      "week-over-week",
      "wow comparison",
      "weekly comparison",
      "compare weeks",
      "week comparison",
      // This week queries
      "how does this week compare",
      "this week compared to last",
      "better than last week",
      "worse than last week",
      // Trend queries
      "weekly trend",
      "week trend",
      "last week vs this week",
      "change from last week",
      "weekly change",
      // Performance
      "weekly performance comparison",
      "week performance",
    ],
    defaultWindow: "last_7_days",
    audience: "executive",
    kpiIds: [
      "delivered_cy",
      "orders_count",
      "tickets_count",
      "late_tickets_count",
      "delivered_cy_by_plant",
      "delivered_cy_by_customer",
    ],
  },
  // ============================================================================
  // MEDIUM PRIORITY PROMPT 3: PLANT CAPACITY STATUS
  // ============================================================================
  {
    id: "plant_capacity_status",
    name: "Plant Capacity Status",
    description:
      "Check plant workload and capacity: see which plants are busy, which have capacity, and compare plant performance — helps with load balancing decisions.",
    triggers: [
      // Capacity queries
      "plant capacity",
      "plant capacity status",
      "capacity status",
      "capacity check",
      // Overload queries
      "are any plants overloaded",
      "plants overloaded",
      "overloaded plants",
      "plant overload",
      "which plants are busy",
      "busy plants",
      // Underutilized
      "plants with capacity",
      "available capacity",
      "underutilized plants",
      "which plants have room",
      // Load balancing
      "plant load",
      "plant workload",
      "load balancing",
      "balance plants",
      "plant utilization",
      // Comparison
      "plant comparison",
      "compare plants",
      "plant vs plant",
      "plant performance",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "delivered_cy_by_plant",
      "tickets_count",
      "active_trucks",
      "orders_count",
      "late_tickets_by_plant",
      "open_orders",
    ],
  },
  // ============================================================================
  // MEDIUM PRIORITY PROMPT 4: PROJECT PROGRESS TRACKING
  // ============================================================================
  {
    id: "project_progress_tracking",
    name: "Project Progress Tracking",
    description:
      "Track delivery progress for construction projects: volume delivered, orders completed, and remaining work — helps monitor job site commitments.",
    triggers: [
      // Project progress
      "project progress",
      "project status",
      "project tracking",
      "track project",
      "how is project doing",
      "project update",
      // Job site
      "job site progress",
      "job progress",
      "job status",
      "job site status",
      "construction site progress",
      // Deliveries by project
      "deliveries by project",
      "project deliveries",
      "volume by project",
      "yards by project",
      "cy by project",
      // Project completion
      "project completion",
      "project completion status",
      "how much delivered to project",
      "project delivery status",
      // Active projects
      "active projects",
      "ongoing projects",
      "current projects",
      "project report",
    ],
    defaultWindow: "last_7_days",
    audience: "all",
    kpiIds: [
      "delivered_cy_by_project",
      "delivered_cy",
      "orders_count",
      "tickets_count",
      "avg_load_size",
      "late_tickets_count",
    ],
  },
  // ============================================================================
  // MEDIUM PRIORITY PROMPT 5: TRUCK/FLEET AVAILABILITY
  // ============================================================================
  {
    id: "fleet_availability",
    name: "Truck/Fleet Availability",
    description:
      "Check fleet status and availability: active trucks, drivers on duty, trucks at plant vs on the road — helps dispatchers plan assignments.",
    triggers: [
      // Availability queries
      "truck availability",
      "fleet availability",
      "available trucks",
      "trucks available",
      "which trucks are available",
      "free trucks",
      // Fleet status
      "fleet status",
      "truck status",
      "trucks status",
      "fleet check",
      "truck check",
      // Active fleet
      "active trucks",
      "trucks running",
      "trucks on duty",
      "trucks working",
      "how many trucks",
      // Driver availability
      "driver availability",
      "available drivers",
      "drivers on duty",
      "active drivers",
      "how many drivers",
      // Location
      "trucks at plant",
      "trucks on road",
      "where are trucks",
      "truck locations",
      "truck positions",
      // Idle
      "idle trucks",
      "waiting trucks",
      "trucks waiting",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      "active_trucks",
      "active_drivers",
      "tickets_at_plant",
      "tickets_at_job",
      "tickets_count",
      "delivered_cy_by_plant",
    ],
  },
  // ============================================================================
  // TOP PRIORITY PROMPT 1: REAL-TIME STATUS NOW
  // ============================================================================
  {
    id: "realtime_status_now",
    name: "Real-Time Status Now",
    description:
      "Live operational snapshot: see exactly what's happening RIGHT NOW — trucks loading, in transit, at job sites, and pouring. Perfect for mid-day dispatch decisions.",
    triggers: [
      // Real-time queries
      "what's happening now",
      "whats happening now",
      "what is happening now",
      "happening right now",
      "right now",
      "live status",
      "live view",
      "current status",
      "current situation",
      "status right now",
      // Active operations
      "active operations",
      "active right now",
      "whats active",
      "what's active",
      "currently active",
      // Real-time fleet
      "where are trucks now",
      "trucks right now",
      "current truck status",
      "fleet right now",
      "current fleet",
      // In progress
      "in progress",
      "whats in progress",
      "what's in progress",
      "ongoing deliveries",
      "active deliveries",
      // This moment
      "this moment",
      "at this moment",
      "as of now",
      "current snapshot",
      "live snapshot",
      "real time",
      "realtime",
      "real-time",
    ],
    defaultWindow: "today",
    audience: "dispatcher",
    kpiIds: [
      // Current truck positions
      "tickets_at_plant",
      "tickets_at_job",
      "tickets_pouring",
      // Active resources
      "active_trucks",
      "active_drivers",
      // Pending work
      "open_orders",
    ],
  },
  // ============================================================================
  // TOP PRIORITY PROMPT 2: ORDER FULFILLMENT CHECK
  // ============================================================================
  {
    id: "order_fulfillment_check",
    name: "Order Fulfillment Check",
    description:
      "Track what's been delivered vs what's still pending: open orders, completed orders, will-call queue, and delivery progress by customer — essential for knowing what work remains.",
    triggers: [
      // Fulfillment queries
      "order fulfillment",
      "fulfillment status",
      "fulfillment check",
      "delivery fulfillment",
      // Outstanding/pending
      "outstanding orders",
      "outstanding deliveries",
      "whats outstanding",
      "what's outstanding",
      "pending deliveries",
      "whats pending",
      "what's pending",
      // Unfulfilled
      "unfulfilled orders",
      "unfulfilled deliveries",
      "not yet delivered",
      "not delivered yet",
      // Partial
      "partial orders",
      "partial deliveries",
      "incomplete orders",
      "incomplete deliveries",
      // Remaining
      "remaining orders",
      "remaining deliveries",
      "whats remaining",
      "what's remaining",
      "what's left",
      "whats left to deliver",
      // Backlog
      "order backlog",
      "delivery backlog",
      "backlog status",
      // Completion tracking
      "completion status",
      "order completion",
      "how much delivered",
      "how much remaining",
      "delivered vs pending",
      "completed vs pending",
    ],
    defaultWindow: "today",
    audience: "all",
    kpiIds: [
      // Order status breakdown
      "open_orders",
      "completed_orders",
      "will_call_orders",
      "orders_count",
      // Delivery progress
      "delivered_cy",
      "delivered_cy_by_customer",
    ],
  },
  // ============================================================================
  // TOP PRIORITY PROMPT 3: UNDERPERFORMERS REPORT
  // ============================================================================
  {
    id: "underperformers_report",
    name: "Underperformers Report",
    description:
      "Identify problem areas: plants with most delays, drivers with late deliveries, poor pour rates, and high lateness — helps management focus improvement efforts.",
    triggers: [
      // Underperformance
      "underperformers",
      "underperforming",
      "what's underperforming",
      "whats underperforming",
      "poor performance",
      "bad performance",
      "worst performance",
      // Problems/issues
      "problem areas",
      "problem plants",
      "problem drivers",
      "issues report",
      "where are the problems",
      // Worst performers
      "worst plants",
      "worst drivers",
      "slowest plants",
      "slowest drivers",
      "most delays",
      "most late",
      // Below average
      "below average",
      "below target",
      "not meeting targets",
      "missing targets",
      "failing metrics",
      // Bottom performers
      "bottom performers",
      "bottom plants",
      "bottom drivers",
      "lowest performing",
      // Improvement needs
      "needs improvement",
      "improvement areas",
      "where to improve",
      "focus areas",
      "what needs fixing",
      // Exception/red flags
      "red flags",
      "warning signs",
      "exceptions",
      "outliers",
    ],
    defaultWindow: "last_7_days",
    audience: "executive",
    kpiIds: [
      // Late delivery metrics
      "late_tickets_count",
      "avg_lateness_minutes",
      // Problem breakdown by entity
      "late_tickets_by_plant",
      "late_tickets_by_driver",
      // Pour rate issues
      "pour_rate_by_plant",
      // Cancelled/suspended
      "cancelled_orders",
    ],
  },
  // ============================================================================
  // TICKET STATUS BREAKDOWN (distinct from order status)
  // ============================================================================
  {
    id: "ticket_status_breakdown",
    name: "Ticket Status Breakdown",
    description:
      "Overview of tickets by status: breakdown by integer status code, lifecycle positions (at plant, at job, pouring), suspended tickets, and total loads — essential for dispatch monitoring.",
    triggers: [
      // Ticket status queries (prioritize over generic "status breakdown")
      "ticket status breakdown",
      "tickets status breakdown",
      "ticket status",
      "tickets status",
      "ticket breakdown",
      "tickets breakdown",
      "ticket status summary",
      "tickets by status",
      "ticket distribution",
      // This month/week variants
      "this month ticket status",
      "this months ticket status",
      "this month's ticket status",
      "this weeks ticket status",
      "this week's ticket status",
      "monthly ticket status",
      "weekly ticket status",
      // Specific ticket status queries
      "show ticket status",
      "ticket status today",
      "ticket status report",
      "ticket overview",
      "tickets overview",
      "load status",
      "loads status",
      "delivery ticket status",
    ],
    defaultWindow: "this_month",
    audience: "dispatcher",
    kpiIds: [
      "tickets_by_status",
      "tickets_at_plant",
      "tickets_at_job",
      "tickets_pouring",
      "suspended_tickets",
      "tickets_count",
    ],
  },
];

// ============================================================================
// Helpers
// ============================================================================

function normalize(s) {
  return s.toLowerCase().trim().replace(/[?!.,;:]/g, "").replace(/\s+/g, " ");
}

/**
 * Returns the best-matching template for a question, or null if none match.
 * Used by the AI's suggestTemplate tool.
 */
export function suggestTemplate(question) {
  const norm = normalize(question);
  if (!norm) return null;

  let best = null;
  for (const t of TEMPLATES) {
    let score = 0;
    for (const trigger of t.triggers) {
      const normTrigger = normalize(trigger);
      if (norm.includes(normTrigger)) {
        // Longer triggers are more specific
        score = Math.max(score, normTrigger.length);
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { template: t, score };
    }
  }
  return best?.template ?? null;
}

/** Returns the registry KpiDef for each id in the template, in order. */
export function expandTemplate(template) {
  return template.kpiIds
    .map((id) => KPI_REGISTRY.find((k) => k.id === id))
    .filter((k) => k !== undefined);
}

/** Returns true if every KPI id in every template exists in the registry. */
export function validateTemplates() {
  const knownIds = new Set(KPI_REGISTRY.map((k) => k.id));
  const missing = [];
  for (const t of TEMPLATES) {
    for (const id of t.kpiIds) {
      if (!knownIds.has(id)) missing.push({ templateId: t.id, kpiId: id });
    }
  }
  return { ok: missing.length === 0, missing };
}
