const express = require('express');
const router = express.Router();
const qrController = require('../controllers/qrController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   POST /api/qr/verify
 * @desc    Decrypt and verify a scanned QR code (encrypted or pipe-format)
 * @access  Private
 */
router.post('/verify', authenticate, qrController.verifyQr);

/**
 * @route   POST /api/qr/encrypt
 * @desc    Encrypt ticket/truck data into a QR payload (mirrors web frontend)
 * @access  Private
 */
router.post('/encrypt', authenticate, qrController.encryptQr);

/**
 * @route   POST /api/qr/decrypt
 * @desc    Decrypt a QR payload (D3 hex, legacy, or pipe-format). No auth required.
 * @access  Public (gated by QR signature)
 */
router.post('/decrypt', qrController.decryptQr);

module.exports = router;
