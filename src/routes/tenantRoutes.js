/**
 * Tenant Routes
 *
 * Tenant configuration endpoints:
 * - GET /api/tenant - Get tenant configuration by subdomain
 */

const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenantController');

/**
 * @route   GET /api/tenant
 * @desc    Get tenant configuration by subdomain
 * @access  Public
 */
router.get('/', tenantController.getTenant);

module.exports = router;
