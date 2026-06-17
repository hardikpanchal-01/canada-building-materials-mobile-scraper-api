const { getNotificationSupabase } = require('../config/notificationDatabase');
const { getMessaging } = require('../config/Firebase');

const FCM_BATCH_SIZE = 500;

/**
 * Check if FCM error indicates invalid/expired token
 */
function isInvalidTokenError(error) {
  if (!error || !error.code) {
    return false;
  }

  const invalidTokenCodes = [
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered',
    'messaging/invalid-argument'
  ];

  return invalidTokenCodes.includes(error.code) ||
         error.message?.includes('invalid') ||
         error.message?.includes('not registered') ||
         error.message?.includes('expired');
}

/**
 * Send push notification to a single device
 */
async function sendPushNotification(deviceToken, title, body, data = {}) {
  try {
    const messaging = getMessaging();

    const message = {
      token: deviceToken,
      notification: { title, body },
      data: data ? Object.keys(data).reduce((acc, key) => {
        acc[key] = String(data[key]);
        return acc;
      }, {}) : {}
    };

    const response = await messaging.send(message);

    return {
      success: true,
      messageId: response,
      successCount: 1,
      failureCount: 0,
      responses: [{ token: deviceToken, success: true, error: null }]
    };
  } catch (error) {
    const isInvalid = isInvalidTokenError(error);

    return {
      success: false,
      messageId: null,
      successCount: 0,
      failureCount: 1,
      responses: [{
        token: deviceToken,
        success: false,
        error: { code: error.code || 'unknown', message: error.message || 'Unknown error' },
        isInvalidToken: isInvalid
      }]
    };
  }
}

/**
 * Send push notification to multiple devices
 */
async function sendPushNotificationToMultiple(deviceTokens, title, body, data = {}) {
  try {
    const messaging = getMessaging();

    if (!Array.isArray(deviceTokens) || deviceTokens.length === 0) {
      throw new Error('deviceTokens must be a non-empty array');
    }

    if (deviceTokens.length > FCM_BATCH_SIZE) {
      return await sendPushNotificationToMultipleBatched(deviceTokens, title, body, data);
    }

    const message = {
      notification: { title, body },
      data: data ? Object.keys(data).reduce((acc, key) => {
        acc[key] = String(data[key]);
        return acc;
      }, {}) : {},
      tokens: deviceTokens
    };

    const response = await messaging.sendEachForMulticast(message);

    return {
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses.map((resp, index) => ({
        token: deviceTokens[index],
        success: resp.success,
        error: resp.error ? { code: resp.error.code || 'unknown', message: resp.error.message || 'Unknown error' } : null,
        isInvalidToken: resp.error ? isInvalidTokenError(resp.error) : false
      }))
    };
  } catch (error) {
    throw new Error(`Failed to send push notifications: ${error.message}`);
  }
}

/**
 * Send push notifications in batches (for large token lists)
 */
async function sendPushNotificationToMultipleBatched(deviceTokens, title, body, data = {}) {
  const batches = [];
  for (let i = 0; i < deviceTokens.length; i += FCM_BATCH_SIZE) {
    batches.push(deviceTokens.slice(i, i + FCM_BATCH_SIZE));
  }

  const results = await Promise.allSettled(
    batches.map(batch => sendPushNotificationToMultiple(batch, title, body, data))
  );

  let totalSuccess = 0;
  let totalFailure = 0;
  const allResponses = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      totalSuccess += result.value.successCount;
      totalFailure += result.value.failureCount;
      allResponses.push(...result.value.responses);
    } else {
      totalFailure += FCM_BATCH_SIZE;
    }
  }

  return {
    success: true,
    successCount: totalSuccess,
    failureCount: totalFailure,
    responses: allResponses
  };
}

/**
 * Get active device tokens for a user from notification Supabase
 */
async function getUserDeviceTokens(userId) {
  const supabase = getNotificationSupabase();

  const { data, error } = await supabase
    .from('user_devices')
    .select('device_token')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (error) throw new Error(`Failed to fetch device tokens: ${error.message}`);

  return (data || []).map(d => d.device_token).filter(Boolean);
}

/**
 * Check single device token in notification Supabase
 */
async function checkDeviceToken(deviceToken) {
  const supabase = getNotificationSupabase();

  const { data, error } = await supabase
    .from('user_devices')
    .select('id, user_id, device_id, device_token, device_name, device_type, is_active')
    .eq('device_token', deviceToken)
    .eq('is_active', true)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('⚠️  Error checking device token:', error.message);
    return null;
  }

  return data || null;
}

/**
 * Batch check device tokens in notification Supabase
 */
async function batchCheckDeviceTokens(deviceTokens) {
  if (!Array.isArray(deviceTokens) || deviceTokens.length === 0) return {};

  const supabase = getNotificationSupabase();

  const { data, error } = await supabase
    .from('user_devices')
    .select('id, user_id, device_id, device_token, device_name, device_type, is_active')
    .in('device_token', deviceTokens)
    .eq('is_active', true);

  if (error) {
    console.error('⚠️  Error batch checking device tokens:', error.message);
    return {};
  }

  const tokenMap = {};
  (data || []).forEach(device => {
    tokenMap[device.device_token] = device;
  });

  return tokenMap;
}

/**
 * Batch deactivate invalid tokens in notification Supabase
 */
async function batchDeactivateTokens(deviceTokens) {
  if (!Array.isArray(deviceTokens) || deviceTokens.length === 0) return 0;

  const supabase = getNotificationSupabase();

  const { data, error } = await supabase
    .from('user_devices')
    .update({ is_active: false })
    .in('device_token', deviceTokens)
    .eq('is_active', true)
    .select('id');

  if (error) {
    console.error('⚠️  Error deactivating tokens:', error.message);
    return 0;
  }

  return data?.length || 0;
}

module.exports = {
  sendPushNotification,
  sendPushNotificationToMultiple,
  getUserDeviceTokens,
  checkDeviceToken,
  batchCheckDeviceTokens,
  batchDeactivateTokens,
  isInvalidTokenError
};
