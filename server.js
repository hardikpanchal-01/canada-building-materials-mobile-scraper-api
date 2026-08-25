const app = require('./app');
const { testConnection, closePool } = require('./src/services/database/postgresClient');
const { runWorkerLoop } = require('./src/services/queueProcessorService');
const {
  startChatRealtimeListener,
  stopChatRealtimeListener,
} = require('./src/services/chatRealtimeListener');
const { initRealtime } = require('./src/services/realtimeService');

const PORT = process.env.PORT || 3000;

// Check for --worker flag to enable embedded worker mode
const WORKER_MODE = process.argv.includes('--worker');
const WORKER_POLL_INTERVAL = parseInt(process.env.QUEUE_POLL_INTERVAL_MS) || 10000;

// Worker stop function (for graceful shutdown)
let stopWorker = null;

// Handle uncaught exceptions - graceful shutdown
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  // Don't exit, keep server running
});

// Test database connections
async function testConnections() {
  // Test PostgreSQL connection (if configured)
  if (process.env.DATABASE_URL) {
    try {
      const dbConnected = await testConnection();
      if (dbConnected) {
        console.log('✓ PostgreSQL database connected successfully');
      } else {
        console.log('⚠️  PostgreSQL database connection failed - scraper features may be unavailable');
      }
    } catch (err) {
      console.log('⚠️  PostgreSQL connection test failed:', err.message);
    }
  } else {
    console.log('⚠️  DATABASE_URL not configured - scraper features will be unavailable');
  }
}

// Create server
const server = app.listen(PORT, async () => {
  // Set server timeouts
  server.timeout = 120000;          // 2 min overall request timeout
  server.keepAliveTimeout = 65000;  // Slightly above typical LB 60s idle timeout
  server.headersTimeout = 66000;    // Must be > keepAliveTimeout

  console.log('═══════════════════════════════════════════════════════');
  console.log(`🚀 Truckast Unified API Server`);
  console.log(`📍 Running on port ${PORT}`);
  console.log(`📍 Local:   http://localhost:${PORT}`);
  console.log(`📍 Network: http://0.0.0.0:${PORT}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('📋 Available Endpoints:');
  console.log(`   GET  http://localhost:${PORT}/health`);
  console.log('');
  console.log('📚 API Documentation:');
  console.log(`   GET  http://localhost:${PORT}/scraper-api-docs   (Scraper API)`);
  console.log(`   GET  http://localhost:${PORT}/mobile-api-docs    (Mobile Backend API)`);
  console.log('');
  console.log('📱 Mobile Backend API:');
  console.log(`   POST http://localhost:${PORT}/api/auth/login`);
  console.log(`   POST http://localhost:${PORT}/api/auth/logout`);
  console.log(`   POST http://localhost:${PORT}/api/auth/refresh`);
  console.log(`   GET  http://localhost:${PORT}/api/auth/me`);
  console.log(`   POST http://localhost:${PORT}/api/notifications/send`);
  console.log('');
  console.log('🔧 Scraper API:');
  console.log(`   POST http://localhost:${PORT}/api/scraped-orders/ingest`);
  console.log('═══════════════════════════════════════════════════════');

  await testConnections();

  // Start embedded worker if --worker flag is passed
  if (WORKER_MODE) {
    console.log('');
    console.log('🔄 Starting embedded queue worker...');
    stopWorker = runWorkerLoop(WORKER_POLL_INTERVAL);
    console.log(`   Polling every ${WORKER_POLL_INTERVAL}ms`);
  }

  // Start the chat realtime listener (PostgreSQL LISTEN → FCM fan-out).
  // Runs on every dyno; cheap (just websocket subscriptions).
  // Skip in local dev when DISABLE_REALTIME=true (persistent PG connections
  // are incompatible with kubectl port-forward which dies after each connection).
  if (process.env.DISABLE_REALTIME === 'true') {
    console.log('⏭️  Realtime listeners disabled (DISABLE_REALTIME=true)');
  } else {
    try {
      startChatRealtimeListener();
    } catch (err) {
      console.error('❌ Failed to start chat realtime listener:', err.message);
    }

    // Start PostgreSQL LISTEN/NOTIFY → Socket.io realtime
    try {
      await initRealtime(server);
      console.log('🔌 Realtime (PG LISTEN/NOTIFY + Socket.io) started');
    } catch (err) {
      console.error('⚠️  Realtime init failed:', err.message);
    }
  }

  console.log('✅ Server ready to accept connections');
  console.log('═══════════════════════════════════════════════════════');
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n⚠️  ${signal} signal received: closing HTTP server`);

  try {
    // Stop queue worker if running
    if (stopWorker) {
      stopWorker();
      console.log('✅ Queue worker stopped');
    }

    // Stop chat realtime listener
    try {
      await stopChatRealtimeListener();
      console.log('✅ Chat realtime listener stopped');
    } catch (err) {
      console.error('⚠️  Error stopping chat realtime listener:', err.message);
    }

    // Close database pool if it exists
    if (closePool) {
      await closePool();
      console.log('✅ Database pool closed');
    }

    server.close(() => {
      console.log('✅ HTTP server closed');
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Keep server alive
server.on('error', (error) => {
  if (error.syscall !== 'listen') {
    throw error;
  }

  const bind = typeof PORT === 'string' ? 'Pipe ' + PORT : 'Port ' + PORT;

  switch (error.code) {
    case 'EACCES':
      console.error(`❌ ${bind} requires elevated privileges`);
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(`❌ ${bind} is already in use`);
      process.exit(1);
      break;
    default:
      throw error;
  }
});
