/**
 * Scraper Authentication Middleware
 *
 * Validates API key for scraper access.
 * Uses a static API key stored in environment variables.
 */

const { secureCompare } = require('../utils/encryptionUtils');

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';

/**
 * Middleware to authenticate scraper requests
 *
 * Expects the API key in the 'x-scraper-api-key' header.
 *
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @param {function} next - Express next function
 */
function scraperAuthMiddleware(req, res, next) {
  // Get API key from header
  const apiKey = req.headers['x-scraper-api-key'];

  // Check if API key is configured on server
  if (!SCRAPER_API_KEY) {
    console.error('Server configuration error: SCRAPER_API_KEY not set');
    return res.status(500).json({
      success: false,
      error: 'Server configuration error: API key not configured',
      error_code: 'SERVER_CONFIG_ERROR'
    });
  }

  // Check if API key is provided in request
  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'API key is required. Provide it in the x-scraper-api-key header',
      error_code: 'UNAUTHORIZED'
    });
  }

  // Validate API key (constant-time comparison to prevent timing attacks)
  if (!secureCompare(apiKey, SCRAPER_API_KEY)) {
    console.warn(`Invalid API key attempt from IP: ${req.ip}`);
    return res.status(401).json({
      success: false,
      error: 'Invalid or missing API key',
      error_code: 'UNAUTHORIZED'
    });
  }

  // API key is valid, proceed to next middleware
  next();
}

module.exports = {
  scraperAuthMiddleware
};
