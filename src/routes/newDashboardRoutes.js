const express = require('express');
const router = express.Router();
const newDashboardController = require('../controllers/newDashboardController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   GET /api/new-dashboard
 * @desc    Get enhanced dashboard data with market summary and date filtering
 * @access  Private
 */
router.get('/', authenticate, newDashboardController.getNewDashboard);

module.exports = router;
