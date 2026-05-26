const express = require('express');
const router = express.Router();
const truckController = require('../controllers/truckController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   GET /api/trucks
 * @desc    Get paginated trucks list with filters
 * @access  Private
 */
router.get('/', authenticate, truckController.getTrucksList);

/**
 * @route   GET /api/trucks/map
 * @desc    Get active trucks for map display (today's active deliveries with coordinates)
 * @access  Private
 */
router.get('/map', authenticate, truckController.getActiveTrucks);

module.exports = router;
