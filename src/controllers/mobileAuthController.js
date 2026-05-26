/**
 * Mobile Federated Authentication Controller
 *
 * Handles HTTP requests for OAuth 2.0 Authorization Code Flow:
 * - POST /api/auth/mobile/login - Authenticate and get authorization code
 * - POST /api/auth/mobile/exchange-code - Exchange code for user info
 */

const mobileAuthService = require('../services/mobileAuthService');

/**
 * @swagger
 * /api/auth/mobile/login:
 *   post:
 *     summary: Mobile federated login
 *     description: |
 *       Authenticates a user and returns an authorization code for the OAuth 2.0 Authorization Code Flow.
 *       The tenant is automatically determined from the tenant_users table.
 *
 *       **Flow:**
 *       1. Mobile app sends email and password
 *       2. Server authenticates user with bcrypt password verification
 *       3. Server automatically finds user's tenant from tenant_users table
 *       4. Server returns authorization code (valid for 60 seconds)
 *       5. Mobile app redirects to {redirect_url}/auth/callback?code={code}
 *     tags: [Mobile Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "user@example.com"
 *               password:
 *                 type: string
 *                 format: password
 *                 example: "password123"
 *     responses:
 *       200:
 *         description: Authentication successful
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
 *                   example: "Authentication successful"
 *                 data:
 *                   type: object
 *                   properties:
 *                     code:
 *                       type: string
 *                       description: Authorization code (64 hex chars)
 *                     redirect_url:
 *                       type: string
 *                       description: Tenant redirect URL
 *                     expires_in:
 *                       type: integer
 *                       description: Code expiry in seconds
 *                       example: 60
 *                     tenant:
 *                       type: object
 *                       description: Tenant information
 *                       properties:
 *                         id:
 *                           type: integer
 *                         name:
 *                           type: string
 *                         subdomain:
 *                           type: string
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication failed
 *       403:
 *         description: Account suspended or inactive
 *       404:
 *         description: User not associated with any tenant
 */
async function login(req, res) {
  try {
    const { email, password } = req.body;

    // Validate email
    if (!email) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'Email is required'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'Invalid email format'
      });
    }

    // Validate password
    if (!password) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'Password is required'
      });
    }

    if (typeof password !== 'string' || password.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'Password cannot be empty'
      });
    }

    // Get client metadata
    const metadata = {
      ip: req.ip || req.connection?.remoteAddress,
      user_agent: req.get('User-Agent')
    };

    // Authenticate and generate code (tenant is auto-detected from tenant_users)
    const result = await mobileAuthService.authenticateAndGenerateCode({
      email: email.trim().toLowerCase(),
      password,
      metadata
    });

    if (!result.success) {
      // Determine appropriate HTTP status
      let status = 400;
      const errorCode = result.error_code;

      if (errorCode === 'INVALID_CREDENTIALS') status = 401;
      if (errorCode === 'USER_NOT_FOUND') status = 401;
      if (errorCode === 'NO_TENANT') status = 404;
      if (errorCode === 'TENANT_SUSPENDED') status = 403;
      if (errorCode === 'USER_INACTIVE') status = 403;
      if (errorCode === 'NO_TENANT_USER') status = 404;
      if (errorCode === 'TENANT_USER_INACTIVE') status = 403;
      if (errorCode === 'SERVER_ERROR') status = 500;

      return res.status(status).json({
        success: false,
        error_code: result.error_code,
        message: result.message
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Authentication successful',
      data: {
        code: result.code,
        client_secret: result.client_secret,
        redirect_url: result.redirect_url,
        expires_in: result.expires_in,
        tenant: result.tenant
      }
    });

  } catch (error) {
    console.error('Mobile login error:', error);
    return res.status(500).json({
      success: false,
      error_code: 'SERVER_ERROR',
      message: 'An unexpected error occurred'
    });
  }
}

/**
 * @swagger
 * /api/auth/mobile/exchange-code:
 *   post:
 *     summary: Exchange authorization code for user info
 *     description: |
 *       Server-to-server endpoint to exchange an authorization code for user information.
 *       This endpoint mirrors the behavior of /api/auth/login exactly, including device registration.
 *
 *       **Security:**
 *       - Client secret must be provided and validated against server configuration
 *       - Code is single-use (consumed after exchange)
 *       - Code expires after 60 seconds
 *       - Device token is validated and registered (same as /api/auth/login)
 *     tags: [Mobile Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *               - client_secret
 *               - device_info
 *             properties:
 *               code:
 *                 type: string
 *                 description: Authorization code from login endpoint
 *               client_secret:
 *                 type: string
 *                 description: Client secret for authentication
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
 *             code: "authorization-code-here"
 *             client_secret: "client-secret-here"
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
 *                           format: uuid
 *                           description: User UUID
 *                         email:
 *                           type: string
 *                         phone:
 *                           type: string
 *                         role:
 *                           type: string
 *                           example: "authenticated"
 *                         metadata:
 *                           type: object
 *                           properties:
 *                             central_user_id:
 *                               type: integer
 *                             central_user_uuid:
 *                               type: string
 *                               format: uuid
 *                             email_verified:
 *                               type: boolean
 *                             full_name:
 *                               type: string
 *                             phone_number:
 *                               type: string
 *                             phone_country_code:
 *                               type: string
 *                             title:
 *                               type: string
 *                             avatar_url:
 *                               type: string
 *                             user_role:
 *                               type: string
 *                             tenant_role:
 *                               type: string
 *                             tenant_status:
 *                               type: string
 *                             tenant:
 *                               type: object
 *                               properties:
 *                                 tenant_id:
 *                                   type: integer
 *                                 tenant_uuid:
 *                                   type: string
 *                                   format: uuid
 *                                 tenant_name:
 *                                   type: string
 *                                 tenant_subdomain:
 *                                   type: string
 *                                 tenant_redirect_url:
 *                                   type: string
 *                                 tenant_client_id:
 *                                   type: string
 *                                   format: uuid
 *                                 tenant_supabase_url:
 *                                   type: string
 *                                 tenant_backend_url:
 *                                   type: string
 *                                   description: Backend API base URL
 *                                   example: "https://api.truckast.ai"
 *                     accessToken:
 *                       type: string
 *                       description: JWT access token
 *                     refreshToken:
 *                       type: string
 *                       description: JWT refresh token
 *       400:
 *         description: Invalid code, request, or missing device_info
 *       401:
 *         description: Invalid client credentials
 *       403:
 *         description: Tenant suspended
 */
async function exchangeCode(req, res) {
  try {
    const { code, client_secret, device_info } = req.body;

    // Validate code
    if (!code) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'Authorization code is required'
      });
    }

    if (typeof code !== 'string' || code.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'Authorization code cannot be empty'
      });
    }

    // Validate client_secret is provided
    if (!client_secret) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'Client secret is required'
      });
    }

    if (typeof client_secret !== 'string' || client_secret.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'Client secret cannot be empty'
      });
    }

    // Validate device_info (mandatory - same as /api/auth/login)
    if (!device_info) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'device_info is required'
      });
    }

    // Validate device_token (mandatory - same as /api/auth/login)
    if (!device_info.device_token) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'device_token is required in device_info'
      });
    }

    if (typeof device_info.device_token !== 'string' || device_info.device_token.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'device_token cannot be empty'
      });
    }

    // Use device_token as device_id if device_id is not provided (same as /api/auth/login)
    const deviceId = device_info.device_id || device_info.device_token;

    // Prepare device info object (only include provided optional fields - same as /api/auth/login)
    const deviceInfo = {
      device_token: device_info.device_token.trim(),
      device_id: deviceId,
      device_type: device_info.device_type || null,
      device_name: device_info.device_name || null,
      device_model: device_info.device_model || null,
      os_version: device_info.os_version || null,
      app_version: device_info.app_version || null
    };

    // Exchange code for user info (service will validate client_secret against tenant's own secret from DB)
    const result = await mobileAuthService.exchangeCodeForUserInfo({
      code: code.trim(),
      client_secret: client_secret.trim(),
      device_info: deviceInfo
    });

    if (!result.success) {
      // Determine appropriate HTTP status
      let status = 400;
      const errorCode = result.error_code;

      if (errorCode === 'INVALID_CLIENT') status = 401;
      if (errorCode === 'TENANT_SUSPENDED') status = 403;
      if (errorCode === 'SERVER_ERROR') status = 500;

      return res.status(status).json({
        success: false,
        error_code: result.error_code,
        message: result.message
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        user: result.user,
        timezone: result.timezone,
        company_timezone: result.company_timezone || null,
        supabase_config: result.supabase_config,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken
      }
    });

  } catch (error) {
    console.error('Code exchange error:', error);
    return res.status(500).json({
      success: false,
      error_code: 'SERVER_ERROR',
      message: 'An unexpected error occurred'
    });
  }
}

/**
 * @swagger
 * /api/auth/mobile/tenants:
 *   get:
 *     summary: List tenants the authenticated user has access to
 *     description: |
 *       Returns all active tenants the user is associated with via `auth_tenant.tenant_users`.
 *       Used by the mobile app's workspace switcher dropdown to populate the tenant list.
 *
 *       **Requires:** Bearer token (JWT access token)
 *     tags: [Mobile Auth]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Tenant list retrieved successfully
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
 *                   example: "Tenants retrieved successfully"
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       uuid:
 *                         type: string
 *                         format: uuid
 *                       name:
 *                         type: string
 *                         example: "Stevenson Weir"
 *                       subdomain:
 *                         type: string
 *                         example: "dolese"
 *                       backend_url:
 *                         type: string
 *                         example: "https://dolese-api.truckast.ai"
 *       401:
 *         description: Not authenticated
 */
async function listTenants(req, res) {
  try {
    const { getUserByEmail, getUserTenants } = mobileAuthService;

    // req.user is set by authenticate middleware (has id, email from JWT)
    const user = await getUserByEmail(req.user.email);
    if (!user) {
      return res.status(404).json({
        success: false,
        error_code: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    const result = await getUserTenants(user.id);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error_code: result.error_code,
        message: result.message
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Tenants retrieved successfully',
      data: result.data
    });
  } catch (error) {
    console.error('List tenants error:', error);
    return res.status(500).json({
      success: false,
      error_code: 'SERVER_ERROR',
      message: 'An unexpected error occurred'
    });
  }
}

/**
 * @swagger
 * /api/auth/mobile/switch-tenant:
 *   post:
 *     summary: Switch to a different tenant
 *     description: |
 *       Generates a new authorization code for the target tenant, allowing the mobile
 *       app to exchange it for new tokens via `/api/auth/mobile/exchange-code`.
 *
 *       **Flow:**
 *       1. Mobile app sends `target_subdomain`
 *       2. Server verifies user has access to the target tenant
 *       3. Server generates a 60-second auth code for the target tenant
 *       4. Returns code + client_secret + tenant backend_url
 *       5. Mobile app sets base URL to `{backend_url}/api`
 *       6. Mobile app exchanges code via `/api/auth/mobile/exchange-code`
 *
 *       **Requires:** Bearer token (JWT access token)
 *     tags: [Mobile Auth]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - target_subdomain
 *             properties:
 *               target_subdomain:
 *                 type: string
 *                 description: Subdomain of the tenant to switch to
 *                 example: "hercules"
 *     responses:
 *       200:
 *         description: Switch credentials generated successfully
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
 *                   example: "Switch credentials generated"
 *                 data:
 *                   type: object
 *                   properties:
 *                     code:
 *                       type: string
 *                       description: Authorization code (64 hex chars, valid 60s)
 *                     client_secret:
 *                       type: string
 *                       description: Client secret for code exchange
 *                     expires_in:
 *                       type: integer
 *                       example: 60
 *                     tenant:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         name:
 *                           type: string
 *                         subdomain:
 *                           type: string
 *                         backend_url:
 *                           type: string
 *       400:
 *         description: Missing target_subdomain
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Tenant suspended
 *       404:
 *         description: User not found or no access to target tenant
 */
async function switchTenant(req, res) {
  try {
    const { target_subdomain } = req.body;

    if (!target_subdomain) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'target_subdomain is required'
      });
    }

    if (typeof target_subdomain !== 'string' || target_subdomain.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error_code: 'INVALID_REQUEST',
        message: 'target_subdomain cannot be empty'
      });
    }

    const { getUserByEmail, generateSwitchCode } = mobileAuthService;

    // Resolve the central user from the JWT email
    const user = await getUserByEmail(req.user.email);
    if (!user) {
      return res.status(404).json({
        success: false,
        error_code: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    const result = await generateSwitchCode({
      userId: user.id,
      email: user.email,
      targetSubdomain: target_subdomain.trim()
    });

    if (!result.success) {
      let status = 400;
      if (result.error_code === 'NO_TENANT') status = 404;
      if (result.error_code === 'TENANT_SUSPENDED') status = 403;
      if (result.error_code === 'NO_TENANT_USER') status = 404;
      if (result.error_code === 'SERVER_ERROR') status = 500;

      return res.status(status).json({
        success: false,
        error_code: result.error_code,
        message: result.message
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Switch credentials generated',
      data: {
        code: result.code,
        client_secret: result.client_secret,
        expires_in: result.expires_in,
        tenant: result.tenant,
        supabase_config: result.supabase_config
      }
    });
  } catch (error) {
    console.error('Switch tenant error:', error);
    return res.status(500).json({
      success: false,
      error_code: 'SERVER_ERROR',
      message: 'An unexpected error occurred'
    });
  }
}

module.exports = {
  login,
  exchangeCode,
  listTenants,
  switchTenant
};
