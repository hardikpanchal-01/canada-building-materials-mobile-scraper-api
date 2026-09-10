const { executeDirectSQL } = require('../utils/postgresExecutor');
const { executeAuthSQL } = require('../config/authPostgres');
const { verifyPassword, hashPassword } = require('../utils/encryptionUtils');
const { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } = require('../utils/jwtUtils');
const deviceService = require('./deviceService');
const { loadUserAccessData } = require('../middleware/auth');

/**
 * Fetch an auth user row (auth.users) by a column, excluding deleted/banned checks
 * are done by callers. Returns null when not found.
 */
async function getAuthUserBy(column, value) {
  const result = await executeDirectSQL(
    `SELECT id, email, phone, role, encrypted_password, raw_user_meta_data, deleted_at, created_at
     FROM auth.users
     WHERE ${column} = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [value]
  );
  return result.data.length > 0 ? result.data[0] : null;
}

/**
 * Record a successful sign-in the same way the previous auth backend did:
 * auth.users.last_sign_in_at and public.users.last_login_at.
 * Best-effort — never fails the login.
 */
async function recordSignIn(authUserId, email) {
  try {
    await executeDirectSQL(
      'UPDATE auth.users SET last_sign_in_at = NOW(), updated_at = NOW() WHERE id = $1',
      [authUserId]
    );
    await executeDirectSQL(
      'UPDATE users SET last_login_at = NOW() WHERE email = $1',
      [email.toLowerCase().trim()]
    );
  } catch (err) {
    console.error('Failed to record sign-in timestamps:', err.message);
  }
}

/**
 * Login with email and password against PostgreSQL (auth.users)
 * @param {string} email - User email
 * @param {string} password - User password
 * @param {Object} deviceInfo - Optional device information
 * @returns {Object} User data and tokens
 */
async function loginWithEmail(email, password, deviceInfo = null) {
  try {
    const normalizedEmail = email.toLowerCase().trim();

    // ---------------------------------------------------------------
    // Pre-auth checks: block users with incomplete signup or pending approval
    // ---------------------------------------------------------------

    // Check if user is still in signup_pending (incomplete signup)
    const pendingResult = await executeDirectSQL(
      `SELECT email_verified, phone_number, phone_country_code
       FROM signup_pending WHERE email = $1 LIMIT 1`,
      [normalizedEmail]
    );

    if (pendingResult.data.length > 0) {
      const pending = pendingResult.data[0];
      if (!pending.email_verified) {
        throw new Error('Email not verified. Please complete email verification first.');
      }
      if (!pending.phone_number || !pending.phone_country_code) {
        throw new Error('Phone number not verified. Please complete phone verification first.');
      }
      // If pending record exists with email verified but still in table → phone not verified
      throw new Error('Phone number not verified. Please complete phone verification first.');
    }

    // Check if user exists in database
    const profileResult = await executeDirectSQL(
      'SELECT active FROM users WHERE email = $1 LIMIT 1',
      [normalizedEmail]
    );

    if (profileResult.data.length === 0) {
      throw new Error('User not found');
    }

    // ---------------------------------------------------------------
    // Authenticate against auth.users (bcrypt)
    // ---------------------------------------------------------------
    const authUser = await getAuthUserBy('email', normalizedEmail);

    if (!authUser) {
      throw new Error('Invalid email or password');
    }

    const passwordValid = await verifyPassword(password, authUser.encrypted_password);
    if (!passwordValid) {
      throw new Error('Invalid email or password');
    }

    // Record sign-in timestamps (non-blocking behavior preserved by best-effort call)
    await recordSignIn(authUser.id, normalizedEmail);

    // Load user access data to determine userType (admin, producer, contractor, none)
    const accessData = await loadUserAccessData(authUser.id);

    // Get user metadata
    const user = {
      id: authUser.id,
      email: authUser.email,
      phone: authUser.phone,
      role: authUser.role || 'user',
      userType: accessData.userType || 'none',
      userRole: accessData.userRole || null,
      metadata: authUser.raw_user_meta_data
    };

    // Register/update device if device info is provided
    if (deviceInfo) {
      try {
        await deviceService.registerOrUpdateDevice(user.id, deviceInfo);
      } catch (deviceError) {
        // Log device registration error but don't fail login
        console.error('Device registration failed:', deviceError.message);
      }
    }

    // Generate JWT tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    return {
      user,
      accessToken,
      refreshToken,
      session: null
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Login with phone and password against PostgreSQL (auth.users)
 * @param {string} phone - User phone number
 * @param {string} password - User password
 * @param {Object} deviceInfo - Optional device information
 * @returns {Object} User data and tokens
 */
async function loginWithPhone(phone, password, deviceInfo = null) {
  try {
    // ---------------------------------------------------------------
    // Authenticate against auth.users by phone (bcrypt)
    // ---------------------------------------------------------------
    const authUser = await getAuthUserBy('phone', phone);

    if (!authUser) {
      throw new Error('Invalid phone number or password');
    }

    // Pre-auth check: block users pending admin approval
    if (authUser.email) {
      const profileResult = await executeDirectSQL(
        'SELECT active FROM users WHERE email = $1 LIMIT 1',
        [authUser.email.toLowerCase()]
      );
      if (profileResult.data.length > 0 && !profileResult.data[0].active) {
        throw new Error('Your account is pending admin approval. You will be notified via email or phone once approved.');
      }
    }

    const passwordValid = await verifyPassword(password, authUser.encrypted_password);
    if (!passwordValid) {
      throw new Error('Invalid phone number or password');
    }

    await recordSignIn(authUser.id, authUser.email || '');

    // Load user access data to determine userType (admin, producer, contractor, none)
    const accessData = await loadUserAccessData(authUser.id);

    // Get user metadata
    const user = {
      id: authUser.id,
      email: authUser.email,
      phone: authUser.phone,
      role: authUser.role || 'user',
      userType: accessData.userType || 'none',
      userRole: accessData.userRole || null,
      metadata: authUser.raw_user_meta_data
    };

    // Register/update device if device info is provided
    if (deviceInfo) {
      try {
        await deviceService.registerOrUpdateDevice(user.id, deviceInfo);
      } catch (deviceError) {
        console.error('Device registration failed:', deviceError.message);
      }
    }

    // Generate JWT tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    return {
      user,
      accessToken,
      refreshToken,
      session: null
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Logout user - deactivate device token
 * (JWT tokens are stateless; invalidation relies on token expiration)
 * @param {string} userId - User ID
 * @param {string} accessToken - Access token (kept for signature compatibility)
 * @param {string} deviceToken - Optional device token to deactivate
 * @returns {boolean} Success status
 */
async function logout(userId, accessToken, deviceToken = null) {
  try {
    // Deactivate device token if provided
    if (deviceToken) {
      try {
        await deviceService.deactivateDeviceToken(deviceToken);
      } catch (deviceError) {
        // Log device deactivation error but don't fail logout
        console.error('⚠️  Device token deactivation failed during logout:', deviceError.message);
      }
    }

    // In a production system, you might want to:
    // 1. Store blacklisted tokens in Redis/database
    // 2. Invalidate refresh tokens
    // For now, we'll rely on token expiration

    return true;
  } catch (error) {
    throw error;
  }
}

/**
 * Refresh access token using refresh token
 * @param {string} refreshToken - Refresh token
 * @returns {Object} New access token and optionally new refresh token
 */
async function refreshToken(refreshToken) {
  try {
    // Verify refresh token
    const decoded = verifyRefreshToken(refreshToken);

    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type');
    }

    // Use user data from refresh token (includes id, email, phone, role)
    // The refresh token now contains user information for token refresh
    const userData = {
      id: decoded.id,
      email: decoded.email || null,
      phone: decoded.phone || null,
      role: decoded.role || 'user'
    };
    const newAccessToken = generateAccessToken(userData);

    // Optionally generate new refresh token (token rotation)
    // const newRefreshToken = generateRefreshToken(userData);

    return {
      accessToken: newAccessToken
      // refreshToken: newRefreshToken // Uncomment for token rotation
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Get current user by ID (auth.users)
 * @param {string} userId - User UUID (from JWT)
 * @returns {Object} User data
 */
async function getCurrentUser(userId) {
  try {
    const authUser = userId ? await getAuthUserBy('id', userId) : null;

    if (!authUser) {
      throw new Error('User not found or session expired');
    }

    return {
      id: authUser.id,
      email: authUser.email,
      phone: authUser.phone,
      role: authUser.role || 'user',
      metadata: authUser.raw_user_meta_data,
      createdAt: authUser.created_at
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Verify JWT token
 * @param {string} token - JWT token
 * @returns {Object} Decoded token data
 */
function verifyToken(token) {
  return verifyAccessToken(token);
}

/**
 * Change user password
 * @param {string} userId - User ID
 * @param {string} userEmail - User email
 * @param {string} currentPassword - Current password
 * @param {string} newPassword - New password
 * @param {string} confirmPassword - Confirm new password
 * @returns {Object} Result object
 */
async function changePassword(userId, userEmail, currentPassword, newPassword, confirmPassword) {
  try {
    // Validate new password and confirm password match
    if (newPassword !== confirmPassword) {
      return {
        success: false,
        error: 'New password and confirm password do not match',
        code: 'PASSWORD_MISMATCH'
      };
    }

    // Validate new password length
    if (!newPassword || newPassword.length < 6) {
      return {
        success: false,
        error: 'New password must be at least 6 characters long',
        code: 'PASSWORD_TOO_SHORT'
      };
    }

    // Validate new password is different from current
    if (currentPassword === newPassword) {
      return {
        success: false,
        error: 'New password must be different from current password',
        code: 'SAME_PASSWORD'
      };
    }

    // Step 1: Verify current password against auth.users
    const authUser = await getAuthUserBy('email', userEmail.toLowerCase().trim());

    if (!authUser || !(await verifyPassword(currentPassword, authUser.encrypted_password))) {
      return {
        success: false,
        error: 'Current password is incorrect',
        code: 'INVALID_CURRENT_PASSWORD'
      };
    }

    // Step 2: Update password hash in auth.users
    const newHash = await hashPassword(newPassword);
    const updateResult = await executeDirectSQL(
      'UPDATE auth.users SET encrypted_password = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
      [newHash, authUser.id]
    );

    if (updateResult.data.length === 0) {
      console.error('Error updating password: no auth user row updated');
      return {
        success: false,
        error: 'Failed to update password. Please try again.',
        code: 'UPDATE_FAILED'
      };
    }

    // Step 3: Keep the central auth store (public.users) in sync so
    // mobile federated login accepts the new password too. Best-effort.
    try {
      await executeAuthSQL(
        'UPDATE public.users SET password_hash = $1, updated_at = NOW() WHERE email = $2 AND deleted_at IS NULL',
        [newHash, userEmail.toLowerCase().trim()]
      );
    } catch (syncError) {
      console.error('Warning: failed to sync new password to public.users:', syncError.message);
    }

    return {
      success: true,
      message: 'Password changed successfully'
    };
  } catch (error) {
    console.error('Error in changePassword:', error.message);
    return {
      success: false,
      error: error.message || 'An unexpected error occurred',
      code: 'UNEXPECTED_ERROR'
    };
  }
}

module.exports = {
  loginWithEmail,
  loginWithPhone,
  logout,
  refreshToken,
  getCurrentUser,
  verifyToken,
  changePassword
};
