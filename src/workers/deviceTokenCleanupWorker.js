#!/usr/bin/env node

/**
 * Device Token Cleanup Worker
 *
 * Periodically cleans up inactive device tokens older than the configured threshold.
 * This worker can be run as a standalone process or scheduled via cron.
 *
 * Usage:
 *   node src/workers/deviceTokenCleanupWorker.js
 *
 * Environment Variables:
 *   TOKEN_CLEANUP_DAYS - Days of inactivity before cleanup (default: 90)
 *   CLEANUP_INTERVAL_MS - Interval between cleanup runs in ms (default: 24 hours)
 *   RUN_ONCE - If set to 'true', run once and exit (for cron jobs)
 */

require('dotenv').config();

const deviceService = require('../services/deviceService');

const TOKEN_CLEANUP_DAYS = parseInt(process.env.TOKEN_CLEANUP_DAYS) || 90;
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS) || 24 * 60 * 60 * 1000; // 24 hours
const RUN_ONCE = process.env.RUN_ONCE === 'true';

/**
 * Run cleanup process
 */
async function runCleanup() {
  const startTime = Date.now();
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`🧹 DEVICE TOKEN CLEANUP [${new Date().toISOString()}]`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`📅 Cleanup threshold: ${TOKEN_CLEANUP_DAYS} days`);
  
  try {
    const deletedCount = await deviceService.cleanupInactiveTokens(TOKEN_CLEANUP_DAYS);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Cleanup completed in ${duration}s`);
    console.log(`📊 Deleted ${deletedCount} inactive token(s)`);
    console.log('═══════════════════════════════════════════════════════\n');
    
    return {
      success: true,
      deletedCount,
      duration: parseFloat(duration)
    };
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`❌ Cleanup failed after ${duration}s:`, error.message);
    console.log('═══════════════════════════════════════════════════════\n');
    
    return {
      success: false,
      error: error.message,
      duration: parseFloat(duration)
    };
  }
}

/**
 * Start worker loop
 */
async function startWorker() {
  console.log('🚀 Device Token Cleanup Worker started');
  console.log(`⏰ Cleanup interval: ${CLEANUP_INTERVAL_MS / 1000 / 60} minutes`);
  console.log(`📅 Cleanup threshold: ${TOKEN_CLEANUP_DAYS} days`);
  console.log(`🔄 Run once: ${RUN_ONCE ? 'Yes' : 'No'}\n`);

  // Run immediately on start
  await runCleanup();

  if (RUN_ONCE) {
    console.log('✅ Run once mode: Exiting');
    process.exit(0);
  }

  // Schedule periodic cleanup
  setInterval(async () => {
    await runCleanup();
  }, CLEANUP_INTERVAL_MS);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n⚠️  Received SIGINT, shutting down gracefully...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n⚠️  Received SIGTERM, shutting down gracefully...');
    process.exit(0);
  });
}

// Start worker if run directly
if (require.main === module) {
  startWorker().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  runCleanup,
  startWorker
};
