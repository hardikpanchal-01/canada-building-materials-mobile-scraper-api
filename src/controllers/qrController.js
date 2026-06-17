/**
 * QR Controller
 *
 * POST /api/qr/verify - Decrypt + verify a QR payload server-side
 */

const qrService = require('../services/qrService');

/**
 * @swagger
 * /api/qr/verify:
 *   post:
 *     summary: Verify a scanned QR code
 *     description: |
 *       Accepts a raw QR payload (encrypted `[TK/E]` or pipe-separated fallback),
 *       decrypts it server-side, and returns the verified ticket/truck details.
 *
 *       **Supported payload formats:**
 *       - Encrypted: `[TK/E]<base64(IV|AuthTag|Ciphertext)>` (AES-256-GCM)
 *       - Ticket pipe fallback: `orderCode|orderId|ticketCode|ticketId|truckCode|truckId` (6 parts)
 *       - Truck pipe fallback:  `truck|truckCode|truckId` (3 parts, first must be literal `truck`)
 *     tags: [QR]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [payload]
 *             properties:
 *               payload:
 *                 type: string
 *                 description: Raw QR code string (encrypted or pipe-separated)
 *                 example: "[TK/E]qk3JvX8...base64..."
 *     responses:
 *       200:
 *         description: QR verified successfully
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
 *                   example: QR verified successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       example: true
 *                     kind:
 *                       type: string
 *                       enum: [ticket, truck]
 *                     qrData:
 *                       type: object
 *                       description: Decrypted/parsed QR payload
 *                     security_mode:
 *                       type: object
 *                       nullable: true
 *                       description: Tenant security policy JSON from `auth_tenant.tenants.security_mode`
 *                       example:
 *                         mode: time_bound
 *                         scannable_statuses: [Loaded, To job]
 *                     details:
 *                       type: object
 *                       description: Enriched ticket/truck details from DB
 *       400:
 *         description: Invalid or unreadable QR payload (INVALID_REQUEST, DECRYPT_FAILED, INVALID_FORMAT, UNKNOWN_FORMAT)
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       404:
 *         description: Ticket or truck not found (NOT_FOUND)
 *       500:
 *         description: Server error
 */
async function verifyQr(req, res) {
  try {
    const { payload } = req.body;

    if (!payload || typeof payload !== 'string' || payload.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'QR payload is required',
      });
    }

    const result = await qrService.verifyQrPayload(payload.trim(), req.user);

    if (!result.success) {
      const status = result.error_code === 'NOT_FOUND' ? 404
        : result.error_code === 'DECRYPT_FAILED' ? 400
        : result.error_code === 'INVALID_FORMAT' ? 400
        : 500;

      return res.status(status).json({
        success: false,
        error_code: result.error_code,
        message: result.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'QR verified successfully',
      data: result,
    });

  } catch (error) {
    console.error('QR verify error:', error);
    return res.status(500).json({
      success: false,
      error_code: 'SERVER_ERROR',
      message: 'Failed to verify QR code',
    });
  }
}

/**
 * @swagger
 * /api/qr/encrypt:
 *   post:
 *     summary: Encrypt ticket/truck data into a QR payload
 *     description: |
 *       Accepts ticket or truck metadata and returns an AES-256-GCM encrypted
 *       QR payload (`[TK/E]<base64>`) identical to the web frontend's
 *       `/api/qr/encrypt` Next.js route. Used by the mobile app to display
 *       the same QR codes as the web.
 *     tags: [QR]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [kind]
 *             properties:
 *               kind:
 *                 type: string
 *                 enum: [ticket, truck]
 *               orderCode:
 *                 type: string
 *               orderId:
 *                 type: string
 *               ticketCode:
 *                 type: string
 *               ticketId:
 *                 type: string
 *               truckCode:
 *                 type: string
 *               truckId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Encrypted QR payload
 *       400:
 *         description: Invalid kind
 *       500:
 *         description: Encryption failed
 */
async function encryptQr(req, res) {
  try {
    const body = req.body;

    if (!body || !body.kind) {
      return res.status(400).json({
        ok: false,
        error: "Request body must include 'kind' (ticket or truck)",
      });
    }

    const result = await qrService.encryptPayload(body, req.user);

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    return res.status(200).json({
      ok: true,
      payload: result.payload,
      tenant: result.tenant,
    });
  } catch (error) {
    console.error('QR encrypt error:', error);
    return res.status(500).json({
      ok: false,
      error: 'Failed to encrypt QR payload',
    });
  }
}

module.exports = { verifyQr, encryptQr };
