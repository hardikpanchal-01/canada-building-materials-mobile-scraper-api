/**
 * Tenant Controller
 *
 * Handles tenant configuration requests:
 * - GET /api/tenant - Get tenant by subdomain
 */

const tenantService = require('../services/tenantService');

/**
 * @swagger
 * /api/tenant:
 *   get:
 *     summary: Get tenant configuration
 *     description: |
 *       Returns public tenant configuration by subdomain.
 *       Used by mobile apps to get tenant details before login.
 *     tags: [Tenant]
 *     parameters:
 *       - in: query
 *         name: subdomain
 *         required: true
 *         schema:
 *           type: string
 *         description: Tenant subdomain
 *         example: "acme"
 *     responses:
 *       200:
 *         description: Tenant found
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
 *                   example: "Tenant retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     tenant:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         uuid:
 *                           type: string
 *                           format: uuid
 *                         name:
 *                           type: string
 *                         subdomain:
 *                           type: string
 *                         client_id:
 *                           type: string
 *                           format: uuid
 *                         redirect_url:
 *                           type: string
 *                         status:
 *                           type: string
 *                           enum: [active, inactive, suspended]
 *       400:
 *         description: Subdomain required
 *       404:
 *         description: Tenant not found
 */
async function getTenant(req, res) {
  try {
    const { subdomain } = req.query;

    // Validate subdomain
    if (!subdomain) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'Subdomain query parameter is required'
      });
    }

    if (typeof subdomain !== 'string' || subdomain.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'Subdomain cannot be empty'
      });
    }

    // Get tenant by subdomain
    const tenant = await tenantService.getTenantBySubdomain(subdomain.trim().toLowerCase());

    if (!tenant) {
      return res.status(404).json({
        success: false,
        error_code: 'NO_TENANT',
        message: 'Tenant not found or inactive'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Tenant retrieved successfully',
      data: {
        tenant
      }
    });

  } catch (error) {
    console.error('Get tenant error:', error);
    return res.status(500).json({
      success: false,
      error_code: 'SERVER_ERROR',
      message: 'An unexpected error occurred'
    });
  }
}

module.exports = {
  getTenant
};
