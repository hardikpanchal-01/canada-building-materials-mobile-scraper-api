const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { authenticate } = require('../middleware/auth');
const { internalChatNotifyAuth } = require('../middleware/internalAuth');

router.get('/read-status', authenticate, chatController.getReadStatus);
router.get('/unread-counts', authenticate, chatController.getUnreadCounts);
router.post('/mark-read', authenticate, chatController.markAsRead);
router.post('/notify', internalChatNotifyAuth, chatController.notifyChatMessage);

module.exports = router;
