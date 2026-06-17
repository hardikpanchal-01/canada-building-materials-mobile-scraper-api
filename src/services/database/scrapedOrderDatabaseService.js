/**
 * Scraped Order Database Service
 *
 * Handles storage and database operations for scraped orders.
 * - Uploads validated orders to Supabase Storage
 * - Creates tracking records in PostgreSQL
 */

const crypto = require('crypto');
const { uploadToStorage } = require('./supabaseClient');
const { executeDirectSQL } = require('../../utils/postgresExecutor');

/**
 * Generate a unique batch ID using Node.js crypto
 *
 * @returns {string} UUID v4 batch identifier
 */
function generateBatchId() {
  return crypto.randomUUID();
}

/**
 * Generate filename for storage
 *
 * @returns {string} Unique filename with timestamp
 */
function generateFileName() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const timestamp = Date.now();
  return `scraped_orders_${dateStr}_${timestamp}.json`;
}

/**
 * Store scraped orders and create tracking record
 *
 * @param {object} params - Storage parameters
 * @param {array} params.orders - Validated and sanitized orders
 * @param {object} params.validationSummary - Validation statistics
 * @param {string} [params.scraperId] - Identifier for the scraper source
 * @param {string} [params.sourceUrl] - URL where orders were scraped from
 * @param {object} [params.scraperMetadata] - Additional scraper metadata
 * @returns {Promise<object>} Storage result with batch_id, file_url, etc.
 */
async function storeScrapedOrders({
  orders,
  validationSummary,
  scraperId = 'default-scraper',
  sourceUrl = null,
  scraperMetadata = null
}) {
  const batchId = generateBatchId();
  const fileName = generateFileName();
  const scrapeTimestamp = new Date().toISOString();

  console.log(`Storing ${orders.length} orders with batch_id: ${batchId}`);

  // Prepare the data package for storage
  const storageData = {
    batch_id: batchId,
    scraper_id: scraperId,
    scrape_timestamp: scrapeTimestamp,
    orders_count: orders.length,
    validation_summary: validationSummary,
    orders: orders
  };

  // Step 1: Upload to Supabase Storage
  let filePath, fileUrl;
  try {
    const uploadResult = await uploadToStorage(fileName, storageData);
    filePath = uploadResult.path;
    fileUrl = uploadResult.publicUrl;
    console.log(`Orders uploaded to storage: ${filePath}`);
  } catch (error) {
    console.error('Storage upload failed:', error);
    throw {
      code: 'STORAGE_ERROR',
      message: 'Failed to upload orders to storage',
      details: error.message
    };
  }

  // Calculate file size (approximate)
  const fileSize = Buffer.byteLength(JSON.stringify(storageData), 'utf-8');

  // Step 2: Create tracking record in PostgreSQL (if DATABASE_URL is configured)
  let recordId = null;
  if (process.env.DATABASE_URL) {
    const insertSQL = `
      INSERT INTO scraped_order_imports (
        batch_id,
        scraper_id,
        file_path,
        file_url,
        file_size,
        source_url,
        scrape_timestamp,
        status,
        orders_count,
        validation_summary,
        scraper_metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, batch_id, created_at
    `;

    const params = [
      batchId,
      scraperId,
      filePath,
      fileUrl,
      fileSize,
      sourceUrl,
      scrapeTimestamp,
      'validated', // Initial status
      orders.length,
      JSON.stringify(validationSummary),
      scraperMetadata ? JSON.stringify(scraperMetadata) : null
    ];

    try {
      const result = await executeDirectSQL(insertSQL, params);

      if (!result.success || !result.data || result.data.length === 0) {
        throw new Error('Insert returned no data');
      }

      recordId = result.data[0].id;
      console.log(`Tracking record created with id: ${recordId}`);
    } catch (error) {
      console.error('Database insert failed:', error);
      // Note: Storage upload already succeeded, so we have orphaned data
      // In production, you might want to implement cleanup or retry logic
      // For now, we'll continue without database record
      console.warn('⚠️  Continuing without database record');
    }
  } else {
    console.log('⚠️  DATABASE_URL not configured - skipping database record creation');
  }

  // Return success response
  return {
    batch_id: batchId,
    file_url: fileUrl,
    file_path: filePath,
    record_id: recordId,
    orders_count: orders.length,
    validation_summary: validationSummary
  };
}

module.exports = {
  storeScrapedOrders
};


