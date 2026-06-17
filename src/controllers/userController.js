const userService = require('../services/userService');

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

function formatProfileTimestamps(profile, tz) {
  if (!profile || !tz) return profile;
  return {
    ...profile,
    createdAt: formatToUserTz(profile.createdAt, tz),
    updatedAt: formatToUserTz(profile.updatedAt, tz),
  };
}

/**
 * @swagger
 * /api/users/profile:
 *   get:
 *     summary: Get current user profile
 *     description: |
 *       Retrieves the complete profile information for the currently authenticated user.
 *       
 *       Returns user data including:
 *       - Personal information (name, email, phone)
 *       - Professional information (title, company)
 *       - Account status and metadata
 *       
 *       **Note:** The profile is retrieved from the `public.users` table which is linked to `auth.users`.
 *     tags: [Users]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
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
 *                   example: "User profile retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                       example: "123e4567-e89b-12d3-a456-426614174000"
 *                     email:
 *                       type: string
 *                       format: email
 *                       example: "user@example.com"
 *                     firstName:
 *                       type: string
 *                       example: "Shane"
 *                     lastName:
 *                       type: string
 *                       example: "Watson"
 *                     fullName:
 *                       type: string
 *                       example: "Shane Watson"
 *                     phone:
 *                       type: string
 *                       example: "+1234567890"
 *                     phoneNumber:
 *                       type: string
 *                       example: "234567890"
 *                     phoneCountryCode:
 *                       type: string
 *                       example: "+1"
 *                     title:
 *                       type: string
 *                       example: "Software Engineer"
 *                     company:
 *                       type: string
 *                       nullable: true
 *                       example: "Acme Corp"
 *                     active:
 *                       type: boolean
 *                       example: true
 *                     avatarUrl:
 *                       type: string
 *                       nullable: true
 *                       format: uri
 *                       example: "https://example.com/avatar.jpg"
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       404:
 *         description: User profile not found
 *       500:
 *         description: Server error
 */
async function getProfile(req, res) {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    // Get profile (will auto-create if it doesn't exist)
    const tz = req.user?.timezone || null;
    const profile = await userService.getUserProfile(userId, userEmail);

    return res.status(200).json({
      success: true,
      message: 'User profile retrieved successfully',
      data: formatProfileTimestamps(profile, tz)
    });
  } catch (error) {
    console.error('Error getting user profile:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to retrieve user profile',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/users/profile:
 *   put:
 *     summary: Update current user profile
 *     description: |
 *       Updates the profile information for the currently authenticated user.
 *       
 *       **Updateable Fields:**
 *       - `firstName` / `lastName` - Will be combined into `full_name` in database
 *       - `phone` - Will be split into `phone_number` and `phone_country_code`
 *       - `title` - Professional title
 *       - `company` - Company name (if supported by schema)
 *       - `avatarUrl` - Profile picture URL (if supported by schema)
 *       
 *       **Note:** Email cannot be updated through this endpoint as it's managed by auth system.
 *       
 *       All fields are optional - only provided fields will be updated.
 *     tags: [Users]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName:
 *                 type: string
 *                 description: First name (will be combined with lastName into full_name)
 *                 example: "Shane"
 *               lastName:
 *                 type: string
 *                 description: Last name (will be combined with firstName into full_name)
 *                 example: "Watson"
 *               phone:
 *                 type: string
 *                 description: Phone number with optional country code (e.g., "+1234567890")
 *                 example: "+1234567890"
 *               title:
 *                 type: string
 *                 description: Professional title
 *                 example: "Software Engineer"
 *               company:
 *                 type: string
 *                 nullable: true
 *                 description: Company name
 *                 example: "Acme Corp"
 *               avatarUrl:
 *                 type: string
 *                 nullable: true
 *                 format: uri
 *                 description: URL to profile picture/avatar
 *                 example: "https://example.com/avatar.jpg"
 *           examples:
 *             fullUpdate:
 *               summary: Full profile update
 *               value:
 *                 firstName: "Shane"
 *                 lastName: "Watson"
 *                 phone: "+1234567890"
 *                 title: "Software Engineer"
 *                 company: "Acme Corp"
 *             partialUpdate:
 *               summary: Partial update (only name)
 *               value:
 *                 firstName: "John"
 *                 lastName: "Doe"
 *             phoneUpdate:
 *               summary: Update phone only
 *               value:
 *                 phone: "+441234567890"
 *     responses:
 *       200:
 *         description: User profile updated successfully
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
 *                   example: "User profile updated successfully"
 *                 data:
 *                   type: object
 *                   description: Updated user profile (same structure as GET response)
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       404:
 *         description: User profile not found
 *       500:
 *         description: Server error
 */
async function updateProfile(req, res) {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    const updateData = req.body;

    // Validate that at least one field is provided
    const allowedFields = ['firstName', 'lastName', 'fullName', 'phone', 'phoneNumber', 'phoneCountryCode', 'title', 'company', 'avatarUrl'];
    const hasValidField = Object.keys(updateData).some(key => allowedFields.includes(key));

    if (!hasValidField) {
      return res.status(400).json({
        success: false,
        message: 'At least one valid field must be provided for update',
        allowedFields
      });
    }

    // Validate phone format if provided
    if (updateData.phone && typeof updateData.phone !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Phone must be a string'
      });
    }

    // Validate name fields
    if (updateData.firstName !== undefined && typeof updateData.firstName !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'firstName must be a string'
      });
    }

    if (updateData.lastName !== undefined && typeof updateData.lastName !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'lastName must be a string'
      });
    }

    // Update profile (will auto-create if it doesn't exist)
    const tz = req.user?.timezone || null;
    const updatedProfile = await userService.updateUserProfile(userId, updateData, userEmail);

    return res.status(200).json({
      success: true,
      message: 'User profile updated successfully',
      data: formatProfileTimestamps(updatedProfile, tz)
    });
  } catch (error) {
    console.error('Error updating user profile:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update user profile',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/users/profile/avatar:
 *   post:
 *     summary: Upload profile picture
 *     description: |
 *       Uploads a profile picture for the authenticated user.
 *       The image is stored in a Supabase Storage bucket and the public URL
 *       is saved to the user's `avatar_url` column.
 *
 *       **Accepted formats:** JPEG, PNG, GIF, WebP
 *       **Max file size:** 5 MB
 *
 *       If the user already has an avatar, the old file is deleted from storage
 *       before the new one is uploaded.
 *     tags: [Users]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - avatar
 *             properties:
 *               avatar:
 *                 type: string
 *                 format: binary
 *                 description: The image file to upload
 *     responses:
 *       200:
 *         description: Avatar uploaded successfully
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
 *                   example: "Avatar uploaded successfully"
 *                 data:
 *                   type: object
 *                   description: Updated user profile
 *       400:
 *         description: No file provided or invalid file type
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
async function uploadAvatar(req, res) {
  try {
    const userId = req.user.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided. Please upload a file with field name "avatar".'
      });
    }

    const tz = req.user?.timezone || null;
    const updatedProfile = await userService.uploadUserAvatar(
      userId,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
      req.user.email
    );

    return res.status(200).json({
      success: true,
      message: 'Avatar uploaded successfully',
      data: formatProfileTimestamps(updatedProfile, tz)
    });
  } catch (error) {
    console.error('Error uploading avatar:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload avatar',
      error: error.message
    });
  }
}

/**
 * @swagger
 * /api/users/profile/avatar:
 *   delete:
 *     summary: Remove profile picture
 *     description: |
 *       Removes the profile picture for the authenticated user.
 *       Deletes the file from storage and sets `avatar_url` to null.
 *     tags: [Users]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Avatar removed successfully
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
 *                   example: "Avatar removed successfully"
 *                 data:
 *                   type: object
 *                   description: Updated user profile
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
async function removeAvatar(req, res) {
  try {
    const userId = req.user.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    const tz = req.user?.timezone || null;
    const updatedProfile = await userService.removeUserAvatar(userId, req.user.email);

    return res.status(200).json({
      success: true,
      message: 'Avatar removed successfully',
      data: formatProfileTimestamps(updatedProfile, tz)
    });
  } catch (error) {
    console.error('Error removing avatar:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to remove avatar',
      error: error.message
    });
  }
}

module.exports = {
  getProfile,
  updateProfile,
  uploadAvatar,
  removeAvatar
};

