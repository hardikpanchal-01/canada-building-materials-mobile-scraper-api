const newDashboardService = require('../services/newDashboardService');
const { getTenantShowRegionForUser } = require('../middleware/auth');

/**
 * @swagger
 * /api/new-dashboard:
 *   get:
 *     summary: Get enhanced dashboard data with market summary
 *     description: |
 *       Returns comprehensive dashboard data including market summary
 *       (company, region, plant aggregations) with date filtering support.
 *       All data returned in a single call for optimal mobile performance.
 *
 *       Includes:
 *       - User profile info
 *       - Average weather from orders
 *       - Order overview (all status counts)
 *       - Progress (percentage for each status)
 *       - Market summary (companies, regions, plants with weather)
 *       - Active deliveries (In Progress orders with pagination)
 *       - Recent alerts/notifications
 *     tags: [Dashboard]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date_filter
 *         schema:
 *           type: string
 *           enum: [today, tomorrow, yesterday, last_week, next_week, this_week, this_month]
 *           default: today
 *         description: Date range preset filter
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Custom start date (YYYY-MM-DD). Overrides date_filter when used with end_date.
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Custom end date (YYYY-MM-DD). Overrides date_filter when used with start_date.
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
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       type: object
 *                     notifications:
 *                       type: object
 *                     weather:
 *                       type: object
 *                       nullable: true
 *                     today_overview:
 *                       type: object
 *                     today_progress:
 *                       type: object
 *                     market_summary:
 *                       type: object
 *                       properties:
 *                         companies:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: integer
 *                               code:
 *                                 type: string
 *                               name:
 *                                 type: string
 *                               totalOrders:
 *                                 type: integer
 *                               activeOrders:
 *                                 type: integer
 *                               cancelledOrders:
 *                                 type: integer
 *                               totalCY:
 *                                 type: number
 *                               usedCY:
 *                                 type: number
 *                         regions:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: integer
 *                               name:
 *                                 type: string
 *                               totalOrders:
 *                                 type: integer
 *                               activeOrders:
 *                                 type: integer
 *                               cancelledOrders:
 *                                 type: integer
 *                               totalCY:
 *                                 type: number
 *                               usedCY:
 *                                 type: number
 *                         plants:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: integer
 *                               code:
 *                                 type: string
 *                               name:
 *                                 type: string
 *                               regionName:
 *                                 type: string
 *                                 nullable: true
 *                               totalOrders:
 *                                 type: integer
 *                               activeOrders:
 *                                 type: integer
 *                               cancelledOrders:
 *                                 type: integer
 *                               totalCY:
 *                                 type: number
 *                               usedCY:
 *                                 type: number
 *                               weather:
 *                                 type: object
 *                                 nullable: true
 *                                 properties:
 *                                   temperature_fahrenheit:
 *                                     type: number
 *                                   humidity:
 *                                     type: number
 *                                   wind_speed_mph:
 *                                     type: number
 *                                   condition:
 *                                     type: string
 *                                   icon:
 *                                     type: string
 *                     active_deliveries:
 *                       type: object
 *                     recent_alerts:
 *                       type: array
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error
 */
async function getNewDashboard(req, res) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    const pagination = {
      page: req.query.page || 1,
      limit: req.query.limit || 10
    };

    const dateParams = {
      dateFilter: req.query.date_filter || 'today',
      startDate: req.query.start_date || null,
      endDate: req.query.end_date || null
    };

    const userAccess = {
      isAdmin: req.user?.isAdmin || false,
      userType: req.user?.userType || 'contractor',
      allowedPlants: req.user?.allowedPlants || [],
      allowedCustomerIds: req.user?.allowedCustomerIds || [],
      allowedProjectCodes: req.user?.allowedProjectCodes || []
    };

    const userEmail = req.user?.email || null;
    const tz = req.user?.timezone || null;
    const dashboardData = await newDashboardService.getNewDashboardData(userId, userAccess, pagination, dateParams, userEmail, tz);

    // Hide region data if tenant has show_regions = false
    const showRegion = await getTenantShowRegionForUser(userId);
    if (!showRegion && dashboardData.market_summary) {
      delete dashboardData.market_summary.regions;
      if (dashboardData.market_summary.plants) {
        dashboardData.market_summary.plants = dashboardData.market_summary.plants.map(({ regionName, ...plant }) => plant);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Dashboard data retrieved successfully',
      data: dashboardData
    });
  } catch (error) {
    console.error('Error getting new dashboard:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve dashboard data',
      error: error.message
    });
  }
}

module.exports = {
  getNewDashboard
};
