const express = require('express');
const router = express.Router();
const announcementController = require('../controllers/announcementController');
const { authenticate } = require('../middleware/auth');

/**
 * @route   GET /api/announcements
 * @desc    Get all announcements with optional filters
 * @access  Private
 */
router.get('/', authenticate, announcementController.getAnnouncements);

/**
 * @route   GET /api/announcements/me
 * @desc    Get announcements for authenticated user based on their plant access
 * @access  Private
 */
router.get('/me', authenticate, announcementController.getAnnouncementsForUser);

/**
 * @route   GET /api/announcements/:id
 * @desc    Get announcement by ID
 * @access  Private
 */
router.get('/:id', authenticate, announcementController.getAnnouncementById);

/**
 * @route   POST /api/announcements
 * @desc    Create a new announcement
 * @access  Private
 */
router.post('/', authenticate, announcementController.createAnnouncement);

/**
 * @route   PUT /api/announcements/:id
 * @desc    Update an announcement
 * @access  Private
 */
router.put('/:id', authenticate, announcementController.updateAnnouncement);

/**
 * @route   DELETE /api/announcements/:id
 * @desc    Delete an announcement
 * @access  Private
 */
router.delete('/:id', authenticate, announcementController.deleteAnnouncement);

module.exports = router;
