const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   GET /api/tickets
 * @desc    Get tickets list with filters
 * @access  Private
 */
router.get('/', authenticate, ticketController.getTickets);

/**
 * @route   GET /api/tickets/details
 * @desc    Get ticket details by order code, order date, and ticket code
 * @access  Private
 */
router.get('/details', authenticate, ticketController.getTicketById);

/**
 * @route   GET /api/tickets/by-order/:order_id
 * @desc    Get all tickets for a specific order
 * @access  Private
 */
router.get('/by-order/:order_id', authenticate, ticketController.getTicketsByOrderId);

/**
 * @route   POST /api/tickets/:ticketId/weather
 * @desc    Fetch/refresh weather for a ticket (with 5 min cache)
 * @access  Private
 */
router.post('/:ticketId/weather', authenticate, ticketController.fetchTicketWeather);

/**
 * @route   POST /api/tickets/:ticketId/eta
 * @desc    Calculate ETA for a ticket using AWS Location Services
 * @access  Private
 */
router.post('/:ticketId/eta', authenticate, ticketController.calculateTicketETA);

/**
 * @route   GET /api/tickets/:ticketId/eta
 * @desc    Get cached ETA data for a ticket
 * @access  Private
 */
router.get('/:ticketId/eta', authenticate, ticketController.getTicketETA);

module.exports = router;

