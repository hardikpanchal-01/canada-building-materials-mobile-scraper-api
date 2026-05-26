/**
 * Forgot Password Service
 *
 * Handles password reset requests with:
 * - Rate limiting (5 minutes per email)
 * - User verification
 * - Token generation via Supabase Admin API
 * - Password reset email sending
 */

const { getSupabaseAdmin } = require('../config/database');
const { executeDirectSQL } = require('../utils/postgresExecutor');
const nodemailer = require('nodemailer');

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const rateLimitMap = new Map(); // In-memory store for rate limiting

// Cached SMTP transporter (created once, reused across requests)
let _cachedTransporter = null;

/**
 * Check if email is rate limited
 * @param {string} email - User email
 * @returns {object} { isLimited: boolean, remainingTime: number }
 */
function checkRateLimit(email) {
  const normalizedEmail = email.toLowerCase().trim();
  const lastRequest = rateLimitMap.get(normalizedEmail);

  if (lastRequest) {
    const timeSinceLastRequest = Date.now() - lastRequest;
    if (timeSinceLastRequest < RATE_LIMIT_WINDOW) {
      const remainingTime = Math.ceil((RATE_LIMIT_WINDOW - timeSinceLastRequest) / 1000);
      return { isLimited: true, remainingTime };
    }
  }

  return { isLimited: false, remainingTime: 0 };
}

/**
 * Set rate limit for email
 * @param {string} email - User email
 */
function setRateLimit(email) {
  const normalizedEmail = email.toLowerCase().trim();
  rateLimitMap.set(normalizedEmail, Date.now());
}

/**
 * Verify if user exists in the system
 * First checks users table, then falls back to Supabase auth.users
 * @param {string} email - User email
 * @returns {object|null} User data or null if not found
 */
async function verifyUserExists(email) {
  const normalizedEmail = email.toLowerCase().trim();

  try {
    // Step 1: Check users table using case-insensitive email match
    const usersSql = `
      SELECT id, email, created_at
      FROM users
      WHERE email ILIKE $1
      LIMIT 1
    `;

    const usersResult = await executeDirectSQL(usersSql, [normalizedEmail]);

    if (usersResult.data && usersResult.data.length > 0) {
      return {
        id: usersResult.data[0].id,
        email: usersResult.data[0].email,
        source: 'users_table'
      };
    }

    // Step 2: Fall back to checking auth.users via Supabase Admin API
    const supabaseAdmin = getSupabaseAdmin();

    // Paginated listUsers to avoid loading ALL users into memory
    let page = 1;
    const perPage = 1000;
    let authUser = null;

    while (!authUser) {
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage
      });

      if (authError) {
        console.error('Error checking auth.users:', authError.message);
        break;
      }

      if (!authData || !authData.users || authData.users.length === 0) {
        break;
      }

      authUser = authData.users.find(
        u => u.email && u.email.toLowerCase() === normalizedEmail
      );

      if (authData.users.length < perPage) break;
      page++;
    }

    if (authUser) {
      return {
        id: authUser.id,
        email: authUser.email,
        source: 'auth_users'
      };
    }

    return null; // User not found
  } catch (error) {
    console.error('Error verifying user:', error.message);
    return null;
  }
}

/**
 * Generate password reset token using Supabase Admin API
 * @param {string} email - User email
 * @param {string} redirectTo - URL to redirect after password reset
 * @returns {object} { success: boolean, token?: string, error?: string }
 */
async function generateResetToken(email, redirectTo) {
  const normalizedEmail = email.toLowerCase().trim();

  try {
    const supabaseAdmin = getSupabaseAdmin();

    // Generate recovery link using Supabase Admin API
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: normalizedEmail,
      options: {
        redirectTo: redirectTo || process.env.PASSWORD_RESET_REDIRECT_URL || (process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/reset-password` : 'http://localhost:3000/reset-password')
      }
    });

    if (error) {
      console.error('Error generating reset link:', error.message);
      return { success: false, error: error.message };
    }

    if (!data || !data.properties || !data.properties.hashed_token) {
      // Extract token from the action link if hashed_token not available
      if (data && data.properties && data.properties.action_link) {
        const actionLink = data.properties.action_link;
        const urlParams = new URL(actionLink);
        const token = urlParams.searchParams.get('token') || urlParams.hash.split('access_token=')[1]?.split('&')[0];

        if (token) {
          return {
            success: true,
            token: token,
            actionLink: actionLink
          };
        }
      }

      return { success: false, error: 'Failed to generate reset token' };
    }

    return {
      success: true,
      token: data.properties.hashed_token,
      actionLink: data.properties.action_link
    };
  } catch (error) {
    console.error('Error generating reset token:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Format password reset email HTML
 * @param {string} resetLink - Password reset link
 * @param {string} email - User email
 * @returns {string} HTML email content
 */
function formatResetEmailHTML(resetLink, email) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          background-color: #f5f5f5;
          padding: 20px;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background-color: #ffffff;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          overflow: hidden;
        }
        .header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 30px 20px;
          text-align: center;
        }
        .header h1 {
          font-size: 24px;
          margin: 0;
          font-weight: 600;
        }
        .content {
          padding: 40px 30px;
        }
        .content p {
          margin-bottom: 20px;
          color: #555;
        }
        .button-container {
          text-align: center;
          margin: 30px 0;
        }
        .reset-button {
          display: inline-block;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white !important;
          text-decoration: none;
          padding: 14px 40px;
          border-radius: 6px;
          font-weight: 600;
          font-size: 16px;
        }
        .reset-button:hover {
          opacity: 0.9;
        }
        .link-fallback {
          margin-top: 30px;
          padding: 20px;
          background-color: #f8f9fa;
          border-radius: 6px;
          word-break: break-all;
        }
        .link-fallback p {
          font-size: 12px;
          color: #666;
          margin-bottom: 10px;
        }
        .link-fallback a {
          color: #667eea;
          font-size: 12px;
        }
        .footer {
          padding: 20px 30px;
          border-top: 1px solid #e0e0e0;
          font-size: 12px;
          color: #7f8c8d;
          text-align: center;
        }
        .warning {
          background-color: #fff3cd;
          border: 1px solid #ffc107;
          border-radius: 6px;
          padding: 15px;
          margin-top: 20px;
          font-size: 13px;
          color: #856404;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Password Reset Request</h1>
        </div>
        <div class="content">
          <p>Hello,</p>
          <p>We received a request to reset the password for your account associated with <strong>${email}</strong>.</p>
          <p>Click the button below to reset your password:</p>

          <div class="button-container">
            <a href="${resetLink}" class="reset-button">Reset Password</a>
          </div>

          <div class="link-fallback">
            <p>If the button doesn't work, copy and paste this link into your browser:</p>
            <a href="${resetLink}">${resetLink}</a>
          </div>

          <div class="warning">
            <strong>Important:</strong> This link will expire in 1 hour. If you didn't request a password reset, please ignore this email or contact support if you have concerns.
          </div>
        </div>
        <div class="footer">
          <p>This is an automated message. Please do not reply to this email.</p>
          <p>&copy; ${new Date().getFullYear()} Truckast. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Send password reset email
 * @param {string} email - User email
 * @param {string} resetLink - Password reset link
 * @returns {Promise<boolean>} True if email sent successfully
 */
async function sendResetEmail(email, resetLink) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const parsedPort = smtpPort ? parseInt(smtpPort, 10) : 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;
  const smtpFrom = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  const smtpSecure = process.env.SMTP_SECURE === 'true' || process.env.SMTP_SECURE === '1';

  console.log('[ForgotPassword] Attempting to send reset email to:', email);
  console.log('[ForgotPassword] SMTP Config - Host:', smtpHost, 'Port:', parsedPort, 'From:', smtpFrom);

  if (!smtpHost || !smtpUser || !smtpPassword) {
    console.error('[ForgotPassword] SMTP configuration is incomplete - Host:', !!smtpHost, 'User:', !!smtpUser, 'Password:', !!smtpPassword);
    return false;
  }

  try {
    // Reuse cached transporter to avoid creating a new TCP/TLS connection per email
    if (!_cachedTransporter) {
      _cachedTransporter = nodemailer.createTransport({
        host: smtpHost,
        port: parsedPort,
        secure: smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPassword
        },
        tls: {
          rejectUnauthorized: false
        },
        pool: true,
        maxConnections: 3
      });
    }
    const transporter = _cachedTransporter;

    // Verify connection
    console.log('[ForgotPassword] Verifying SMTP connection...');
    await transporter.verify();
    console.log('[ForgotPassword] SMTP connection verified successfully');

    const mailOptions = {
      from: smtpFrom,
      to: email,
      subject: 'Password Reset Request',
      html: formatResetEmailHTML(resetLink, email)
    };

    console.log('[ForgotPassword] Sending email...');
    const info = await transporter.sendMail(mailOptions);
    console.log('[ForgotPassword] Email sent successfully. MessageId:', info.messageId);
    return true;
  } catch (error) {
    console.error('[ForgotPassword] Error sending reset email:', error.message);
    console.error('[ForgotPassword] Full error:', error);
    return false;
  }
}

/**
 * Main function: Request password reset
 * @param {string} email - User email
 * @param {string} redirectTo - Optional redirect URL after reset
 * @returns {Promise<object>} Result object
 */
async function requestPasswordReset(email, redirectTo = null) {
  console.log('[ForgotPassword] Starting password reset request for:', email);

  // Step 1: Validate email format
  if (!email || typeof email !== 'string') {
    console.log('[ForgotPassword] Step 1 Failed: Email is required');
    return {
      success: false,
      error: 'Email is required',
      code: 'INVALID_EMAIL'
    };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const normalizedEmail = email.toLowerCase().trim();

  if (!emailRegex.test(normalizedEmail)) {
    console.log('[ForgotPassword] Step 1 Failed: Invalid email format');
    return {
      success: false,
      error: 'Invalid email format',
      code: 'INVALID_EMAIL_FORMAT'
    };
  }
  console.log('[ForgotPassword] Step 1 Passed: Email validated');

  // Step 2: Check rate limiting
  const { isLimited, remainingTime } = checkRateLimit(normalizedEmail);
  if (isLimited) {
    console.log('[ForgotPassword] Step 2 Failed: Rate limited, remaining time:', remainingTime);
    return {
      success: false,
      error: `Too many requests. Please try again in ${remainingTime} seconds.`,
      code: 'RATE_LIMITED',
      remainingTime
    };
  }
  console.log('[ForgotPassword] Step 2 Passed: Not rate limited');

  // Step 3: Verify user exists
  console.log('[ForgotPassword] Step 3: Verifying user exists...');
  const user = await verifyUserExists(normalizedEmail);
  if (!user) {
    console.log('[ForgotPassword] Step 3 Failed: User not found');
    // Set rate limit even for non-existent users to prevent email enumeration
    setRateLimit(normalizedEmail);
    return {
      success: false,
      error: 'User not found',
      code: 'USER_NOT_FOUND'
    };
  }
  console.log('[ForgotPassword] Step 3 Passed: User found from', user.source);

  // Step 4: Generate reset token
  console.log('[ForgotPassword] Step 4: Generating reset token...');
  const tokenResult = await generateResetToken(normalizedEmail, redirectTo);
  if (!tokenResult.success) {
    console.log('[ForgotPassword] Step 4 Failed: Token generation failed -', tokenResult.error);
    return {
      success: false,
      error: tokenResult.error || 'Failed to generate reset token',
      code: 'TOKEN_GENERATION_FAILED'
    };
  }
  console.log('[ForgotPassword] Step 4 Passed: Token generated');

  // Step 5: Build reset URL
  const baseUrl = redirectTo || process.env.PASSWORD_RESET_REDIRECT_URL || (process.env.NEXT_PUBLIC_APP_URL ? `${process.env.NEXT_PUBLIC_APP_URL}/reset-password` : 'http://localhost:3000/reset-password');
  console.log('[ForgotPassword] Step 5: Using baseUrl -', baseUrl);
  console.log('[ForgotPassword] Step 5: Env vars - PASSWORD_RESET_REDIRECT_URL:', process.env.PASSWORD_RESET_REDIRECT_URL, 'NEXT_PUBLIC_APP_URL:', process.env.NEXT_PUBLIC_APP_URL);
  
  // Extract token from actionLink if it exists, otherwise use token from result
  let resetToken = tokenResult.token;
  if (tokenResult.actionLink && !resetToken) {
    try {
      const urlParams = new URL(tokenResult.actionLink);
      resetToken = urlParams.searchParams.get('token') || urlParams.searchParams.get('access_token') || 
                   urlParams.hash.split('access_token=')[1]?.split('&')[0];
      console.log('[ForgotPassword] Step 5: Extracted token from actionLink');
    } catch (e) {
      console.log('[ForgotPassword] Could not extract token from actionLink:', e.message);
    }
  }
  
  // Always build our own reset link with the correct production URL
  const resetLink = resetToken ? `${baseUrl}?token=${resetToken}&email=${encodeURIComponent(normalizedEmail)}` : tokenResult.actionLink;
  console.log('[ForgotPassword] Step 5: Reset link built -', resetLink);

  // Step 6: Send reset email
  console.log('[ForgotPassword] Step 6: Sending reset email...');
  const emailSent = await sendResetEmail(normalizedEmail, resetLink);
  if (!emailSent) {
    console.log('[ForgotPassword] Step 6 Failed: Email send failed');
    return {
      success: false,
      error: 'Failed to send reset email. Please try again later.',
      code: 'EMAIL_SEND_FAILED'
    };
  }
  console.log('[ForgotPassword] Step 6 Passed: Email sent');

  // Step 7: Set rate limit after successful request
  setRateLimit(normalizedEmail);
  console.log('[ForgotPassword] Step 7: Rate limit set. Process completed successfully!');

  return {
    success: true,
    message: 'Password reset email sent successfully'
  };
}

module.exports = {
  requestPasswordReset,
  verifyUserExists,
  checkRateLimit
};
