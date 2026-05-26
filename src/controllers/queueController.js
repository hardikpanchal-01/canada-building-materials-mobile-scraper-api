/**
 * Queue Controller
 *
 * Handles queue management endpoints for monitoring and manual processing.
 */

const {
  processPendingJobs,
  getQueueStats,
  getJobStatus
} = require('../services/queueProcessorService');

/**
 * Process pending jobs manually
 *
 * POST /api/queue/process
 *
 * Can be triggered by cron job or manually.
 */
async function processQueue(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 10;

    console.log(`Manual queue processing triggered (limit: ${limit})`);

    const result = await processPendingJobs(limit);

    return res.status(200).json({
      success: true,
      message: `Processed ${result.processed} job(s)`,
      data: result
    });

  } catch (error) {
    console.error('Queue processing error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to process queue',
      message: error.message
    });
  }
}

/**
 * Get queue statistics
 *
 * GET /api/queue/stats
 */
async function getStats(req, res) {
  try {
    const stats = await getQueueStats();

    return res.status(200).json({
      success: true,
      data: {
        ...stats,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Failed to get queue stats:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get queue statistics',
      message: error.message
    });
  }
}

/**
 * Get job status by batch ID
 *
 * GET /api/queue/status/:batchId
 */
async function getStatus(req, res) {
  try {
    const { batchId } = req.params;

    if (!batchId) {
      return res.status(400).json({
        success: false,
        error: 'Batch ID is required'
      });
    }

    const status = await getJobStatus(batchId);

    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        batch_id: batchId
      });
    }

    return res.status(200).json({
      success: true,
      data: status
    });

  } catch (error) {
    console.error('Failed to get job status:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get job status',
      message: error.message
    });
  }
}

module.exports = {
  processQueue,
  getStats,
  getStatus
};
