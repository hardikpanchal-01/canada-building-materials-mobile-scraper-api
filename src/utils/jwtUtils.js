const jwt = require('jsonwebtoken');
const { accessTokenSecret, refreshTokenSecret, accessTokenExpiry, refreshTokenExpiry } = require('../config/jwt');

/**
 * Generate access token (short-lived)
 * @param {Object} user - User object with id, email, phone, etc.
 * @returns {string} JWT access token
 */
function generateAccessToken(user) {
  const payload = {
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role || 'user',
    type: 'access'
  };

  return jwt.sign(payload, accessTokenSecret, {
    expiresIn: accessTokenExpiry,
    issuer: 'truckast-api',
    audience: 'truckast-client'
  });
}

/**
 * Generate refresh token (long-lived)
 * @param {Object} user - User object with id, email, phone
 * @returns {string} JWT refresh token
 */
function generateRefreshToken(user) {
  const payload = {
    id: user.id,
    email: user.email || null,
    phone: user.phone || null,
    role: user.role || 'user',
    type: 'refresh'
  };

  return jwt.sign(payload, refreshTokenSecret, {
    expiresIn: refreshTokenExpiry,
    issuer: 'truckast-api',
    audience: 'truckast-client'
  });
}

/**
 * Verify and decode access token
 * @param {string} token - JWT token
 * @returns {Object} Decoded token payload
 */
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, accessTokenSecret, {
      issuer: 'truckast-api',
      audience: 'truckast-client'
    });
  } catch (error) {
    throw new Error('Invalid or expired access token');
  }
}

/**
 * Verify and decode refresh token
 * @param {string} token - JWT refresh token
 * @returns {Object} Decoded token payload
 */
function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, refreshTokenSecret, {
      issuer: 'truckast-api',
      audience: 'truckast-client'
    });
  } catch (error) {
    throw new Error('Invalid or expired refresh token');
  }
}

/**
 * Verify any token (tries access first, then refresh)
 * @param {string} token - JWT token
 * @returns {Object} Decoded token payload with token type
 */
function verifyToken(token) {
  try {
    const decoded = verifyAccessToken(token);
    return { ...decoded, tokenType: 'access' };
  } catch (accessError) {
    try {
      const decoded = verifyRefreshToken(token);
      return { ...decoded, tokenType: 'refresh' };
    } catch (refreshError) {
      throw new Error('Invalid or expired token');
    }
  }
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  verifyToken
};


