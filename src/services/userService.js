const { getSupabase, getSupabaseAdmin } = require('../config/database');
const { uploadAvatarToStorage, deleteAvatarFromStorage, AVATARS_BUCKET } = require('./database/supabaseClient');

// In-memory user profile cache (2-minute TTL)
// getUserProfile is called on every authenticated request via dashboard/controllers
const _userProfileCache = new Map();
const USER_PROFILE_CACHE_TTL_MS = 2 * 60 * 1000;

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _userProfileCache) {
    if (now - entry.timestamp > USER_PROFILE_CACHE_TTL_MS) {
      _userProfileCache.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function _invalidateProfileCache(userId) {
  _userProfileCache.delete(userId);
}

/**
 * Get user email from auth.users via Supabase Auth (fallback if not in JWT)
 * @param {string} userId - User ID (UUID)
 * @returns {string|null} User email
 */
async function getUserEmailFromAuth(userId) {
  try {
    // Use admin client for auth admin operations
    const supabase = getSupabaseAdmin();
    
    // Try using admin API (requires service role key)
    try {
      const { data: { user }, error } = await supabase.auth.admin.getUserById(userId);
      if (!error && user && user.email) {
        return user.email;
      }
    } catch (adminError) {
      // Admin API not available, continue to fallback
      console.warn('Admin API not available:', adminError.message);
    }
    
    // Fallback: The email should come from JWT token in most cases
    return null;
  } catch (error) {
    console.warn('Could not fetch user email from auth:', error.message);
    return null;
  }
}

/**
 * Create user profile in public.users table if it doesn't exist
 * @param {string} userId - User ID (UUID)
 * @param {string} email - User email
 * @returns {Object} Created or existing user profile data
 */
async function createUserProfile(userId, email) {
  try {
    // Use admin client to bypass RLS policies for user creation
    const supabase = getSupabaseAdmin();
    
    // First, check if user already exists (race condition protection)
    const { data: existingUser } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    // If user already exists, return it
    if (existingUser) {
      return existingUser;
    }
    
    const newUser = {
      id: userId,
      email: email || null,
      full_name: null,
      active: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      invitation_status: null,
      invitation_sent_at: null,
      invitation_token: null,
      last_login_at: null,
      password_reset_at: null,
      title: null,
      phone_number: null,
      phone_country_code: null
    };

    const { data, error } = await supabase
      .from('users')
      .insert(newUser)
      .select()
      .single();

    if (error) {
      // If duplicate key error, user was created between check and insert - fetch it
      if (error.code === '23505' || error.message.includes('duplicate key') || error.message.includes('unique constraint')) {
        // Try by ID first, then by email (email unique constraint means another ID has this email)
        const { data: existingById } = await supabase
          .from('users')
          .select('*')
          .eq('id', userId)
          .single();

        if (existingById) {
          return existingById;
        }

        if (email) {
          const { data: existingByEmail } = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

          if (existingByEmail) {
            return existingByEmail;
          }
        }
      }
      throw new Error(error.message || 'Failed to create user profile');
    }

    return data;
  } catch (error) {
    throw error;
  }
}

/**
 * Get user's company from user_customers table joined with customers
 * @param {string} userId - User ID (UUID)
 * @returns {string|null} Company name or null if not found
 */
async function getUserCompany(userId) {
  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('user_customers')
      .select('customer_id, customers(id, name)')
      .eq('user_id', userId)
      .limit(1)
      .single();

    if (error || !data) {
      return null;
    }

    return data.customers?.name || null;
  } catch (error) {
    console.warn('Could not fetch user company:', error.message);
    return null;
  }
}

/**
 * Get user profile from public.users table, creating it if it doesn't exist
 * @param {string} userId - User ID (UUID)
 * @param {string} userEmail - User email (optional, will be fetched if not provided)
 * @returns {Object} User profile data
 */
async function getUserProfile(userId, userEmail = null) {
  try {
    // Check cache first (avoids 2 DB queries on every authenticated request)
    const cached = _userProfileCache.get(userId);
    if (cached && (Date.now() - cached.timestamp) < USER_PROFILE_CACHE_TTL_MS) {
      return cached.data;
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new Error(error.message || 'Failed to fetch user profile');
    }

    if (!data) {
      // User not found by ID - check if they exist by email (ID may have changed via central auth migration)
      console.log(`User profile not found for ${userId}, checking by email...`);

      let email = userEmail;
      if (!email) {
        email = await getUserEmailFromAuth(userId);
      }

      if (email) {
        const { data: existingByEmail } = await supabase
          .from('users')
          .select('*')
          .eq('email', email)
          .single();

        if (existingByEmail) {
          // User exists with a different ID (old Supabase auth vs new central auth)
          // Return existing profile as-is — cannot update users.id due to FK constraints from user_roles/user_customers
          console.log(`User found by email ${email} with old ID ${existingByEmail.id} (new auth ID: ${userId})`);
          const company = await getUserCompany(existingByEmail.id);
          const profile = formatUserProfile(existingByEmail, company);
          _userProfileCache.set(userId, { data: profile, timestamp: Date.now() });
          return profile;
        }
      }

      // Truly new user — create profile
      console.log(`No existing user found, creating new profile for ${userId}`);
      const newUserData = await createUserProfile(userId, email);
      const company = await getUserCompany(userId);
      const profile = formatUserProfile(newUserData, company);
      _userProfileCache.set(userId, { data: profile, timestamp: Date.now() });
      return profile;
    }

    // Get company from user_customers
    const company = await getUserCompany(userId);

    const profile = formatUserProfile(data, company);
    _userProfileCache.set(userId, { data: profile, timestamp: Date.now() });
    return profile;
  } catch (error) {
    throw error;
  }
}

/**
 * Format user profile data for API response
 * @param {Object} data - Raw user data from database
 * @param {string|null} company - Company name from user_customers
 * @returns {Object} Formatted user profile
 */
function formatUserProfile(data, company = null) {
  // Parse full_name into first_name and last_name
  let firstName = '';
  let lastName = '';
  if (data.full_name) {
    const nameParts = data.full_name.trim().split(/\s+/);
    firstName = nameParts[0] || '';
    lastName = nameParts.slice(1).join(' ') || '';
  }

  // Format phone number with country code
  let phone = '';
  if (data.phone_number) {
    phone = data.phone_country_code
      ? `${data.phone_country_code}${data.phone_number}`
      : data.phone_number;
  }

  return {
    id: data.id,
    email: data.email,
    firstName,
    lastName,
    fullName: data.full_name || '',
    phone,
    phoneNumber: data.phone_number || '',
    phoneCountryCode: data.phone_country_code || '',
    title: data.title || '',
    company: company || null,
    active: data.active || false,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    avatarUrl: data.avatar_url || null,
    // Tenant volume unit (m³ for CBM, CY for US). Shared mobile app renders this.
    volumeUnit: process.env.VOLUME_UNIT || 'CY'
  };
}

/**
 * Update user profile in public.users table
 * @param {string} userId - User ID (UUID)
 * @param {Object} profileData - Profile data to update
 * @returns {Object} Updated user profile data
 */
async function updateUserProfile(userId, profileData, userEmail = null) {
  try {
    // Use admin client to bypass RLS policies for updates
    const supabase = getSupabaseAdmin();

    // Ensure user profile exists before updating
    let currentProfile;
    try {
      currentProfile = await getUserProfile(userId, userEmail);
    } catch (error) {
      // If profile doesn't exist, create it first
      if (error.message === 'User profile not found' || error.code === 'PGRST116') {
        let email = userEmail;
        if (!email) {
          email = await getUserEmailFromAuth(userId);
        }
        await createUserProfile(userId, email);
        currentProfile = await getUserProfile(userId, email);
      } else {
        throw error;
      }
    }

    // Build update object
    const updateData = {};

    // Handle name - combine first_name and last_name into full_name
    if (profileData.firstName !== undefined || profileData.lastName !== undefined) {
      const firstName = profileData.firstName !== undefined ? profileData.firstName : currentProfile.firstName;
      const lastName = profileData.lastName !== undefined ? profileData.lastName : currentProfile.lastName;
      
      if (firstName || lastName) {
        updateData.full_name = `${firstName || ''} ${lastName || ''}`.trim();
      } else {
        updateData.full_name = null;
      }
    } else if (profileData.fullName !== undefined) {
      updateData.full_name = profileData.fullName || null;
    }

    // Handle phone - split phone into phone_number and phone_country_code
    if (profileData.phone !== undefined) {
      if (profileData.phone) {
        // Try to extract country code (common formats: +1, +44, etc.)
        const phoneMatch = profileData.phone.match(/^(\+\d{1,4})?(.+)$/);
        if (phoneMatch && phoneMatch[1]) {
          updateData.phone_country_code = phoneMatch[1];
          updateData.phone_number = phoneMatch[2].replace(/\D/g, ''); // Remove non-digits
        } else {
          updateData.phone_country_code = null;
          updateData.phone_number = profileData.phone.replace(/\D/g, ''); // Remove non-digits
        }
      } else {
        updateData.phone_number = null;
        updateData.phone_country_code = null;
      }
    } else {
      // Handle separate phone_number and phone_country_code
      if (profileData.phoneNumber !== undefined) {
        updateData.phone_number = profileData.phoneNumber ? profileData.phoneNumber.replace(/\D/g, '') : null;
      }
      if (profileData.phoneCountryCode !== undefined) {
        updateData.phone_country_code = profileData.phoneCountryCode || null;
      }
    }

    // Handle title
    if (profileData.title !== undefined) {
      updateData.title = profileData.title || null;
    }

    // Note: company is read-only, managed via user_customers table

    // Handle avatar URL (if column exists in schema)
    if (profileData.avatarUrl !== undefined) {
      updateData.avatar_url = profileData.avatarUrl || null;
    }

    // Check if there's anything to update
    if (Object.keys(updateData).length === 0) {
      // No fields to update, return current profile
      return currentProfile;
    }

    // Update updated_at will be handled by trigger, but we can set it explicitly if needed
    updateData.updated_at = new Date().toISOString();

    // Perform update using admin client.
    // Use the RESOLVED public.users id (currentProfile.id), not the raw central-auth
    // userId. Users created via central auth carry a different public.users id and are
    // matched by email in getUserProfile(); updating by the central userId matches 0
    // rows → PostgREST "Cannot coerce the result to a single JSON object".
    const targetUserId = currentProfile?.id || userId;
    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', targetUserId)
      .select()
      .single();

    if (error) {
      console.error('Supabase update error:', error);
      throw new Error(error.message || 'Failed to update user profile');
    }

    if (!data) {
      console.error('Update returned no data for user:', userId);
      throw new Error('User profile not found or update failed');
    }

    _invalidateProfileCache(userId);
    return formatUserProfile(data);
  } catch (error) {
    console.error('Error in updateUserProfile:', error);
    throw error;
  }
}

/**
 * Check if user exists in public.users table
 * @param {string} userId - User ID (UUID)
 * @returns {boolean} True if user exists
 */
async function userExists(userId) {
  try {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .single();

    if (error && error.code === 'PGRST116') {
      return false;
    }

    return !!data;
  } catch (error) {
    return false;
  }
}

/**
 * Upload user avatar image to storage and save URL in database
 * @param {string} userId - User ID (UUID)
 * @param {Buffer} fileBuffer - Raw image buffer
 * @param {string} mimeType - MIME type of the image
 * @param {string} originalName - Original filename
 * @returns {Object} Updated user profile
 */
/**
 * Resolve the actual public.users row id for an authenticated user. Users created
 * via central auth carry a different public.users id (matched by email), so callers
 * must not assume req.user.id === public.users.id. Falls back to userId.
 */
async function resolveUserRowId(supabase, userId, userEmail = null) {
  const byId = await supabase.from('users').select('id').eq('id', userId).maybeSingle();
  if (byId.data) return byId.data.id;
  if (userEmail) {
    const byEmail = await supabase.from('users').select('id').eq('email', userEmail).maybeSingle();
    if (byEmail.data) return byEmail.data.id;
  }
  return userId;
}

async function uploadUserAvatar(userId, fileBuffer, mimeType, originalName, userEmail = null) {
  const supabase = getSupabaseAdmin();
  const rowId = await resolveUserRowId(supabase, userId, userEmail);

  // Get current avatar URL to clean up old file
  const { data: currentUser } = await supabase
    .from('users')
    .select('avatar_url')
    .eq('id', rowId)
    .maybeSingle();

  // Delete old avatar from storage if it exists in our bucket
  if (currentUser && currentUser.avatar_url && currentUser.avatar_url.includes(AVATARS_BUCKET)) {
    try {
      // Extract path from the public URL: everything after /avatars/
      const urlParts = currentUser.avatar_url.split(`/${AVATARS_BUCKET}/`);
      if (urlParts[1]) {
        await deleteAvatarFromStorage(urlParts[1]);
      }
    } catch (err) {
      console.warn('Could not delete old avatar:', err.message);
    }
  }

  // Upload new avatar
  const { publicUrl } = await uploadAvatarToStorage(rowId, fileBuffer, mimeType, originalName);

  // Update avatar_url in the users table
  const { data, error } = await supabase
    .from('users')
    .update({ avatar_url: publicUrl, updated_at: new Date().toISOString() })
    .eq('id', rowId)
    .select()
    .single();

  if (error) {
    throw new Error(error.message || 'Failed to update avatar URL');
  }

  _invalidateProfileCache(userId);
  const company = await getUserCompany(rowId);
  return formatUserProfile(data, company);
}

/**
 * Remove user avatar - delete from storage and clear URL in database
 * @param {string} userId - User ID (UUID)
 * @returns {Object} Updated user profile
 */
async function removeUserAvatar(userId, userEmail = null) {
  const supabase = getSupabaseAdmin();
  const rowId = await resolveUserRowId(supabase, userId, userEmail);

  // Get current avatar URL
  const { data: currentUser } = await supabase
    .from('users')
    .select('avatar_url')
    .eq('id', rowId)
    .maybeSingle();

  // Delete from storage if it exists in our bucket
  if (currentUser && currentUser.avatar_url && currentUser.avatar_url.includes(AVATARS_BUCKET)) {
    try {
      const urlParts = currentUser.avatar_url.split(`/${AVATARS_BUCKET}/`);
      if (urlParts[1]) {
        await deleteAvatarFromStorage(urlParts[1]);
      }
    } catch (err) {
      console.warn('Could not delete avatar from storage:', err.message);
    }
  }

  // Clear avatar_url in database
  const { data, error } = await supabase
    .from('users')
    .update({ avatar_url: null, updated_at: new Date().toISOString() })
    .eq('id', rowId)
    .select()
    .single();

  if (error) {
    throw new Error(error.message || 'Failed to remove avatar');
  }

  _invalidateProfileCache(userId);
  const company = await getUserCompany(rowId);
  return formatUserProfile(data, company);
}

module.exports = {
  getUserProfile,
  updateUserProfile,
  uploadUserAvatar,
  removeUserAvatar,
  userExists,
  getUserCompany
};

