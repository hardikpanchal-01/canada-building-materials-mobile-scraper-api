const notificationPushService = require('../services/notificationPushService');

/**
 * Handle push notification failures and deactivate invalid tokens
 */
async function handlePushFailures(responses) {
  if (!Array.isArray(responses)) return;

  const invalidTokens = responses
    .filter(r => !r.success && r.isInvalidToken)
    .map(r => r.token);

  if (invalidTokens.length > 0) {
    try {
      await notificationPushService.batchDeactivateTokens(invalidTokens);
    } catch (error) {
      console.error('⚠️  Error deactivating invalid tokens:', error.message);
    }
  }
}

/**
 * @swagger
 * /api/notifications/fcm:
 *   post:
 *     summary: Send push notification to device(s) or user
 *     description: |
 *       Sends a push notification to one or more devices using Firebase Cloud Messaging (FCM).
 *       Device tokens are looked up from the **notification Supabase** database.
 *
 *       **Authentication:** Requires a valid JWT token in the `Authorization: Bearer <token>` header.
 *
 *       **Device Targeting:**
 *       - Use `deviceToken` to send to a single device
 *       - Use `deviceTokens` (array) to send to multiple devices
 *       - Use `userId` to send to all active devices for a user
 *       - At least one of these fields is required
 *
 *       **Notification Content:**
 *       - `title`: Notification title (required)
 *       - `body`: Notification body text (required)
 *       - `data`: Optional custom data payload (object, all values converted to strings)
 *     tags: [Notifications]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - body
 *             oneOf:
 *               - required: [deviceToken]
 *               - required: [deviceTokens]
 *               - required: [userId]
 *             properties:
 *               deviceToken:
 *                 type: string
 *                 description: FCM device token for single device notification
 *                 example: "fcm-device-token-here"
 *               deviceTokens:
 *                 type: array
 *                 description: Array of FCM device tokens for multiple device notification
 *                 items:
 *                   type: string
 *                 minItems: 1
 *                 example: ["token1", "token2", "token3"]
 *               userId:
 *                 type: string
 *                 format: uuid
 *                 description: User ID to send notification to all active devices
 *                 example: "41f7ae25-485d-4127-be4d-3967725c20ef"
 *               title:
 *                 type: string
 *                 description: Notification title
 *                 example: "New Order"
 *               body:
 *                 type: string
 *                 description: Notification body text
 *                 example: "You have a new order #12345"
 *               data:
 *                 type: object
 *                 description: Optional custom data payload (all values are converted to strings)
 *                 additionalProperties: true
 *                 example:
 *                   orderId: "12345"
 *                   type: "new_order"
 *           examples:
 *             singleDevice:
 *               summary: Send to single device
 *               value:
 *                 deviceToken: "fcm-device-token-here"
 *                 title: "New Order"
 *                 body: "You have a new order #12345"
 *                 data:
 *                   orderId: "12345"
 *                   type: "new_order"
 *             multipleDevices:
 *               summary: Send to multiple devices
 *               value:
 *                 deviceTokens: ["token1", "token2", "token3"]
 *                 title: "System Update"
 *                 body: "New features are available"
 *                 data:
 *                   version: "2.0.0"
 *             userDevices:
 *               summary: Send to all user devices
 *               value:
 *                 userId: "41f7ae25-485d-4127-be4d-3967725c20ef"
 *                 title: "New Order"
 *                 body: "You have a new order #12345"
 *                 data:
 *                   orderId: "12345"
 *     responses:
 *       200:
 *         description: Notification sent successfully
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
 *                   example: "Push notification sent successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       example: true
 *                     messageId:
 *                       type: string
 *                       description: FCM message ID (for single device)
 *                       example: "projects/truckast-app/messages/0:1234567890"
 *                     successCount:
 *                       type: integer
 *                       description: Number of successful sends
 *                       example: 2
 *                     failureCount:
 *                       type: integer
 *                       description: Number of failed sends
 *                       example: 0
 *                     responses:
 *                       type: array
 *                       description: Per-device send results
 *                       items:
 *                         type: object
 *                         properties:
 *                           token:
 *                             type: string
 *                             description: Device token
 *                           success:
 *                             type: boolean
 *                             description: Whether send was successful
 *                           error:
 *                             type: object
 *                             nullable: true
 *                             properties:
 *                               code:
 *                                 type: string
 *                               message:
 *                                 type: string
 *                           isInvalidToken:
 *                             type: boolean
 *                             description: Whether the token is invalid/expired
 *       400:
 *         description: Validation error (missing title, body, or device targeting)
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
 *                   example: "Either deviceToken, deviceTokens, or userId is required"
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       403:
 *         description: Forbidden - Cannot send to other user's devices (non-admin)
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
 *                   example: "You can only send notifications to your own devices"
 *       500:
 *         description: Server error or FCM service error
 */
async function sendNotification(req, res) {
  const timestamp = new Date().toISOString();
  const user = req.user;

  try {
    const { deviceToken, deviceTokens, userId, title, body, data } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }

    if (!body) {
      return res.status(400).json({ success: false, message: 'Body is required' });
    }

    if (!deviceToken && !deviceTokens && !userId) {
      return res.status(400).json({
        success: false,
        message: 'Either deviceToken, deviceTokens, or userId is required'
      });
    }

    if (deviceTokens && !Array.isArray(deviceTokens)) {
      return res.status(400).json({ success: false, message: 'deviceTokens must be an array' });
    }

    if (deviceTokens && deviceTokens.length === 0) {
      return res.status(400).json({ success: false, message: 'deviceTokens array cannot be empty' });
    }

    let result;

    // Send to user (all active devices)
    if (userId) {
      if (user.id !== userId && !user.isAdmin) {
        return res.status(403).json({
          success: false,
          message: 'You can only send notifications to your own devices'
        });
      }

      const userDeviceTokens = await notificationPushService.getUserDeviceTokens(userId);

      if (userDeviceTokens.length === 0) {
        return res.status(200).json({
          success: true,
          message: 'User has no active devices',
          data: { successCount: 0, failureCount: 0, responses: [] }
        });
      }

      result = await notificationPushService.sendPushNotificationToMultiple(userDeviceTokens, title, body, data);

      if (result.responses) await handlePushFailures(result.responses);
    }
    // Send to single device
    else if (deviceToken) {
      result = await notificationPushService.sendPushNotification(deviceToken, title, body, data);

      if (result.responses) await handlePushFailures(result.responses);
    }
    // Send to multiple devices
    else if (deviceTokens) {
      result = await notificationPushService.sendPushNotificationToMultiple(deviceTokens, title, body, data);

      if (result.responses) await handlePushFailures(result.responses);
    }

    return res.status(200).json({
      success: true,
      message: 'Push notification sent successfully',
      data: result
    });
  } catch (error) {
    console.error(`Push notification error: ${error.message || 'Unknown error'}`);

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to send push notification',
      error: error.message
    });
  }
}

module.exports = {
  sendNotification
};
