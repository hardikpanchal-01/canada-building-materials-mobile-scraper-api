const { getTrucks, getActiveTrucksForMap } = require('../services/truckService');

/**
 * @swagger
 * /api/trucks:
 *   get:
 *     summary: Get trucks with pagination and filters
 *     description: |
 *       Returns paginated list of trucks with their current ticket info, status, and location.
 *       Designed for truck list views and map displays.
 *
 *       **Filters:**
 *       - Date range (dateFrom/dateTo) - defaults to today
 *       - Status filter (ticket status)
 *       - Active filter (truck active flag)
 *       - hasTickets - only trucks with assigned tickets
 *       - filterByOrder - filter by order code
 *       - filterByPlant - filter by plant code/name
 *       - search - full text search on truck code, driver name, order code, customer
 *     tags: [Trucks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *         description: Number of items per page
 *       - in: query
 *         name: dateFrom
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date filter (ISO format). Defaults to today.
 *       - in: query
 *         name: dateTo
 *         schema:
 *           type: string
 *           format: date
 *         description: End date filter (ISO format). Defaults to today.
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [code, created_at, current_driver_name, ticket_status, order_code]
 *           default: created_at
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort direction
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by truck code, driver name, order code, or customer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [all, Ticketed, Loading, Loaded, To Job, At Job, Pouring, Washing, To Plant, At Plant, Cancelled]
 *         description: Filter by ticket status
 *       - in: query
 *         name: active
 *         schema:
 *           type: boolean
 *         description: Filter by truck active status
 *       - in: query
 *         name: hasTickets
 *         schema:
 *           type: boolean
 *         description: Only return trucks with tickets
 *       - in: query
 *         name: filterByOrder
 *         schema:
 *           type: string
 *         description: Filter by order code (partial match)
 *       - in: query
 *         name: filterByPlant
 *         schema:
 *           type: string
 *         description: Filter by plant code or name (partial match)
 *     responses:
 *       200:
 *         description: Paginated truck list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       truck_id:
 *                         type: integer
 *                       code:
 *                         type: string
 *                         example: "T001"
 *                       description:
 *                         type: string
 *                       latitude:
 *                         type: string
 *                         example: "28.6139"
 *                       longitude:
 *                         type: string
 *                         example: "77.2090"
 *                       current_driver_name:
 *                         type: string
 *                       ticket_code:
 *                         type: string
 *                       order_code:
 *                         type: string
 *                       ticket_status:
 *                         type: string
 *                         enum: [Ticketed, Loading, Loaded, To Job, At Job, Pouring, Washing, To Plant, At Plant, Cancelled]
 *                       is_active_delivery:
 *                         type: boolean
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 pageSize:
 *                   type: integer
 *                 totalPages:
 *                   type: integer
 *                 hasNextPage:
 *                   type: boolean
 *                 hasPreviousPage:
 *                   type: boolean
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
async function getTrucksList(req, res) {
  try {
    const {
      page,
      pageSize,
      dateFrom,
      dateTo,
      sortBy,
      sortOrder,
      search,
      status,
      active,
      hasTickets,
      filterByOrder,
      filterByPlant
    } = req.query;

    // Parse boolean parameters
    let parsedActive = undefined;
    if (active === 'true') parsedActive = true;
    if (active === 'false') parsedActive = false;

    let parsedHasTickets = undefined;
    if (hasTickets === 'true') parsedHasTickets = true;

    const tz = req.user?.timezone || null;
    const result = await getTrucks({
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 20,
      dateFrom,
      dateTo,
      sortBy,
      sortOrder,
      search,
      status,
      active: parsedActive,
      hasTickets: parsedHasTickets,
      filterByOrder,
      filterByPlant
    }, tz);

    return res.status(200).json(result);

  } catch (error) {
    console.error('Error getting trucks:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get trucks',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/trucks/map:
 *   get:
 *     summary: Get active trucks for map display
 *     description: |
 *       Returns all active trucks with valid coordinates for today.
 *       Optimized for real-time map display showing truck locations.
 *
 *       Only returns trucks that:
 *       - Have valid latitude/longitude
 *       - Are active (active = true)
 *       - Have a ticket today with non-completed status
 *     tags: [Trucks]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of active trucks with locations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 count:
 *                   type: integer
 *                   example: 15
 *                 trucks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       truck_id:
 *                         type: integer
 *                       code:
 *                         type: string
 *                         example: "T001"
 *                       description:
 *                         type: string
 *                       latitude:
 *                         type: string
 *                         example: "28.6139"
 *                       longitude:
 *                         type: string
 *                         example: "77.2090"
 *                       driver_name:
 *                         type: string
 *                       ticket_code:
 *                         type: string
 *                       order_code:
 *                         type: string
 *                       delivery_address:
 *                         type: string
 *                       customer_name:
 *                         type: string
 *                       ticket_status:
 *                         type: string
 *                         enum: [Ticketed, Loading, Loaded, To Job, At Job, Pouring, Washing]
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
async function getActiveTrucks(req, res) {
  try {
    const tz = req.user?.timezone || null;
    const result = await getActiveTrucksForMap(tz);
    return res.status(200).json(result);

  } catch (error) {
    console.error('Error getting active trucks for map:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get active trucks',
      error: error.message
    });
  }
}

module.exports = {
  getTrucksList,
  getActiveTrucks
};
