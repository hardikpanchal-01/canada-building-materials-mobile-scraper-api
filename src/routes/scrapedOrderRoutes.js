/**
 * Scraped Order Routes
 *
 * @swagger
 * tags:
 *   name: Scraped Orders
 *   description: Endpoints for scraper order ingestion
 */

const express = require('express');
const {
  ingestScrapedOrdersController,
  ingestLiteScrapedOrdersController
} = require('../controllers/scrapedOrderController');
const { scraperAuthMiddleware } = require('../middleware/scraperAuth');

const router = express.Router();

/**
 * @swagger
 * /api/scraped-orders/ingest:
 *   post:
 *     summary: Ingest scraped order data
 *     description: |
 *       Receives and stores scraped order data from external scrapers.
 *
 *       **Authentication:** Requires a valid API key in the `x-scraper-api-key` header.
 *
 *       **Process:**
 *       1. Validates the request payload structure
 *       2. Validates each order against required fields and format rules
 *       3. Sanitizes and normalizes data (dates, quantities, statuses)
 *       4. Uploads validated orders to Supabase Storage as JSON
 *       5. Creates a tracking record in the database
 *       6. Returns batch ID and file URL for downstream processing
 *     tags: [Scraped Orders]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orders
 *             properties:
 *               orders:
 *                 type: array
 *                 description: Array of order objects to ingest
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required:
 *                     - order_code
 *                     - order_date
 *                     - customer_name
 *                     - product_code
 *                   properties:
 *                     order_code:
 *                       type: string
 *                       description: Unique order identifier
 *                       example: "26324"
 *                     order_date:
 *                       type: string
 *                       description: Order date (YYYY-MM-DD or MM/DD/YYYY)
 *                       example: "2025-12-25"
 *                     start_time:
 *                       type: string
 *                       description: Order start time (HH:MM or HH:MM:SS)
 *                       example: "10:45"
 *                     plant_code:
 *                       type: string
 *                       description: Plant/facility code
 *                       example: "263"
 *                     customer_name:
 *                       type: string
 *                       description: Customer name
 *                       example: "ABC Construction"
 *                     delivery_address:
 *                       type: string
 *                       description: Delivery address
 *                       example: "123 Main St, City, ST 12345"
 *                     product_code:
 *                       type: string
 *                       description: Product code
 *                       example: "T355N0"
 *                     qty:
 *                       type: string
 *                       description: Quantity (number or "delivered/ordered" format)
 *                       example: "0.00/21.01"
 *                     ordered_qty:
 *                       type: number
 *                       description: Ordered quantity
 *                       example: 21.01
 *                     delivered_qty:
 *                       type: number
 *                       description: Delivered quantity
 *                       example: 0.00
 *                     status:
 *                       type: string
 *                       description: Order status
 *                       enum: [Normal, Hold, Cancelled, Completed, Pending, In Progress]
 *                       example: "Normal"
 *                     has_notes:
 *                       type: boolean
 *                       description: Whether order has notes (accepts true/false, Y/N, 1/0)
 *                       example: false
 *           example:
 *             orders:
 *               - order_code: "26324"
 *                 order_date: "2025-12-25"
 *                 start_time: "10:45"
 *                 plant_code: "263"
 *                 customer_name: "ABC Construction"
 *                 delivery_address: "123 Main St, City, ST 12345"
 *                 product_code: "T355N0"
 *                 delivered_qty: 0.00
 *                 ordered_qty: 21.01
 *                 status: "Normal"
 *                 has_notes: false
 *     responses:
 *       200:
 *         description: Orders ingested successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized - Invalid or missing API key
 *       500:
 *         description: Server error
 */
router.post('/scraped-orders/ingest', scraperAuthMiddleware, ingestScrapedOrdersController);

/**
 * @swagger
 * /api/scraped-orders/ingest-lite:
 *   post:
 *     summary: Ingest scraped orders (lite — Connex extension)
 *     description: |
 *       Synchronous, self-contained comparison for the Connex browser extension.
 *
 *       Accepts a reduced order shape (order_code, order_date, ordered_qty,
 *       delivered_qty, status), matches each order by order_code + order_date,
 *       compares ONLY quantity + status, and always emails the comparison report.
 *
 *       No Command Cloud re-validation, DB writes, time-window guard, or
 *       already-emailed dedup are applied. Returns the comparison counts and
 *       email status directly in the response.
 *
 *       **Authentication:** requires a valid API key in the `x-scraper-api-key` header.
 *     tags: [Scraped Orders]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orders]
 *             properties:
 *               orders:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [order_code, order_date]
 *                   properties:
 *                     order_code: { type: string, example: "50866-1" }
 *                     order_date: { type: string, example: "2026-06-04" }
 *                     ordered_qty: { type: number, example: 40 }
 *                     delivered_qty: { type: number, example: 30 }
 *                     status: { type: string, example: "Normal" }
 *           example:
 *             orders:
 *               - order_code: "50866-1"
 *                 order_date: "2026-06-04"
 *                 ordered_qty: 40
 *                 delivered_qty: 30
 *                 status: "Normal"
 *             scraper_id: "connex-extension"
 *             source_url: "https://connex.us.commandalkon.io/app/dispatch-exp/.../orders"
 *     responses:
 *       200:
 *         description: Lite comparison completed (includes email status)
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized - Invalid or missing API key
 *       500:
 *         description: Server error
 */
router.post('/scraped-orders/ingest-lite', scraperAuthMiddleware, ingestLiteScrapedOrdersController);

module.exports = router;


