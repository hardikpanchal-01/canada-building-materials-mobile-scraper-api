const dashboardService = require('../services/dashboardService');

/**
 * @swagger
 * /api/dashboard:
 *   get:
 *     summary: Get dashboard data for home screen
 *     description: |
 *       Returns comprehensive dashboard data for the mobile app home screen.
 *       All data is user-specific based on assigned customers.
 *
 *       Includes:
 *       - User profile info
 *       - Average weather from ALL today's orders
 *       - Today's order overview (all status counts)
 *       - Today's progress (average percentage for each status)
 *       - Active deliveries (today's recent In Progress orders with pagination)
 *       - Recent alerts/notifications
 *     tags: [Dashboard]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for active_deliveries pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of active deliveries per page (max 100)
 *     responses:
 *       200:
 *         description: Dashboard data retrieved successfully
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
 *                   example: "Dashboard data retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       type: object
 *                       description: User profile information
 *                       properties:
 *                         id:
 *                           type: string
 *                           format: uuid
 *                         firstName:
 *                           type: string
 *                           example: "John"
 *                         lastName:
 *                           type: string
 *                           example: "Smith"
 *                         fullName:
 *                           type: string
 *                           example: "John Smith"
 *                         email:
 *                           type: string
 *                           example: "john@example.com"
 *                         avatarUrl:
 *                           type: string
 *                           nullable: true
 *                         company:
 *                           type: string
 *                           nullable: true
 *                           example: "Stevenson Weir"
 *                     notifications:
 *                       type: object
 *                       description: Notification counts
 *                       properties:
 *                         unread_count:
 *                           type: integer
 *                           example: 2
 *                     weather:
 *                       type: object
 *                       nullable: true
 *                       description: Average weather from ALL today's orders
 *                       properties:
 *                         location:
 *                           type: string
 *                           example: "Charlotte, NC"
 *                         avg_temperature_fahrenheit:
 *                           type: integer
 *                           example: 28
 *                         avg_feels_like_fahrenheit:
 *                           type: integer
 *                           example: 24
 *                         avg_humidity_percent:
 *                           type: integer
 *                           example: 55
 *                         avg_wind_speed_mph:
 *                           type: integer
 *                           example: 30
 *                         avg_precipitation_percent:
 *                           type: integer
 *                           example: 0
 *                         condition:
 *                           type: string
 *                           example: "Clear"
 *                         orders_with_weather:
 *                           type: integer
 *                           description: Number of orders used to calculate average
 *                           example: 15
 *                     today_overview:
 *                       type: object
 *                       description: All order status counts for today
 *                       properties:
 *                         total_orders:
 *                           type: integer
 *                           example: 22
 *                         in_process:
 *                           type: integer
 *                           example: 5
 *                         in_process_change:
 *                           type: integer
 *                           description: Change from yesterday (positive or negative)
 *                           example: 2
 *                         pre_pour:
 *                           type: integer
 *                           example: 3
 *                         completed:
 *                           type: integer
 *                           example: 12
 *                         completed_change:
 *                           type: integer
 *                           description: Change from yesterday (positive or negative)
 *                           example: 4
 *                         cancelled:
 *                           type: integer
 *                           example: 1
 *                         hold_delivery:
 *                           type: integer
 *                           example: 0
 *                         will_call:
 *                           type: integer
 *                           example: 1
 *                         normal:
 *                           type: integer
 *                           example: 0
 *                     today_progress:
 *                       type: object
 *                       description: Progress with average percentage for each status
 *                       properties:
 *                         percent:
 *                           type: integer
 *                           description: Overall completion percentage (0-100)
 *                           example: 55
 *                         completed_orders:
 *                           type: integer
 *                           example: 12
 *                         total_orders:
 *                           type: integer
 *                           example: 22
 *                         active_orders:
 *                           type: integer
 *                           description: Orders currently in progress
 *                           example: 5
 *                         remaining_orders:
 *                           type: integer
 *                           description: Orders not yet completed (excludes cancelled)
 *                           example: 9
 *                         avg_status_percent:
 *                           type: object
 *                           description: Average percentage distribution of each status
 *                           properties:
 *                             completed:
 *                               type: integer
 *                               description: Percentage of completed orders
 *                               example: 55
 *                             in_process:
 *                               type: integer
 *                               description: Percentage of in-process orders
 *                               example: 23
 *                             pre_pour:
 *                               type: integer
 *                               description: Percentage of pre-pour orders
 *                               example: 14
 *                             hold_delivery:
 *                               type: integer
 *                               description: Percentage of hold delivery orders
 *                               example: 0
 *                             will_call:
 *                               type: integer
 *                               description: Percentage of will call orders
 *                               example: 5
 *                             cancelled:
 *                               type: integer
 *                               description: Percentage of cancelled orders
 *                               example: 3
 *                     active_deliveries:
 *                       type: object
 *                       description: Today's recent In Progress orders
 *                       properties:
 *                         count:
 *                           type: integer
 *                           description: Number of active in-progress orders
 *                           example: 5
 *                         orders:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               order_id:
 *                                 type: string
 *                               order_code:
 *                                 type: string
 *                                 example: "45123"
 *                               customer_name:
 *                                 type: string
 *                                 example: "ABC Construction"
 *                               delivery_address:
 *                                 type: string
 *                                 example: "123 Main St, Oklahoma City"
 *                               product_codes:
 *                                 type: string
 *                                 example: "A305N0, A356A0"
 *                               start_time:
 *                                 type: string
 *                                 example: "08:30AM"
 *                               ordered_qty:
 *                                 type: number
 *                                 example: 50
 *                               delivered_qty:
 *                                 type: number
 *                                 example: 30
 *                               remaining_qty:
 *                                 type: number
 *                                 example: 20
 *                               progress_percent:
 *                                 type: integer
 *                                 description: Order delivery progress (0-100)
 *                                 example: 60
 *                               status:
 *                                 type: string
 *                                 example: "In Progress"
 *                     recent_alerts:
 *                       type: array
 *                       description: Recent notifications/alerts
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           title:
 *                             type: string
 *                             example: "Weather Advisory"
 *                           message:
 *                             type: string
 *                             example: "Rain expected at 3 PM - 4 orders may be affected"
 *                           type:
 *                             type: string
 *                             enum: [weather, truck, order, info, warning]
 *                             example: "weather"
 *                           time_ago:
 *                             type: string
 *                             example: "10 min ago"
 *                           created_at:
 *                             type: string
 *                             format: date-time
 *                           read:
 *                             type: boolean
 *             example:
 *               success: true
 *               message: "Dashboard data retrieved successfully"
 *               data:
 *                 user:
 *                   id: "123e4567-e89b-12d3-a456-426614174000"
 *                   firstName: "John"
 *                   lastName: "Smith"
 *                   fullName: "John Smith"
 *                   email: "john@example.com"
 *                   avatarUrl: null
 *                   company: "Stevenson Weir"
 *                 notifications:
 *                   unread_count: 2
 *                 weather:
 *                   location: "Charlotte, NC"
 *                   avg_temperature_fahrenheit: 28
 *                   avg_feels_like_fahrenheit: 24
 *                   avg_humidity_percent: 55
 *                   avg_wind_speed_mph: 30
 *                   avg_precipitation_percent: 0
 *                   condition: "Clear"
 *                   orders_with_weather: 15
 *                 today_overview:
 *                   total_orders: 22
 *                   in_process: 5
 *                   in_process_change: 2
 *                   pre_pour: 3
 *                   completed: 12
 *                   completed_change: 4
 *                   cancelled: 1
 *                   hold_delivery: 0
 *                   will_call: 1
 *                   normal: 0
 *                 today_progress:
 *                   percent: 55
 *                   completed_orders: 12
 *                   total_orders: 22
 *                   active_orders: 5
 *                   remaining_orders: 9
 *                   avg_status_percent:
 *                     completed: 55
 *                     in_process: 23
 *                     pre_pour: 14
 *                     hold_delivery: 0
 *                     will_call: 5
 *                     cancelled: 3
 *                 active_deliveries:
 *                   count: 3
 *                   orders:
 *                     - order_id: "order-123"
 *                       order_code: "45123"
 *                       customer_name: "ABC Construction"
 *                       delivery_address: "123 Main St, Oklahoma City"
 *                       product_codes: "A305N0"
 *                       start_time: "08:30AM"
 *                       ordered_qty: 50
 *                       delivered_qty: 30
 *                       remaining_qty: 20
 *                       progress_percent: 60
 *                       status: "In Progress"
 *                 recent_alerts:
 *                   - id: "alert-1"
 *                     title: "Weather Advisory"
 *                     message: "Rain expected at 3 PM - 4 orders may be affected"
 *                     type: "weather"
 *                     time_ago: "10 min ago"
 *                     created_at: "2026-01-21T09:49:00Z"
 *                     read: false
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error
 */
async function getDashboard(req, res) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    // Extract pagination parameters for active_deliveries
    const pagination = {
      page: req.query.page || 1,
      limit: req.query.limit || 10
    };

    // Extract user access control data
    const userAccess = {
      isAdmin: req.user?.isAdmin || false,
      userType: req.user?.userType || 'contractor',
      allowedPlants: req.user?.allowedPlants || [],
      // Zone-based plants are already included in allowedPlants via auth.js
      allowedCustomerIds: req.user?.allowedCustomerIds || [],
      allowedProjectCodes: req.user?.allowedProjectCodes || []
    };

    const userEmail = req.user?.email || null;
    const tz = req.user?.timezone || null;
    const dashboardData = await dashboardService.getDashboardData(userId, userAccess, pagination, userEmail, tz);

    return res.status(200).json({
      success: true,
      message: 'Dashboard data retrieved successfully',
      data: dashboardData
    });
  } catch (error) {
    console.error('Error getting dashboard:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve dashboard data',
      error: error.message
    });
  }
}

module.exports = {
  getDashboard
};
