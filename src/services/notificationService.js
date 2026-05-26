const deviceService = require('./deviceService');
const {
  isInvalidTokenError,
  sendPushNotification,
  sendPushNotificationToMultiple
} = require('./notificationPushService');

/**
 * Send notification to all active devices for a user
 * @param {string} userId - User ID
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {Object} data - Optional custom data payload
 * @returns {Promise<Object>} Notification result
 */
async function sendNotificationToUser(userId, title, body, data = {}) {
  try {
    if (!userId) {
      throw new Error('user_id is required');
    }

    const deviceTokens = await deviceService.getUserDeviceTokens(userId);

    if (deviceTokens.length === 0) {
      return {
        success: true,
        message: 'User has no active devices',
        successCount: 0,
        failureCount: 0,
        responses: []
      };
    }

    return await sendPushNotificationToMultiple(deviceTokens, title, body, data);
  } catch (error) {
    throw new Error(`Failed to send notification to user: ${error.message}`);
  }
}

module.exports = {
  sendPushNotification,
  sendPushNotificationToMultiple,
  sendNotificationToUser,
  isInvalidTokenError
};
