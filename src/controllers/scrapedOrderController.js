/**
 * Scraped Order Controller
 *
 * Handles HTTP requests for scraped order ingestion.
 * Orders are stored immediately and processing is queued for background execution.
 */

const {
  validateRequestPayload,
  validateAndSanitizeOrders
} = require('../utils/scrapedOrderValidation');
const { storeScrapedOrders } = require('../services/database/scrapedOrderDatabaseService');

/**
 * Ingest scraped orders
 *
 * POST /api/scraped-orders/ingest
 *
 * Receives order data from scrapers, validates it, stores it, and queues
 * for background processing. Returns immediately after storage.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
async function ingestScrapedOrdersController(req, res) {
  const startTime = Date.now();

  try {
    // Step 1: Validate request payload
    const payloadValidation = validateRequestPayload(req.body);

    if (!payloadValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request payload',
        error_code: 'INVALID_PAYLOAD',
        validation_errors: payloadValidation.errors
      });
    }

    const { orders } = req.body;

    // Step 2: Validate and sanitize orders
    const validationResult = validateAndSanitizeOrders(orders);

    if (!validationResult.isValid) {
      return res.status(400).json({
        success: false,
        error: `Validation failed: ${validationResult.errors.length} orders have errors`,
        error_code: 'VALIDATION_ERROR',
        validation_errors: validationResult.errors,
        validation_warnings: validationResult.warnings,
        validation_summary: validationResult.validationSummary
      });
    }

    // Step 3: Store orders to Supabase Storage and create DB record
    // The DB record is created with processing_status = 'pending'
    const storeResult = await storeScrapedOrders({
      orders: validationResult.sanitizedOrders,
      validationSummary: validationResult.validationSummary,
      scraperId: req.body.scraper_id || 'default-scraper',
      sourceUrl: req.body.source_url || null,
      scraperMetadata: req.body.metadata || null
    });

    // Step 4: Return immediately - comparison will be processed by background worker
    const finalDuration = Date.now() - startTime;

    console.log(`Orders stored successfully. Batch ${storeResult.batch_id} queued for processing. Duration: ${finalDuration}ms`);

    return res.status(200).json({
      success: true,
      message: 'Orders stored successfully. Comparison processing queued.',
      data: {
        batch_id: storeResult.batch_id,
        file_url: storeResult.file_url,
        file_path: storeResult.file_path,
        record_id: storeResult.record_id,
        orders_count: storeResult.orders_count,
        validation_summary: storeResult.validation_summary,
        processing_status: 'pending',
        processing_time_ms: finalDuration
      }
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('Error processing scraped orders:', error);

    if (error.code === 'STORAGE_ERROR') {
      return res.status(500).json({
        success: false,
        error: error.message,
        error_code: 'STORAGE_ERROR',
        details: error.details
      });
    }

    if (error.code === 'DATABASE_ERROR') {
      return res.status(500).json({
        success: false,
        error: error.message,
        error_code: 'DATABASE_ERROR',
        details: error.details
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Internal server error while processing orders',
      error_code: 'INTERNAL_ERROR',
      processing_time_ms: duration
    });
  }
}

module.exports = {
  ingestScrapedOrdersController
};
