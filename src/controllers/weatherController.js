const weatherService = require('../services/weatherService');

/**
 * @swagger
 * /api/weather/all:
 *   get:
 *     summary: Get weather data from orders table
 *     description: Retrieves weather_data JSONB column directly from orders table
 *     tags: [Weather]
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
 *     responses:
 *       200:
 *         description: Weather data retrieved successfully
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
 *                   example: "Weather data retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     order_id:
 *                       type: integer
 *                       example: 12345
 *                     order_code:
 *                       type: string
 *                       example: "5528301"
 *                     order_date:
 *                       type: string
 *                       format: date
 *                       example: "2024-04-08"
 *                     weather_data:
 *                       type: object
 *                       nullable: true
 *                       description: Weather data JSONB from orders table
 *       400:
 *         description: Bad request - Missing required parameters
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
async function getAllWeatherData(req, res) {
  try {
    const { order_code, order_date } = req.query;

    // If order_code and order_date provided, return per-order weather
    if (order_code && order_date) {
      const allData = await weatherService.getAllWeatherData(order_code, order_date);
      return res.status(200).json({
        success: true,
        message: 'Weather data retrieved successfully',
        data: allData
      });
    }

    // Otherwise return all plant weather data
    const { executeDirectSQL } = require('../utils/postgresExecutor');
    const result = await executeDirectSQL(
      `SELECT pw.*, p.code as plant_code, p.description as plant_name
       FROM plant_weather pw
       JOIN plants p ON p.id = pw.plant_id
       ORDER BY pw.fetched_at DESC`
    );

    return res.status(200).json({
      success: true,
      message: 'Plant weather data retrieved successfully',
      data: result.data || []
    });
  } catch (error) {
    console.error('Error getting weather data:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve weather data',
      error: error.message
    });
  }
}

module.exports = {
  getAllWeatherData
};
