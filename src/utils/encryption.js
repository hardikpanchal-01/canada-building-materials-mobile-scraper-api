/**
 * RSA Encryption Utility
 *
 * Provides RSA encryption functions for Command Cloud SOAP API authentication.
 * Uses node-forge to convert XML RSA keys to PEM and encrypt passwords.
 */

const forge = require('node-forge');

/**
 * Convert an XML RSA public key to PEM format
 *
 * Parses <Modulus> and <Exponent> from XML RSA key string,
 * constructs an RSA public key, and returns PEM format.
 *
 * @param {string} xmlKey - XML string containing RSAKeyValue with Modulus and Exponent
 * @returns {string} PEM-formatted public key
 */
function convertXmlKeyToPem(xmlKey) {
  if (!xmlKey) {
    throw new Error('XML key is required');
  }

  // Extract Modulus and Exponent from XML
  const modulusMatch = xmlKey.match(/<Modulus>(.*?)<\/Modulus>/);
  const exponentMatch = xmlKey.match(/<Exponent>(.*?)<\/Exponent>/);

  if (!modulusMatch || !exponentMatch) {
    throw new Error('Invalid XML key: missing Modulus or Exponent');
  }

  const modulusB64 = modulusMatch[1];
  const exponentB64 = exponentMatch[1];

  // Decode Base64 to binary
  const modulusBytes = forge.util.decode64(modulusB64);
  const exponentBytes = forge.util.decode64(exponentB64);

  // Create BigInteger from bytes
  const modulus = new forge.jsbn.BigInteger(forge.util.bytesToHex(modulusBytes), 16);
  const exponent = new forge.jsbn.BigInteger(forge.util.bytesToHex(exponentBytes), 16);

  // Create RSA public key
  const publicKey = forge.pki.setRsaPublicKey(modulus, exponent);

  // Convert to PEM
  return forge.pki.publicKeyToPem(publicKey);
}

/**
 * Encrypt a password using RSA PKCS1 v1.5
 *
 * Encodes the password as UTF-16LE (as required by Command Cloud API),
 * encrypts with RSA PKCS1 v1.5, and returns Base64-encoded result.
 *
 * @param {string} publicKeyPem - PEM-formatted RSA public key
 * @param {string} password - Plaintext password to encrypt
 * @returns {string} Base64-encoded encrypted password
 */
function encryptPassword(publicKeyPem, password) {
  if (!publicKeyPem || !password) {
    throw new Error('Public key PEM and password are required');
  }

  // Encode password as UTF-16LE
  const utf16leBytes = [];
  for (let i = 0; i < password.length; i++) {
    const code = password.charCodeAt(i);
    utf16leBytes.push(code & 0xff);         // Low byte
    utf16leBytes.push((code >> 8) & 0xff);  // High byte
  }
  const passwordBuffer = String.fromCharCode(...utf16leBytes);

  // Import the public key
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);

  // Encrypt with PKCS1 v1.5
  const encrypted = publicKey.encrypt(passwordBuffer, 'RSAES-PKCS1-V1_5');

  // Return Base64-encoded
  return forge.util.encode64(encrypted);
}

module.exports = {
  convertXmlKeyToPem,
  encryptPassword
};
