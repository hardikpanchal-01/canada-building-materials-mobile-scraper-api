/**
 * Scraper Email Log Service
 *
 * Logs every comparison run (sent, skipped, or failed) to the scraper_email_logs table.
 * Used by the admin panel's Scraper Monitoring page to provide visibility
 * into whether the scraper system is running — even when emails are skipped.
 */

const { executeDirectSQL } = require('../../utils/postgresExecutor');

/**
 * Log a scraper email event (sent, skipped, or failed)
 *
 * @param {object} params
 * @param {string} params.batchId        - Batch ID from the import
 * @param {string} params.status         - 'sent' | 'skipped' | 'failed'
 * @param {string} [params.skipReason]   - Reason for skipping (when status='skipped')
 * @param {string} [params.errorMessage] - Error details (when status='failed')
 * @param {object} [params.summary]      - Comparison summary stats
 * @param {object} [params.recipients]   - { to, cc } email addresses
 * @param {number} [params.processingDurationMs] - How long the comparison took
 */
async function logScraperEmail({
  batchId,
  status,
  skipReason = null,
  errorMessage = null,
  summary = {},
  recipients = {},
  processingDurationMs = null
}) {
  const provider = process.env.SCRAPED_SYSTEM || process.env.PROVIDER_NAME || 'Unknown';

  const sql = `
    INSERT INTO scraper_email_logs (
      batch_id, provider, status, skip_reason, error_message,
      total_orders, active_orders, cancelled_orders,
      matched_count, mismatched_count, missing_count,
      new_in_system_count, excluded_count, resolved_count,
      recipients_to, recipients_cc, processing_duration_ms
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11,
      $12, $13, $14,
      $15, $16, $17
    )
    RETURNING id
  `;

  const params = [
    batchId,
    provider,
    status,
    skipReason,
    errorMessage,
    summary.total_external_orders || summary.total_orders || 0,
    summary.dashboard_active || 0,
    summary.dashboard_cancelled || 0,
    summary.matched_count || 0,
    summary.mismatched_count || 0,
    summary.missing_in_system_count || 0,
    summary.new_in_system_count || 0,
    summary.excluded_count || 0,
    summary.resolved_count || 0,
    recipients.to || null,
    recipients.cc || null,
    processingDurationMs || summary.processing_duration_ms || null
  ];

  try {
    const result = await executeDirectSQL(sql, params);
    if (result.success) {
      console.log(`  [scraper-log] Logged email event: status=${status}, batch=${batchId}`);
    } else {
      console.warn(`  [scraper-log] Failed to log email event: ${result.error}`);
    }
    return result;
  } catch (err) {
    // Don't let logging failures break the main flow
    console.warn(`  [scraper-log] Error logging email event: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { logScraperEmail };
