/**
 * Mobile Federated Authentication Routes
 *
 * OAuth 2.0 Authorization Code Flow endpoints:
 * - POST /api/auth/mobile/login - Authenticate and get authorization code
 * - POST /api/auth/mobile/exchange-code - Exchange code for user info
 * - GET  /api/auth/mobile/tenants - List tenants the user has access to
 * - POST /api/auth/mobile/switch-tenant - Generate auth code for switching tenant
 */

const express = require('express');
const router = express.Router();
const mobileAuthController = require('../controllers/mobileAuthController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   POST /api/auth/mobile/login
 * @desc    Authenticate user and get authorization code
 * @access  Public
 */
router.post('/login', mobileAuthController.login);

/**
 * @route   POST /api/auth/mobile/exchange-code
 * @desc    Exchange authorization code for user info (server-to-server)
 * @access  Public (requires client credentials)
 */
router.post('/exchange-code', mobileAuthController.exchangeCode);

/**
 * @route   GET /api/auth/mobile/tenants
 * @desc    List tenants the authenticated user has access to
 * @access  Private (requires JWT)
 */
router.get('/tenants', authenticate, mobileAuthController.listTenants);

/**
 * @route   POST /api/auth/mobile/switch-tenant
 * @desc    Generate auth code for switching to a different tenant
 * @access  Private (requires JWT)
 */
router.post('/switch-tenant', authenticate, mobileAuthController.switchTenant);

module.exports = router;
