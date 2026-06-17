const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const favouriteOrderController = require('../controllers/favouriteOrderController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   GET /api/orders/summary
 * @desc    Get orders summary statistics
 * @access  Private
 */
router.get('/summary', authenticate, orderController.getOrdersSummary);

/**
 * @route   GET /api/orders/active-tracking
 * @desc    Get today's In Progress orders with full tracking (trucks, plants, tickets, locations)
 * @access  Private
 */
router.get('/active-tracking', authenticate, orderController.getActiveTracking);

/**
 * @route   GET /api/orders/favourites
 * @desc    Get all favourite orders for the authenticated user
 * @access  Private
 */
router.get('/favourites', authenticate, favouriteOrderController.getFavourites);

/**
 * @route   POST /api/orders/:order_id/favourite
 * @desc    Toggle favourite/unfavourite an order
 * @access  Private
 */
router.post('/:order_id/favourite', authenticate, favouriteOrderController.toggleFavourite);

/**
 * @route   GET /api/orders
 * @desc    Get orders list with filters
 * @access  Private
 */
router.get('/', authenticate, orderController.getOrders);

/**
 * @route   GET /api/orders/details
 * @desc    Get order details by order code and order date
 * @access  Private
 */
router.get('/details', authenticate, orderController.getOrderById);

/**
 * @route   GET /api/orders/scheduled-loads
 * @desc    Get paginated scheduled loads for an order by order code and order date
 * @access  Private
 */
router.get('/scheduled-loads', authenticate, orderController.getScheduledLoads);

/**
 * @route   GET /api/orders/tracking/:order_id
 * @desc    Get order tracking details by order ID with all tickets, truck locations, plant locations, and order location
 * @access  Private
 */
router.get('/tracking/:order_id', authenticate, orderController.getOrderTracking);

module.exports = router;
