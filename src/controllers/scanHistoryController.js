/**
 * Scan History Controller
 *
 * GET    /api/scan-history      - Fetch all scan records for the authenticated user
 * POST   /api/scan-history      - Save a new scan record
 * DELETE /api/scan-history/:id  - Delete a single scan record
 * DELETE /api/scan-history      - Clear all scan history for the user
 */

const scanHistoryService = require('../services/scanHistoryService');

/**
 * @swagger
 * components:
 *   schemas:
 *     ScanRecord:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Client-generated unique scan ID
 *         data:
 *           type: string
 *           description: Raw QR/barcode payload
 *         type:
 *           type: string
 *           description: Scan type (qr, ean-13, code-128, etc.)
 *           example: qr
 *         timestamp:
 *           type: integer
 *           format: int64
 *           description: Client-side epoch milliseconds
 *         label:
 *           type: string
 *           nullable: true
 *         verified:
 *           type: string
 *           nullable: true
 *           enum: [verified, not_found, offline, error]
 *         tkData:
 *           type: object
 *           nullable: true
 *           description: Decrypted QR data (ticket/truck)
 *         apiData:
 *           type: object
 *           nullable: true
 *           description: Enriched API data
 *     ScanHistoryPagination:
 *       type: object
 *       properties:
 *         page:
 *           type: integer
 *           example: 1
 *         limit:
 *           type: integer
 *           example: 20
 *         total:
 *           type: integer
 *         total_pages:
 *           type: integer
 *         has_next:
 *           type: boolean
 *         has_prev:
 *           type: boolean
 */

/**
 * @swagger
 * /api/scan-history:
 *   get:
 *     summary: Get paginated scan history for the authenticated user
 *     description: Returns scan records newest-first, scoped to the authenticated user.
 *     tags: [Scan History]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *         description: 1-based page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           minimum: 1
 *           maximum: 100
 *         description: Records per page (max 100)
 *     responses:
 *       200:
 *         description: Scan history fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ScanRecord'
 *                 pagination:
 *                   $ref: '#/components/schemas/ScanHistoryPagination'
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error
 */
async function getHistory(req, res) {
  try {
    const { page, limit } = req.query;
    const result = await scanHistoryService.getHistory(req.user.id, page, limit);

    return res.status(200).json({
      success: true,
      data: result.records,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error('[ScanHistory] getHistory error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch scan history',
    });
  }
}

/**
 * @swagger
 * /api/scan-history:
 *   post:
 *     summary: Save a new scan record
 *     description: |
 *       Persists a scan record for the authenticated user. Upserts on `(user_id, scan_id)`,
 *       so re-sending the same `id` updates the existing record.
 *     tags: [Scan History]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, data, timestamp]
 *             properties:
 *               id:
 *                 type: string
 *                 description: Client-generated unique scan ID
 *               data:
 *                 type: string
 *                 description: Raw QR/barcode payload
 *               type:
 *                 type: string
 *                 default: qr
 *                 example: qr
 *               timestamp:
 *                 type: integer
 *                 format: int64
 *                 description: Client-side epoch milliseconds
 *               label:
 *                 type: string
 *                 nullable: true
 *               verified:
 *                 type: string
 *                 nullable: true
 *                 enum: [verified, not_found, offline, error]
 *               tkData:
 *                 type: object
 *                 nullable: true
 *               apiData:
 *                 type: object
 *                 nullable: true
 *     responses:
 *       201:
 *         description: Scan record saved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/ScanRecord'
 *       400:
 *         description: Missing required fields (id, data)
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error
 */
async function saveScan(req, res) {
  try {
    const record = req.body;

    if (!record || !record.id || !record.data) {
      return res.status(400).json({
        success: false,
        message: 'Scan record with id and data is required',
      });
    }

    const saved = await scanHistoryService.saveScan(req.user.id, record);

    return res.status(201).json({
      success: true,
      data: saved,
    });
  } catch (error) {
    console.error('[ScanHistory] saveScan error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to save scan record',
    });
  }
}

/**
 * @swagger
 * /api/scan-history/{id}:
 *   delete:
 *     summary: Delete a single scan record
 *     description: Deletes a scan record by its client `scan_id`, scoped to the authenticated user.
 *     tags: [Scan History]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Client-generated scan ID
 *     responses:
 *       200:
 *         description: Scan record deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Scan record deleted
 *       400:
 *         description: Missing scan ID
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error
 */
async function deleteScan(req, res) {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Scan ID is required',
      });
    }

    const result = await scanHistoryService.deleteScan(req.user.id, id);

    return res.status(200).json({
      success: true,
      message: `Scan record deleted`,
    });
  } catch (error) {
    console.error('[ScanHistory] deleteScan error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete scan record',
    });
  }
}

/**
 * @swagger
 * /api/scan-history:
 *   delete:
 *     summary: Clear all scan history for the authenticated user
 *     description: Permanently removes every scan record owned by the authenticated user.
 *     tags: [Scan History]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Scan history cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Scan history cleared
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error
 */
async function clearHistory(req, res) {
  try {
    const result = await scanHistoryService.clearHistory(req.user.id);

    return res.status(200).json({
      success: true,
      message: `Scan history cleared`,
    });
  } catch (error) {
    console.error('[ScanHistory] clearHistory error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to clear scan history',
    });
  }
}

module.exports = {
  getHistory,
  saveScan,
  deleteScan,
  clearHistory,
};
