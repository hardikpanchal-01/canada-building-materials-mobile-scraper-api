#!/usr/bin/env node

/**
 * Queue Worker - Standalone Background Processor
 *
 * Processes pending scraped order comparison jobs from the database queue.
 *
 * Usage:
 *   node src/workers/processQueueWorker.js
 *
 * Environment Variables:
 *   QUEUE_POLL_INTERVAL_MS - Polling interval (default: 10000ms)
 *   QUEUE_MAX_RETRIES - Max retry attempts (default: 3)
 */

require('dotenv').config();

const { runWorkerLoop, getQueueStats } = require('../services/queueProcessorService');

// Configuration
const POLL_INTERVAL = parseInt(process.env.QUEUE_POLL_INTERVAL_MS) || 10000;

// Track worker state
let stopWorker = null;
let isShuttingDown = false;

/**
 * Display startup banner
 */
function displayBanner() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  Truckast Queue Worker');
  console.log('  Processing scraped order comparisons in background');
  console.log('='.repeat(60));
  console.log(`  Poll Interval: ${POLL_INTERVAL}ms`);
  console.log(`  Max Retries: ${process.env.QUEUE_MAX_RETRIES || 3}`);
  console.log(`  Started at: ${new Date().toISOString()}`);
  console.log('='.repeat(60));
}

/**
 * Display queue stats on startup
 */
async function displayStats() {
  try {
    const stats = await getQueueStats();
    console.log('\nQueue Status:');
    console.log(`  Pending: ${stats.pending}`);
    console.log(`  Processing: ${stats.processing}`);
    console.log(`  Completed: ${stats.completed}`);
    console.log(`  Failed: ${stats.failed}`);
    console.log('');
  } catch (error) {
    console.error('Failed to get queue stats:', error.message);
  }
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log('Forced exit...');
    process.exit(1);
  }

  isShuttingDown = true;
  console.log(`\n${signal} received. Shutting down gracefully...`);

  if (stopWorker) {
    stopWorker();
  }

  // Give time for current job to complete
  setTimeout(() => {
    console.log('Worker shutdown complete');
    process.exit(0);
  }, 1000);
}

/**
 * Main entry point
 */
async function main() {
  displayBanner();

  // Check database connection
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  // Display initial stats
  await displayStats();

  // Start the worker loop
  stopWorker = runWorkerLoop(POLL_INTERVAL);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the worker
main().catch((error) => {
  console.error('Worker failed to start:', error);
  process.exit(1);
});
