const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const notificationPushController = require('../controllers/notificationPushController');
const notificationQueueController = require('../controllers/notificationQueueController');
const orderNotificationController = require('../controllers/orderNotificationController');
const notificationQueueService = require('../services/notificationQueueService');
const { authenticate } = require('../middleware/auth');

/**
 * @route   POST /api/notifications/send
 * @desc    Send push notification to device(s) (uses main Supabase)
 * @access  Private
 */
router.post('/send', authenticate, notificationController.sendNotification);

/**
 * @route   POST /api/notifications/fcm
 * @desc    Send push notification via FCM (uses notification Supabase)
 * @access  Private
 */
router.post('/fcm', authenticate, notificationPushController.sendNotification);

/**
 * @route   POST /api/notifications/send-order
 * @desc    Send order notification with navigation data (FCM + notification_queue)
 * @access  Private
 */
router.post('/send-order', authenticate, orderNotificationController.sendOrderNotification);

/**
 * @route   GET /api/notifications/history
 * @desc    Get notification history for authenticated user (uses notification Supabase)
 * @access  Private
 */
router.get('/history', authenticate, notificationQueueController.getNotifications);

/**
 * @route   GET /api/notifications/recent
 * @desc    Get the authenticated user's recent notifications (mobile Notifications screen)
 * @access  Private
 */
router.get('/recent', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const data = await notificationQueueService.getRecentNotifications(req.user.id, page, limit);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[Notifications] /recent error:', err.message);
    return res.status(500).json({ success: false, message: err.message || 'Failed to fetch recent notifications' });
  }
});

module.exports = router;


