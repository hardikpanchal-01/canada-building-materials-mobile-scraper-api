const orderService = require('../services/orderService');
const { getFavouriteOrderIds } = require('../services/favouriteOrderService');
const { getTenantShowRegionForUser } = require('../middleware/auth');
const { executeDirectSQL } = require('../utils/postgresExecutor');

/**
 * Check if user has access to a specific order (by order_code + order_date).
 * Uses the same OR-based access logic as list endpoints:
 *   plant_code matches OR customer_id matches OR project_code matches.
 * Admin users always have access.
 * @returns {boolean} true if user can access the order
 */
async function checkOrderAccess(orderCode, orderDate, userAccess) {
  if (!userAccess || userAccess.isAdmin) return true;

  const accessOrConditions = [];
  const params = [orderCode, orderDate];
  let paramIndex = 3;

  if (userAccess.allowedPlants && userAccess.allowedPlants.length > 0) {
    const placeholders = userAccess.allowedPlants.map((_, i) => `$${paramIndex + i}::text`).join(', ');
    accessOrConditions.push(`EXISTS (
      SELECT 1 FROM order_products op_ac
      INNER JOIN order_product_schedules ops_ac ON ops_ac.order_product_id = op_ac.id
      WHERE op_ac.order_id = o.order_id
        AND (op_ac.order_qty_unit = 'YDQ' AND op_ac.is_mix = true)
        AND ops_ac.plant_code::text IN (${placeholders})
    )`);
    params.push(...userAccess.allowedPlants.map(p => String(p)));
    paramIndex += userAccess.allowedPlants.length;
  }

  if (userAccess.allowedCustomerIds && userAccess.allowedCustomerIds.length > 0) {
    const placeholders = userAccess.allowedCustomerIds.map((_, i) => `$${paramIndex + i}`).join(', ');
    accessOrConditions.push(`o.customer_id IN (${placeholders})`);
    params.push(...userAccess.allowedCustomerIds);
    paramIndex += userAccess.allowedCustomerIds.length;
  }

  if (userAccess.allowedProjectCodes && userAccess.allowedProjectCodes.length > 0) {
    const placeholders = userAccess.allowedProjectCodes.map((_, i) => `$${paramIndex + i}`).join(', ');
    accessOrConditions.push(`o.project_code IN (${placeholders})`);
    params.push(...userAccess.allowedProjectCodes);
    paramIndex += userAccess.allowedProjectCodes.length;
  }

  if (accessOrConditions.length === 0) return false;

  const sql = `
    SELECT 1 FROM orders o
    WHERE o.order_code = $1
      AND o.order_date >= $2::date AND o.order_date < ($2::date + INTERVAL '1 day')
      AND (${accessOrConditions.join(' OR ')})
    LIMIT 1
  `;

  const result = await executeDirectSQL(sql, params);
  return result.data && result.data.length > 0;
}

/**
 * @swagger
 * /api/orders:
 *   get:
 *     summary: Get orders list with filters
 *     description: Retrieves a paginated list of orders with support for date filters, status filters, and search. Returns orders with their status (Normal, Will Call, Hold Delivery, Completed, Wait List, Canceled, In Progress).
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_filter
 *         schema:
 *           type: string
 *           enum: [today, tomorrow, yesterday, last_week, next_week, next_month, this_week, this_month]
 *           default: today
 *         description: Predefined date filter
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Custom start date (YYYY-MM-DD). Overrides date_filter if provided with end_date.
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Custom end date (YYYY-MM-DD). Overrides date_filter if provided with start_date.
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by order status. Supports multi-select with comma-separated values (e.g., "Completed,Will Call"). Valid statuses are Canceled, Normal, Will Call, Hold Delivery, Completed, Wait List, In Progress
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by order code, customer name, or delivery address
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Number of items per page (optimized for mobile)
 *       - in: query
 *         name: sort_by
 *         schema:
 *           type: string
 *           enum: [order_date, order_code, customer_name, start_time, ordered_qty, delivered_qty, status]
 *           default: order_date
 *         description: |
 *           Field to sort by:
 *           - ordered_qty: Sort by order quantity (use with sort_order)
 *           - delivered_qty: Sort by delivered quantity (use with sort_order)
 *           - status: Sort by status priority
 *       - in: query
 *         name: sort_order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: |
 *           Sort direction:
 *           - desc: High to Low (highest quantity first)
 *           - asc: Low to High (lowest quantity first)
 *       - in: query
 *         name: company_name
 *         schema:
 *           type: string
 *         description: Filter by company name (partial match, case-insensitive). Matches via pricing_plant_code → plants → companies.
 *       - in: query
 *         name: region_name
 *         schema:
 *           type: string
 *         description: Filter by region name (partial match, case-insensitive). Matches via pricing_plant_code → plants → regions.
 *       - in: query
 *         name: plant_code
 *         schema:
 *           type: string
 *         description: Filter by plant code (exact match via order_product_schedules.plant_code)
 *       - in: query
 *         name: plant_name
 *         schema:
 *           type: string
 *         description: Filter by plant name/description (partial match, case-insensitive)
 *       - in: query
 *         name: is_favourite
 *         schema:
 *           type: string
 *           enum: [true, false]
 *         description: Filter by favourite status. When true, returns only favourite orders. When false, returns only non-favourite orders. Omit to return all orders. Ignored when tab is provided.
 *       - in: query
 *         name: tab
 *         schema:
 *           type: string
 *           enum: [saved, scheduled, active, completed, cancelled, requested]
 *         description: |
 *           Mobile tab filter. When provided, supersedes `status` and `is_favourite` params.
 *           Returns `tab_counts`, `default_tab`, and `active_tab` in the response.
 *           - saved: Orders in user's favourites (any status)
 *           - scheduled: Pre-pour orders (Normal, Will Call, Hold Delivery, Wait List)
 *           - active: In Progress orders
 *           - completed: Completed orders
 *           - cancelled: Canceled orders
 *           - requested: Placeholder (always returns empty)
 *     responses:
 *       200:
 *         description: Orders retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Orders retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     orders:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           order_id:
 *                             type: string
 *                           order_code:
 *                             type: string
 *                             example: "4512"
 *                           order_date:
 *                             type: string
 *                             format: date
 *                           display_date:
 *                             type: string
 *                             example: "08 Apr 09:45AM"
 *                           start_time:
 *                             type: string
 *                             example: "09:45AM"
 *                           estimated_finish_time:
 *                             type: string
 *                             example: "04:30PM"
 *                           customer_name:
 *                             type: string
 *                             example: "Oranj Constructors Corporation"
 *                           project_name:
 *                             type: string
 *                             description: Project name associated with the order
 *                             example: "Project New Renovation"
 *                           delivery_address:
 *                             type: string
 *                             example: "2464 Royal LN, Mesa, New Jersey 45463"
 *                           ordered_qty:
 *                             type: number
 *                             example: 70
 *                           delivered_qty:
 *                             type: number
 *                             example: 47
 *                           remaining_qty:
 *                             type: number
 *                             example: 23
 *                           remaining_display:
 *                             type: string
 *                             example: "23CY"
 *                           status:
 *                             type: string
 *                             enum: [Canceled, Normal, Will Call, Weather Permitting, Hold Delivery, Completed, Wait List, Unknown, Delayed, In Progress]
 *                           can_chat:
 *                             type: boolean
 *                             description: Chat functionality enabled (always true for all orders)
 *                           can_ticketed:
 *                             type: boolean
 *                             description: Ticket visibility enabled (true only for In Progress and Completed orders)
 *                           has_notes:
 *                             type: boolean
 *                           is_favourite:
 *                             type: boolean
 *                             description: Whether the order is favourited by the current user
 *                           tickets_count:
 *                             type: integer
 *                           plant_codes:
 *                             type: string
 *                             description: Plant codes (comma-separated if multiple plants)
 *                             example: "255, 260"
 *                           plant_name:
 *                             type: string
 *                             description: Primary plant name/description
 *                             example: "Yukon Batch Plant"
 *                           product_codes:
 *                             type: string
 *                             description: Product codes (comma-separated if multiple products)
 *                             example: "RDY-4000, RDY-3500"
 *                           product_description:
 *                             type: string
 *                             description: Product descriptions (comma-separated if multiple products)
 *                             example: "4000 PSI Ready Mix Concrete, 3500 PSI Ready Mix"
 *                           weather_data:
 *                             type: object
 *                             nullable: true
 *                             description: Weather data JSONB from orders table
 *                           recent_ticket:
 *                             type: object
 *                             nullable: true
 *                             description: Most recently created ticket for this order. Updates automatically when new tickets are created.
 *                             properties:
 *                               ticket_code:
 *                                 type: string
 *                                 example: "T-12345"
 *                               truck_code:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "TRK-100"
 *                               driver_name:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "John Smith"
 *                               status:
 *                                 type: string
 *                                 enum: [pending, ticketed, loading, loaded, to_job, at_job, pouring, washing, to_plant, at_plant, cancelled]
 *                                 description: Derived ticket status based on timestamps
 *                               status_display:
 *                                 type: string
 *                                 enum: [Pending, Ticketed, Loading, Loaded, To Job, At Job, Pouring, Washing, To Plant, At Plant, Cancelled]
 *                                 description: Human-readable status label
 *                               load_qty:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "10.50 CY"
 *                               latest_timestamp:
 *                                 type: string
 *                                 nullable: true
 *                                 description: The most recent status timestamp in CST
 *                                 example: "2026-03-03 09:45:00 AM"
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         page:
 *                           type: integer
 *                         limit:
 *                           type: integer
 *                         total:
 *                           type: integer
 *                         total_pages:
 *                           type: integer
 *                         has_next:
 *                           type: boolean
 *                         has_prev:
 *                           type: boolean
 *                     filters:
 *                       type: object
 *                       properties:
 *                         date_filter:
 *                           type: string
 *                         date_range:
 *                           type: object
 *                           properties:
 *                             startDate:
 *                               type: string
 *                             endDate:
 *                               type: string
 *                         status:
 *                           type: string
 *                         search:
 *                           type: string
 *                     status_counts:
 *                       type: object
 *                       properties:
 *                         Canceled:
 *                           type: integer
 *                         Normal:
 *                           type: integer
 *                         Will Call:
 *                           type: integer
 *                         Weather Permitting:
 *                           type: integer
 *                         Hold Delivery:
 *                           type: integer
 *                         Completed:
 *                           type: integer
 *                         Wait List:
 *                           type: integer
 *                         Unknown:
 *                           type: integer
 *                         Delayed:
 *                           type: integer
 *                         In Progress:
 *                           type: integer
 *                     tab_counts:
 *                       type: object
 *                       nullable: true
 *                       description: Count of orders per tab. Only present when `tab` query param is provided.
 *                       properties:
 *                         saved:
 *                           type: integer
 *                           description: Orders in user's favourites
 *                         scheduled:
 *                           type: integer
 *                           description: Pre-pour orders (Normal, Will Call, Hold Delivery, Wait List)
 *                         active:
 *                           type: integer
 *                           description: In Progress orders
 *                         completed:
 *                           type: integer
 *                           description: Completed orders
 *                         cancelled:
 *                           type: integer
 *                           description: Canceled orders
 *                         requested:
 *                           type: integer
 *                           description: Placeholder (always 0)
 *                     default_tab:
 *                       type: string
 *                       nullable: true
 *                       enum: [saved, scheduled, active, completed, cancelled]
 *                       description: Auto-detected best tab based on priority (saved > scheduled > active > completed > cancelled). Only present when `tab` query param is provided.
 *                     active_tab:
 *                       type: string
 *                       nullable: true
 *                       enum: [saved, scheduled, active, completed, cancelled, requested]
 *                       description: The tab currently used for filtering. Only present when `tab` query param is provided.
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error
 */
async function getOrders(req, res) {
  try {
    const {
      date_filter,
      start_date,
      end_date,
      status,
      search,
      page,
      limit,
      sort_by,
      sort_order,
      company_name,
      region_name,
      plant_code,
      plant_name,
      is_favourite,
      tab
    } = req.query;

    // Extract user access control data
    const userAccess = {
      isAdmin: req.user?.isAdmin || false,
      userType: req.user?.userType || 'contractor',
      allowedPlants: req.user?.allowedPlants || [],
      // Zone-based plants are already included in allowedPlants via auth.js
      allowedCustomerIds: req.user?.allowedCustomerIds || [],
      allowedProjectCodes: req.user?.allowedProjectCodes || [],
      timezone: req.user?.timezone || null
    };

    // Check tenant show_regions setting — ignore region_name filter if disabled
    const showRegion = await getTenantShowRegionForUser(req.user?.id);

    const serviceParams = {
      date_filter,
      start_date,
      end_date,
      status,
      search,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 10,
      sort_by,
      sort_order,
      company_name,
      region_name: showRegion ? region_name : undefined,
      plant_code,
      plant_name
    };

    let result;

    // Always fetch favourite IDs first (needed for tab_counts saved count + is_favourite flag)
    const favouriteIds = await getFavouriteOrderIds(req.user.id);
    serviceParams.favourite_order_ids = [...favouriteIds];

    if (tab) {
      serviceParams.tab = tab;
    } else if (is_favourite !== undefined) {
      serviceParams.is_favourite_filter = is_favourite === 'true';
    }

    result = await orderService.getOrders(serviceParams, userAccess);

    // Add is_favourite flag to each order
    result.orders = result.orders.map(order => ({
      ...order,
      is_favourite: favouriteIds.has(order.order_id)
    }));

    // Hide region_name from filters if tenant has show_regions disabled
    if (!showRegion && result.filters) {
      delete result.filters.region_name;
    }

    return res.status(200).json({
      success: true,
      message: 'Orders retrieved successfully',
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve orders',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/orders/details:
 *   get:
 *     summary: Get order details by order code and order date
 *     description: |
 *       Retrieves detailed information for a specific order including products, tickets, notes,
 *       and **graph data** for Pour Speed and Trucks on Job charts.
 *
 *       **Graph 1 — Pour Speed (Line Chart):**
 *       Shows cumulative delivery rate (CY/HR) over time with three lines:
 *       - **Ordered** (blue, dashed): Constant flat line at the scheduled `delivery_rate_per_hour`, points at `truck_space` minute intervals.
 *       - **Delivered** (black, solid): Cumulative rate based on `on_job_time`. First truck uses schedule rate; subsequent trucks = `cumulativeQty / elapsedHours`.
 *       - **Poured** (green, solid): Same formula but using `unload_time`. Elapsed time is measured from the first delivery (not first pour), so Poured is always at or below Delivered.
 *
 *       **Graph 2 — Trucks on the Job (Stacked Area Chart):**
 *       Shows how many trucks are on site at each event time, broken down by state:
 *       - **Waiting** (gray): `on_job_time` → `unload_time`
 *       - **Pouring** (green): `unload_time` → `wash_time`
 *       - **Washout** (blue): `wash_time` → `to_plant_time`
 *
 *       Both graph objects are `null` when no schedule data or no trucks have arrived yet.
 *
 *       **Delay Details:** The `delay_details` array contains one row per load (ticket) with planned vs actual on-job/pour times,
 *       producer delay (late arrival), contractor delay (waiting to pour + pour over time), spacing, and plus-load flag. Empty when no primary schedule or tickets.
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: order_code
 *         required: true
 *         schema:
 *           type: string
 *         description: The order code
 *       - in: query
 *         name: order_date
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *         description: The order date (YYYY-MM-DD)
 *     responses:
 *       200:
 *         description: Order details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Order retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     order:
 *                       type: object
 *                       properties:
 *                         order_id:
 *                           type: string
 *                         order_code:
 *                           type: string
 *                         order_date:
 *                           type: string
 *                           format: date
 *                         display_date:
 *                           type: string
 *                         start_time:
 *                           type: string
 *                         estimated_finish_time:
 *                           type: string
 *                         customer_name:
 *                           type: string
 *                         project_name:
 *                           type: string
 *                           description: Project name associated with the order
 *                         delivery_address:
 *                           type: string
 *                         ordered_qty:
 *                           type: number
 *                         delivered_qty:
 *                           type: number
 *                         remaining_qty:
 *                           type: number
 *                         remaining_display:
 *                           type: string
 *                         status:
 *                           type: string
 *                         can_chat:
 *                           type: boolean
 *                           description: Chat functionality enabled (always true for all orders)
 *                         can_ticketed:
 *                           type: boolean
 *                           description: Ticket visibility enabled (true only for In Progress and Completed orders)
 *                         has_notes:
 *                           type: boolean
 *                         is_favourite:
 *                           type: boolean
 *                           description: Whether the order is favourited by the current user
 *                         delay_details:
 *                           type: array
 *                           description: One row per load with planned/actual times, producer and contractor delay (per delay-details.md)
 *                           items:
 *                             type: object
 *                             properties:
 *                               load_order: { type: number, description: 1-based load index }
 *                               ticket: { type: string }
 *                               truck: { type: string }
 *                               planned_on_job: { type: string, format: date-time, nullable: true, description: "Load 1 uses order_date or schedule start_time; Load 2+ uses schedule start_time + spacing" }
 *                               actual_on_job: { type: string, format: date-time, nullable: true, description: "Actual truck arrival time from ticket on_job_time" }
 *                               producer_delay: { type: number, description: "Minutes late vs adjusted planned time (0 if early). Adjusted = MAX(planned, prev_end_pour)" }
 *                               begin_pour: { type: string, format: date-time, nullable: true, description: "When pouring started (unload_time, fallback on_job_time)" }
 *                               end_pour: { type: string, format: date-time, nullable: true, description: "When pouring ended (wash_time > end_unload > to_plant_time)" }
 *                               scheduled_end_pour: { type: string, format: date-time, nullable: true, description: "planned_on_job + spacing minutes" }
 *                               spacing: { type: number, nullable: true, description: "Minutes between loads = FLOOR(load_qty / delivery_rate * 60)" }
 *                               waiting_to_pour: { type: number, description: "Minutes truck waited before pour started (contractor delay component)" }
 *                               pour_min_over: { type: number, description: "Minutes pour exceeded spacing allocation (negative = finished early)" }
 *                               contractor_delay: { type: number, description: "Total contractor delay = waiting_to_pour + pour_min_over" }
 *                               plus_load: { type: boolean, description: "True if load exceeds scheduled number_of_loads" }
 *                         products:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               order_product_id:
 *                                 type: string
 *                               product_id:
 *                                 type: string
 *                               item_code:
 *                                 type: string
 *                               ordered_qty:
 *                                 type: number
 *                               delivered_qty:
 *                                 type: number
 *                               remaining_qty:
 *                                 type: number
 *                               start_time:
 *                                 type: string
 *                               plant_code:
 *                                 type: string
 *                         tickets:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               ticket_id:
 *                                 type: string
 *                               ticket_number:
 *                                 type: string
 *                               ticket_time:
 *                                 type: string
 *                               quantity:
 *                                 type: number
 *                               truck_code:
 *                                 type: string
 *                               driver_name:
 *                                 type: string
 *                         notes:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               note_id:
 *                                 type: string
 *                               note_text:
 *                                 type: string
 *                               created_at:
 *                                 type: string
 *                         order_location:
 *                           type: object
 *                           description: Delivery address coordinates
 *                           properties:
 *                             latitude:
 *                               type: number
 *                               nullable: true
 *                               example: 51.0447
 *                             longitude:
 *                               type: number
 *                               nullable: true
 *                               example: -114.0719
 *                         weather_data:
 *                           type: object
 *                           nullable: true
 *                           description: Weather data JSONB from orders table
 *                         graphs:
 *                           type: object
 *                           description: Pre-computed graph data for Pour Speed and Trucks on Job charts
 *                           properties:
 *                             pour_speed:
 *                               type: object
 *                               nullable: true
 *                               description: "Pour Speed line chart data (null if no schedule data)"
 *                               properties:
 *                                 schedule_rate:
 *                                   type: number
 *                                   description: Scheduled delivery rate (CY/HR)
 *                                   example: 15.5
 *                                 y_max:
 *                                   type: number
 *                                   description: "Recommended Y-axis max value (ceil(maxRate * 1.2) with outlier cap)"
 *                                   example: 20
 *                                 ordered:
 *                                   type: array
 *                                   description: "Scheduled rate line (blue, dashed) — constant flat line at delivery_rate_per_hour"
 *                                   items:
 *                                     type: object
 *                                     properties:
 *                                       time:
 *                                         type: string
 *                                         format: date-time
 *                                         description: ISO 8601 UTC timestamp
 *                                         example: "2026-01-28T15:00:00.000Z"
 *                                       time_display:
 *                                         type: string
 *                                         description: Formatted time in CST
 *                                         example: "09:00AM"
 *                                       rate:
 *                                         type: number
 *                                         description: Delivery rate (CY/HR) — always equals schedule_rate
 *                                         example: 15.5
 *                                 delivered:
 *                                   type: array
 *                                   description: "Actual delivery rate line (black, solid) — cumulative CY/HR at each truck arrival"
 *                                   items:
 *                                     type: object
 *                                     properties:
 *                                       time:
 *                                         type: string
 *                                         format: date-time
 *                                         example: "2026-01-28T15:12:00.000Z"
 *                                       time_display:
 *                                         type: string
 *                                         example: "09:12AM"
 *                                       rate:
 *                                         type: number
 *                                         description: "Cumulative rate = cumulativeQty / elapsedHours (first truck uses schedule_rate)"
 *                                         example: 16.2
 *                                       cumulative_qty:
 *                                         type: number
 *                                         description: Running total of delivered CY up to this truck
 *                                         example: 10
 *                                 poured:
 *                                   type: array
 *                                   description: "Actual pour rate line (green, solid) — cumulative CY/HR at each pour start, elapsed from first delivery"
 *                                   items:
 *                                     type: object
 *                                     properties:
 *                                       time:
 *                                         type: string
 *                                         format: date-time
 *                                         example: "2026-01-28T15:18:00.000Z"
 *                                       time_display:
 *                                         type: string
 *                                         example: "09:18AM"
 *                                       rate:
 *                                         type: number
 *                                         description: "Cumulative rate = cumulativeQty / elapsedHours from first delivery time"
 *                                         example: 14.2
 *                                       cumulative_qty:
 *                                         type: number
 *                                         description: Running total of poured CY up to this truck
 *                                         example: 10
 *                             trucks_on_job:
 *                               type: object
 *                               nullable: true
 *                               description: "Trucks on Job stacked area chart data (null if no trucks have arrived)"
 *                               properties:
 *                                 time_points:
 *                                   type: array
 *                                   description: Truck state counts at each event timestamp (sorted chronologically)
 *                                   items:
 *                                     type: object
 *                                     properties:
 *                                       time:
 *                                         type: string
 *                                         format: date-time
 *                                         example: "2026-01-28T15:00:00.000Z"
 *                                       time_display:
 *                                         type: string
 *                                         example: "09:00AM"
 *                                       waiting:
 *                                         type: integer
 *                                         description: "Trucks waiting to pour (on_job → unload)"
 *                                         example: 1
 *                                       pouring:
 *                                         type: integer
 *                                         description: "Trucks actively pouring (unload → wash)"
 *                                         example: 0
 *                                       washout:
 *                                         type: integer
 *                                         description: "Trucks washing out / heading back (wash → to_plant)"
 *                                         example: 0
 *                                       total:
 *                                         type: integer
 *                                         description: Total trucks on site (waiting + pouring + washout)
 *                                         example: 1
 *                                 averages:
 *                                   type: object
 *                                   description: Average duration in each state across all trucks (in minutes)
 *                                   properties:
 *                                     avg_waiting_minutes:
 *                                       type: number
 *                                       description: "Average time from arrival to pour start (on_job → unload)"
 *                                       example: 12.5
 *                                     avg_pouring_minutes:
 *                                       type: number
 *                                       description: "Average pour duration (unload → wash)"
 *                                       example: 8.3
 *                                     avg_washout_minutes:
 *                                       type: number
 *                                       description: "Average washout + departure time (wash → to_plant)"
 *                                       example: 5.1
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       404:
 *         description: Order not found
 *       500:
 *         description: Server error
 */
async function getOrderById(req, res) {
  try {
    const { order_code, order_date, loads_page, loads_limit } = req.query;

    if (!order_code) {
      return res.status(400).json({
        success: false,
        message: 'Order code is required'
      });
    }

    if (!order_date) {
      return res.status(400).json({
        success: false,
        message: 'Order date is required'
      });
    }

    // Access control check — same OR logic as list endpoints
    const userAccess = {
      isAdmin: req.user?.isAdmin || false,
      allowedPlants: req.user?.allowedPlants || [],
      allowedCustomerIds: req.user?.allowedCustomerIds || [],
      allowedProjectCodes: req.user?.allowedProjectCodes || []
    };

    const hasAccess = await checkOrderAccess(order_code, order_date, userAccess);
    if (!hasAccess) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Parse pagination params for scheduled loads
    const loadsPagination = {
      page: parseInt(loads_page) || 1,
      limit: Math.min(parseInt(loads_limit) || 100, 100) // Default 100, max 100
    };

    const [order, favouriteIds] = await Promise.all([
      orderService.getOrderByCodeAndDate(order_code, order_date, req.user?.timezone || null, loadsPagination),
      getFavouriteOrderIds(req.user.id)
    ]);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Add is_favourite flag to order
    order.is_favourite = favouriteIds.has(order.order_id);

    return res.status(200).json({
      success: true,
      message: 'Order retrieved successfully',
      data: {
        order
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve order',
      error: error.message
    });
  }
}

/**
 * Get paginated scheduled loads for an order
 * GET /api/orders/scheduled-loads?order_code=XXX&order_date=YYYY-MM-DD&page=1&limit=10
 */
async function getScheduledLoads(req, res) {
  try {
    const { order_code, order_date, page, limit } = req.query;

    if (!order_code) {
      return res.status(400).json({
        success: false,
        message: 'Order code is required'
      });
    }

    if (!order_date) {
      return res.status(400).json({
        success: false,
        message: 'Order date is required'
      });
    }

    // Access control check — same OR logic as list endpoints
    const userAccess = {
      isAdmin: req.user?.isAdmin || false,
      allowedPlants: req.user?.allowedPlants || [],
      allowedCustomerIds: req.user?.allowedCustomerIds || [],
      allowedProjectCodes: req.user?.allowedProjectCodes || []
    };

    const hasAccess = await checkOrderAccess(order_code, order_date, userAccess);
    if (!hasAccess) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const pagination = {
      page: parseInt(page) || 1,
      limit: Math.min(parseInt(limit) || 10, 100) // Default 10, max 100
    };

    const result = await orderService.getScheduledLoadsByOrder(
      order_code,
      order_date,
      req.user?.timezone || null,
      pagination
    );

    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Scheduled loads retrieved successfully',
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve scheduled loads',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/orders/summary:
 *   get:
 *     summary: Get orders summary statistics
 *     description: Retrieves summary statistics for orders within a date range including totals and delivery progress.
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_filter
 *         schema:
 *           type: string
 *           enum: [today, tomorrow, yesterday, last_week, next_week, next_month, this_week, this_month]
 *           default: today
 *         description: Predefined date filter
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Custom start date (YYYY-MM-DD)
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Custom end date (YYYY-MM-DD)
 *       - in: query
 *         name: company_name
 *         schema:
 *           type: string
 *         description: Filter by company name (partial match, case-insensitive)
 *       - in: query
 *         name: region_name
 *         schema:
 *           type: string
 *         description: Filter by region name (partial match, case-insensitive)
 *       - in: query
 *         name: plant_code
 *         schema:
 *           type: string
 *         description: Filter by plant code (exact match)
 *       - in: query
 *         name: plant_name
 *         schema:
 *           type: string
 *         description: Filter by plant name (partial match, case-insensitive)
 *     responses:
 *       200:
 *         description: Summary retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Summary retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total_orders:
 *                           type: integer
 *                           example: 15
 *                         total_ordered_qty:
 *                           type: number
 *                           example: 500
 *                         total_delivered_qty:
 *                           type: number
 *                           example: 350
 *                         total_remaining_qty:
 *                           type: number
 *                           example: 150
 *                         cancelled_orders:
 *                           type: integer
 *                         completed_orders:
 *                           type: integer
 *                         delivery_progress:
 *                           type: integer
 *                           description: Delivery progress percentage (0-100)
 *                           example: 70
 *                         date_range:
 *                           type: object
 *                           properties:
 *                             startDate:
 *                               type: string
 *                             endDate:
 *                               type: string
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error
 */
async function getOrdersSummary(req, res) {
  try {
    const { date_filter, start_date, end_date, company_name, region_name, plant_code, plant_name } = req.query;

    // Extract user access control data
    const userAccess = {
      isAdmin: req.user?.isAdmin || false,
      userType: req.user?.userType || 'contractor',
      allowedPlants: req.user?.allowedPlants || [],
      // Zone-based plants are already included in allowedPlants via auth.js
      allowedCustomerIds: req.user?.allowedCustomerIds || [],
      allowedProjectCodes: req.user?.allowedProjectCodes || [],
      timezone: req.user?.timezone || null
    };

    const summary = await orderService.getOrdersSummary({
      date_filter,
      start_date,
      end_date,
      company_name,
      region_name,
      plant_code,
      plant_name
    }, userAccess);

    return res.status(200).json({
      success: true,
      message: 'Summary retrieved successfully',
      data: {
        summary
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve summary',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/orders/active-tracking:
 *   get:
 *     summary: Get today's In Progress orders with full tracking details
 *     description: |
 *       Returns all In Progress orders for the given date with complete tracking data per order:
 *       - Order delivery location (latitude/longitude)
 *       - Plant details (code, address, phone, latitude/longitude)
 *       - All tickets load-by-load with truck details (code, driver, latitude/longitude)
 *       - Per-ticket timestamps (ticketed, loading, loaded, to_job, at_job, pouring, washing, to_plant, at_plant)
 *       - Per-order summary (ordered, delivered, remaining qty, progress)
 *
 *       Designed for dispatch/tracking dashboards where you need a single API call
 *       to render all active deliveries with real-time truck positions.
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_filter
 *         schema:
 *           type: string
 *           enum: [today, tomorrow, yesterday, last_week, next_week, next_month, this_week, this_month]
 *           default: today
 *         description: Predefined date filter
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Custom start date (YYYY-MM-DD). Overrides date_filter if provided with end_date.
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Custom end date (YYYY-MM-DD). Overrides date_filter if provided with start_date.
 *       - in: query
 *         name: company_name
 *         schema:
 *           type: string
 *         description: Filter by company name (partial match, case-insensitive)
 *       - in: query
 *         name: region_name
 *         schema:
 *           type: string
 *         description: Filter by region name (partial match, case-insensitive)
 *       - in: query
 *         name: plant_code
 *         schema:
 *           type: string
 *         description: Filter by plant code (exact match)
 *       - in: query
 *         name: plant_name
 *         schema:
 *           type: string
 *         description: Filter by plant name (partial match, case-insensitive)
 *     responses:
 *       200:
 *         description: Active tracking data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Active tracking data retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     date:
 *                       type: string
 *                       format: date
 *                     total_orders:
 *                       type: integer
 *                     orders:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           order_id:
 *                             type: string
 *                           order_code:
 *                             type: string
 *                             example: "ORD-2026-001"
 *                           order_date:
 *                             type: string
 *                             format: date
 *                             example: "2026-01-27"
 *                           display_date:
 *                             type: string
 *                             example: "27 Jan 2026"
 *                           customer_name:
 *                             type: string
 *                             example: "ABC Construction LLC"
 *                           project_name:
 *                             type: string
 *                             description: Project name associated with the order
 *                             example: "Highway 101 Extension"
 *                           delivery_address:
 *                             type: string
 *                             example: "1234 Main St, Houston, TX 77001"
 *                           delivery_addr1:
 *                             type: string
 *                             example: "1234 Main St"
 *                           delivery_addr2:
 *                             type: string
 *                             example: "Houston"
 *                           delivery_addr3:
 *                             type: string
 *                             example: "TX 77001"
 *                           ordered_qty:
 *                             type: number
 *                             example: 50
 *                           delivered_qty:
 *                             type: number
 *                             example: 30
 *                           remaining_qty:
 *                             type: number
 *                             example: 20
 *                           remaining_display:
 *                             type: string
 *                             example: "20CY"
 *                           progress_percent:
 *                             type: integer
 *                             example: 60
 *                           current_status:
 *                             type: integer
 *                             description: "Numeric status code (0=Normal, 1=Will Call, 3=Hold Delivery, 4=Completed, 5=Wait List)"
 *                           removed:
 *                             type: boolean
 *                           remove_reason_code:
 *                             type: string
 *                             nullable: true
 *                           status:
 *                             type: string
 *                             example: "In Progress"
 *                           can_chat:
 *                             type: boolean
 *                             description: Chat functionality enabled (always true for In Progress orders)
 *                             example: true
 *                           can_ticketed:
 *                             type: boolean
 *                             description: Ticket visibility enabled (always true for In Progress orders)
 *                             example: true
 *                           has_notes:
 *                             type: boolean
 *                           product_codes:
 *                             type: string
 *                             example: "RDY-4000, RDY-3500"
 *                           product_description:
 *                             type: string
 *                             description: Product descriptions (comma-separated if multiple products)
 *                             example: "4000 PSI Ready Mix Concrete, 3500 PSI Ready Mix"
 *                           start_time:
 *                             type: string
 *                             example: "07:30 AM"
 *                           estimated_finish_time:
 *                             type: string
 *                             example: "11:30 AM"
 *                           order_location:
 *                             type: object
 *                             properties:
 *                               latitude:
 *                                 type: number
 *                                 example: 29.7604
 *                               longitude:
 *                                 type: number
 *                                 example: -95.3698
 *                           plant:
 *                             type: object
 *                             nullable: true
 *                             properties:
 *                               code:
 *                                 type: string
 *                                 example: "PLT-01"
 *                               description:
 *                                 type: string
 *                                 example: "Houston Main Plant"
 *                               address:
 *                                 type: string
 *                                 example: "500 Industrial Blvd, Houston TX"
 *                               phone:
 *                                 type: string
 *                               latitude:
 *                                 type: number
 *                                 example: 29.7855
 *                               longitude:
 *                                 type: number
 *                                 example: -95.3412
 *                           notes:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 note_id:
 *                                   type: string
 *                                 note_text:
 *                                   type: string
 *                                 created_at:
 *                                   type: string
 *                           notes_count:
 *                             type: integer
 *                           weather_data:
 *                             type: object
 *                             nullable: true
 *                           tickets:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 load:
 *                                   type: integer
 *                                   example: 1
 *                                 ticket_code:
 *                                   type: string
 *                                   example: "TKT-001"
 *                                 status:
 *                                   type: string
 *                                   enum: [pending, ticketed, loading, loaded, to_job, at_job, pouring, washing, to_plant, at_plant, cancelled]
 *                                   example: "pouring"
 *                                 status_display:
 *                                   type: string
 *                                   example: "Pouring"
 *                                 tracking_status:
 *                                   type: array
 *                                   description: Chronological tracking status array showing all status milestones from Ticketed to At Plant
 *                                   items:
 *                                     type: object
 *                                     properties:
 *                                       status:
 *                                         type: string
 *                                         enum: [ticketed, loading, loaded, to_job, at_job, pouring, washing, to_plant, at_plant]
 *                                         example: "ticketed"
 *                                       status_display:
 *                                         type: string
 *                                         example: "Ticketed"
 *                                       completed:
 *                                         type: boolean
 *                                         description: Whether this status milestone has been reached
 *                                         example: true
 *                                       is_current:
 *                                         type: boolean
 *                                         description: Whether this is the current active status (only one will be true)
 *                                         example: false
 *                                       time:
 *                                         type: string
 *                                         nullable: true
 *                                         description: Timestamp when this status was reached (null if not reached)
 *                                         example: "02:13 AM"
 *                                 truck:
 *                                   type: object
 *                                   properties:
 *                                     code:
 *                                       type: string
 *                                       example: "TRK-10"
 *                                     description:
 *                                       type: string
 *                                       example: "Mixer Truck 10"
 *                                     driver_name:
 *                                       type: string
 *                                       example: "John Smith"
 *                                     driver_phone:
 *                                       type: string
 *                                     latitude:
 *                                       type: number
 *                                       example: 29.7610
 *                                     longitude:
 *                                       type: number
 *                                       example: -95.3700
 *                                 product:
 *                                   type: string
 *                                   example: "RDY-4000"
 *                                 load_qty:
 *                                   type: number
 *                                   example: 10
 *                                 running_qty:
 *                                   type: number
 *                                   example: 10
 *                                 ordered_qty:
 *                                   type: number
 *                                   example: 50
 *                                 remaining_after_load:
 *                                   type: number
 *                                   example: 40
 *                                 timestamps:
 *                                   type: object
 *                                   properties:
 *                                     eta_at_job:
 *                                       type: string
 *                                       example: "08:00 AM"
 *                                     ticketed:
 *                                       type: string
 *                                     loading:
 *                                       type: string
 *                                     loaded:
 *                                       type: string
 *                                     to_job:
 *                                       type: string
 *                                     at_job:
 *                                       type: string
 *                                     pouring:
 *                                       type: string
 *                                     washing:
 *                                       type: string
 *                                     to_plant:
 *                                       type: string
 *                                     at_plant:
 *                                       type: string
 *                           summary:
 *                             type: object
 *                             properties:
 *                               total_tickets:
 *                                 type: integer
 *                               active_tickets:
 *                                 type: integer
 *                               cancelled_tickets:
 *                                 type: integer
 *                               total_delivered_qty:
 *                                 type: number
 *                               ordered_qty:
 *                                 type: number
 *                               remaining_qty:
 *                                 type: number
 *                               progress_percent:
 *                                 type: integer
 *                               progress_display:
 *                                 type: string
 *                                 example: "30.00 OF 50.00 CY"
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error
 */
async function getActiveTracking(req, res) {
  try {
    const { date_filter, start_date, end_date, company_name, region_name, plant_code, plant_name } = req.query;

    // Extract user access control data
    const userAccess = {
      isAdmin: req.user?.isAdmin || false,
      userType: req.user?.userType || 'contractor',
      allowedPlants: req.user?.allowedPlants || [],
      // Zone-based plants are already included in allowedPlants via auth.js
      allowedCustomerIds: req.user?.allowedCustomerIds || [],
      allowedProjectCodes: req.user?.allowedProjectCodes || [],
      timezone: req.user?.timezone || null
    };

    const result = await orderService.getActiveTrackingOrders({
      date_filter,
      start_date,
      end_date,
      company_name,
      region_name,
      plant_code,
      plant_name
    }, userAccess);

    return res.status(200).json({
      success: true,
      message: 'Active tracking data retrieved successfully',
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve active tracking data',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/orders/tracking/{order_id}:
 *   get:
 *     summary: Get order tracking details by order ID with pagination
 *     description: |
 *       Returns complete tracking information for a specific order including:
 *       - Order details with delivery location (latitude/longitude)
 *       - Plant information with location (latitude/longitude)
 *       - Paginated tickets with full details including:
 *         - Ticket status and timestamps
 *         - Truck details with current location (latitude/longitude)
 *         - Driver information
 *         - Plant information per ticket with location
 *         - Product details and quantities
 *
 *       This API is designed for tracking/map views where you need all location
 *       data for an order's delivery trucks, plant, and destination in a single call.
 *       Tickets are paginated for better performance with large orders.
 *     tags: [Orders]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: order_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The order ID to retrieve tracking details for
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for ticket pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Number of tickets per page
 *     responses:
 *       200:
 *         description: Order tracking details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Order tracking details retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     order_id:
 *                       type: integer
 *                       example: 12345
 *                     order_code:
 *                       type: string
 *                       example: "ORD-2026-001"
 *                     order_date:
 *                       type: string
 *                       format: date
 *                       example: "2026-01-27"
 *                     display_date:
 *                       type: string
 *                       example: "27 Jan 2026"
 *                     customer_name:
 *                       type: string
 *                       example: "ABC Construction LLC"
 *                     project_name:
 *                       type: string
 *                       example: "Highway 101 Extension"
 *                     delivery_address:
 *                       type: string
 *                       example: "1234 Main St, Houston, TX 77001"
 *                     delivery_addr1:
 *                       type: string
 *                     delivery_addr2:
 *                       type: string
 *                     delivery_addr3:
 *                       type: string
 *                     ordered_qty:
 *                       type: number
 *                       example: 50
 *                     delivered_qty:
 *                       type: number
 *                       example: 30
 *                     remaining_qty:
 *                       type: number
 *                       example: 20
 *                     remaining_display:
 *                       type: string
 *                       example: "20CY"
 *                     progress_percent:
 *                       type: integer
 *                       example: 60
 *                     status:
 *                       type: string
 *                       example: "In Progress"
 *                     can_chat:
 *                       type: boolean
 *                     can_ticketed:
 *                       type: boolean
 *                       description: Ticket visibility enabled (true only for In Progress and Completed orders)
 *                     product_codes:
 *                       type: string
 *                       example: "RDY-4000, RDY-3500"
 *                     product_description:
 *                       type: string
 *                       example: "4000 PSI Ready Mix Concrete"
 *                     weather_data:
 *                       type: object
 *                       nullable: true
 *                     order_location:
 *                       type: object
 *                       description: Order delivery site coordinates
 *                       properties:
 *                         latitude:
 *                           type: number
 *                           example: 29.7604
 *                         longitude:
 *                           type: number
 *                           example: -95.3698
 *                     plant:
 *                       type: object
 *                       nullable: true
 *                       description: Plant details with location
 *                       properties:
 *                         code:
 *                           type: string
 *                           example: "PLT-01"
 *                         description:
 *                           type: string
 *                           example: "Houston Main Plant"
 *                         address:
 *                           type: string
 *                           example: "500 Industrial Blvd, Houston TX"
 *                         address1:
 *                           type: string
 *                         address2:
 *                           type: string
 *                         phone:
 *                           type: string
 *                           example: "713-555-1234"
 *                         latitude:
 *                           type: number
 *                           example: 29.7855
 *                         longitude:
 *                           type: number
 *                           example: -95.3412
 *                     tickets:
 *                       type: array
 *                       description: Paginated tickets for this order with truck and plant locations
 *                       items:
 *                         type: object
 *                         properties:
 *                           load:
 *                             type: integer
 *                             description: Load number (sequential)
 *                             example: 1
 *                           ticket_id:
 *                             type: integer
 *                             example: 5678
 *                           ticket_code:
 *                             type: string
 *                             example: "TKT-001"
 *                           status:
 *                             type: string
 *                             enum: [pending, ticketed, loading, loaded, to_job, at_job, pouring, washing, to_plant, at_plant, cancelled]
 *                             example: "pouring"
 *                           status_display:
 *                             type: string
 *                             example: "Pouring"
 *                           tracking_status:
 *                             type: array
 *                             description: Chronological tracking status array showing all status milestones from Ticketed to At Plant
 *                             items:
 *                               type: object
 *                               properties:
 *                                 status:
 *                                   type: string
 *                                   enum: [ticketed, loading, loaded, to_job, at_job, pouring, washing, to_plant, at_plant]
 *                                   example: "ticketed"
 *                                 status_display:
 *                                   type: string
 *                                   example: "Ticketed"
 *                                 completed:
 *                                   type: boolean
 *                                   description: Whether this status milestone has been reached
 *                                   example: true
 *                                 is_current:
 *                                   type: boolean
 *                                   description: Whether this is the current active status (only one will be true)
 *                                   example: false
 *                                 time:
 *                                   type: string
 *                                   nullable: true
 *                                   description: Timestamp when this status was reached (null if not reached)
 *                                   example: "02:13 AM"
 *                           product:
 *                             type: object
 *                             properties:
 *                               item_code:
 *                                 type: string
 *                                 example: "RDY-4000"
 *                               description:
 *                                 type: string
 *                                 example: "4000 PSI Ready Mix Concrete"
 *                           load_qty:
 *                             type: number
 *                             example: 10
 *                           running_qty:
 *                             type: number
 *                             description: Cumulative delivered quantity
 *                             example: 10
 *                           ordered_qty:
 *                             type: number
 *                             example: 50
 *                           remaining_after_load:
 *                             type: number
 *                             example: 40
 *                           truck:
 *                             type: object
 *                             description: Truck details with current location
 *                             properties:
 *                               code:
 *                                 type: string
 *                                 example: "TRK-10"
 *                               description:
 *                                 type: string
 *                                 example: "Mixer Truck 10"
 *                               owner:
 *                                 type: string
 *                                 example: "Fleet Corp"
 *                               latitude:
 *                                 type: number
 *                                 description: Current truck latitude
 *                                 example: 29.7610
 *                               longitude:
 *                                 type: number
 *                                 description: Current truck longitude
 *                                 example: -95.3700
 *                           driver:
 *                             type: object
 *                             properties:
 *                               code:
 *                                 type: string
 *                               name:
 *                                 type: string
 *                                 example: "John Smith"
 *                               phone:
 *                                 type: string
 *                                 example: "713-555-9999"
 *                           plant:
 *                             type: object
 *                             description: Plant for this specific ticket with location
 *                             properties:
 *                               code:
 *                                 type: string
 *                                 example: "PLT-01"
 *                               name:
 *                                 type: string
 *                                 example: "Houston Main Plant"
 *                               latitude:
 *                                 type: number
 *                                 example: 29.7855
 *                               longitude:
 *                                 type: number
 *                                 example: -95.3412
 *                           timestamps:
 *                             type: object
 *                             description: All ticket event timestamps
 *                             properties:
 *                               eta_at_job:
 *                                 type: string
 *                                 example: "08:00AM"
 *                               ticketed:
 *                                 type: string
 *                               loading:
 *                                 type: string
 *                               loaded:
 *                                 type: string
 *                               to_job:
 *                                 type: string
 *                               at_job:
 *                                 type: string
 *                               pouring:
 *                                 type: string
 *                               washing:
 *                                 type: string
 *                               to_plant:
 *                                 type: string
 *                               at_plant:
 *                                 type: string
 *                     pagination:
 *                       type: object
 *                       description: Pagination information for tickets
 *                       properties:
 *                         page:
 *                           type: integer
 *                           description: Current page number
 *                           example: 1
 *                         limit:
 *                           type: integer
 *                           description: Items per page
 *                           example: 10
 *                         total:
 *                           type: integer
 *                           description: Total number of tickets
 *                           example: 25
 *                         total_pages:
 *                           type: integer
 *                           description: Total number of pages
 *                           example: 3
 *                         has_next:
 *                           type: boolean
 *                           description: Whether there is a next page
 *                           example: true
 *                         has_prev:
 *                           type: boolean
 *                           description: Whether there is a previous page
 *                           example: false
 *                     summary:
 *                       type: object
 *                       description: Order summary statistics
 *                       properties:
 *                         total_tickets:
 *                           type: integer
 *                           example: 5
 *                         active_tickets:
 *                           type: integer
 *                           example: 4
 *                         cancelled_tickets:
 *                           type: integer
 *                           example: 1
 *                         total_delivered_qty:
 *                           type: number
 *                           example: 30
 *                         ordered_qty:
 *                           type: number
 *                           example: 50
 *                         remaining_qty:
 *                           type: number
 *                           example: 20
 *                         progress_percent:
 *                           type: integer
 *                           example: 60
 *                         progress_display:
 *                           type: string
 *                           example: "30.00 OF 50.00 CY"
 *       400:
 *         description: Bad request - Order ID is required
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       404:
 *         description: Order not found
 *       500:
 *         description: Server error
 */
async function getOrderTracking(req, res) {
  try {
    const { order_id } = req.params;
    const { page, limit } = req.query;

    if (!order_id) {
      return res.status(400).json({
        success: false,
        message: 'Order ID is required'
      });
    }

    // Extract user access control data
    const userAccess = {
      isAdmin: req.user?.isAdmin || false,
      userType: req.user?.userType || 'contractor',
      allowedPlants: req.user?.allowedPlants || [],
      // Zone-based plants are already included in allowedPlants via auth.js
      allowedCustomerIds: req.user?.allowedCustomerIds || [],
      allowedProjectCodes: req.user?.allowedProjectCodes || [],
      timezone: req.user?.timezone || null
    };

    const result = await orderService.getOrderTrackingById(order_id, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 10
    }, userAccess);

    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Order tracking details retrieved successfully',
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve order tracking details',
      error: error.message
    });
  }
}

module.exports = {
  getOrders,
  getOrderById,
  getScheduledLoads,
  getOrdersSummary,
  getActiveTracking,
  getOrderTracking
};
