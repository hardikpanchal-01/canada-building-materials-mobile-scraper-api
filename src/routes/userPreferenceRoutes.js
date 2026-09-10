const express = require('express');
const router = express.Router();
const { authenticate, invalidateTzPrefCache } = require('../middleware/auth');
const { executeDirectSQL } = require('../utils/postgresExecutor');

/**
 * @route   GET /api/user-preferences
 * @desc    Get all user preferences
 * @access  Private
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await executeDirectSQL(
      'SELECT preference_key, preference_value FROM user_preferences WHERE user_id = $1',
      [userId]
    );
    const prefs = {};
    for (const row of (result.data || [])) {
      prefs[row.preference_key] = row.preference_value;
    }
    return res.status(200).json({ success: true, data: prefs });
  } catch (err) {
    console.error('[UserPreferences] GET all error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch preferences' });
  }
});

/**
 * @route   GET /api/user-preferences/:key
 * @desc    Get a single user preference by key
 * @access  Private
 */
router.get('/:key', authenticate, async (req, res) => {
  try {
    // Use req.user.id (the JWT's id) so the saved preference is keyed by the SAME
    // id the auth middleware reads it back by (middleware/auth.js: .eq('user_id', decoded.id)).
    // Using a resolved/email-mapped id here caused timezone changes to never reflect
    // for multi-tenant users (saved under one id, read under another).
    const userId = req.user.id;
    const { key } = req.params;

    let data;
    try {
      const result = await executeDirectSQL(
        'SELECT preference_value FROM user_preferences WHERE user_id = $1 AND preference_key = $2 LIMIT 1',
        [userId, key]
      );
      data = result.data[0] || null;
    } catch (error) {
      console.error('[UserPreferences] GET error:', error.message);
      return res.status(500).json({ success: false, message: 'Failed to fetch preference' });
    }

    return res.status(200).json({
      success: true,
      data: data ? data.preference_value : null,
    });
  } catch (err) {
    console.error('[UserPreferences] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch preference' });
  }
});

/**
 * @route   PUT /api/user-preferences/:key
 * @desc    Set/update a single user preference
 * @access  Private
 */
router.put('/:key', authenticate, async (req, res) => {
  try {
    // Use req.user.id (the JWT's id) so the saved preference is keyed by the SAME
    // id the auth middleware reads it back by (middleware/auth.js: .eq('user_id', decoded.id)).
    // Using a resolved/email-mapped id here caused timezone changes to never reflect
    // for multi-tenant users (saved under one id, read under another).
    const userId = req.user.id;
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({ success: false, message: 'value is required' });
    }

    let data;
    try {
      // JSON.stringify + ::jsonb handles any value type (string/number/boolean/object/array)
      const result = await executeDirectSQL(
        `INSERT INTO user_preferences (user_id, preference_key, preference_value, updated_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (user_id, preference_key)
         DO UPDATE SET preference_value = EXCLUDED.preference_value, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [userId, key, JSON.stringify(value), new Date().toISOString()]
      );
      data = result.data[0];
    } catch (error) {
      console.error('[UserPreferences] PUT error:', error.message);
      return res.status(500).json({ success: false, message: 'Failed to save preference' });
    }

    // Immediately invalidate timezone cache so next request uses new value
    if (key === 'timezone') {
      invalidateTzPrefCache(userId);
    }

    return res.status(200).json({
      success: true,
      data: data,
    });
  } catch (err) {
    console.error('[UserPreferences] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to save preference' });
  }
});

module.exports = router;
