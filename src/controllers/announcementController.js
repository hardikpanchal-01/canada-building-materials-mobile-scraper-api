const announcementService = require('../services/announcementService');

const FALLBACK_TZ = 'America/Chicago';

function formatToUserTz(dateTimeStr, tz) {
  if (!dateTimeStr) return null;
  const date = new Date(dateTimeStr);
  if (isNaN(date.getTime())) return dateTimeStr;
  const timeZone = tz?.iana || FALLBACK_TZ;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function formatAnnouncementTimestamps(announcement, tz) {
  if (!announcement || !tz) return announcement;
  return {
    ...announcement,
    created_at: formatToUserTz(announcement.created_at, tz),
    updated_at: formatToUserTz(announcement.updated_at, tz),
  };
}

/**
 * @swagger
 * /api/announcements:
 *   get:
 *     summary: Get all announcements
 *     description: |
 *       Fetches announcements with optional filters for published status, plant_id, and active status.
 *       Supports pagination with page and limit parameters.
 *     tags: [Announcements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: published
 *         required: false
 *         schema:
 *           type: boolean
 *         description: Filter by published status
 *         example: true
 *       - in: query
 *         name: plant_id
 *         required: false
 *         schema:
 *           type: integer
 *         description: Filter by plant_id (announcements containing this plant_id)
 *         example: 1
 *       - in: query
 *         name: active
 *         required: false
 *         schema:
 *           type: boolean
 *         description: Filter by active announcements (current date within start_date and end_date)
 *         example: true
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *         description: Page number (1-based)
 *         example: 1
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of announcements per page
 *         example: 50
 *     responses:
 *       200:
 *         description: Announcements retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Announcements retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     announcements:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Announcement'
 *                     total:
 *                       type: integer
 *                       example: 10
 *                     page:
 *                       type: integer
 *                       example: 1
 *                     limit:
 *                       type: integer
 *                       example: 50
 *                     totalPages:
 *                       type: integer
 *                       example: 1
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       500:
 *         description: Server error
 */
async function getAnnouncements(req, res) {
  try {
    const { published, plant_id, active, page, limit } = req.query;

    const filters = {};
    if (published !== undefined) {
      filters.published = published === 'true';
    }
    if (plant_id) {
      filters.plant_id = plant_id;
    }
    if (active !== undefined) {
      filters.active = active === 'true';
    }

    const parsedPage = page ? parseInt(page, 10) : 1;
    const parsedLimit = limit ? parseInt(limit, 10) : 50;

    const tz = req.user?.timezone || null;
    const data = await announcementService.getAnnouncements(filters, parsedPage, parsedLimit);

    if (tz && data.announcements) {
      data.announcements = data.announcements.map(a => formatAnnouncementTimestamps(a, tz));
    }

    return res.status(200).json({
      success: true,
      message: 'Announcements retrieved successfully',
      data
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch announcements',
      error_code: 'INTERNAL_ERROR'
    });
  }
}

/**
 * @swagger
 * /api/announcements/{id}:
 *   get:
 *     summary: Get announcement by ID
 *     description: Fetches a single announcement by its ID
 *     tags: [Announcements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Announcement ID
 *         example: 1
 *     responses:
 *       200:
 *         description: Announcement retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Announcement retrieved successfully"
 *                 data:
 *                   $ref: '#/components/schemas/Announcement'
 *       404:
 *         description: Announcement not found
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       500:
 *         description: Server error
 */
async function getAnnouncementById(req, res) {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Announcement ID is required',
        error_code: 'VALIDATION_ERROR'
      });
    }

    const tz = req.user?.timezone || null;
    const data = await announcementService.getAnnouncementById(parseInt(id, 10));

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Announcement not found',
        error_code: 'NOT_FOUND'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Announcement retrieved successfully',
      data: formatAnnouncementTimestamps(data, tz)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch announcement',
      error_code: 'INTERNAL_ERROR'
    });
  }
}

/**
 * @swagger
 * /api/announcements:
 *   post:
 *     summary: Create a new announcement
 *     description: Creates a new announcement with the provided data
 *     tags: [Announcements]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - campaign
 *             properties:
 *               name:
 *                 type: string
 *                 description: Announcement name
 *                 example: "Summer Sale"
 *               campaign:
 *                 type: string
 *                 description: Campaign name
 *                 example: "Summer 2024"
 *               start_date:
 *                 type: string
 *                 format: date-time
 *                 description: Start date of the announcement
 *                 example: "2024-06-01T00:00:00Z"
 *               end_date:
 *                 type: string
 *                 format: date-time
 *                 description: End date of the announcement
 *                 example: "2024-08-31T23:59:59Z"
 *               tile_type:
 *                 type: string
 *                 description: Type of tile display
 *                 example: "banner"
 *               tagline:
 *                 type: string
 *                 description: Short tagline
 *                 example: "Limited Time Offer"
 *               title:
 *                 type: string
 *                 description: Announcement title
 *                 example: "Summer Savings"
 *               subtitle:
 *                 type: string
 *                 description: Announcement subtitle
 *                 example: "Up to 50% off"
 *               icon_or_percent:
 *                 type: string
 *                 description: Icon name or percentage value
 *                 example: "50%"
 *               color:
 *                 type: string
 *                 description: Display color
 *                 example: "#FF5733"
 *               url:
 *                 type: string
 *                 description: Link URL
 *                 example: "https://example.com/summer-sale"
 *               published:
 *                 type: boolean
 *                 description: Whether the announcement is published
 *                 example: false
 *               plant_ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Array of plant IDs
 *                 example: [1, 2, 3]
 *               message_details_code:
 *                 type: string
 *                 description: Message details code
 *                 example: "SUMMER_SALE_2024"
 *               created_by:
 *                 type: string
 *                 format: uuid
 *                 description: UUID of the user who created the announcement
 *                 example: "41f7ae25-485d-4127-be4d-3967725c20ef"
 *     responses:
 *       201:
 *         description: Announcement created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Announcement created successfully"
 *                 data:
 *                   $ref: '#/components/schemas/Announcement'
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       500:
 *         description: Server error
 */
async function createAnnouncement(req, res) {
  try {
    const { name, campaign } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'name is required',
        error_code: 'VALIDATION_ERROR'
      });
    }

    if (!campaign) {
      return res.status(400).json({
        success: false,
        message: 'campaign is required',
        error_code: 'VALIDATION_ERROR'
      });
    }

    const data = await announcementService.createAnnouncement(req.body);

    return res.status(201).json({
      success: true,
      message: 'Announcement created successfully',
      data
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create announcement',
      error_code: 'INTERNAL_ERROR'
    });
  }
}

/**
 * @swagger
 * /api/announcements/{id}:
 *   put:
 *     summary: Update an announcement
 *     description: Updates an existing announcement by ID
 *     tags: [Announcements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Announcement ID
 *         example: 1
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Updated Summer Sale"
 *               campaign:
 *                 type: string
 *                 example: "Summer 2024"
 *               start_date:
 *                 type: string
 *                 format: date-time
 *               end_date:
 *                 type: string
 *                 format: date-time
 *               tile_type:
 *                 type: string
 *               tagline:
 *                 type: string
 *               title:
 *                 type: string
 *               subtitle:
 *                 type: string
 *               icon_or_percent:
 *                 type: string
 *               color:
 *                 type: string
 *               url:
 *                 type: string
 *               published:
 *                 type: boolean
 *               plant_ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *               message_details_code:
 *                 type: string
 *     responses:
 *       200:
 *         description: Announcement updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Announcement updated successfully"
 *                 data:
 *                   $ref: '#/components/schemas/Announcement'
 *       404:
 *         description: Announcement not found
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       500:
 *         description: Server error
 */
async function updateAnnouncement(req, res) {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Announcement ID is required',
        error_code: 'VALIDATION_ERROR'
      });
    }

    const data = await announcementService.updateAnnouncement(parseInt(id, 10), req.body);

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Announcement not found',
        error_code: 'NOT_FOUND'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Announcement updated successfully',
      data
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update announcement',
      error_code: 'INTERNAL_ERROR'
    });
  }
}

/**
 * @swagger
 * /api/announcements/{id}:
 *   delete:
 *     summary: Delete an announcement
 *     description: Deletes an announcement by ID
 *     tags: [Announcements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Announcement ID
 *         example: 1
 *     responses:
 *       200:
 *         description: Announcement deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Announcement deleted successfully"
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       500:
 *         description: Server error
 */
async function deleteAnnouncement(req, res) {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Announcement ID is required',
        error_code: 'VALIDATION_ERROR'
      });
    }

    await announcementService.deleteAnnouncement(parseInt(id, 10));

    return res.status(200).json({
      success: true,
      message: 'Announcement deleted successfully'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete announcement',
      error_code: 'INTERNAL_ERROR'
    });
  }
}

/**
 * @swagger
 * /api/announcements/me:
 *   get:
 *     summary: Get announcements for authenticated user
 *     description: |
 *       Fetches announcements for the authenticated user based on their plant access.
 *       Flow: user_id (from JWT) → user_roles → role_plants → filter announcements by plant_ids.
 *       Only returns published announcements. Use `active` filter to get active/inactive announcements.
 *     tags: [Announcements]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: active
 *         required: false
 *         schema:
 *           type: boolean
 *         description: |
 *           Filter by active status:
 *           - `true`: Only active announcements (current date within start_date and end_date)
 *           - `false`: Only inactive announcements (current date outside start_date and end_date)
 *           - Not provided: All announcements regardless of dates
 *         example: true
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *         description: Page number (1-based)
 *         example: 1
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of announcements per page
 *         example: 50
 *     responses:
 *       200:
 *         description: Announcements retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Announcements retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     announcements:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Announcement'
 *                     total:
 *                       type: integer
 *                       example: 10
 *                     page:
 *                       type: integer
 *                       example: 1
 *                     limit:
 *                       type: integer
 *                       example: 50
 *                     totalPages:
 *                       type: integer
 *                       example: 1
 *                     userPlantIds:
 *                       type: array
 *                       items:
 *                         type: integer
 *                       description: Plant IDs the user has access to
 *                       example: [1, 2, 3]
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       500:
 *         description: Server error
 */
async function getAnnouncementsForUser(req, res) {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?.sub;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User ID not found in token',
        error_code: 'UNAUTHORIZED'
      });
    }

    const { active, page, limit } = req.query;

    const filters = {};
    if (active !== undefined) {
      filters.active = active === 'true';
    }

    const parsedPage = page ? parseInt(page, 10) : 1;
    const parsedLimit = limit ? parseInt(limit, 10) : 50;

    const tz = req.user?.timezone || null;
    const data = await announcementService.getAnnouncementsForUser(userId, filters, parsedPage, parsedLimit);

    if (tz && data.announcements) {
      data.announcements = data.announcements.map(a => formatAnnouncementTimestamps(a, tz));
    }

    return res.status(200).json({
      success: true,
      message: 'Announcements retrieved successfully',
      data
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch announcements',
      error_code: 'INTERNAL_ERROR'
    });
  }
}

/**
 * @swagger
 * components:
 *   schemas:
 *     Announcement:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           example: 1
 *         name:
 *           type: string
 *           example: "Summer Sale"
 *         campaign:
 *           type: string
 *           example: "Summer 2024"
 *         start_date:
 *           type: string
 *           format: date-time
 *           nullable: true
 *           example: "2024-06-01T00:00:00Z"
 *         end_date:
 *           type: string
 *           format: date-time
 *           nullable: true
 *           example: "2024-08-31T23:59:59Z"
 *         tile_type:
 *           type: string
 *           nullable: true
 *           example: "banner"
 *         tagline:
 *           type: string
 *           nullable: true
 *           example: "Limited Time Offer"
 *         title:
 *           type: string
 *           nullable: true
 *           example: "Summer Savings"
 *         subtitle:
 *           type: string
 *           nullable: true
 *           example: "Up to 50% off"
 *         icon_or_percent:
 *           type: string
 *           nullable: true
 *           example: "50%"
 *         color:
 *           type: string
 *           nullable: true
 *           example: "#FF5733"
 *         url:
 *           type: string
 *           nullable: true
 *           example: "https://example.com/summer-sale"
 *         published:
 *           type: boolean
 *           example: false
 *         plant_ids:
 *           type: array
 *           items:
 *             type: integer
 *           example: [1, 2, 3]
 *         message_details_code:
 *           type: string
 *           nullable: true
 *           example: "SUMMER_SALE_2024"
 *         created_by:
 *           type: string
 *           format: uuid
 *           nullable: true
 *           example: "41f7ae25-485d-4127-be4d-3967725c20ef"
 *         created_at:
 *           type: string
 *           format: date-time
 *           example: "2024-01-15T10:30:00Z"
 *         updated_at:
 *           type: string
 *           format: date-time
 *           example: "2024-01-15T10:30:00Z"
 */

module.exports = {
  getAnnouncements,
  getAnnouncementById,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  getAnnouncementsForUser
};
