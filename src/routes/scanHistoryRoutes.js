const express = require('express');
const router = express.Router();
const scanHistoryController = require('../controllers/scanHistoryController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   GET /api/scan-history
 * @desc    Get all scan records for the authenticated user
 * @access  Private
 */
router.get('/', authenticate, scanHistoryController.getHistory);

/**
 * @route   POST /api/scan-history
 * @desc    Save a new scan record
 * @access  Private
 */
router.post('/', authenticate, scanHistoryController.saveScan);

/**
 * @route   DELETE /api/scan-history/:id
 * @desc    Delete a single scan record by client scan_id
 * @access  Private
 */
router.delete('/:id', authenticate, scanHistoryController.deleteScan);

/**
 * @route   DELETE /api/scan-history
 * @desc    Clear all scan history for the authenticated user
 * @access  Private
 */
router.delete('/', authenticate, scanHistoryController.clearHistory);

module.exports = router;
