/**
 * Health Check Routes
 *
 * @swagger
 * tags:
 *   name: Health
 *   description: Health check endpoints for monitoring API status
 */

const express = require('express');
const { healthCheck } = require('../controllers/healthController');

const router = express.Router();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: |
 *       Returns the health status of the API including database connectivity, uptime, and system information.
 *       
 *       This endpoint is useful for monitoring and load balancer health checks.
 *       - Returns 200 if service is healthy
 *       - Returns 503 if service is unhealthy (database disconnected)
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [healthy, unhealthy]
 *                   example: healthy
 *                   description: Overall health status of the service
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-04-08T12:34:56.789Z"
 *                   description: Current server timestamp
 *                 version:
 *                   type: string
 *                   example: "2.0.0"
 *                   description: API version
 *                 environment:
 *                   type: string
 *                   example: "development"
 *                   enum: [development, production, staging]
 *                   description: Current environment
 *                 uptime:
 *                   type: number
 *                   description: Server uptime in seconds
 *                   example: 3600
 *                 database:
 *                   type: object
 *                   description: Database connection status and pool information
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [connected, disconnected, not_configured]
 *                       example: connected
 *                       description: Database connection status
 *                     pool:
 *                       type: object
 *                       nullable: true
 *                       description: Database connection pool statistics
 *                       properties:
 *                         totalCount:
 *                           type: number
 *                           description: Total number of connections in pool
 *                           example: 10
 *                         idleCount:
 *                           type: number
 *                           description: Number of idle connections
 *                           example: 8
 *                         waitingCount:
 *                           type: number
 *                           description: Number of requests waiting for connection
 *                           example: 0
 *       503:
 *         description: Service is unhealthy - database connection failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: unhealthy
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 error:
 *                   type: string
 *                   example: "Health check failed"
 *                 database:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       example: error
 *                     message:
 *                       type: string
 */
router.get('/health', healthCheck);

module.exports = router;


