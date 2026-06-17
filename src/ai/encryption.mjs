/**
 * AES-256-GCM encryption utility (ported from the web app's @/lib/encryption).
 * Reads the secret from ENCRYPTION_SECRET_KEY, falling back to the backend's
 * existing ENCRYPTION_KEY so the same value works under either name.
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const ENCODING = 'hex';

function getEncryptionKey() {
  const secret = process.env.ENCRYPTION_SECRET_KEY || process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'ENCRYPTION_SECRET_KEY (or ENCRYPTION_KEY) environment variable is not set.',
    );
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function checkIsEncrypted(text) {
  if (!text) return false;
  const parts = text.split(':');
  if (parts.length !== 3) return false;
  const [ivHex, authTagHex] = parts;
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    return iv.length === IV_LENGTH && authTag.length === AUTH_TAG_LENGTH;
  } catch {
    return false;
  }
}

export function encrypt(plainText) {
  if (!plainText) return '';
  if (checkIsEncrypted(plainText)) return plainText;
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plainText, 'utf8', ENCODING);
    encrypted += cipher.final(ENCODING);
    const authTag = cipher.getAuthTag();
    return `${iv.toString(ENCODING)}:${authTag.toString(ENCODING)}:${encrypted}`;
  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error('Failed to encrypt data');
  }
}

export function decrypt(encryptedText) {
  if (!encryptedText) return '';
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    console.warn('Data does not appear to be encrypted, returning as-is');
    return encryptedText;
  }
  try {
    const key = getEncryptionKey();
    const [ivHex, authTagHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, ENCODING);
    const authTag = Buffer.from(authTagHex, ENCODING);
    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      console.warn('Invalid encryption format, returning as-is');
      return encryptedText;
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, ENCODING, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.warn('Decryption failed, data might be unencrypted:', error);
    return encryptedText;
  }
}

export function isEncrypted(text) {
  return checkIsEncrypted(text);
}

export function maskSensitiveData(text, visibleChars = 4) {
  if (!text) return '';
  if (text.length <= visibleChars * 2) return '****';
  const start = text.substring(0, visibleChars);
  const end = text.substring(text.length - visibleChars);
  return `${start}...${end}`;
}
