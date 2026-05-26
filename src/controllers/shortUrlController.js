/**
 * Short URL Controller
 *
 * Handles short URL resolution requests:
 * - GET /api/short-urls/resolve/:code - Resolve a short URL code
 */

const shortUrlService = require('../services/shortUrlService');

/**
 * @swagger
 * /api/short-urls/resolve/{code}:
 *   get:
 *     summary: Resolve a short URL code
 *     description: |
 *       Resolves a short URL code to its original URL and tenant slug.
 *       Used by the mobile app to handle deep link navigation.
 *       Validates expiry and increments click count.
 *     tags: [Short URLs]
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *         description: The short URL code to resolve
 *         example: "abc123"
 *     responses:
 *       200:
 *         description: Short URL resolved successfully
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
 *                   example: "Short URL resolved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     tenant_slug:
 *                       type: string
 *                       example: "acme"
 *                     original_url:
 *                       type: string
 *                       example: "https://acme.truckast.ai/orders/ORD-123?date=2026-04-09&tab=details"
 *       400:
 *         description: Missing code parameter
 *       404:
 *         description: Short URL not found
 *       410:
 *         description: Short URL has expired
 */
async function resolveShortUrl(req, res) {
  try {
    const { code } = req.params;

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'Short URL code is required',
      });
    }

    const result = await shortUrlService.resolveShortUrl(code.trim());

    if (!result.success) {
      const statusMap = {
        NOT_FOUND: 404,
        EXPIRED: 410,
        DB_ERROR: 500,
      };

      const status = statusMap[result.error_code] || 500;

      return res.status(status).json({
        success: false,
        error_code: result.error_code,
        message: result.error,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Short URL resolved successfully',
      data: result.data,
    });
  } catch (error) {
    console.error('[ShortUrl] Resolve error:', error);
    return res.status(500).json({
      success: false,
      error_code: 'SERVER_ERROR',
      message: 'An unexpected error occurred',
    });
  }
}

module.exports = {
  resolveShortUrl,
};
