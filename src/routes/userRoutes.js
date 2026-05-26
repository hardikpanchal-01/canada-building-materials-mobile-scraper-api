const express = require('express');
const router = express.Router();
const multer = require('multer');
const userController = require('../controllers/userController');
const { authenticate } = require('../middleware/auth');

// Multer config: store in memory, max 5 MB, images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, GIF, and WebP images are allowed'));
    }
  }
});

/**
 * @route   GET /api/users/profile
 * @desc    Get current user profile
 * @access  Private
 */
router.get('/profile', authenticate, userController.getProfile);

/**
 * @route   PUT /api/users/profile
 * @desc    Update current user profile
 * @access  Private
 */
router.put('/profile', authenticate, userController.updateProfile);

/**
 * @route   PATCH /api/users/profile
 * @desc    Partially update current user profile (alias for PUT)
 * @access  Private
 */
router.patch('/profile', authenticate, userController.updateProfile);

// Wrapper to handle multer errors as JSON responses
function handleUpload(req, res, next) {
  upload.single('avatar')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        success: false,
        message: err.code === 'LIMIT_FILE_SIZE'
          ? 'File too large. Maximum size is 5 MB.'
          : err.message
      });
    }
    if (err) {
      return res.status(400).json({
        success: false,
        message: err.message
      });
    }
    next();
  });
}

/**
 * @route   POST /api/users/profile/avatar
 * @desc    Upload profile picture
 * @access  Private
 */
router.post('/profile/avatar', authenticate, handleUpload, userController.uploadAvatar);

/**
 * @route   DELETE /api/users/profile/avatar
 * @desc    Remove profile picture
 * @access  Private
 */
router.delete('/profile/avatar', authenticate, userController.removeAvatar);

module.exports = router;

