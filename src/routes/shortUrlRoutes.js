/**
 * Short URL Routes
 *
 * Short URL resolution endpoints:
 * - GET /api/short-urls/resolve/:code - Resolve a short URL code (public, no auth)
 */

const express = require('express');
const router = express.Router();
const shortUrlController = require('../controllers/shortUrlController');

/**
 * @route   GET /api/short-urls/resolve/:code
 * @desc    Resolve a short URL code to original URL and tenant slug
 * @access  Public (no authentication required)
 */
router.get('/resolve/:code', shortUrlController.resolveShortUrl);

module.exports = router;
