/**
 * Health Check Controller
 *
 * Provides health check endpoint for monitoring.
 */

const { testConnection, getPoolStats } = require('../services/database/postgresClient');

/**
 * Health check endpoint
 *
 * Returns detailed health status including database connectivity.
 * Returns 503 if database is not connected.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
async function healthCheck(req, res) {
  try {
    // Test PostgreSQL connection if configured
    let dbConnected = false;
    let poolStats = null;
    
    if (process.env.DATABASE_URL) {
      dbConnected = await testConnection();
      poolStats = getPoolStats();
    }

    const health = {
      status: dbConnected || !process.env.DATABASE_URL ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '2.0.0',
      environment: process.env.NODE_ENV || 'development',
      uptime: Math.floor(process.uptime()),
      database: process.env.DATABASE_URL ? {
        status: dbConnected ? 'connected' : 'disconnected',
        pool: poolStats
      } : {
        status: 'not_configured'
      }
    };

    const statusCode = dbConnected || !process.env.DATABASE_URL ? 200 : 503;
    res.status(statusCode).json(health);

  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
      database: {
        status: 'error',
        message: error.message
      }
    });
  }
}

module.exports = {
  healthCheck
};


