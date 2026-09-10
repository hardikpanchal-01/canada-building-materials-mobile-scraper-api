const express = require('express');
const router = express.Router();
const multer = require('multer');
const chatController = require('../controllers/chatController');
const chatDataController = require('../controllers/chatDataController');
const { authenticate } = require('../middleware/auth');
const { internalChatNotifyAuth } = require('../middleware/internalAuth');

// Multer config: memory storage, max 10 MB, images + audio
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg',
      'audio/x-m4a',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image and audio files are allowed'));
    }
  }
});

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        success: false,
        message: err.code === 'LIMIT_FILE_SIZE' ? 'File too large. Maximum size is 10 MB.' : err.message
      });
    }
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
}

router.get('/read-status', authenticate, chatController.getReadStatus);
router.get('/unread-counts', authenticate, chatController.getUnreadCounts);
router.post('/mark-read', authenticate, chatController.markAsRead);
router.post('/notify', internalChatNotifyAuth, chatController.notifyChatMessage);

// Chat file upload (images, audio)
router.post('/upload', authenticate, handleUpload, chatDataController.uploadFile);

// Direct PostgreSQL chat data endpoints
router.get('/rooms', authenticate, chatDataController.getRooms);
router.get('/rooms/:order_id', authenticate, chatDataController.getOrCreateRoom);
router.get('/messages/:order_id', authenticate, chatDataController.getMessages);
router.post('/messages', authenticate, chatDataController.sendMessage);
router.get('/user/:user_id', authenticate, chatDataController.getUserName);
router.post('/messages/delete', authenticate, chatDataController.deleteMessage);
router.delete('/messages/:id', authenticate, chatDataController.deleteMessage);

module.exports = router;
