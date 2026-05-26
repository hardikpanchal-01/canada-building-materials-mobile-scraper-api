/**
 * Encryption Utilities
 *
 * Provides security functions for the mobile federated authentication:
 * - AES-256-GCM encryption/decryption for sensitive tenant data
 * - Bcrypt password hashing/verification
 * - Secure random code generation
 * - Constant-time string comparison
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 12 bytes recommended for GCM
const AUTH_TAG_LENGTH = 16; // 16 bytes for maximum security
const BCRYPT_ROUNDS = 10;

/**
 * Get encryption key from environment
 * @returns {Buffer} 32-byte encryption key
 * @throws {Error} If key not configured or invalid
 */
function getEncryptionKey() {
  const keyHex = process.env.ENCRYPTION_KEY;

  if (!keyHex) {
    throw new Error('ENCRYPTION_KEY not configured in environment variables');
  }

  if (keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }

  return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt plaintext using AES-256-GCM
 * @param {string} plaintext - Text to encrypt
 * @returns {string} Encrypted string in format: iv:authTag:ciphertext (all hex)
 */
function encrypt(plaintext) {
  if (!plaintext) {
    return null;
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt ciphertext using AES-256-GCM
 * @param {string} encryptedData - Encrypted string in format: iv:authTag:ciphertext
 * @returns {string} Decrypted plaintext
 * @throws {Error} If decryption fails or data is tampered
 */
function decrypt(encryptedData) {
  if (!encryptedData) {
    return null;
  }

  const parts = encryptedData.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const [ivHex, authTagHex, ciphertext] = parts;

  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  });

  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Generate a secure random authorization code
 * @returns {string} 64-character hex string (32 bytes)
 */
function generateAuthCode() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a password using bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Bcrypt hash
 */
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify a password against a bcrypt hash
 * @param {string} password - Plain text password
 * @param {string} hash - Bcrypt hash to compare against
 * @returns {Promise<boolean>} True if password matches
 */
async function verifyPassword(password, hash) {
  if (!password || !hash) {
    return false;
  }

  return bcrypt.compare(password, hash);
}

/**
 * Securely compare two strings in constant time
 * Prevents timing attacks on secret comparison
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings are equal
 */
function secureCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  // Ensure both strings are the same length for timingSafeEqual
  if (a.length !== b.length) {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  encrypt,
  decrypt,
  generateAuthCode,
  hashPassword,
  verifyPassword,
  secureCompare
};
