/**
 * Queue Routes
 *
 * Routes for queue management and monitoring.
 */

const express = require('express');
const router = express.Router();
const {
  processQueue,
  getStats,
  getStatus
} = require('../controllers/queueController');

/**
 * @route POST /api/queue/process
 * @desc Process pending jobs in the queue
 * @query limit - Maximum number of jobs to process (default: 10)
 */
router.post('/process', processQueue);

/**
 * @route GET /api/queue/stats
 * @desc Get queue statistics (pending, processing, completed, failed)
 */
router.get('/stats', getStats);

/**
 * @route GET /api/queue/status/:batchId
 * @desc Get status of a specific job by batch ID
 */
router.get('/status/:batchId', getStatus);

module.exports = router;
