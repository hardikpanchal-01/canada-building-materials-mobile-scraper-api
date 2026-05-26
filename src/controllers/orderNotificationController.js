const crypto = require('crypto');
const notificationService = require('../services/notificationService');
const notificationPushService = require('../services/notificationPushService');
const { getNotificationSupabase } = require('../config/notificationDatabase');

/**
 * Insert notification into notification_queue for in-app history
 */
async function insertNotificationQueue({ userId, tenantId, eventCode, entityType, entityId, subject, body, orderCode, orderDate }) {
  try {
    const supabase = getNotificationSupabase();

    const { error } = await supabase
      .from('notification_queue')
      .insert({
        queue_uuid: crypto.randomUUID(),
        channel_code: 'push',
        user_id: userId,
        event_code: eventCode,
        event_name: eventCode.replace(/_/g, ' '),
        entity_type: entityType || 'order',
        entity_id: entityId || null,
        subject,
        body,
        priority: 1,
        status: 'sent',
        tenant_id: tenantId || null,
        order_code: orderCode || null,
        order_date: orderDate || null,
      });

    if (error) {
      console.error('[OrderNotification] Error inserting notification_queue:', error.message);
    }
  } catch (err) {
    console.error('[OrderNotification] notification_queue insert failed:', err.message);
  }
}

/**
 * @swagger
 * /api/notifications/send-order:
 *   post:
 *     summary: Send order notification to a user
 *     description: |
 *       Sends a push notification for an order event to all active devices of the specified user.
 *       The notification payload is automatically structured so the mobile app navigates
 *       to the correct screen (OrderDetail) when the notification is tapped.
 *
 *       **Required fields:** at least `order_id` or `order_code`. user_id and tenant_id are auto-resolved from the Bearer token.
 *
 *       **Target:** Pass `fcm_token` (single) or `fcm_tokens` (array) to send directly to specific devices.
 *       If neither is provided, sends to all active devices for the user.
 *
 *       **Optional fields:** `title`, `body`, `event_code`, `tenant_id`, `extra_data`
 *     tags: [Notifications]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               user_id:
 *                 type: string
 *                 format: uuid
 *                 description: Optional — defaults to authenticated user from Bearer token
 *                 example: "41f7ae25-485d-4127-be4d-3967725c20ef"
 *               order_id:
 *                 type: string
 *                 description: Order ID for navigation
 *                 example: "21509"
 *               order_code:
 *                 type: string
 *                 description: Order code for navigation
 *                 example: "21509"
 *               order_date:
 *                 type: string
 *                 description: Order date for navigation (YYYY-MM-DD)
 *                 example: "2026-04-10"
 *               title:
 *                 type: string
 *                 description: Custom notification title (defaults to "New Order #order_code")
 *                 example: "New Order #21509"
 *               body:
 *                 type: string
 *                 description: Custom notification body
 *                 example: "You have been assigned a new order"
 *               event_code:
 *                 type: string
 *                 description: Event code for routing (defaults to ORDER_CREATED)
 *                 enum: [ORDER_CREATED, ORDER_UPDATED, ORDER_CANCELLED]
 *                 example: "ORDER_CREATED"
 *               tenant_id:
 *                 type: integer
 *                 description: Tenant ID for notification queue record
 *                 example: 1
 *               fcm_token:
 *                 type: string
 *                 description: Single FCM device token to send to directly
 *                 example: "dK8xJ..."
 *               fcm_tokens:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of FCM device tokens to send to directly
 *                 example: ["dK8xJ...", "eL9yK..."]
 *               extra_data:
 *                 type: object
 *                 description: Additional custom data to include in the notification payload
 *                 additionalProperties: true
 *     responses:
 *       200:
 *         description: Notification sent successfully
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Server error
 */
async function sendOrderNotification(req, res) {
  const timestamp = new Date().toISOString();

  try {
    const {
      user_id,
      order_id,
      order_code,
      order_date,
      title,
      body,
      event_code,
      tenant_id,
      extra_data,
      fcm_token,
      fcm_tokens,
    } = req.body;

    console.log('\n===================================================');
    console.log(`[OrderNotification] REQUEST [${timestamp}]`);
    console.log('===================================================');

    // Defaults from Bearer token; body values override
    const targetUserId = user_id || req.user?.id;
    const effectiveTenantId = tenant_id ?? req.user?.metadata?.tenant?.tenant_id ?? null;

    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'Could not resolve user_id from token' });
    }
    if (!order_id && !order_code) {
      return res.status(400).json({ success: false, message: 'order_id or order_code is required' });
    }

    const effectiveOrderId = order_id || order_code;
    const effectiveOrderCode = order_code || order_id;
    const effectiveOrderDate = order_date || '';

    const effectiveEventCode = event_code || 'ORDER_CREATED';
    const effectiveTitle = title || `New Order #${effectiveOrderCode}`;
    const effectiveBody = body || `You have a new order #${effectiveOrderCode}`;

    console.log(`  User ID: ${targetUserId}`);
    console.log(`  Order: #${effectiveOrderCode} (ID: ${effectiveOrderId}, Date: ${effectiveOrderDate || 'N/A'})`);
    console.log(`  Event: ${effectiveEventCode}`);
    console.log(`  Title: ${effectiveTitle}`);

    // FCM data payload — field names match mobile app's navigateFromNotification()
    const fcmData = {
      event_code: effectiveEventCode,
      order_id: String(effectiveOrderId),
      order_code: String(effectiveOrderCode),
      order_date: String(effectiveOrderDate),
      ...(extra_data || {}),
    };

    // Send FCM — use explicit token(s) if provided, otherwise look up by user_id
    const directTokens = fcm_tokens || (fcm_token ? [fcm_token] : null);
    let result;

    if (directTokens && directTokens.length > 0) {
      console.log(`  Sending to ${directTokens.length} explicit FCM token(s)`);
      if (directTokens.length === 1) {
        result = await notificationPushService.sendPushNotification(directTokens[0], effectiveTitle, effectiveBody, fcmData);
      } else {
        result = await notificationPushService.sendPushNotificationToMultiple(directTokens, effectiveTitle, effectiveBody, fcmData);
      }
    } else {
      result = await notificationService.sendNotificationToUser(targetUserId, effectiveTitle, effectiveBody, fcmData);
    }

    console.log(`  Result: ${result.successCount} sent, ${result.failureCount} failed`);

    if (result.responses) {
      const invalidTokens = result.responses
        .filter(r => !r.success && r.isInvalidToken)
        .map(r => r.token);

      if (invalidTokens.length > 0) {
        console.log(`  Deactivating ${invalidTokens.length} invalid token(s)`);
        await notificationPushService.batchDeactivateTokens(invalidTokens);
      }
    }

    await insertNotificationQueue({
      userId: targetUserId,
      tenantId: effectiveTenantId,
      eventCode: effectiveEventCode,
      entityType: 'order',
      entityId: effectiveOrderId,
      subject: effectiveTitle,
      body: effectiveBody,
      orderCode: effectiveOrderCode,
      orderDate: effectiveOrderDate,
    });

    console.log('===================================================\n');

    return res.status(200).json({
      success: true,
      message: 'Order notification sent successfully',
      data: {
        successCount: result.successCount,
        failureCount: result.failureCount,
        event_code: effectiveEventCode,
        order_id: effectiveOrderId,
        order_code: effectiveOrderCode,
        order_date: effectiveOrderDate,
      },
    });
  } catch (error) {
    console.error(`[OrderNotification] Error: ${error.message}`);
    console.log('===================================================\n');

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to send order notification',
    });
  }
}

module.exports = {
  sendOrderNotification,
};
