/**
 * Scraped Order Controller
 *
 * Handles HTTP requests for scraped order ingestion.
 * Orders are stored immediately and processing is queued for background execution.
 */

const crypto = require('crypto');
const {
  validateRequestPayload,
  validateAndSanitizeOrders,
  validateAndSanitizeLiteOrders
} = require('../utils/scrapedOrderValidation');
const { storeScrapedOrders } = require('../services/database/scrapedOrderDatabaseService');
const { compareLiteOrders, revalidateLiteStatuses } = require('../services/liteComparisonService');
const { sendLiteComparisonEmail } = require('../services/emailService');

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

/**
 * Ingest scraped orders — LITE flow (Connex browser extension)
 *
 * POST /api/scraped-orders/ingest-lite
 *
 * Unlike the full /ingest endpoint (validate → store → async queue → worker),
 * this runs SYNCHRONOUSLY and self-contained:
 *   1. Validate + sanitize the minimal lite payload (order_code, order_date,
 *      quantities, status).
 *   2. Match against the system DB and compare ONLY quantity + status
 *      (reuses compareOrdersWithSystem, then filters differences).
 *   3. Always send the comparison email report.
 *   4. Return the comparison counts + email status to the caller.
 *
 * It does NOT run Command Cloud re-validation, DB writes, time-window guards,
 * or already-emailed dedup — by design, for an on-demand tool.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
async function ingestLiteScrapedOrdersController(req, res) {
  const startTime = Date.now();
  const batchId = `lite_${crypto.randomUUID()}`;

  try {
    // Step 1: Validate request payload structure
    const payloadValidation = validateRequestPayload(req.body);
    if (!payloadValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request payload',
        error_code: 'INVALID_PAYLOAD',
        validation_errors: payloadValidation.errors
      });
    }

    // Step 2: Validate + sanitize with the relaxed (lite) rules
    const validationResult = validateAndSanitizeLiteOrders(req.body.orders);
    if (!validationResult.isValid) {
      return res.status(400).json({
        success: false,
        error: `Validation failed: ${validationResult.errors.length} order(s) have errors`,
        error_code: 'VALIDATION_ERROR',
        validation_errors: validationResult.errors,
        validation_warnings: validationResult.warnings,
        validation_summary: validationResult.validationSummary
      });
    }

    // Step 3: Compare against the system DB (qty + status only)
    let { summary, fullResult } = await compareLiteOrders({
      sanitizedOrders: validationResult.sanitizedOrders,
      batchId
    });

    // Step 3.5: Re-validate STATUS mismatches against the live Command Cloud API.
    // Status diffs that the board has wrong (now agree with Command Cloud) are
    // dropped; remaining ones are shown as Connex (extraction) vs Command Cloud.
    try {
      const revalidated = await revalidateLiteStatuses(
        { summary, fullResult },
        (validationResult.validationSummary || {}).dateRange
      );
      summary = revalidated.summary;
      fullResult = revalidated.fullResult;
    } catch (revalErr) {
      console.error(`Lite Command Cloud re-validation error: ${revalErr.message}`);
      // Continue with the un-revalidated result (extraction vs Truckast).
    }

    // Step 4: Always send the lite comparison email report. When everything
    // matches it is the "100% Accuracy" hero; otherwise the problems table.
    let emailStatus = 'sent';
    let emailError = null;
    try {
      await sendLiteComparisonEmail(summary, fullResult, {
        perTab: (req.body && req.body.metadata && req.body.metadata.perTab) || null
      });
    } catch (err) {
      emailStatus = 'failed';
      emailError = err.message;
      console.error(`Lite flow: failed to send email for batch ${batchId}:`, err.message);
    }

    const duration = Date.now() - startTime;
    console.log(`Lite comparison ${batchId} done in ${duration}ms — matched=${summary.matched_count}, mismatched=${summary.mismatched_count}, missing=${summary.missing_in_system_count}, email=${emailStatus}`);

    return res.status(200).json({
      success: true,
      message: 'Lite comparison completed.',
      data: {
        batch_id: batchId,
        compare_mode: 'lite',
        email_status: emailStatus,
        email_error: emailError,
        summary: {
          total_external_orders: summary.total_external_orders,
          matched_count: summary.matched_count,
          mismatched_count: summary.mismatched_count,
          missing_in_system_count: summary.missing_in_system_count,
          new_in_system_count: summary.new_in_system_count,
          excluded_count: summary.excluded_count
        },
        validation_summary: validationResult.validationSummary,
        processing_time_ms: duration
      }
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('Error processing lite scraped orders:', error);

    // Transient DB lookup failure (no system orders returned) — retryable, no email sent.
    if (error.code === 'SYSTEM_LOOKUP_EMPTY') {
      return res.status(503).json({
        success: false,
        error: error.message,
        error_code: 'SYSTEM_LOOKUP_EMPTY',
        processing_time_ms: duration
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Internal server error while processing lite orders',
      error_code: 'INTERNAL_ERROR',
      details: error.message,
      processing_time_ms: duration
    });
  }
}

module.exports = {
  ingestScrapedOrdersController,
  ingestLiteScrapedOrdersController
};
