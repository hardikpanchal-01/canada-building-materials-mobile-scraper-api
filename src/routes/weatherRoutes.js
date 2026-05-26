const express = require('express');
const router = express.Router();
const weatherController = require('../controllers/weatherController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   GET /api/weather/all
 * @desc    Get weather data from orders table weather_data column
 * @access  Private
 */
router.get('/all', authenticate, weatherController.getAllWeatherData);

module.exports = router;
    