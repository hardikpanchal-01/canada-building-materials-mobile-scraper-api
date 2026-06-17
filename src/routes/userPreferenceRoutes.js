const express = require('express');
const router = express.Router();
const { authenticate, invalidateTzPrefCache } = require('../middleware/auth');
const { getSupabaseAdmin } = require('../config/database');

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

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('user_preferences')
      .select('preference_value')
      .eq('user_id', userId)
      .eq('preference_key', key)
      .maybeSingle();

    if (error) {
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

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('user_preferences')
      .upsert({
        user_id: userId,
        preference_key: key,
        preference_value: value,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,preference_key',
      })
      .select()
      .single();

    if (error) {
      console.error('[UserPreferences] PUT error:', error.message, 'code:', error.code, 'details:', error.details, 'hint:', error.hint);
      console.error('[UserPreferences] PUT params:', { userId, key, value: typeof value, valueRaw: JSON.stringify(value) });
      return res.status(500).json({ success: false, message: 'Failed to save preference', error: error.message });
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
    console.error('[UserPreferences] Catch error:', err.message, err.stack);
    return res.status(500).json({ success: false, message: 'Failed to save preference', error: err.message });
  }
});

module.exports = router;
