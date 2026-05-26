const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   GET /api/dashboard
 * @desc    Get dashboard data for home screen
 * @access  Private
 */
router.get('/', authenticate, dashboardController.getDashboard);

module.exports = router;
