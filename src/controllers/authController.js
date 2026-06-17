const authService = require('../services/authService');
const { getUserCompany } = require('../services/userService');
const { requestPasswordReset } = require('../services/forgotPasswordService');
const { getTenantShowRegionForUser, resolveEffectiveUserId } = require('../middleware/auth');
const {
  signup: signupService,
  verifyEmailOtp: verifyEmailOtpService,
  sendPhoneOtpForSignup: sendPhoneOtpService,
  verifyPhoneOtp: verifyPhoneOtpService,
  setPasswordAndComplete: setPasswordService
} = require('../services/signupService');

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login user with email and password
 *     description: Authenticates a user with email/password and registers/updates device information. Returns JWT access and refresh tokens.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *               - device_info
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "user@example.com"
 *               password:
 *                 type: string
 *                 format: password
 *                 example: "password123"
 *               device_info:
 *                 type: object
 *                 required:
 *                   - device_token
 *                 properties:
 *                   device_token:
 *                     type: string
 *                     description: FCM device token for push notifications
 *                     example: "fcm-device-token-here"
 *                   device_id:
 *                     type: string
 *                     description: Unique device identifier (optional, defaults to device_token)
 *                   device_type:
 *                     type: string
 *                     enum: [ios, android]
 *                     example: "android"
 *                   device_name:
 *                     type: string
 *                     example: "John's iPhone"
 *                   device_model:
 *                     type: string
 *                     example: "iPhone 13 Pro"
 *                   os_version:
 *                     type: string
 *                     example: "15.0"
 *                   app_version:
 *                     type: string
 *                     example: "1.0.0"
 *           example:
 *             email: "user@example.com"
 *             password: "password123"
 *             device_info:
 *               device_token: "fcm-device-token-here"
 *               device_type: "android"
 *               device_name: "My Device"
 *     responses:
 *       200:
 *         description: Login successful
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
 *                   example: "Login successful"
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         email:
 *                           type: string
 *                         phone:
 *                           type: string
 *                         role:
 *                           type: string
 *                         userType:
 *                           type: string
 *                           enum: [admin, producer, contractor, none]
 *                           description: User's access role (admin, producer, contractor, or none)
 *                     accessToken:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *       400:
 *         description: Validation error (missing or invalid fields)
 *       401:
 *         description: Authentication failed (invalid credentials)
 */
async function login(req, res) {
  try {
    const { email, password, device_info } = req.body;

    // Validate email (mandatory)
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    // Validate password (mandatory)
    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required'
      });
    }

    if (typeof password !== 'string' || password.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Password cannot be empty'
      });
    }

    // Validate device_info (mandatory)
    if (!device_info) {
      return res.status(400).json({
        success: false,
        message: 'device_info is required'
      });
    }

    // Validate device_token (mandatory)
    if (!device_info.device_token) {
      return res.status(400).json({
        success: false,
        message: 'device_token is required in device_info'
      });
    }

    if (typeof device_info.device_token !== 'string' || device_info.device_token.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'device_token cannot be empty'
      });
    }

    // Use device_token as device_id if device_id is not provided
    const deviceId = device_info.device_id || device_info.device_token;

    // Prepare device info object (only include provided optional fields)
    const deviceInfo = {
      device_token: device_info.device_token.trim(),
      device_id: deviceId,
      device_type: device_info.device_type || null,
      device_name: device_info.device_name || null,
      device_model: device_info.device_model || null,
      os_version: device_info.os_version || null,
      app_version: device_info.app_version || null
    };

    // Authenticate user with email
    const result = await authService.loginWithEmail(email.trim(), password, deviceInfo);

    // Return success response
    return res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken
      }
    });
  } catch (error) {
    const msg = error.message || 'Login failed';

    // Map specific error messages to proper HTTP status codes
    let statusCode = 401;
    if (msg.includes('Email not verified') || msg.includes('Phone number not verified')) {
      statusCode = 403;
    } else if (msg.includes('pending admin approval')) {
      statusCode = 403;
    }

    return res.status(statusCode).json({
      success: false,
      message: msg
    });
  }
}

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout user
 *     description: Logs out the authenticated user, invalidates the current access token, and deactivates the device token if provided.
 *     tags: [Auth]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               device_token:
 *                 type: string
 *                 description: Optional device token to deactivate on logout
 *                 example: "fcm-device-token-here"
 *           example:
 *             device_token: "fcm-device-token-here"
 *     responses:
 *       200:
 *         description: Logout successful
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
 *                   example: "Logout successful"
 *       401:
 *         description: Unauthorized - Invalid or missing token
 */
async function logout(req, res) {
  try {
    const userId = req.user?.id;
    const token = req.token;
    const deviceToken = req.body?.device_token || req.headers['x-device-token'];

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    await authService.logout(userId, token, deviceToken);

    return res.status(200).json({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Logout failed',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh access token
 *     description: Generates a new access token using a valid refresh token. Optionally returns a new refresh token if the current one is about to expire.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: Valid refresh token
 *                 example: "refresh-token-here"
 *           example:
 *             refreshToken: "refresh-token-here"
 *     responses:
 *       200:
 *         description: Token refreshed successfully
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
 *                   example: "Token refreshed successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     accessToken:
 *                       type: string
 *                     refreshToken:
 *                       type: string
 *                       description: New refresh token (only if current one is about to expire)
 *       400:
 *         description: Refresh token is required
 *       401:
 *         description: Invalid or expired refresh token
 */
async function refresh(req, res) {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token is required'
      });
    }

    const result = await authService.refreshToken(refreshToken);

    return res.status(200).json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        accessToken: result.accessToken,
        ...(result.refreshToken && { refreshToken: result.refreshToken })
      }
    });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message || 'Token refresh failed',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get current authenticated user
 *     description: Returns the profile information of the currently authenticated user.
 *     tags: [Auth]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: User information retrieved successfully
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
 *                   example: "User retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         email:
 *                           type: string
 *                         phone:
 *                           type: string
 *                         role:
 *                           type: string
 *                         metadata:
 *                           type: object
 *       401:
 *         description: Unauthorized - Invalid or missing token
 */
async function me(req, res) {
  try {
    // User is already attached to req by auth middleware
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    // Get company from user_customers table
    const company = await getUserCompany(req.user.id);

    // Format user data to match login response structure
    const user = {
      id: req.user.id,
      email: req.user.email || '',
      phone: req.user.phone || '',
      role: req.user.role || 'authenticated',
      userType: req.user.userType || 'none',
      userRole: req.user.userRole || null,
      company: company || null,
      metadata: req.user.metadata || {}
    };

    return res.status(200).json({
      success: true,
      message: 'User retrieved successfully',
      data: {
        user
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to get user information',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/auth/forgot-password:
 *   post:
 *     summary: Request password reset
 *     description: |
 *       Sends a password reset email to the user if the email exists in the system.
 *
 *       **Rate Limiting:** Maximum 1 request per email every 5 minutes.
 *
 *       **Flow:**
 *       1. Validates email format
 *       2. Checks rate limiting (5 min window)
 *       3. Verifies user exists in database
 *       4. Generates reset token via Supabase
 *       5. Sends password reset email
 *
 *       **Security Notes:**
 *       - Returns error if user does not exist
 *       - Rate limiting applies even for non-existent emails
 *       - Reset link expires in 1 hour
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User's email address
 *                 example: "user@example.com"
 *               redirect_url:
 *                 type: string
 *                 format: uri
 *                 description: Optional URL to redirect after password reset
 *                 example: "https://app.example.com/reset-password"
 *           example:
 *             email: "user@example.com"
 *     responses:
 *       200:
 *         description: Password reset email sent successfully
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
 *                   example: "Password reset link has been sent to your email."
 *       404:
 *         description: User not found
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
 *                   example: "No account found with this email address."
 *       400:
 *         description: Validation error (invalid email format)
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
 *                   example: "Invalid email format"
 *       429:
 *         description: Too many requests (rate limited)
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
 *                   example: "Too many requests. Please try again in 300 seconds."
 *                 remaining_time:
 *                   type: integer
 *                   description: Seconds until next request is allowed
 *                   example: 300
 *       500:
 *         description: Server error
 */
async function forgotPassword(req, res) {
  try {
    const { email, redirect_url } = req.body;

    // Validate email is provided
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    // Call the forgot password service
    const result = await requestPasswordReset(email, redirect_url);

    // Handle rate limiting
    if (result.code === 'RATE_LIMITED') {
      return res.status(429).json({
        success: false,
        message: result.error,
        remaining_time: result.remainingTime
      });
    }

    // Handle validation errors
    if (result.code === 'INVALID_EMAIL' || result.code === 'INVALID_EMAIL_FORMAT') {
      return res.status(400).json({
        success: false,
        message: result.error
      });
    }

    // Return success if password reset email was sent
    if (result.success) {
      return res.status(200).json({
        success: true,
        message: 'Password reset link has been sent to your email.'
      });
    }

    // Return error if user not found
    if (result.code === 'USER_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: 'No account found with this email address.'
      });
    }

    // For other errors (token generation, email send), return server error
    return res.status(500).json({
      success: false,
      message: 'Failed to process password reset request. Please try again later.'
    });
  } catch (error) {
    console.error('Error in forgot password:', error);
    return res.status(500).json({
      success: false,
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
}

/**
 * @swagger
 * /api/auth/change-password:
 *   post:
 *     summary: Change user password
 *     description: |
 *       Changes the authenticated user's password.
 *
 *       **Requirements:**
 *       - User must be authenticated
 *       - Current password must be correct
 *       - New password and confirm password must match
 *       - New password must be at least 6 characters
 *       - New password must be different from current password
 *     tags: [Auth]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - current_password
 *               - new_password
 *               - confirm_password
 *             properties:
 *               current_password:
 *                 type: string
 *                 format: password
 *                 description: User's current password
 *                 example: "currentPassword123"
 *               new_password:
 *                 type: string
 *                 format: password
 *                 description: New password (min 6 characters)
 *                 example: "newPassword456"
 *               confirm_password:
 *                 type: string
 *                 format: password
 *                 description: Confirm new password (must match new_password)
 *                 example: "newPassword456"
 *           example:
 *             current_password: "currentPassword123"
 *             new_password: "newPassword456"
 *             confirm_password: "newPassword456"
 *     responses:
 *       200:
 *         description: Password changed successfully
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
 *                   example: "Password changed successfully"
 *       400:
 *         description: Validation error
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
 *                   example: "New password and confirm password do not match"
 *       401:
 *         description: Unauthorized or invalid current password
 *       500:
 *         description: Server error
 */
async function changePassword(req, res) {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    const userId = req.user?.id;
    const userEmail = req.user?.email;

    // Validate user is authenticated
    if (!userId || !userEmail) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    // Validate required fields
    if (!current_password) {
      return res.status(400).json({
        success: false,
        message: 'Current password is required'
      });
    }

    if (!new_password) {
      return res.status(400).json({
        success: false,
        message: 'New password is required'
      });
    }

    if (!confirm_password) {
      return res.status(400).json({
        success: false,
        message: 'Confirm password is required'
      });
    }

    // Call the change password service
    const result = await authService.changePassword(
      userId,
      userEmail,
      current_password,
      new_password,
      confirm_password
    );

    if (!result.success) {
      // Determine appropriate status code based on error type
      let statusCode = 400;
      if (result.code === 'INVALID_CURRENT_PASSWORD') {
        statusCode = 401;
      } else if (result.code === 'UPDATE_FAILED' || result.code === 'UNEXPECTED_ERROR') {
        statusCode = 500;
      }

      return res.status(statusCode).json({
        success: false,
        message: result.error
      });
    }

    return res.status(200).json({
      success: true,
      message: result.message
    });
  } catch (error) {
    console.error('Error in change password:', error);
    return res.status(500).json({
      success: false,
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
}

/**
 * Get app permissions for the authenticated user.
 * Reads from user_app_permissions table (same as web's /api/users/{id}/app-access).
 */
async function getAppPermissions(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'User not authenticated' });
    }

    const userId = req.user.id;
    const userEmail = req.user.email;
    const { executeDirectSQL } = require('../utils/postgresExecutor');

    // Resolve effective user ID (central auth UUID → public.users UUID)
    const effectiveUserId = await resolveEffectiveUserId(userId, userEmail);
    const showRegion = await getTenantShowRegionForUser(userId);

    // tk-admin users get all permissions by default
    if (req.user.isAdmin) {
      const allPermsSql = `
        SELECT code FROM permissions WHERE is_active = true
        UNION
        SELECT DISTINCT permission_code FROM user_app_permissions
        ORDER BY code
      `;
      const allPermsResult = await executeDirectSQL(allPermsSql, []);
      const permissions = (allPermsResult.data || []).map(row => row.code);

      return res.status(200).json({
        success: true,
        message: 'App permissions retrieved successfully',
        data: { permissions, showRegion, volume_unit: process.env.VOLUME_UNIT || 'CY' }
      });
    }

    const sql = `
      SELECT permission_code
      FROM user_app_permissions
      WHERE user_id = $1
      ORDER BY permission_code
    `;
    const result = await executeDirectSQL(sql, [effectiveUserId]);
    const permissions = (result.data || []).map(row => row.permission_code);

    return res.status(200).json({
      success: true,
      message: 'App permissions retrieved successfully',
      data: { permissions, showRegion, volume_unit: process.env.VOLUME_UNIT || 'CY' }
    });
  } catch (error) {
    console.error('Error fetching app permissions:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch app permissions'
    });
  }
}

/**
 * @swagger
 * /api/auth/signup:
 *   post:
 *     summary: Register a new user (Step 1 - Initiate signup & send email OTP)
 *     description: |
 *       Collects basic user information (name + email), stores it as a pending signup,
 *       and sends an email OTP. Password is NOT required at this step.
 *       The user is NOT fully created until both email and phone OTPs are verified.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               firstName:
 *                 type: string
 *                 description: First name (combined with lastName into full_name)
 *               lastName:
 *                 type: string
 *                 description: Last name
 *               full_name:
 *                 type: string
 *                 description: Full name (alternative to firstName+lastName)
 *     responses:
 *       200:
 *         description: Signup initiated, email OTP sent
 *       400:
 *         description: Validation error
 *       409:
 *         description: Email already exists
 *       429:
 *         description: OTP rate limited
 */
async function signup(req, res) {
  try {
    const { email, firstName, lastName, full_name } = req.body;

    // Validate required fields
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || typeof email !== 'string' || !emailRegex.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Valid email is required' });
    }

    // Accept either full_name or firstName+lastName
    const resolvedName = full_name
      || [firstName, lastName].filter(Boolean).join(' ');

    if (!resolvedName || resolvedName.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Full name is required' });
    }

    const result = await signupService({
      email: email.trim(),
      full_name: resolvedName.trim()
    });

    if (!result.success) {
      // Already verified steps — return 200 so client can navigate to the correct step
      if (result.code === 'EMAIL_ALREADY_VERIFIED' || result.code === 'VERIFICATION_COMPLETE') {
        return res.status(200).json({ success: true, message: result.error, code: result.code });
      }
      const statusMap = { EMAIL_EXISTS: 409, RATE_LIMITED: 429, PENDING_CREATE_FAILED: 500 };
      const statusCode = statusMap[result.code] || 500;
      return res.status(statusCode).json({ success: false, message: result.error, code: result.code });
    }

    return res.status(200).json({
      success: true,
      message: result.message
    });
  } catch (error) {
    console.error('Error in signup:', error);
    return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again later.' });
  }
}

/**
 * @swagger
 * /api/auth/verify-email-otp:
 *   post:
 *     summary: Verify email OTP (Step 2)
 *     description: Verifies the email OTP sent during signup. After success, proceed to phone verification.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, otp]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *                 description: 6-digit OTP
 *     responses:
 *       200:
 *         description: Email verified successfully
 *       400:
 *         description: Invalid or expired OTP
 */
async function verifyEmailOtp(req, res) {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    if (typeof otp !== 'string' || otp.trim().length !== 6) {
      return res.status(400).json({ success: false, message: 'OTP must be a 6-digit code' });
    }

    const result = await verifyEmailOtpService(email, otp.trim());

    if (!result.success) {
      // Already verified — return success so client can proceed to next step
      if (result.code === 'ALREADY_VERIFIED') {
        return res.status(200).json({ success: true, message: result.error, code: result.code });
      }
      const statusMap = { OTP_EXPIRED: 410, MAX_ATTEMPTS: 429, NO_PENDING_SIGNUP: 404 };
      const statusCode = statusMap[result.code] || 400;
      return res.status(statusCode).json({ success: false, message: result.error });
    }

    return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    console.error('Error in verifyEmailOtp:', error);
    return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
  }
}

/**
 * @swagger
 * /api/auth/send-phone-otp:
 *   post:
 *     summary: Send phone OTP (Step 3 - after email verified)
 *     description: Sends an SMS OTP to the user's phone number. Email must be verified first.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, phone_country_code, phone_number]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               phone_country_code:
 *                 type: string
 *               phone_number:
 *                 type: string
 *     responses:
 *       200:
 *         description: Phone OTP sent
 *       400:
 *         description: Validation error or email not verified
 *       429:
 *         description: Rate limited
 */
async function sendPhoneOtp(req, res) {
  try {
    const { email, phone_country_code, phone_number } = req.body;

    if (!email || !phone_country_code || !phone_number) {
      return res.status(400).json({ success: false, message: 'Email, phone country code, and phone number are required' });
    }

    const result = await sendPhoneOtpService(email, phone_country_code.trim(), phone_number.trim());

    if (!result.success) {
      const statusMap = {
        EMAIL_NOT_VERIFIED: 403,
        NO_PENDING_SIGNUP: 404,
        PHONE_EXISTS: 409,
        RATE_LIMITED: 429
      };
      const statusCode = statusMap[result.code] || 400;
      return res.status(statusCode).json({ success: false, message: result.error, code: result.code });
    }

    return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    console.error('Error in sendPhoneOtp:', error.message || error);
    return res.status(500).json({ success: false, message: error.message || 'An unexpected error occurred.' });
  }
}

/**
 * @swagger
 * /api/auth/verify-phone-otp:
 *   post:
 *     summary: Verify phone OTP and complete registration (Step 4)
 *     description: |
 *       Verifies the phone OTP and completes user registration.
 *       Creates the user in Supabase Auth and public.users table.
 *       Returns JWT access and refresh tokens on success.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, otp]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *                 description: 6-digit OTP
 *     responses:
 *       201:
 *         description: Registration complete, returns user + JWT tokens
 *       400:
 *         description: Invalid or expired OTP
 *       403:
 *         description: Email not verified
 */
async function verifyPhoneOtp(req, res) {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    if (typeof otp !== 'string' || otp.trim().length !== 6) {
      return res.status(400).json({ success: false, message: 'OTP must be a 6-digit code' });
    }

    const result = await verifyPhoneOtpService(email, otp.trim());

    if (!result.success) {
      const statusMap = {
        EMAIL_NOT_VERIFIED: 403,
        NO_PENDING_SIGNUP: 404,
        OTP_EXPIRED: 410,
        MAX_ATTEMPTS: 429,
        EMAIL_EXISTS: 409,
        SESSION_EXPIRED: 410
      };
      const statusCode = statusMap[result.code] || 400;
      return res.status(statusCode).json({ success: false, message: result.error });
    }

    return res.status(200).json({
      success: true,
      message: result.message
    });
  } catch (error) {
    console.error('Error in verifyPhoneOtp:', error);
    return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
  }
}

/**
 * @swagger
 * /api/auth/set-password:
 *   post:
 *     summary: Set password and complete registration (Step 5)
 *     description: |
 *       Sets the user password and creates the account.
 *       Only allowed after both email and phone OTP are verified.
 *       Sets user_type to QR_CODE and active to false (pending admin approval).
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, confirmPassword]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 description: Minimum 6 characters
 *               confirmPassword:
 *                 type: string
 *                 description: Must match password
 *     responses:
 *       201:
 *         description: Signup completed
 *       400:
 *         description: Validation error
 *       403:
 *         description: Email or phone not verified
 */
async function setPassword(req, res) {
  try {
    const { email, password, confirmPassword } = req.body;

    if (!email || !password || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'Email, password, and confirmPassword are required' });
    }

    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match' });
    }

    const result = await setPasswordService(email.trim(), password);

    if (!result.success) {
      const statusMap = {
        EMAIL_NOT_VERIFIED: 403,
        PHONE_NOT_VERIFIED: 403,
        NO_PENDING_SIGNUP: 404,
        ALREADY_REGISTERED: 409,
        EMAIL_EXISTS: 409,
        DUPLICATE_EMAIL: 409,
        DB_QUERY_FAILED: 500
      };
      const statusCode = statusMap[result.code] || 400;
      return res.status(statusCode).json({ success: false, message: result.error, code: result.code });
    }

    return res.status(201).json({
      success: true,
      message: result.message
    });
  } catch (error) {
    console.error('Error in setPassword:', error);
    return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
  }
}

/**
 * @swagger
 * /api/auth/resend-email-otp:
 *   post:
 *     summary: Resend email OTP
 *     description: Resends the email verification OTP. Subject to cooldown and rate limits.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: OTP resent
 *       429:
 *         description: Rate limited / cooldown
 */
async function resendEmailOtp(req, res) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const { getSupabaseAdmin } = require('../config/database');
    const supabase = getSupabaseAdmin();

    // Ensure there is a pending signup
    const { data: pending } = await supabase
      .from('signup_pending')
      .select('email')
      .eq('email', email.toLowerCase().trim())
      .limit(1);

    if (!pending || pending.length === 0) {
      return res.status(404).json({ success: false, message: 'No pending signup found. Please sign up first.' });
    }

    const { requestEmailOtp } = require('../services/otpService');
    const result = await requestEmailOtp(email.toLowerCase().trim());

    if (!result.success) {
      return res.status(429).json({
        success: false,
        message: result.error,
        ...(result.waitSeconds && { wait_seconds: result.waitSeconds })
      });
    }

    return res.status(200).json({ success: true, message: 'OTP resent to your email.' });
  } catch (error) {
    console.error('Error in resendEmailOtp:', error);
    return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
  }
}

/**
 * @swagger
 * /api/auth/resend-phone-otp:
 *   post:
 *     summary: Resend phone OTP
 *     description: Resends the phone verification OTP. Email must be verified. Subject to cooldown.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: OTP resent
 *       429:
 *         description: Rate limited / cooldown
 */
async function resendPhoneOtp(req, res) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const { getSupabaseAdmin } = require('../config/database');
    const supabase = getSupabaseAdmin();
    const normalizedEmail = email.toLowerCase().trim();

    const { data: pending } = await supabase
      .from('signup_pending')
      .select('*')
      .eq('email', normalizedEmail)
      .limit(1);

    if (!pending || pending.length === 0) {
      return res.status(404).json({ success: false, message: 'No pending signup found.' });
    }

    if (!pending[0].email_verified) {
      return res.status(403).json({ success: false, message: 'Please verify your email first.' });
    }

    const fullPhone = `${pending[0].phone_country_code}${pending[0].phone_number}`.replace(/\s+/g, '');
    const { requestPhoneOtp } = require('../services/otpService');
    const result = await requestPhoneOtp(fullPhone);

    if (!result.success) {
      return res.status(429).json({
        success: false,
        message: result.error,
        ...(result.waitSeconds && { wait_seconds: result.waitSeconds })
      });
    }

    return res.status(200).json({ success: true, message: 'OTP resent to your phone.' });
  } catch (error) {
    console.error('Error in resendPhoneOtp:', error);
    return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
  }
}

module.exports = {
  login,
  logout,
  refresh,
  me,
  forgotPassword,
  changePassword,
  getAppPermissions,
  signup,
  verifyEmailOtp,
  sendPhoneOtp,
  verifyPhoneOtp,
  setPassword,
  resendEmailOtp,
  resendPhoneOtp
};

