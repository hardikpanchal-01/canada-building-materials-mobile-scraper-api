const { getSupabase, getSupabaseAdmin } = require('../config/database');
const { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } = require('../utils/jwtUtils');
const deviceService = require('./deviceService');
const { loadUserAccessData } = require('../middleware/auth');

/**
 * Login with email and password using Supabase Auth
 * @param {string} email - User email
 * @param {string} password - User password
 * @param {Object} deviceInfo - Optional device information
 * @returns {Object} User data and tokens
 */
async function loginWithEmail(email, password, deviceInfo = null) {
  try {
    const supabase = getSupabase();
    const supabaseAdmin = getSupabaseAdmin();
    const normalizedEmail = email.toLowerCase().trim();

    // ---------------------------------------------------------------
    // Pre-auth checks: block users with incomplete signup or pending approval
    // ---------------------------------------------------------------

    // Check if user is still in signup_pending (incomplete signup)
    const { data: pendingSignup } = await supabaseAdmin
      .from('signup_pending')
      .select('email_verified, phone_number, phone_country_code')
      .eq('email', normalizedEmail)
      .limit(1);

    if (pendingSignup && pendingSignup.length > 0) {
      const pending = pendingSignup[0];
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
    const { data: userProfile } = await supabaseAdmin
      .from('users')
      .select('active, user_type')
      .eq('email', normalizedEmail)
      .limit(1);

    if (!userProfile || userProfile.length === 0) {
      throw new Error('User not found');
    }

    // Check admin approval — ONLY for QR signup users
    const profile = userProfile[0];
    if (profile.user_type === 'QR' && !profile.active) {
      throw new Error('Your account is pending admin approval. You will be notified via email or phone once approved.');
    }

    // ---------------------------------------------------------------
    // Authenticate with Supabase Auth
    // ---------------------------------------------------------------
    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password
    });

    if (error) {
      throw new Error(error.message || 'Invalid email or password');
    }

    if (!data.user) {
      throw new Error('Authentication failed');
    }

    // Load user access data to determine userType (admin, producer, contractor, none)
    const accessData = await loadUserAccessData(data.user.id);

    // Get user metadata
    const user = {
      id: data.user.id,
      email: data.user.email,
      phone: data.user.phone,
      role: data.user.role || 'user',
      userType: accessData.userType || 'none',
      userRole: accessData.userRole || null,
      metadata: data.user.user_metadata
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
      session: data.session
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Login with phone and password using Supabase Auth
 * @param {string} phone - User phone number
 * @param {string} password - User password
 * @param {Object} deviceInfo - Optional device information
 * @returns {Object} User data and tokens
 */
async function loginWithPhone(phone, password, deviceInfo = null) {
  try {
    const supabase = getSupabase();
    const supabaseAdmin = getSupabaseAdmin();

    // ---------------------------------------------------------------
    // Pre-auth check: block users pending admin approval
    // Look up email from auth user by phone, then check public.users.active
    // ---------------------------------------------------------------
    const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (authUsers?.users) {
      const matchedAuth = authUsers.users.find(u => u.phone === phone);
      if (matchedAuth?.email) {
        const { data: userProfile } = await supabaseAdmin
          .from('users')
          .select('active')
          .eq('email', matchedAuth.email.toLowerCase())
          .limit(1);

        if (userProfile && userProfile.length > 0 && !userProfile[0].active) {
          throw new Error('Your account is pending admin approval. You will be notified via email or phone once approved.');
        }
      }
    }

    // ---------------------------------------------------------------
    // Authenticate with Supabase Auth using phone
    // ---------------------------------------------------------------
    const { data, error } = await supabase.auth.signInWithPassword({
      phone,
      password
    });

    if (error) {
      throw new Error(error.message || 'Invalid phone number or password');
    }

    if (!data.user) {
      throw new Error('Authentication failed');
    }

    // Load user access data to determine userType (admin, producer, contractor, none)
    const accessData = await loadUserAccessData(data.user.id);

    // Get user metadata
    const user = {
      id: data.user.id,
      email: data.user.email,
      phone: data.user.phone,
      role: data.user.role || 'user',
      userType: accessData.userType || 'none',
      userRole: accessData.userRole || null,
      metadata: data.user.user_metadata
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
      session: data.session
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Logout user - invalidate session and deactivate device token
 * @param {string} userId - User ID
 * @param {string} accessToken - Access token to invalidate
 * @param {string} deviceToken - Optional device token to deactivate
 * @returns {boolean} Success status
 */
async function logout(userId, accessToken, deviceToken = null) {
  try {
    const supabase = getSupabase();
    
    // Deactivate device token if provided
    if (deviceToken) {
      try {
        await deviceService.deactivateDeviceToken(deviceToken);
      } catch (deviceError) {
        // Log device deactivation error but don't fail logout
        console.error('⚠️  Device token deactivation failed during logout:', deviceError.message);
      }
    }
    
    // Sign out from Supabase Auth
    const { error } = await supabase.auth.signOut();

    if (error) {
      throw new Error(error.message || 'Logout failed');
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
 * Get current user from Supabase session
 * @returns {Object} User data
 */
async function getCurrentUser() {
  try {
    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      throw new Error('User not found or session expired');
    }

    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role || 'user',
      metadata: user.user_metadata,
      createdAt: user.created_at
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

    // Step 1: Verify current password by attempting to sign in
    const supabase = getSupabase();
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: userEmail,
      password: currentPassword
    });

    if (signInError || !signInData.user) {
      return {
        success: false,
        error: 'Current password is incorrect',
        code: 'INVALID_CURRENT_PASSWORD'
      };
    }

    // Step 2: Update password using Supabase Admin API
    const supabaseAdmin = getSupabaseAdmin();
    const { data: updateData, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      { password: newPassword }
    );

    if (updateError) {
      console.error('Error updating password:', updateError.message);
      return {
        success: false,
        error: 'Failed to update password. Please try again.',
        code: 'UPDATE_FAILED'
      };
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


