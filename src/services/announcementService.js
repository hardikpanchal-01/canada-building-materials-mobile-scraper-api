const { getSupabaseAdmin } = require('../config/database');

/**
 * Get plant_ids for a user based on their roles
 * Flow: user_id → user_roles → role_plants → plant_ids
 * @param {string} userId - User UUID
 * @returns {Array<number>} Array of plant_ids the user has access to
 */
async function getUserPlantIds(userId) {
  const supabase = getSupabaseAdmin();

  // Get role_ids for the user from user_roles table
  const { data: userRoles, error: userRolesError } = await supabase
    .from('user_roles')
    .select('role_id')
    .eq('user_id', userId);

  if (userRolesError) throw new Error(`Failed to fetch user roles: ${userRolesError.message}`);

  if (!userRoles || userRoles.length === 0) {
    return [];
  }

  const roleIds = userRoles.map(ur => ur.role_id);

  // Get plant_ids for those roles from role_plants table
  const { data: rolePlants, error: rolePlantsError } = await supabase
    .from('role_plants')
    .select('plant_id')
    .in('role_id', roleIds);

  if (rolePlantsError) throw new Error(`Failed to fetch role plants: ${rolePlantsError.message}`);

  if (!rolePlants || rolePlants.length === 0) {
    return [];
  }

  // Return unique plant_ids
  const plantIds = [...new Set(rolePlants.map(rp => rp.plant_id))];
  return plantIds;
}

/**
 * Get announcements for a specific user based on their plant access
 * Filters by: published=true, plant_ids overlap, and optionally active dates
 * @param {string} userId - User UUID
 * @param {Object} filters - Filter options
 * @param {boolean} filters.active - If true, only active announcements (current date within start/end date)
 * @param {number} page - Page number (1-based)
 * @param {number} limit - Results per page (default 50)
 * @returns {Object} { announcements, total, page, limit, totalPages, userPlantIds }
 */
async function getAnnouncementsForUser(userId, filters = {}, page = 1, limit = 50) {
  const supabase = getSupabaseAdmin();

  // Get user's plant_ids
  const userPlantIds = await getUserPlantIds(userId);

  if (userPlantIds.length === 0) {
    return {
      announcements: [],
      total: 0,
      page,
      limit,
      totalPages: 0,
      userPlantIds: []
    };
  }

  const from = (page - 1) * limit;
  const to = from + limit - 1;
  const now = new Date().toISOString();

  // Build query for published announcements
  // that have at least one plant_id matching user's plant_ids
  let query = supabase
    .from('announcements')
    .select('*', { count: 'exact' })
    .eq('published', true)
    .overlaps('plant_ids', userPlantIds);

  // Filter by active status (current date within start_date and end_date)
  if (filters.active === true) {
    // Active: start_date <= now AND end_date >= now (or null)
    query = query
      .or(`start_date.is.null,start_date.lte.${now}`)
      .or(`end_date.is.null,end_date.gte.${now}`);
  } else if (filters.active === false) {
    // Inactive: start_date > now OR end_date < now
    query = query
      .or(`start_date.gt.${now},end_date.lt.${now}`);
  }
  // If filters.active is undefined, return all (no date filter)

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new Error(`Failed to fetch announcements: ${error.message}`);

  return {
    announcements: data || [],
    total: count || 0,
    page,
    limit,
    totalPages: Math.ceil((count || 0) / limit),
    userPlantIds
  };
}

/**
 * Get all announcements with optional filters and pagination
 * @param {Object} filters - Filter options
 * @param {boolean} filters.published - Filter by published status
 * @param {number} filters.plant_id - Filter by plant_id (checks if plant_id is in plant_ids array)
 * @param {boolean} filters.active - Filter by active announcements (current date between start_date and end_date)
 * @param {number} page - Page number (1-based)
 * @param {number} limit - Results per page (default 50)
 * @returns {Object} { announcements, total, page, limit, totalPages }
 */
async function getAnnouncements(filters = {}, page = 1, limit = 50) {
  const supabase = getSupabaseAdmin();

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('announcements')
    .select('*', { count: 'exact' });

  // Filter by published status
  if (filters.published !== undefined) {
    query = query.eq('published', filters.published);
  }

  // Filter by plant_id (check if plant_id is in plant_ids array)
  if (filters.plant_id) {
    query = query.contains('plant_ids', [parseInt(filters.plant_id, 10)]);
  }

  // Filter by active announcements (current date between start_date and end_date)
  if (filters.active) {
    const now = new Date().toISOString();
    query = query
      .or(`start_date.is.null,start_date.lte.${now}`)
      .or(`end_date.is.null,end_date.gte.${now}`);
  }

  // Apply pagination and ordering
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new Error(`Failed to fetch announcements: ${error.message}`);

  return {
    announcements: data || [],
    total: count || 0,
    page,
    limit,
    totalPages: Math.ceil((count || 0) / limit)
  };
}

/**
 * Get a single announcement by ID
 * @param {number} id - Announcement ID
 * @returns {Object} Announcement object
 */
async function getAnnouncementById(id) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to fetch announcement: ${error.message}`);
  }

  return data;
}

/**
 * Create a new announcement
 * @param {Object} announcementData - Announcement data
 * @returns {Object} Created announcement
 */
async function createAnnouncement(announcementData) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('announcements')
    .insert([announcementData])
    .select()
    .single();

  if (error) throw new Error(`Failed to create announcement: ${error.message}`);

  return data;
}

/**
 * Update an existing announcement
 * @param {number} id - Announcement ID
 * @param {Object} announcementData - Updated announcement data
 * @returns {Object} Updated announcement
 */
async function updateAnnouncement(id, announcementData) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('announcements')
    .update(announcementData)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to update announcement: ${error.message}`);
  }

  return data;
}

/**
 * Delete an announcement
 * @param {number} id - Announcement ID
 * @returns {boolean} True if deleted successfully
 */
async function deleteAnnouncement(id) {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from('announcements')
    .delete()
    .eq('id', id);

  if (error) throw new Error(`Failed to delete announcement: ${error.message}`);

  return true;
}

module.exports = {
  getAnnouncements,
  getAnnouncementById,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  getUserPlantIds,
  getAnnouncementsForUser
};
