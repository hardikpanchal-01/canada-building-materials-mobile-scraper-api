const express = require('express');
const router = express.Router();
const nlqController = require('../controllers/nlqController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   POST /api/ai/chat
 * @desc    Ask a question in plain English, get an answer from the database
 * @access  Private
 */
router.post('/chat', authenticate, nlqController.generateSQL);

/**
 * @route   GET /api/ai/history/:sessionId
 * @desc    Get conversation history for a session
 * @access  Private
 */
router.get('/history/:sessionId', authenticate, nlqController.getHistory);

/**
 * @route   DELETE /api/ai/history/:sessionId
 * @desc    Clear conversation history for a session
 * @access  Private
 */
router.delete('/history/:sessionId', authenticate, nlqController.clearHistory);

module.exports = router;
