/**
 * Queue Processor Service
 *
 * Handles background processing of scraped order comparisons.
 * Uses PostgreSQL as a job queue (database queue pattern).
 */

const { executeDirectSQL } = require('../utils/postgresExecutor');
const { compareOrdersWithSystem, revalidateMismatchedOrders, revalidateMissingOrders, fetchDashboardCounts } = require('./orderComparisonService');
const { sendComparisonEmail, shouldHideRevalidatedOrderForFreshMatch } = require('./emailService');
const { storeComparisonResult } = require('./database/comparisonDatabaseService');
const { fetchExclusionPatterns, filterExcludedOrders } = require('./exclusionPatternService');
const { filterAlreadyEmailedOrders, recordEmailedOrders, updateSummaryWithFilteredCounts } = require('./database/emailedOrdersService');
const { validateEmailSendingWindow } = require('./truckTimeService');
const { updateResolvedOrdersInDatabase, attachAfterUpdateValues, insertResolvedMissingOrdersInDatabase } = require('./database/resolvedOrderUpdateService');
const { logScraperEmail } = require('./database/scraperEmailLogService');

// Configuration
const MAX_RETRIES = parseInt(process.env.QUEUE_MAX_RETRIES) || 3;
const COMPARISON_BATCH_SIZE = parseInt(process.env.COMPARISON_BATCH_SIZE) || 50;
const STALE_JOB_TIMEOUT_MS = parseInt(process.env.QUEUE_STALE_TIMEOUT_MS) || 5 * 60 * 1000; // Default: 5 minutes

/**
 * Reset stale jobs that have been stuck in 'processing' status
 *
 * This handles cases where:
 * - Worker crashed/restarted mid-processing
 * - Server was restarted while jobs were being processed
 * - Network issues caused worker to lose connection
 *
 * Jobs stuck for longer than STALE_JOB_TIMEOUT_MS are reset to 'pending'
 * with incremented retry count.
 *
 * @returns {Promise<number>} Number of jobs reset
 */
async function resetStaleJobs() {
  const staleTimeoutMinutes = Math.floor(STALE_JOB_TIMEOUT_MS / 60000);

  const sql = `
    UPDATE scraped_order_imports
    SET
      processing_status = CASE
        WHEN retry_count >= $1 THEN 'failed'
        ELSE 'pending'
      END,
      processing_started_at = NULL,
      processing_error = CASE
        WHEN retry_count >= $1 THEN 'Job abandoned after maximum retries (worker crash/restart)'
        ELSE 'Job reset due to stale processing (worker crash/restart)'
      END,
      retry_count = retry_count + 1
    WHERE processing_status = 'processing'
      AND processing_started_at < NOW() - INTERVAL '${staleTimeoutMinutes} minutes'
    RETURNING batch_id, retry_count
  `;

  try {
    const result = await executeDirectSQL(sql, [MAX_RETRIES]);

    if (!result.success) {
      console.error(`Failed to reset stale jobs: ${result.error}`);
      return 0;
    }

    const resetCount = result.data?.length || 0;

    if (resetCount > 0) {
      console.log(`Reset ${resetCount} stale job(s) that were stuck in 'processing' status`);
    }

    return resetCount;
  } catch (error) {
    console.error('Error resetting stale jobs:', error.message);
    return 0;
  }
}

/**
 * Fetch pending jobs from the database
 *
 * @param {number} limit - Maximum number of jobs to fetch
 * @returns {Promise<array>} Array of pending job records
 */
async function fetchPendingJobs(limit = 5) {
  const sql = `
    SELECT
      id,
      batch_id,
      file_url,
      file_path,
      orders_count,
      scraper_id,
      retry_count,
      email_sent_at,
      created_at
    FROM scraped_order_imports
    WHERE processing_status = 'pending'
    ORDER BY created_at ASC
    LIMIT $1
  `;

  const result = await executeDirectSQL(sql, [limit]);

  if (!result.success) {
    throw new Error(`Failed to fetch pending jobs: ${result.error}`);
  }

  return result.data || [];
}

/**
 * Lock a job for processing (set status to 'processing')
 * Uses optimistic locking to prevent duplicate processing
 *
 * @param {string} batchId - Batch ID to lock
 * @returns {Promise<boolean>} True if job was locked successfully
 */
async function lockJob(batchId) {
  const sql = `
    UPDATE scraped_order_imports
    SET
      processing_status = 'processing',
      processing_started_at = NOW()
    WHERE batch_id = $1
      AND processing_status = 'pending'
    RETURNING id
  `;

  const result = await executeDirectSQL(sql, [batchId]);

  if (!result.success) {
    throw new Error(`Failed to lock job: ${result.error}`);
  }

  // If no rows were updated, another worker already grabbed this job
  return result.data && result.data.length > 0;
}

/**
 * Mark a job as completed
 *
 * @param {string} batchId - Batch ID to mark complete
 * @param {object} summary - Comparison summary to store
 */
async function markComplete(batchId, summary) {
  const sql = `
    UPDATE scraped_order_imports
    SET
      processing_status = 'completed',
      processing_completed_at = NOW(),
      processing_error = NULL
    WHERE batch_id = $1
  `;

  const result = await executeDirectSQL(sql, [batchId]);

  if (!result.success) {
    console.error(`Failed to mark job complete: ${result.error}`);
  }
}

/**
 * Mark email as sent for a job
 * This prevents duplicate emails on job retry/reprocessing
 *
 * @param {string} batchId - Batch ID to mark email sent
 */
async function markEmailSent(batchId) {
  const sql = `
    UPDATE scraped_order_imports
    SET email_sent_at = NOW()
    WHERE batch_id = $1
  `;

  const result = await executeDirectSQL(sql, [batchId]);

  if (!result.success) {
    console.error(`Failed to mark email sent: ${result.error}`);
  }
}

/**
 * Mark email as skipped for a job (due to time window validation)
 * Records the skip reason for debugging and audit purposes
 *
 * @param {string} batchId - Batch ID to mark email skipped
 * @param {string} reason - Reason why email was skipped
 * @param {object} validationDetails - Detailed validation result
 */
async function markEmailSkipped(batchId, reason, validationDetails = null) {
  const sql = `
    UPDATE scraped_order_imports
    SET
      email_skipped_at = NOW(),
      email_skip_reason = $2,
      truck_time_validation = $3
    WHERE batch_id = $1
  `;

  const result = await executeDirectSQL(sql, [
    batchId,
    reason,
    validationDetails ? JSON.stringify(validationDetails) : null
  ]);

  if (!result.success) {
    console.error(`Failed to mark email skipped: ${result.error}`);
  }
}

/**
 * Mark a job as failed or retry
 *
 * @param {string} batchId - Batch ID that failed
 * @param {string} error - Error message
 * @param {number} currentRetryCount - Current retry count
 */
async function markFailed(batchId, error, currentRetryCount) {
  if (currentRetryCount < MAX_RETRIES - 1) {
    // Retry: reset to pending with incremented retry count
    const sql = `
      UPDATE scraped_order_imports
      SET
        processing_status = 'pending',
        processing_started_at = NULL,
        processing_error = $2,
        retry_count = $3
      WHERE batch_id = $1
    `;

    const result = await executeDirectSQL(sql, [batchId, error, currentRetryCount + 1]);

    if (!result.success) {
      console.error(`Failed to reset job for retry: ${result.error}`);
    } else {
      console.log(`Job ${batchId} will be retried (attempt ${currentRetryCount + 2}/${MAX_RETRIES})`);
    }
  } else {
    // Max retries reached: mark as permanently failed
    const sql = `
      UPDATE scraped_order_imports
      SET
        processing_status = 'failed',
        processing_completed_at = NOW(),
        processing_error = $2,
        retry_count = $3
      WHERE batch_id = $1
    `;

    const result = await executeDirectSQL(sql, [batchId, error, currentRetryCount + 1]);

    if (!result.success) {
      console.error(`Failed to mark job as failed: ${result.error}`);
    } else {
      console.log(`Job ${batchId} permanently failed after ${MAX_RETRIES} attempts`);
    }
  }
}

/**
 * Fetch orders from Supabase Storage
 *
 * @param {string} fileUrl - URL to the stored orders JSON file
 * @returns {Promise<array>} Array of orders
 */
async function fetchOrdersFromStorage(fileUrl) {
  const response = await fetch(fileUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch orders from storage: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.orders || [];
}

/**
 * Process orders in batches with aggregated results
 *
 * @param {array} orders - All orders to process
 * @param {string} batchId - Main batch ID
 * @param {string} fileUrl - Storage file URL
 * @param {number} startTime - Processing start timestamp
 * @param {number} batchSize - Orders per batch
 * @returns {Promise<object>} Aggregated comparison results
 */
async function processOrdersInBatches(orders, batchId, fileUrl, startTime, batchSize) {
  const totalBatches = Math.ceil(orders.length / batchSize);

  // Aggregated results
  const allResults = {
    matched_orders: [],
    mismatched_orders: [],
    missing_in_system_orders: [],
    new_in_system_orders: []
  };

  let totalNew = 0;
  const partialFailures = [];
  // Dedup sets for all categories - the scraper sends one row per product,
  // so the same order_code + order_date can appear across batches when
  // multi-product orders are split. Without dedup, the same order would
  // appear multiple times in the email.
  const seenMatchedOrders = new Set();
  const seenMismatchedOrders = new Set();
  const seenMissingOrders = new Set();
  const seenNewOrders = new Set();
  const seenExcludedOrders = new Set();

  for (let i = 0; i < orders.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    const batch = orders.slice(i, i + batchSize);

    try {
      const result = await compareOrdersWithSystem({
        sanitizedOrders: batch,
        batchId: `${batchId}_batch${batchNum}`,
        fileUrl,
        processingStartTime: startTime
      });

      // Aggregate results with deduplication by order_code + order_date
      for (const order of (result.fullResult.matched_orders || [])) {
        const key = `${order.order_code}_${order.order_date}`;
        if (!seenMatchedOrders.has(key)) {
          seenMatchedOrders.add(key);
          allResults.matched_orders.push(order);
        }
      }
      for (const order of (result.fullResult.mismatched_orders || [])) {
        const key = `${order.order_code}_${order.order_date}`;
        if (!seenMismatchedOrders.has(key)) {
          seenMismatchedOrders.add(key);
          allResults.mismatched_orders.push(order);
        }
      }
      for (const order of (result.fullResult.missing_in_system_orders || [])) {
        const key = `${order.order_code}_${order.order_date}`;
        if (!seenMissingOrders.has(key)) {
          seenMissingOrders.add(key);
          allResults.missing_in_system_orders.push(order);
        }
      }
      for (const order of (result.fullResult.excluded_no_cy_mix_orders || [])) {
        const key = `${order.order_code}_${order.order_date}`;
        if (!seenExcludedOrders.has(key)) {
          seenExcludedOrders.add(key);
          if (!allResults.excluded_no_cy_mix_orders) allResults.excluded_no_cy_mix_orders = [];
          allResults.excluded_no_cy_mix_orders.push(order);
        }
      }

      // Deduplicate new_in_system_orders
      for (const newOrder of (result.fullResult.new_in_system_orders || [])) {
        const key = `${newOrder.order_code}_${newOrder.order_date}`;
        if (!seenNewOrders.has(key)) {
          seenNewOrders.add(key);
          allResults.new_in_system_orders.push(newOrder);
        }
      }

      totalNew = allResults.new_in_system_orders.length;

    } catch (error) {
      console.error(`  Batch ${batchNum} failed:`, error.message);
      partialFailures.push({
        batch: batchNum,
        startIndex: i,
        endIndex: Math.min(i + batchSize, orders.length),
        orderCount: batch.length,
        error: error.message
      });
    }
  }

  // Count unique orders (by order_code + order_date) instead of total product lines,
  // because the scraper sends one row per product so multi-product orders create duplicates
  const uniqueOrders = new Set();
  for (const order of orders) {
    uniqueOrders.add(`${(order.order_code || '').toString().trim().toUpperCase()}_${order.order_date || ''}`);
  }
  const totalExternal = uniqueOrders.size;
  // Use deduplicated array lengths for accurate counts
  const totalMatched = allResults.matched_orders.length;
  const totalMismatched = allResults.mismatched_orders.length;
  const totalMissing = allResults.missing_in_system_orders.length;
  const totalExcludedNoCyMix = (allResults.excluded_no_cy_mix_orders || []).length;
  const matchPercentage = totalExternal > 0 ? ((totalMatched / totalExternal) * 100).toFixed(2) : '0.00';
  const mismatchPercentage = totalExternal > 0 ? ((totalMismatched / totalExternal) * 100).toFixed(2) : '0.00';

  const processingDuration = Date.now() - startTime;

  return {
    summary: {
      batch_id: batchId,
      file_url: fileUrl,
      total_external_orders: totalExternal,
      totalExternalOrders: totalExternal,
      total_system_orders: totalMatched + totalMismatched + totalNew,
      totalSystemOrders: totalMatched + totalMismatched + totalNew,
      matched_count: totalMatched,
      matchedCount: totalMatched,
      matched_percentage: parseFloat(matchPercentage),
      matchedPercentage: parseFloat(matchPercentage),
      mismatched_count: totalMismatched,
      mismatchedCount: totalMismatched,
      mismatched_percentage: parseFloat(mismatchPercentage),
      mismatchedPercentage: parseFloat(mismatchPercentage),
      missing_in_system_count: totalMissing,
      missingInSystemCount: totalMissing,
      no_cy_mix_excluded_count: totalExcludedNoCyMix,
      noCyMixExcludedCount: totalExcludedNoCyMix,
      new_in_system_count: totalNew,
      newInSystemCount: totalNew,
      processing_duration_ms: processingDuration,
      comparison_timestamp: new Date().toISOString(),
      batches_processed: totalBatches,
      batches_failed: partialFailures.length
    },
    fullResult: allResults,
    partialFailures
  };
}

/**
 * Process a single job
 *
 * @param {object} job - Job record from database
 * @returns {Promise<object>} Processing result
 */
async function processJob(job) {
  const startTime = Date.now();
  const { batch_id, file_url, orders_count, retry_count, email_sent_at } = job;

  console.log(`\nProcessing job: ${batch_id} (${orders_count} orders, attempt ${retry_count + 1}/${MAX_RETRIES})`);

  try {
    // Step 1: Lock the job
    const locked = await lockJob(batch_id);
    if (!locked) {
      console.log(`Job ${batch_id} already locked by another worker`);
      return { skipped: true };
    }

    // Step 2: Fetch orders from storage
    const orders = await fetchOrdersFromStorage(file_url);

    if (!orders || orders.length === 0) {
      throw new Error('No orders found in storage file');
    }

    // Step 3: Run comparison
    let comparisonResult;

    if (orders.length > COMPARISON_BATCH_SIZE) {
      comparisonResult = await processOrdersInBatches(
        orders,
        batch_id,
        file_url,
        startTime,
        COMPARISON_BATCH_SIZE
      );
    } else {
      comparisonResult = await compareOrdersWithSystem({
        sanitizedOrders: orders,
        batchId: batch_id,
        fileUrl: file_url,
        processingStartTime: startTime
      });
    }

    // Step 3.5: Fetch dashboard counts (matches web app's Total/Active/Cancelled)
    try {
      // Extract date range from orders
      const orderDates = orders
        .map(o => o.order_date)
        .filter(Boolean)
        .map(d => {
          const date = new Date(d);
          if (isNaN(date.getTime())) return d;
          return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
        })
        .sort();
      const minDate = orderDates[0];
      const maxDate = orderDates[orderDates.length - 1];

      if (minDate && maxDate) {
        const dashboardCounts = await fetchDashboardCounts(minDate, maxDate);
        comparisonResult.summary.dashboard_total = dashboardCounts.dashboard_total;
        comparisonResult.summary.dashboard_active = dashboardCounts.dashboard_active;
        comparisonResult.summary.dashboard_cancelled = dashboardCounts.dashboard_cancelled;
        console.log(`Dashboard counts: Total=${dashboardCounts.dashboard_total}, Active=${dashboardCounts.dashboard_active}, Cancelled=${dashboardCounts.dashboard_cancelled}`);
      }
    } catch (dashboardError) {
      console.error(`  Failed to fetch dashboard counts: ${dashboardError.message}`);
      // Continue - dashboard counts are optional, email will fall back to existing layout
    }

    // Step 4: Store comparison result
    try {
      await storeComparisonResult(
        batch_id,
        comparisonResult.summary,
        comparisonResult.fullResult
      );
    } catch (storeError) {
      console.error(`  Failed to store comparison result: ${storeError.message}`);
      // Continue - storage failure should not fail the job
    }

    // Step 5: Fetch exclusion patterns and filter results before email
    let emailComparisonResult = comparisonResult;
    try {
      const exclusionPatterns = await fetchExclusionPatterns();
      if (exclusionPatterns.length > 0) {
        const { filteredResult, excludedCount } = filterExcludedOrders(comparisonResult, exclusionPatterns);
        emailComparisonResult = filteredResult;
      } else {
        // Even without pattern-based exclusions, include no-CY-mix exclusions in excluded_count
        const noCyMixExcluded = comparisonResult.summary.no_cy_mix_excluded_count || 0;
        if (noCyMixExcluded > 0) {
          emailComparisonResult = {
            summary: {
              ...comparisonResult.summary,
              excluded_count: noCyMixExcluded,
              excludedCount: noCyMixExcluded
            },
            fullResult: comparisonResult.fullResult
          };
        }
      }
    } catch (filterError) {
      console.error(`  Failed to filter exclusions: ${filterError.message}`);
      // Continue with unfiltered results
    }

    // Step 5.5: Filter out already-emailed orders (order-level deduplication)
    let shouldSendEmail = true;
    try {
      const { filteredResult, filteredCount, newOrdersCount } = await filterAlreadyEmailedOrders(emailComparisonResult.fullResult);

      // Always update with filtered data so log counts match actual state
      emailComparisonResult = {
        summary: updateSummaryWithFilteredCounts(emailComparisonResult.summary, filteredResult),
        fullResult: filteredResult
      };

      if (newOrdersCount === 0) {
        console.log(`No new orders to email - skipping notification`);
        shouldSendEmail = false;
      }
    } catch (dedupeError) {
      console.error(`  Failed to filter already-emailed orders: ${dedupeError.message}`);
      // Continue with unfiltered results to avoid blocking emails on deduplication errors
    }

    // Step 5.6: Re-validate ONLY the filtered mismatched orders via Command Cloud API
    let revalidationResults = null;
    const filteredMismatched = emailComparisonResult.fullResult?.mismatched_orders || [];
    console.log(`📋 Mismatched orders for re-validation: ${filteredMismatched.length} (after exclusion + dedup filtering)`);
    if (filteredMismatched.length > 0 && shouldSendEmail) {
      try {
        revalidationResults = await revalidateMismatchedOrders(filteredMismatched);
        console.log(`🔄 Re-validation: ${revalidationResults.confirmed_count} confirmed, ${revalidationResults.resolved_count} resolved`);

        // If all mismatches resolved after re-validation, check if there are still missing orders to report
        if (revalidationResults.confirmed_count === 0) {
          const missingCount = emailComparisonResult.fullResult?.missing_in_system_orders?.length || 0;
          if (missingCount > 0) {
            console.log(`All ${revalidationResults.resolved_count} mismatched order(s) resolved after re-validation, but ${missingCount} missing order(s) still need reporting`);
          } else {
            console.log(`All ${revalidationResults.resolved_count} mismatched order(s) resolved after re-validation and no missing orders - skipping email`);
            shouldSendEmail = false;
          }
        }
      } catch (revalError) {
        console.error(`  Failed to re-validate mismatched orders: ${revalError.message}`);
        // Continue - re-validation failure should not fail the job
      }
    }

    // Step 5.6.1: Update ALL revalidated orders in Truckast DB with fresh API values
    // Runs for both resolved AND confirmed orders so the DB always reflects the latest API data
    if (revalidationResults && revalidationResults.revalidated_count > 0) {
      try {
        const updateSummary = await updateResolvedOrdersInDatabase(revalidationResults);
        console.log(`📝 Revalidated DB updates: ${updateSummary.orders_updated} orders, ${updateSummary.products_updated} products, ${updateSummary.schedules_updated} schedules`);
      } catch (updateError) {
        console.error(`  Failed to update revalidated orders in DB: ${updateError.message}`);
        // Continue - DB update failure should not fail the job
      }
    }

    // Step 5.6.2: Re-fetch ALL revalidated orders from DB after update to get "After Truckast Updated" values
    // This runs AFTER the DB update so confirmed/mismatched orders show the latest Truckast DB state in the email
    if (revalidationResults && revalidationResults.orders && revalidationResults.orders.length > 0) {
      try {
        await attachAfterUpdateValues(revalidationResults);
        console.log(`📋 After-update values attached to revalidated orders for email display`);
      } catch (refetchError) {
        console.error(`  Failed to attach after-update values: ${refetchError.message}`);
        // Continue - this is non-fatal, email will just not show the 4th line
      }
    }

    // Step 5.6.3: Re-validate MISSING orders via Command Cloud API
    // If found in API, insert into Truckast DB and mark as resolved
    let missingRevalidationResults = null;
    const filteredMissing = emailComparisonResult.fullResult?.missing_in_system_orders || [];
    console.log(`📋 Missing orders for re-validation: ${filteredMissing.length} (after exclusion + dedup filtering)`);
    if (filteredMissing.length > 0 && shouldSendEmail) {
      try {
        missingRevalidationResults = await revalidateMissingOrders(filteredMissing);
        console.log(`🔄 Missing re-validation: ${missingRevalidationResults.resolved_count} resolved, ${missingRevalidationResults.still_missing_count} still missing`);
      } catch (revalError) {
        console.error(`  Failed to re-validate missing orders: ${revalError.message}`);
        // Continue - re-validation failure should not fail the job
      }
    }

    // Step 5.6.4: Insert resolved missing orders into Truckast DB
    if (missingRevalidationResults && missingRevalidationResults.resolved_count > 0) {
      try {
        const insertSummary = await insertResolvedMissingOrdersInDatabase(missingRevalidationResults);
        console.log(`📝 Missing order DB inserts: ${insertSummary.orders_inserted} orders, ${insertSummary.products_inserted} products, ${insertSummary.schedules_inserted} schedules`);
      } catch (insertError) {
        console.error(`  Failed to insert resolved missing orders: ${insertError.message}`);
        // Continue - DB insert failure should not fail the job
      }
    }

    // Step 5.6.5: Remove resolved missing orders from the missing list and update counts
    if (missingRevalidationResults && missingRevalidationResults.resolved_count > 0) {
      const stillMissingCodes = new Set(
        missingRevalidationResults.orders
          .filter(o => o.revalidation_status === 'still_missing')
          .map(o => `${o.order_code}_${o.order_date}`)
      );

      // Filter missing_in_system_orders to only keep still-missing ones
      emailComparisonResult.fullResult.missing_in_system_orders =
        emailComparisonResult.fullResult.missing_in_system_orders.filter(o => {
          const ext = o.external_order || o.externalOrder || {};
          const key = `${ext.order_code}_${ext.order_date}`;
          return stillMissingCodes.has(key);
        });

      // Update summary counts
      emailComparisonResult.summary.missing_in_system_count =
        emailComparisonResult.fullResult.missing_in_system_orders.length;
      emailComparisonResult.summary.missingInSystemCount =
        emailComparisonResult.fullResult.missing_in_system_orders.length;

      console.log(`📋 After missing re-validation: ${emailComparisonResult.fullResult.missing_in_system_orders.length} missing orders remain`);
    }

    // Step 5.6.6: Skip email if there are no issues (0 visible mismatched + 0 missing in system)
    // IMPORTANT: Use the same hide filter as the email display — count only orders
    // that have visible differences (Command Cloud !== API). Without this, the email
    // would be sent showing Mismatched=0 when all mismatches are hidden by the filter.
    if (shouldSendEmail) {
      let finalMismatchedCount;
      if (revalidationResults && revalidationResults.orders && revalidationResults.orders.length > 0) {
        const visibleConfirmed = revalidationResults.orders.filter(
          o => o.order_status === 'confirmed' && !shouldHideRevalidatedOrderForFreshMatch(o)
        );
        finalMismatchedCount = visibleConfirmed.length;
      } else {
        finalMismatchedCount = emailComparisonResult.fullResult?.mismatched_orders?.length || 0;
      }
      const finalMissingCount = emailComparisonResult.fullResult?.missing_in_system_orders?.length || 0;

      if (finalMismatchedCount === 0 && finalMissingCount === 0) {
        console.log(`No issues to report (visible mismatched: ${finalMismatchedCount}, missing: ${finalMissingCount}) - skipping email`);
        shouldSendEmail = false;
      }
    }

    // Step 5.7: Validate email sending time window (truck times + date check)
    let emailSkipReason = null;
    if (shouldSendEmail) {
      try {
        // Extract order date from the first order in the batch
        const orderDate = orders[0]?.order_date || null;

        if (!orderDate) {
          console.log(`No order date found in batch - skipping time window validation`);
        } else {
          const emailValidation = await validateEmailSendingWindow({
            orderDate: orderDate,
            currentTime: new Date()
          });

          if (!emailValidation.shouldSendEmail) {
            console.log(`Email skipped for batch ${batch_id}: ${emailValidation.reason}`);
            shouldSendEmail = false;
            emailSkipReason = emailValidation.reason;

            // Record the skip reason and validation details
            await markEmailSkipped(batch_id, emailValidation.reason, emailValidation.details);
          } else {
            console.log(`Email validation passed: ${emailValidation.reason}`);
          }
        }
      } catch (validationError) {
        console.error(`  Failed to validate email time window: ${validationError.message}`);
        // Fail closed - don't send email if validation fails
        shouldSendEmail = false;
        emailSkipReason = `Validation error: ${validationError.message}`;
        await markEmailSkipped(batch_id, emailSkipReason, { error: validationError.message });
      }
    }

    // Step 6: Send email notification (only if not already sent and has new orders)
    let emailLogStatus = null;
    let emailLogSkipReason = null;
    let emailLogErrorMessage = null;

    if (email_sent_at) {
      console.log(`Email already sent - skipping`);
    } else if (!shouldSendEmail) {
      emailLogStatus = 'skipped';
      emailLogSkipReason = emailSkipReason || 'No issues to report';
    } else {
      try {
        await sendComparisonEmail(emailComparisonResult.summary, emailComparisonResult.fullResult, revalidationResults, missingRevalidationResults);
        await markEmailSent(batch_id);  // Mark email as sent IMMEDIATELY after success
        console.log(`Email sent successfully`);
        emailLogStatus = 'sent';

        // Step 6.5: Record which orders were emailed (for future deduplication)
        try {
          await recordEmailedOrders(batch_id, emailComparisonResult.fullResult);
        } catch (recordError) {
          console.error(`  Failed to record emailed orders: ${recordError.message}`);
          // Don't fail the job - recording is for future deduplication only
        }
      } catch (emailError) {
        console.error(`  Failed to send email: ${emailError.message}`);
        emailLogStatus = 'failed';
        emailLogErrorMessage = emailError.message;
        // Continue - email failure should not fail the job
      }
    }

    // Step 7: Mark job as complete
    await markComplete(batch_id, comparisonResult.summary);

    // Step 8: Log to scraper_email_logs (LAST step — captures final state matching email display)
    if (emailLogStatus) {
      const logSummary = emailComparisonResult.summary;

      // Mismatched: same visible count the email uses (after re-validation + hide filter)
      const logMismatchedCount = (() => {
        if (revalidationResults && revalidationResults.orders && revalidationResults.orders.length > 0) {
          const visibleConfirmed = revalidationResults.orders.filter(
            o => o.order_status === 'confirmed' && !shouldHideRevalidatedOrderForFreshMatch(o)
          );
          return visibleConfirmed.length;
        }
        return emailComparisonResult.fullResult?.mismatched_orders?.length || 0;
      })();

      // Missing: array length after re-validation filtering (step 5.6.5)
      const logMissingCount = emailComparisonResult.fullResult?.missing_in_system_orders?.length || 0;

      // Resolved: mismatched resolved + missing resolved
      const logResolvedCount = (revalidationResults?.resolved_count || 0) + (missingRevalidationResults?.resolved_count || 0);

      // New in system
      const logNewCount = emailComparisonResult.fullResult?.new_in_system_orders?.length || 0;

      // Excluded: use summary excluded_count (includes both pattern-based + no-CY-mix exclusions)
      const logExcludedCount = logSummary.excluded_count || logSummary.excludedCount || 0;

      // Dashboard counts (same as email)
      const hasDashboard = logSummary.dashboard_total != null;
      const logTotalOrders = hasDashboard ? logSummary.dashboard_total : (logSummary.total_external_orders || 0);
      const logActiveOrders = hasDashboard ? (logSummary.dashboard_active || 0) : 0;
      const logCancelledOrders = hasDashboard ? (logSummary.dashboard_cancelled || 0) : 0;

      // Matched = Active - Mismatched - Missing - New - Excluded - Resolved (same formula as email)
      let logMatchedCount = logSummary.matched_count || 0;
      if (hasDashboard) {
        const activeCount = logActiveOrders || (logTotalOrders - logCancelledOrders);
        logMatchedCount = Math.max(0, activeCount - logMismatchedCount - logMissingCount - logNewCount - logExcludedCount - logResolvedCount);
      }

      const emailLogSummary = {
        total_external_orders: logTotalOrders,
        dashboard_active: logActiveOrders,
        dashboard_cancelled: logCancelledOrders,
        matched_count: logMatchedCount,
        mismatched_count: logMismatchedCount,
        missing_in_system_count: logMissingCount,
        new_in_system_count: logNewCount,
        excluded_count: logExcludedCount,
        resolved_count: logResolvedCount,
        processing_duration_ms: logSummary.processing_duration_ms
      };

      // Build skip message using the same computed counts
      if (emailLogStatus === 'skipped' && !emailSkipReason) {
        emailLogSkipReason = `No issues to report (${logMismatchedCount} mismatched, ${logMissingCount} missing)`;
      }

      await logScraperEmail({
        batchId: batch_id,
        status: emailLogStatus,
        skipReason: emailLogSkipReason,
        errorMessage: emailLogErrorMessage,
        summary: emailLogSummary,
        recipients: {
          to: process.env.SMTP_TO || null,
          cc: process.env.SMTP_CC || null
        }
      });
    }

    const duration = Date.now() - startTime;
    console.log(`Job ${batch_id} completed successfully in ${duration}ms`);

    return {
      success: true,
      batch_id,
      duration,
      summary: comparisonResult.summary
    };

  } catch (error) {
    console.error(`Job ${batch_id} failed:`, error.message);
    await markFailed(batch_id, error.message, retry_count);

    return {
      success: false,
      batch_id,
      error: error.message
    };
  }
}

/**
 * Process all pending jobs (single pass)
 *
 * @param {number} limit - Maximum jobs to process
 * @returns {Promise<object>} Processing summary
 */
async function processPendingJobs(limit = 10) {
  // First, reset any stale jobs that were stuck in 'processing'
  // This handles crash recovery and stuck jobs
  await resetStaleJobs();

  const jobs = await fetchPendingJobs(limit);

  if (jobs.length === 0) {
    console.log('No pending jobs found');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  console.log(`Found ${jobs.length} pending job(s)`);

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const job of jobs) {
    const result = await processJob(job);

    if (result.skipped) {
      skipped++;
    } else if (result.success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  console.log(`\nQueue processing complete: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`);

  return {
    processed: jobs.length,
    succeeded,
    failed,
    skipped
  };
}

/**
 * Start the worker loop (for standalone worker)
 *
 * @param {number} intervalMs - Polling interval in milliseconds
 * @returns {function} Stop function to terminate the loop
 */
function runWorkerLoop(intervalMs = 10000) {
  let running = true;
  let timeoutId = null;

  async function poll() {
    if (!running) return;

    try {
      await processPendingJobs(5);
    } catch (error) {
      console.error('Worker loop error:', error.message);
    }

    if (running) {
      timeoutId = setTimeout(poll, intervalMs);
    }
  }

  console.log(`\nQueue Worker started (polling every ${intervalMs}ms)`);
  console.log('Press Ctrl+C to stop\n');

  // Start first poll immediately
  poll();

  // Return stop function
  return function stop() {
    running = false;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    console.log('\nQueue Worker stopped');
  };
}

/**
 * Get queue statistics
 *
 * @returns {Promise<object>} Queue stats
 */
async function getQueueStats() {
  const sql = `
    SELECT
      processing_status,
      COUNT(*) as count
    FROM scraped_order_imports
    GROUP BY processing_status
  `;

  const result = await executeDirectSQL(sql, []);

  if (!result.success) {
    throw new Error(`Failed to get queue stats: ${result.error}`);
  }

  const stats = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0
  };

  for (const row of (result.data || [])) {
    if (stats.hasOwnProperty(row.processing_status)) {
      stats[row.processing_status] = parseInt(row.count);
    }
  }

  return stats;
}

/**
 * Get job status by batch ID
 *
 * @param {string} batchId - Batch ID to check
 * @returns {Promise<object>} Job status
 */
async function getJobStatus(batchId) {
  const sql = `
    SELECT
      batch_id,
      processing_status,
      processing_started_at,
      processing_completed_at,
      processing_error,
      retry_count,
      orders_count,
      created_at
    FROM scraped_order_imports
    WHERE batch_id = $1
  `;

  const result = await executeDirectSQL(sql, [batchId]);

  if (!result.success) {
    throw new Error(`Failed to get job status: ${result.error}`);
  }

  if (!result.data || result.data.length === 0) {
    return null;
  }

  return result.data[0];
}

module.exports = {
  resetStaleJobs,
  fetchPendingJobs,
  lockJob,
  markComplete,
  markEmailSent,
  markEmailSkipped,
  markFailed,
  processJob,
  processPendingJobs,
  runWorkerLoop,
  getQueueStats,
  getJobStatus
};
