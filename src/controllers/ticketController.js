const ticketService = require('../services/ticketService');

/**
 * @swagger
 * tags:
 *   name: Tickets
 *   description: Ticket listing, tracking, and details
 */

/**
 * @swagger
 * /api/tickets:
 *   get:
 *     summary: Get tickets list with filters
 *     description: |
 *       Retrieves a paginated list of tickets with status derivation from timestamp fields, search, and filtering for mobile views.
 *       
 *       **Status Derivation:**
 *       - Status is derived from timestamp fields in priority order: end_unload → unload_time → on_job_time → at_plant_time → to_job_time → loaded_time → load_time
 *       - Falls back to current_status field if no timestamps are present
 *       
 *       **Search Fields:**
 *       - Searches across ticket_code, truck_code, order_code, customer_name, and delivery address
 *       
 *       **Order Summary:**
 *       - Groups tickets by order and provides order date and delivery address summary
 *     tags: [Tickets]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_filter
 *         schema:
 *           type: string
 *           enum: [today, yesterday, last_week, next_week, this_week, this_month]
 *           default: today
 *         description: Predefined date filter based on order_date
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Custom start date (YYYY-MM-DD). Overrides date_filter with end_date.
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Custom end date (YYYY-MM-DD). Overrides date_filter with start_date.
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [delivered, pouring, on_job, at_plant, to_job, loaded, loading, pending]
 *         description: Filter by derived status
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by ticket_code, truck_code, order_code, customer_name, delivery address
 *       - in: query
 *         name: order_id
 *         schema:
 *           type: integer
 *         description: Filter by order ID
 *       - in: query
 *         name: truck_code
 *         schema:
 *           type: string
 *         description: Filter by truck code
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
 *           default: 20
 *         description: Items per page (optimized for mobile)
 *       - in: query
 *         name: sort_by
 *         schema:
 *           type: string
 *           enum: [order_date, ticket_code, truck_code, created_date, at_plant_time, on_job_time, unload_time, end_unload]
 *           default: order_date
 *         description: Field to sort by
 *       - in: query
 *         name: sort_order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort direction
 *     responses:
 *       200:
 *         description: Tickets retrieved successfully
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
 *                   example: "Tickets retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     tickets:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           ticket_id:
 *                             type: integer
 *                             example: 12345
 *                           ticket_code:
 *                             type: string
 *                             example: "45613567"
 *                           truck_code:
 *                             type: string
 *                             example: "0512-MILLWOOD"
 *                           order_id:
 *                             type: integer
 *                             example: 789
 *                           order_code:
 *                             type: string
 *                             example: "4512"
 *                           order_date:
 *                             type: string
 *                             format: date
 *                             example: "2025-11-11"
 *                           customer_name:
 *                             type: string
 *                             example: "ABC Construction"
 *                           delivery_address:
 *                             type: string
 *                             example: "2 SCHOOL STREET, RIPLEY"
 *                           volume:
 *                             type: number
 *                             example: 3.00
 *                           volume_display:
 *                             type: string
 *                             example: "3.00CY"
 *                           progress_display:
 *                             type: string
 *                             example: "3.00 OF 300 CY"
 *                           status:
 *                             type: string
 *                             enum: [delivered, pouring, on_job, at_plant, to_job, loaded, loading, pending]
 *                             example: "at_plant"
 *                           status_display:
 *                             type: string
 *                             example: "AT PLANT"
 *                           timestamp:
 *                             type: string
 *                             format: date-time
 *                             nullable: true
 *                           timestamp_display:
 *                             type: string
 *                             example: "07:45 AM"
 *                           driver_name:
 *                             type: string
 *                             nullable: true
 *                           plant_name:
 *                             type: string
 *                             nullable: true
 *                           latitude:
 *                             type: string
 *                             nullable: true
 *                             example: "40.275761"
 *                           longitude:
 *                             type: string
 *                             nullable: true
 *                             example: "-90.042658"
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         page:
 *                           type: integer
 *                           example: 1
 *                         limit:
 *                           type: integer
 *                           example: 20
 *                         total:
 *                           type: integer
 *                           example: 150
 *                         total_pages:
 *                           type: integer
 *                           example: 8
 *                         has_next:
 *                           type: boolean
 *                           example: true
 *                         has_prev:
 *                           type: boolean
 *                           example: false
 *                     filters:
 *                       type: object
 *                       properties:
 *                         date_filter:
 *                           type: string
 *                           nullable: true
 *                         date_range:
 *                           type: object
 *                           properties:
 *                             startDate:
 *                               type: string
 *                               format: date
 *                             endDate:
 *                               type: string
 *                               format: date
 *                         status:
 *                           type: string
 *                           nullable: true
 *                         search:
 *                           type: string
 *                           nullable: true
 *                         order_id:
 *                           type: integer
 *                           nullable: true
 *                         truck_code:
 *                           type: string
 *                           nullable: true
 *                     status_counts:
 *                       type: object
 *                       properties:
 *                         delivered:
 *                           type: integer
 *                           example: 45
 *                         pouring:
 *                           type: integer
 *                           example: 12
 *                         on_job:
 *                           type: integer
 *                           example: 8
 *                         at_plant:
 *                           type: integer
 *                           example: 25
 *                         to_job:
 *                           type: integer
 *                           example: 5
 *                         loaded:
 *                           type: integer
 *                           example: 3
 *                         loading:
 *                           type: integer
 *                           example: 2
 *                         pending:
 *                           type: integer
 *                           example: 50
 *                     order_summary:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         order_id:
 *                           type: integer
 *                         order_code:
 *                           type: string
 *                         order_date:
 *                           type: string
 *                           format: date
 *                         delivery_address:
 *                           type: string
 *                         total_volume:
 *                           type: number
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Unauthorized"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Failed to retrieve tickets"
 *                 error:
 *                   type: string
 */
async function getTickets(req, res) {
  try {
    const {
      date_filter,
      start_date,
      end_date,
      status,
      search,
      order_id,
      truck_code,
      page,
      limit,
      sort_by,
      sort_order
    } = req.query;

    const tz = req.user?.timezone || null;
    const result = await ticketService.getTickets({
      tz,
      date_filter,
      start_date,
      end_date,
      status,
      search,
      order_id,
      truck_code,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || undefined,
      sort_by,
      sort_order
    });

    return res.status(200).json({
      success: true,
      message: 'Tickets retrieved successfully',
      data: result
    });
  } catch (error) {
    console.error('Error getting tickets:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve tickets',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/tickets/details:
 *   get:
 *     summary: Get ticket details by order code, order date, and ticket code
 *     description: |
 *       Retrieves detailed information for a specific ticket with derived status and related order/truck info.
 *       
 *       Includes all ticket fields, order information, truck location data, and timestamp details.
 *     tags: [Tickets]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: order_code
 *         required: true
 *         schema:
 *           type: string
 *         description: Order Code
 *       - in: query
 *         name: order_date
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *         description: Order Date (YYYY-MM-DD)
 *       - in: query
 *         name: ticket_code
 *         required: true
 *         schema:
 *           type: string
 *         description: Ticket Code
 *     responses:
 *       200:
 *         description: Ticket retrieved successfully
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
 *                   example: "Ticket retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     ticket:
 *                       type: object
 *                       properties:
 *                         ticket_id:
 *                           type: integer
 *                           example: 12345
 *                         ticket_code:
 *                           type: string
 *                           example: "45613567"
 *                         truck_code:
 *                           type: string
 *                           example: "0512-MILLWOOD"
 *                         order_id:
 *                           type: integer
 *                           example: 789
 *                         order_code:
 *                           type: string
 *                           example: "4512"
 *                         order_date:
 *                           type: string
 *                           format: date
 *                         customer_name:
 *                           type: string
 *                         delivery_address:
 *                           type: string
 *                         load_qty:
 *                           type: number
 *                           description: Load quantity for this ticket (CY)
 *                         volume:
 *                           type: number
 *                         volume_display:
 *                           type: string
 *                         progress_display:
 *                           type: string
 *                         status:
 *                           type: string
 *                         status_display:
 *                           type: string
 *                         timestamp:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         timestamp_display:
 *                           type: string
 *                         driver_name:
 *                           type: string
 *                           nullable: true
 *                         plant_name:
 *                           type: string
 *                           nullable: true
 *                         latitude:
 *                           type: string
 *                           nullable: true
 *                         longitude:
 *                           type: string
 *                           nullable: true
 *                         load_time:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         loaded_time:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         to_job_time:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         on_job_time:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         unload_time:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         end_unload:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         at_plant_time:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *       400:
 *         description: Bad request - Ticket ID is required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Ticket ID is required"
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Unauthorized"
 *       404:
 *         description: Ticket not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Ticket not found"
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Failed to retrieve ticket"
 *                 error:
 *                   type: string
 */
async function getTicketById(req, res) {
  try {
    const { order_code, order_date, ticket_code } = req.query;

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

    if (!ticket_code) {
      return res.status(400).json({
        success: false,
        message: 'Ticket code is required'
      });
    }

    const tz = req.user?.timezone || null;
    const ticket = await ticketService.getTicketByCodeAndDate(order_code, order_date, ticket_code, tz);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Ticket retrieved successfully',
      data: { ticket }
    });
  } catch (error) {
    console.error('Error getting ticket by ID:', error.message, error.stack);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve ticket',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/tickets/by-order/{order_id}:
 *   get:
 *     summary: Get all tickets for a specific order
 *     description: |
 *       Retrieves all tickets associated with a specific order ID.
 *       Returns ticket data matching the web app's ticket table view including:
 *       - Load number, Ticket Code, Truck, Load Qty, Running/Ordered Qty
 *       - Status (derived from timestamps)
 *       - Product code
 *       - All timestamp fields (ETA, Ticketed, Loading, Loaded, To Job, At Job, Pouring, Washing, To Plant, At Plant)
 *
 *       Also includes order summary with total tickets, delivered quantity, and progress.
 *     tags: [Tickets]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: order_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The Order ID to fetch tickets for
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: |
 *           Filter by ticket status (multi-selection supported).
 *           Comma-separated values: pending,ticketed,loading,loaded,to_job,at_job,pouring,washing,to_plant,at_plant,cancelled
 *           Example: status=at_plant,pouring
 *       - in: query
 *         name: load
 *         schema:
 *           type: string
 *         description: |
 *           Filter by load number (multi-selection supported).
 *           Comma-separated values.
 *           Example: load=1,2,3
 *       - in: query
 *         name: sort_order
 *         schema:
 *           type: string
 *           enum: [desc, asc]
 *           default: desc
 *         description: Sort direction for load numbers (desc = latest load first, asc = load 1 first)
 *     responses:
 *       200:
 *         description: Tickets retrieved successfully
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
 *                   example: "Tickets retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     order:
 *                       type: object
 *                       properties:
 *                         order_id:
 *                           type: integer
 *                           example: 12345
 *                         order_code:
 *                           type: string
 *                           example: "23002"
 *                         order_date:
 *                           type: string
 *                           format: date
 *                           example: "1/15/2026"
 *                         customer_name:
 *                           type: string
 *                           example: "COM-CRETE LLC"
 *                         delivery_address:
 *                           type: string
 *                           example: "830 S George Nigh Expy"
 *                     tickets:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           load:
 *                             type: integer
 *                             example: 1
 *                           ticket_code:
 *                             type: string
 *                             example: "23867438"
 *                           truck:
 *                             type: string
 *                             example: "205,0R5"
 *                           load_qty:
 *                             type: string
 *                             example: "10.50 CY"
 *                           run_qty_ord_qty:
 *                             type: string
 *                             example: "10.50/42.01 CY"
 *                           running_qty:
 *                             type: number
 *                             example: 10.50
 *                           ordered_qty:
 *                             type: number
 *                             example: 42.01
 *                           status:
 *                             type: string
 *                             example: "at_plant"
 *                           status_display:
 *                             type: string
 *                             example: "At Plant"
 *                           product:
 *                             type: string
 *                             example: "A405N0"
 *                           timestamps:
 *                             type: object
 *                             properties:
 *                               eta_at_job:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "7:30 AM"
 *                               ticketed:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "6:38 AM"
 *                               loading:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "7:04 AM"
 *                               loaded:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "6:57 AM"
 *                               to_job:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "7:01 AM"
 *                               at_job:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "7:46 AM"
 *                               pouring:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "7:46 AM"
 *                               washing:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "8:03 AM"
 *                               to_plant:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "7:56 AM"
 *                               at_plant:
 *                                 type: string
 *                                 nullable: true
 *                                 example: "8:00 AM"
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total_tickets:
 *                           type: integer
 *                           example: 2
 *                         total_delivered_qty:
 *                           type: number
 *                           example: 21.00
 *                         ordered_qty:
 *                           type: number
 *                           example: 42.01
 *                         remaining_qty:
 *                           type: number
 *                           example: 21.01
 *                         progress_display:
 *                           type: string
 *                           example: "21.00 OF 42.01 CY"
 *       400:
 *         description: Bad request - Order ID is required
 *       404:
 *         description: Order not found
 *       500:
 *         description: Server error
 */
async function getTicketsByOrderId(req, res) {
  try {
    const { order_id } = req.params;
    const { status, load, sort_order } = req.query;

    if (!order_id) {
      return res.status(400).json({
        success: false,
        message: 'Order ID is required'
      });
    }

    const orderId = order_id;

    const tz = req.user?.timezone || null;
    const result = await ticketService.getTicketsByOrderId(orderId, {
      tz,
      status,
      load,
      sort_order
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Tickets retrieved successfully',
      data: result
    });
  } catch (error) {
    console.error('Error getting tickets by order ID:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve tickets',
      error: error.message
    });
  }
}

/**
 * POST /api/tickets/:ticketId/weather
 * Fetch/refresh weather for a ticket (same as web: 5 min cache, OpenWeatherMap)
 */
async function fetchTicketWeather(req, res) {
  try {
    const ticketId = req.params.ticketId;

    const forceRefresh = req.body?.force_refresh === true;

    const result = await ticketService.fetchTicketWeatherById(ticketId, forceRefresh);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error fetching ticket weather:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch ticket weather',
      error: error.message
    });
  }
}

/**
 * POST /api/tickets/:ticketId/eta
 * Calculate ETA for a ticket using AWS Location Services
 */
async function calculateTicketETA(req, res) {
  try {
    const ticketId = req.params.ticketId;

    const { truckSpecs, optimizeFor, avoid, forceRecalculate } = req.body || {};

    const result = await ticketService.calculateTicketETAById(ticketId, {
      truckSpecs,
      optimizeFor,
      avoid,
      forceRecalculate: forceRecalculate === true,
    });

    if (!result) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error calculating ticket ETA:', error.message);
    const isConfigError = error.message?.includes('not configured');
    return res.status(isConfigError ? 503 : 500).json({
      success: false,
      message: isConfigError ? 'ETA service is not available yet' : 'Failed to calculate ETA',
      error: error.message
    });
  }
}

/**
 * GET /api/tickets/:ticketId/eta
 * Get cached ETA data for a ticket
 */
async function getTicketETA(req, res) {
  try {
    const ticketId = req.params.ticketId;

    const result = await ticketService.getTicketETAById(ticketId);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error getting ticket ETA:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get ETA',
      error: error.message
    });
  }
}

module.exports = {
  getTickets,
  getTicketById,
  getTicketsByOrderId,
  fetchTicketWeather,
  calculateTicketETA,
  getTicketETA
};

