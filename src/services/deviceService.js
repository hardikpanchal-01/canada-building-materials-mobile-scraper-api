const { executeDirectSQL } = require('../utils/postgresExecutor');

// Configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 1000; // 1 second base delay
const MAX_DEVICES_PER_USER = parseInt(process.env.MAX_DEVICES_PER_USER) || 10;
const TOKEN_CLEANUP_DAYS = parseInt(process.env.TOKEN_CLEANUP_DAYS) || 90;

// Valid device types
const VALID_DEVICE_TYPES = ['android', 'ios', 'web'];

/**
 * Retry helper with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum retry attempts
 * @param {Function} shouldRetry - Function to determine if error should be retried
 * @returns {Promise<any>} Result of the function
 */
async function retryWithBackoff(fn, maxRetries = MAX_RETRIES, shouldRetry = null) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }

      // Don't retry validation errors or duplicate constraint violations
      if (error.message?.includes('validation') ||
          error.message?.includes('duplicate') ||
          error.code === '23505') { // PostgreSQL unique violation
        throw error;
      }

      // If not the last attempt, wait before retrying
      if (attempt < maxRetries) {
        const delay = RETRY_DELAY_BASE * attempt; // Exponential backoff: 1s, 2s, 3s
        console.warn(`Device operation attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms:`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
    }
  }

  throw lastError || new Error('Operation failed after all retries');
}

/**
 * Validate device token format
 * Supports FCM tokens (150+ chars, base64-like) and APNs tokens (64 hex chars)
 * @param {string} deviceToken - Device token to validate
 * @returns {boolean} True if valid
 */
function validateDeviceToken(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') {
    return false;
  }

  const trimmed = deviceToken.trim();

  // Minimum 20 characters (APNs hex tokens are 64 chars, FCM ~152+, but allow shorter for dev/test)
  if (trimmed.length < 20) {
    return false;
  }

  // Allow alphanumeric, hyphens, underscores, colons, dots, slashes, equals, plus
  // These cover FCM (base64-like with colons) and APNs (hex strings) token formats
  const tokenPattern = /^[a-zA-Z0-9_\-:.\/+=]+$/;
  return tokenPattern.test(trimmed);
}

/**
 * Validate and sanitize device metadata
 * @param {Object} deviceInfo - Device information
 * @returns {Object} Sanitized device info
 */
function validateAndSanitizeDeviceInfo(deviceInfo) {
  const sanitized = {};

  // Validate device_type
  if (deviceInfo.device_type) {
    const deviceType = deviceInfo.device_type.toLowerCase().trim();
    if (VALID_DEVICE_TYPES.includes(deviceType)) {
      sanitized.device_type = deviceType;
    } else {
      throw new Error(`Invalid device_type. Must be one of: ${VALID_DEVICE_TYPES.join(', ')}`);
    }
  }

  // Sanitize string fields (prevent XSS, limit length)
  const stringFields = ['device_name', 'device_model', 'os_version', 'app_version'];
  stringFields.forEach(field => {
    if (deviceInfo[field]) {
      // Remove HTML tags and limit length
      let value = String(deviceInfo[field]).trim();
      value = value.replace(/<[^>]*>/g, ''); // Remove HTML tags
      if (value.length > 255) {
        value = value.substring(0, 255);
      }
      sanitized[field] = value || null;
    }
  });

  return sanitized;
}

/**
 * Register or update user device
 * Uses device_token as unique identifier to support multiple devices per user
 * @param {string} userId - User ID
 * @param {Object} deviceInfo - Device information
 * @param {string} deviceInfo.device_token - FCM device token (required)
 * @param {string} deviceInfo.device_id - Device ID (optional, defaults to device_token)
 * @param {string} deviceInfo.device_type - Device type (optional: android, ios, web)
 * @param {string} deviceInfo.device_name - Device name (optional)
 * @param {string} deviceInfo.device_model - Device model (optional)
 * @param {string} deviceInfo.os_version - OS version (optional)
 * @param {string} deviceInfo.app_version - App version (optional)
 * @returns {Promise<Object>} Device record
 */
async function registerOrUpdateDevice(userId, deviceInfo) {
  try {
    // Validate required fields
    if (!userId) {
      throw new Error('user_id is required');
    }
    if (!deviceInfo.device_token) {
      throw new Error('device_token is required');
    }

    // Validate device token format
    if (!validateDeviceToken(deviceInfo.device_token)) {
      throw new Error('Invalid device_token format');
    }

    // Validate and sanitize device info
    const sanitized = validateAndSanitizeDeviceInfo(deviceInfo);

    // Use device_token as device_id if not provided
    const deviceId = deviceInfo.device_id || deviceInfo.device_token;

    const now = new Date().toISOString();

    // Check if device_token already exists (may have duplicates, so use limit(1))
    const checkDevice = async () => {
      try {
        const result = await executeDirectSQL(
          'SELECT id, user_id FROM user_devices WHERE device_token = $1 LIMIT 1',
          [deviceInfo.device_token]
        );
        return result.data && result.data.length > 0 ? result.data[0] : null;
      } catch (checkError) {
        throw new Error(`Error checking device: ${checkError.message}`);
      }
    };

    const existingDevice = await retryWithBackoff(checkDevice);

    // If device_token exists, check if it belongs to a different user (security check)
    if (existingDevice && existingDevice.user_id !== userId) {
      console.warn(`⚠️  Security: Device token ${deviceInfo.device_token.substring(0, 20)}... is being reused by different user. Original user: ${existingDevice.user_id}, New user: ${userId}`);
      // Log security event but allow update (token refresh scenario)
      // The token will be updated to the new user
    }

    const deviceData = {
      user_id: userId,
      device_token: deviceInfo.device_token.trim(),
      device_id: deviceId,
      device_type: sanitized.device_type || null,
      device_name: sanitized.device_name || null,
      device_model: sanitized.device_model || null,
      os_version: sanitized.os_version || null,
      app_version: sanitized.app_version || null,
      is_active: true,
      last_active_at: now
    };

    // Shared UPDATE ... RETURNING * for the update-by-token paths
    const updateDeviceByToken = async (tokenValue) => {
      const result = await executeDirectSQL(
        `UPDATE user_devices
         SET user_id = $1, device_token = $2, device_id = $3, device_type = $4,
             device_name = $5, device_model = $6, os_version = $7, app_version = $8,
             is_active = $9, last_active_at = $10
         WHERE device_token = $11
         RETURNING *`,
        [
          deviceData.user_id, deviceData.device_token, deviceData.device_id,
          deviceData.device_type, deviceData.device_name, deviceData.device_model,
          deviceData.os_version, deviceData.app_version, deviceData.is_active,
          deviceData.last_active_at, tokenValue
        ]
      );
      return result.data && result.data.length > 0 ? result.data[0] : null;
    };

    let result;

    if (existingDevice) {
      // Update existing device by device_token (may match multiple rows)
      const updateDevice = async () => {
        try {
          return await updateDeviceByToken(deviceInfo.device_token);
        } catch (error) {
          throw new Error(`Error updating device: ${error.message}`);
        }
      };

      result = await retryWithBackoff(updateDevice);
      console.log(`✅ Device updated: ${deviceInfo.device_token.substring(0, 20)}... for user ${userId}`);
    } else {
      // Check device limit before inserting
      // (errors in this limit-check path are ignored, matching the original behavior)
      try {
        const countResult = await executeDirectSQL(
          'SELECT count(*)::int AS count FROM user_devices WHERE user_id = $1 AND is_active = true',
          [userId]
        );
        const activeCount = countResult.data && countResult.data.length > 0 ? countResult.data[0].count : 0;

        if (activeCount >= MAX_DEVICES_PER_USER) {
          // Deactivate oldest inactive device or oldest active device
          const oldestResult = await executeDirectSQL(
            'SELECT id FROM user_devices WHERE user_id = $1 ORDER BY last_active_at ASC LIMIT 1',
            [userId]
          );

          const oldestDevice = oldestResult.data && oldestResult.data.length > 0 ? oldestResult.data[0] : null;
          if (oldestDevice) {
            await executeDirectSQL(
              'UPDATE user_devices SET is_active = false WHERE id = $1',
              [oldestDevice.id]
            );

            console.log(`⚠️  Device limit reached for user ${userId}, deactivated oldest device`);
          }
        }
      } catch (limitError) {
        // Original code ignored errors in the device-limit check
      }

      // Insert new device
      const insertDevice = async () => {
        try {
          const insertResult = await executeDirectSQL(
            `INSERT INTO user_devices
               (user_id, device_token, device_id, device_type, device_name,
                device_model, os_version, app_version, is_active, last_active_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING *`,
            [
              deviceData.user_id, deviceData.device_token, deviceData.device_id,
              deviceData.device_type, deviceData.device_name, deviceData.device_model,
              deviceData.os_version, deviceData.app_version, deviceData.is_active,
              deviceData.last_active_at, now
            ]
          );
          return insertResult.data && insertResult.data.length > 0 ? insertResult.data[0] : null;
        } catch (error) {
          // Handle duplicate token error gracefully
          if (error.code === '23505' || error.message?.includes('duplicate')) {
            // Token was inserted between check and insert, try update instead
            try {
              return await updateDeviceByToken(deviceInfo.device_token.trim());
            } catch (updateError) {
              throw new Error(`Error registering device: ${updateError.message}`);
            }
          }
          throw new Error(`Error registering device: ${error.message}`);
        }
      };

      result = await retryWithBackoff(insertDevice);
      console.log(`✅ Device registered: ${deviceInfo.device_token.substring(0, 20)}... for user ${userId}`);
    }

    return result;
  } catch (error) {
    console.error('❌ Device registration error:', error.message);
    throw error;
  }
}

/**
 * Deactivate a device token
 * @param {string} deviceToken - Device token to deactivate
 * @returns {Promise<boolean>} Success status
 */
async function deactivateDeviceToken(deviceToken) {
  try {
    if (!deviceToken) {
      throw new Error('device_token is required');
    }

    const deactivate = async () => {
      try {
        const result = await executeDirectSQL(
          'UPDATE user_devices SET is_active = false WHERE device_token = $1 RETURNING id',
          [deviceToken]
        );
        return result.data && result.data.length > 0;
      } catch (error) {
        throw new Error(`Error deactivating device: ${error.message}`);
      }
    };

    const success = await retryWithBackoff(deactivate);

    if (success) {
      console.log(`✅ Device token deactivated: ${deviceToken.substring(0, 20)}...`);
    } else {
      console.log(`⚠️  Device token not found for deactivation: ${deviceToken.substring(0, 20)}...`);
    }

    return success;
  } catch (error) {
    console.error('❌ Error deactivating device token:', error.message);
    throw error;
  }
}

/**
 * Deactivate a specific device token for a user
 * @param {string} userId - User ID
 * @param {string} deviceToken - Device token to deactivate
 * @returns {Promise<boolean>} Success status
 */
async function deactivateUserDeviceToken(userId, deviceToken) {
  try {
    if (!userId || !deviceToken) {
      throw new Error('user_id and device_token are required');
    }

    // Verify token belongs to user before deactivating
    let devices = null;
    try {
      const checkResult = await executeDirectSQL(
        'SELECT id FROM user_devices WHERE device_token = $1 AND user_id = $2 LIMIT 1',
        [deviceToken, userId]
      );
      devices = checkResult.data;
    } catch (checkError) {
      devices = null;
    }

    if (!devices || devices.length === 0) {
      throw new Error('Device token not found or does not belong to user');
    }

    return await deactivateDeviceToken(deviceToken);
  } catch (error) {
    console.error('❌ Error deactivating user device token:', error.message);
    throw error;
  }
}

/**
 * Deactivate all devices for a user
 * @param {string} userId - User ID
 * @returns {Promise<number>} Number of devices deactivated
 */
async function deactivateAllUserDevices(userId) {
  try {
    if (!userId) {
      throw new Error('user_id is required');
    }

    const deactivate = async () => {
      try {
        const result = await executeDirectSQL(
          'UPDATE user_devices SET is_active = false WHERE user_id = $1 AND is_active = true RETURNING id',
          [userId]
        );
        return result.data?.length || 0;
      } catch (error) {
        throw new Error(`Error deactivating devices: ${error.message}`);
      }
    };

    const count = await retryWithBackoff(deactivate);
    console.log(`✅ Deactivated ${count} device(s) for user ${userId}`);

    return count;
  } catch (error) {
    console.error('❌ Error deactivating all user devices:', error.message);
    throw error;
  }
}

/**
 * Handle invalid token (deactivate on push failure)
 * @param {string} deviceToken - Invalid device token
 * @returns {Promise<boolean>} Success status
 */
async function handleInvalidToken(deviceToken) {
  try {
    console.log(`🔧 Handling invalid token: ${deviceToken.substring(0, 20)}...`);
    return await deactivateDeviceToken(deviceToken);
  } catch (error) {
    console.error('❌ Error handling invalid token:', error.message);
    // Don't throw - this is cleanup, shouldn't break the flow
    return false;
  }
}

/**
 * Get all active devices for a user
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of device records
 */
async function getUserDevices(userId) {
  try {
    if (!userId) {
      throw new Error('user_id is required');
    }

    const fetchDevices = async () => {
      try {
        const result = await executeDirectSQL(
          'SELECT * FROM user_devices WHERE user_id = $1 AND is_active = true ORDER BY last_active_at DESC',
          [userId]
        );
        return result.data || [];
      } catch (error) {
        throw new Error(`Error fetching devices: ${error.message}`);
      }
    };

    return await retryWithBackoff(fetchDevices);
  } catch (error) {
    console.error('❌ Error fetching user devices:', error.message);
    throw error;
  }
}

/**
 * Get device tokens for a user (for push notifications).
 *
 * Returns AT MOST ONE token -- the most recently active one. Multiple
 * rows for the same physical phone accumulate in user_devices over
 * time (FCM token refresh, app reinstall, tenant-switch re-registering
 * the token, occasionally a stamped device_type that doesn't match the
 * physical platform). Without this collapse, push fans out to every
 * surviving row and Firebase delivers each one to whichever installation
 * the token actually routes to -- multiple of which can be the same
 * physical phone -- so the user sees N banners for one logical message.
 *
 * Trade-off: a user who genuinely runs the app on two devices (e.g. an
 * Android phone *and* an iPhone for the same account) will only get the
 * push on the most-recently-active one. Accepted: that pattern is rare
 * compared to the common stale-token bug and is recoverable by the
 * unused device coming back online (which bumps last_active_at).
 */
async function getUserDeviceTokens(userId) {
  try {
    const devices = await getUserDevices(userId);
    for (const device of devices) {
      if (device.device_token) return [device.device_token];
    }
    return [];
  } catch (error) {
    throw error;
  }
}

/**
 * Batch get device tokens for multiple users
 * @param {Array<string>} userIds - Array of user IDs
 * @returns {Promise<Object>} Map of userId -> array of device tokens
 */
async function batchGetUserDeviceTokens(userIds) {
  try {
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return {};
    }

    let data;
    try {
      const result = await executeDirectSQL(
        `SELECT user_id, device_token, device_type, last_active_at
         FROM user_devices
         WHERE user_id = ANY($1) AND is_active = true
         ORDER BY last_active_at DESC`,
        [userIds]
      );
      data = result.data;
    } catch (error) {
      throw new Error(`Error batch fetching device tokens: ${error.message}`);
    }

    // Collapse to at most one token per user (most recently active).
    // See getUserDeviceTokens for the rationale -- keeps push fan-out
    // from hitting stale tokens that still resolve to the same physical
    // phone (which can happen even across rows stamped with a different
    // device_type if the column was set incorrectly during an old test
    // install or workspace switch).
    const seenUser = new Set();
    const result = {};
    userIds.forEach((userId) => {
      result[userId] = [];
    });

    (data || []).forEach((device) => {
      if (!device.device_token) return;
      if (seenUser.has(device.user_id)) return;
      seenUser.add(device.user_id);
      if (!result[device.user_id]) result[device.user_id] = [];
      result[device.user_id].push(device.device_token);
    });

    return result;
  } catch (error) {
    console.error('❌ Error batch fetching device tokens:', error.message);
    throw error;
  }
}

/**
 * Batch deactivate multiple device tokens
 * @param {Array<string>} deviceTokens - Array of device tokens to deactivate
 * @returns {Promise<number>} Number of tokens deactivated
 */
async function batchDeactivateTokens(deviceTokens) {
  try {
    if (!Array.isArray(deviceTokens) || deviceTokens.length === 0) {
      return 0;
    }

    // Process in batches of 100 to avoid query size limits
    const batchSize = 100;
    let totalDeactivated = 0;

    for (let i = 0; i < deviceTokens.length; i += batchSize) {
      const batch = deviceTokens.slice(i, i + batchSize);

      const deactivate = async () => {
        try {
          const result = await executeDirectSQL(
            'UPDATE user_devices SET is_active = false WHERE device_token = ANY($1) AND is_active = true RETURNING id',
            [batch]
          );
          return result.data?.length || 0;
        } catch (error) {
          throw new Error(`Error batch deactivating tokens: ${error.message}`);
        }
      };

      const count = await retryWithBackoff(deactivate);
      totalDeactivated += count;
    }

    console.log(`✅ Batch deactivated ${totalDeactivated} device token(s)`);
    return totalDeactivated;
  } catch (error) {
    console.error('❌ Error batch deactivating tokens:', error.message);
    throw error;
  }
}

/**
 * Cleanup inactive tokens older than specified days
 * @param {number} daysOld - Number of days of inactivity (default: 90)
 * @returns {Promise<number>} Number of tokens deleted
 */
async function cleanupInactiveTokens(daysOld = TOKEN_CLEANUP_DAYS) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    const cutoffISO = cutoffDate.toISOString();

    console.log(`🧹 Starting cleanup of inactive tokens older than ${daysOld} days (before ${cutoffISO})`);

    // Process in batches to avoid large deletions
    const batchSize = 1000;
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      const cleanup = async () => {
        // First, get IDs of tokens to delete
        let tokensToDelete;
        try {
          const selectResult = await executeDirectSQL(
            'SELECT id FROM user_devices WHERE is_active = false AND last_active_at < $1 LIMIT $2',
            [cutoffISO, batchSize]
          );
          tokensToDelete = selectResult.data;
        } catch (selectError) {
          throw new Error(`Error selecting tokens for cleanup: ${selectError.message}`);
        }

        if (!tokensToDelete || tokensToDelete.length === 0) {
          hasMore = false;
          return 0;
        }

        const ids = tokensToDelete.map(t => t.id);

        // Delete the tokens
        try {
          await executeDirectSQL(
            'DELETE FROM user_devices WHERE id = ANY($1)',
            [ids]
          );
        } catch (deleteError) {
          throw new Error(`Error deleting tokens: ${deleteError.message}`);
        }

        return ids.length;
      };

      const deleted = await retryWithBackoff(cleanup);
      totalDeleted += deleted;

      if (deleted < batchSize) {
        hasMore = false;
      }
    }

    console.log(`✅ Cleanup complete: Deleted ${totalDeleted} inactive token(s)`);
    return totalDeleted;
  } catch (error) {
    console.error('❌ Error cleaning up inactive tokens:', error.message);
    throw error;
  }
}

module.exports = {
  registerOrUpdateDevice,
  getUserDevices,
  getUserDeviceTokens,
  deactivateDeviceToken,
  deactivateUserDeviceToken,
  deactivateAllUserDevices,
  handleInvalidToken,
  batchGetUserDeviceTokens,
  batchDeactivateTokens,
  cleanupInactiveTokens
};
