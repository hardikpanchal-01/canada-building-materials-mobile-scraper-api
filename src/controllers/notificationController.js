const notificationService = require('../services/notificationService');
const deviceService = require('../services/deviceService');
const { getSupabase } = require('../config/database');

/**
 * Batch check device tokens in database (fixes N+1 query issue)
 * @param {Array<string>} deviceTokens - Array of device tokens to check
 * @returns {Promise<Object>} Map of deviceToken -> deviceInfo or null
 */
async function batchCheckDeviceTokensInDatabase(deviceTokens) {
  try {
    if (!Array.isArray(deviceTokens) || deviceTokens.length === 0) {
      return {};
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('user_devices')
      .select('id, user_id, device_id, device_token, device_name, device_type, is_active')
      .in('device_token', deviceTokens)
      .eq('is_active', true);

    if (error) {
      console.error('⚠️  Error batch checking device tokens:', error.message);
      return {};
    }

    // Create map for quick lookup
    const tokenMap = {};
    (data || []).forEach(device => {
      tokenMap[device.device_token] = device;
    });

    return tokenMap;
  } catch (error) {
    console.error('⚠️  Error batch checking device tokens:', error.message);
    return {};
  }
}

/**
 * Check if device token exists in database (single token)
 * @param {string} deviceToken - Device token to check
 * @returns {Promise<Object|null>} Device record or null
 */
async function checkDeviceTokenInDatabase(deviceToken) {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('user_devices')
      .select('id, user_id, device_id, device_token, device_name, device_type, is_active')
      .eq('device_token', deviceToken)
      .eq('is_active', true)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('⚠️  Error checking device token in database:', error.message);
      return null;
    }

    return data || null;
  } catch (error) {
    console.error('⚠️  Error checking device token:', error.message);
    return null;
  }
}

/**
 * Handle push notification failures and deactivate invalid tokens
 * @param {Array} responses - Array of notification responses
 */
async function handlePushFailures(responses) {
  if (!Array.isArray(responses)) {
    return;
  }

  const invalidTokens = [];
  
  responses.forEach(response => {
    if (!response.success && response.isInvalidToken) {
      invalidTokens.push(response.token);
    }
  });

  if (invalidTokens.length > 0) {
    try {
      await deviceService.batchDeactivateTokens(invalidTokens);
    } catch (error) {
      console.error('⚠️  Error deactivating invalid tokens:', error.message);
    }
  }
}

/**
 * @swagger
 * /api/notifications/send:
 *   post:
 *     summary: Send push notification to device(s) or user
 *     description: |
 *       Sends a push notification to one or more devices using Firebase Cloud Messaging (FCM).
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
 *       - `data`: Optional custom data payload (object)
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
 *                 description: User ID to send notification to all active devices
 *                 example: "user-uuid-here"
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
 *                 description: Optional custom data payload
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
 *                 userId: "user-uuid-here"
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
 *                   description: Response data (varies for single vs multiple)
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       description: For single device
 *                     messageId:
 *                       type: string
 *                       description: FCM message ID (for single device)
 *                     successCount:
 *                       type: number
 *                       description: Number of successful sends (for multiple devices)
 *                     failureCount:
 *                       type: number
 *                       description: Number of failed sends (for multiple devices)
 *       400:
 *         description: Validation error (missing title, body, or device token)
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       500:
 *         description: Server error or FCM service error
 */
async function sendNotification(req, res) {
  const timestamp = new Date().toISOString();
  const user = req.user; // User from authenticate middleware

  try {
    const { deviceToken, deviceTokens, userId, title, body, data } = req.body;

    // Validate required fields
    if (!title) {
      return res.status(400).json({
        success: false,
        message: 'Title is required'
      });
    }

    if (!body) {
      return res.status(400).json({
        success: false,
        message: 'Body is required'
      });
    }

    // Validate that at least one targeting method is provided
    if (!deviceToken && !deviceTokens && !userId) {
      return res.status(400).json({
        success: false,
        message: 'Either deviceToken, deviceTokens, or userId is required'
      });
    }

    // Validate deviceTokens is an array if provided
    if (deviceTokens && !Array.isArray(deviceTokens)) {
      return res.status(400).json({
        success: false,
        message: 'deviceTokens must be an array'
      });
    }

    // Validate deviceTokens array is not empty
    if (deviceTokens && deviceTokens.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'deviceTokens array cannot be empty'
      });
    }

    let result;
    let deviceInfo = null;

    // Send to user (all active devices)
    if (userId) {
      // Validate user ownership if current user is not admin
      if (user.id !== userId && user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'You can only send notifications to your own devices'
        });
      }

      result = await notificationService.sendNotificationToUser(userId, title, body, data);

      // Handle push failures
      if (result.responses) {
        await handlePushFailures(result.responses);
      }
    }
    // Send to single device
    else if (deviceToken) {
      result = await notificationService.sendPushNotification(
        deviceToken,
        title,
        body,
        data
      );

      // Handle push failures
      if (result.responses) {
        await handlePushFailures(result.responses);
      }
    }
    // Send to multiple devices
    else if (deviceTokens) {
      result = await notificationService.sendPushNotificationToMultiple(
        deviceTokens,
        title,
        body,
        data
      );

      // Handle push failures
      if (result.responses) {
        await handlePushFailures(result.responses);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Push notification sent successfully',
      data: result
    });
  } catch (error) {
    console.error(`Notification send error: ${error.message || 'Unknown error'}`);

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
