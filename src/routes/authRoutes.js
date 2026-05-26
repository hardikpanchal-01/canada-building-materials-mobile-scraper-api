const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   POST /api/auth/signup
 * @desc    Step 1: Initiate signup & send email OTP
 * @access  Public
 */
router.post('/signup', authController.signup);

/**
 * @route   POST /api/auth/verify-email-otp
 * @desc    Step 2: Verify email OTP
 * @access  Public
 */
router.post('/verify-email-otp', authController.verifyEmailOtp);

/**
 * @route   POST /api/auth/send-phone-otp
 * @desc    Step 3: Send phone OTP (after email verified)
 * @access  Public
 */
router.post('/send-phone-otp', authController.sendPhoneOtp);

/**
 * @route   POST /api/auth/verify-phone-otp
 * @desc    Step 4: Verify phone OTP & complete registration
 * @access  Public
 */
router.post('/verify-phone-otp', authController.verifyPhoneOtp);

/**
 * @route   POST /api/auth/set-password
 * @desc    Step 5: Set password & complete registration
 * @access  Public
 */
router.post('/set-password', authController.setPassword);

/**
 * @route   POST /api/auth/resend-email-otp
 * @desc    Resend email OTP (with cooldown)
 * @access  Public
 */
router.post('/resend-email-otp', authController.resendEmailOtp);

/**
 * @route   POST /api/auth/resend-phone-otp
 * @desc    Resend phone OTP (with cooldown)
 * @access  Public
 */
router.post('/resend-phone-otp', authController.resendPhoneOtp);

/**
 * @route   POST /api/auth/login
 * @desc    Login user with email or phone
 * @access  Public
 */
router.post('/login', authController.login);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user
 * @access  Private
 */
router.post('/logout', authenticate, authController.logout);

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public
 */
router.post('/refresh', authController.refresh);

/**
 * @route   GET /api/auth/me
 * @desc    Get current authenticated user
 * @access  Private
 */
router.get('/me', authenticate, authController.me);

/**
 * @route   GET /api/auth/app-permissions
 * @desc    Get app permissions for the authenticated user
 * @access  Private
 */
router.get('/app-permissions', authenticate, authController.getAppPermissions);

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Request password reset email
 * @access  Public
 */
router.post('/forgot-password', authController.forgotPassword);

/**
 * @route   POST /api/auth/change-password
 * @desc    Change user password (requires authentication)
 * @access  Private
 */
router.post('/change-password', authenticate, authController.changePassword);

module.exports = router;
