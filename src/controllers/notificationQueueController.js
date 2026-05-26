const notificationQueueService = require('../services/notificationQueueService');

const FALLBACK_TZ = 'America/Chicago';

function formatToUserTz(dateTimeStr, tz) {
  if (!dateTimeStr) return null;
  const date = new Date(dateTimeStr);
  if (isNaN(date.getTime())) return dateTimeStr;
  const timeZone = tz?.iana || FALLBACK_TZ;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * @swagger
 * /api/notifications/history:
 *   get:
 *     summary: Get notifications for authenticated user
 *     description: |
 *       Fetches notifications from the notification queue for the authenticated user,
 *       filtered by tenant_id, ordered by created_at descending, with a default limit of 50.
 *
 *       Uses a **separate Supabase instance** dedicated to notifications.
 *     tags: [Notifications]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: User UUID to fetch notifications for
 *         example: "41f7ae25-485d-4127-be4d-3967725c20ef"
 *       - in: query
 *         name: tenant_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Tenant ID for multi-tenant isolation
 *         example: 1
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *         description: Page number (1-based)
 *         example: 1
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of notifications per page
 *         example: 50
 *     responses:
 *       200:
 *         description: Notifications retrieved successfully
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
 *                   example: "Notifications retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     notifications:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                       id:
 *                         type: integer
 *                         example: 29
 *                       queue_uuid:
 *                         type: string
 *                         format: uuid
 *                         example: "79be6728-22ac-42a2-9e09-8748d4abc202"
 *                       event_log_id:
 *                         type: integer
 *                         nullable: true
 *                         example: 31
 *                       channel_code:
 *                         type: string
 *                         nullable: true
 *                         example: "in_app"
 *                       channel_name:
 *                         type: string
 *                         nullable: true
 *                       user_id:
 *                         type: string
 *                         format: uuid
 *                         example: "41f7ae25-485d-4127-be4d-3967725c20ef"
 *                       user_email:
 *                         type: string
 *                         nullable: true
 *                       user_phone:
 *                         type: string
 *                         nullable: true
 *                       user_name:
 *                         type: string
 *                         nullable: true
 *                       recipient_device_token:
 *                         type: string
 *                         nullable: true
 *                       customer_id:
 *                         type: integer
 *                         nullable: true
 *                       customer_code:
 *                         type: string
 *                         nullable: true
 *                       customer_name:
 *                         type: string
 *                         nullable: true
 *                       event_code:
 *                         type: string
 *                         nullable: true
 *                         example: "ORDER_CREATED"
 *                       event_name:
 *                         type: string
 *                         nullable: true
 *                         example: "Order Created"
 *                       entity_type:
 *                         type: string
 *                         nullable: true
 *                         example: "order"
 *                       entity_id:
 *                         type: string
 *                         nullable: true
 *                       entity_code:
 *                         type: string
 *                         nullable: true
 *                       subject:
 *                         type: string
 *                         nullable: true
 *                         example: "New Order #7468"
 *                       body:
 *                         type: string
 *                         nullable: true
 *                         example: "Test notification - Stevenson Weir OKC"
 *                       body_html:
 *                         type: string
 *                         nullable: true
 *                       scheduled_at:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                       priority:
 *                         type: integer
 *                         nullable: true
 *                         example: 5
 *                       status:
 *                         type: string
 *                         example: "pending"
 *                         description: "'pending' (unread) or 'delivered' (read)"
 *                       attempt_count:
 *                         type: integer
 *                         example: 0
 *                       max_attempts:
 *                         type: integer
 *                         example: 3
 *                       next_retry_at:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                       last_attempt_at:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                       sent_at:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                       delivered_at:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                       failed_at:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                       failure_reason:
 *                         type: string
 *                         nullable: true
 *                       last_error_code:
 *                         type: string
 *                         nullable: true
 *                       last_error_message:
 *                         type: string
 *                         nullable: true
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                         example: "2026-02-24T10:29:07.817215+00:00"
 *                       updated_at:
 *                         type: string
 *                         format: date-time
 *                         example: "2026-02-24T10:29:07.817215+00:00"
 *                       tenant_id:
 *                         type: integer
 *                         nullable: true
 *                         example: 1
 *                     total:
 *                       type: integer
 *                       description: Total number of notifications matching the filter
 *                       example: 3
 *                     page:
 *                       type: integer
 *                       description: Current page number
 *                       example: 1
 *                     limit:
 *                       type: integer
 *                       description: Number of results per page
 *                       example: 50
 *                     totalPages:
 *                       type: integer
 *                       description: Total number of pages
 *                       example: 1
 *       400:
 *         description: Validation error - user_id and tenant_id are required
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "user_id query parameter is required"
 *                 error_code:
 *                   type: string
 *                   example: "VALIDATION_ERROR"
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       500:
 *         description: Server error
 */
async function getNotifications(req, res) {
  try {
    const { user_id, tenant_id, page, limit } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'user_id query parameter is required',
        error_code: 'VALIDATION_ERROR'
      });
    }

    if (!tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id query parameter is required',
        error_code: 'VALIDATION_ERROR'
      });
    }

    const parsedPage = page ? parseInt(page, 10) : 1;
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const tz = req.user?.timezone || null;
    const data = await notificationQueueService.getNotifications(user_id, parseInt(tenant_id, 10), parsedPage, parsedLimit);

    // Format timestamps in user's timezone
    if (tz && data.notifications) {
      data.notifications = data.notifications.map(n => ({
        ...n,
        created_at: formatToUserTz(n.created_at, tz),
        updated_at: formatToUserTz(n.updated_at, tz),
      }));
    }

    return res.status(200).json({
      success: true,
      message: 'Notifications retrieved successfully',
      data
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch notifications',
      error_code: 'INTERNAL_ERROR'
    });
  }
}

module.exports = {
  getNotifications
};
