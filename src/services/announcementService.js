const { executeDirectSQL } = require('../utils/postgresExecutor');

/**
 * Get plant_ids for a user based on their roles
 * Flow: user_id → user_roles → role_plants → plant_ids
 * @param {string} userId - User UUID
 * @returns {Array<number>} Array of plant_ids the user has access to
 */
async function getUserPlantIds(userId) {
  // Get role_ids for the user from user_roles table
  let userRoles;
  try {
    const result = await executeDirectSQL(
      'SELECT role_id FROM user_roles WHERE user_id = $1',
      [userId]
    );
    userRoles = result.data;
  } catch (userRolesError) {
    throw new Error(`Failed to fetch user roles: ${userRolesError.message}`);
  }

  if (!userRoles || userRoles.length === 0) {
    return [];
  }

  const roleIds = userRoles.map(ur => ur.role_id);

  // Get plant_ids for those roles from role_plants table
  let rolePlants;
  try {
    const result = await executeDirectSQL(
      'SELECT plant_id FROM role_plants WHERE role_id = ANY($1)',
      [roleIds]
    );
    rolePlants = result.data;
  } catch (rolePlantsError) {
    throw new Error(`Failed to fetch role plants: ${rolePlantsError.message}`);
  }

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
  const now = new Date().toISOString();

  // Build query for published announcements
  // that have at least one plant_id matching user's plant_ids
  const whereClauses = ['published = true', 'plant_ids && $1'];
  const params = [userPlantIds];

  // Filter by active status (current date within start_date and end_date)
  if (filters.active === true) {
    // Active: start_date <= now AND end_date >= now (or null)
    params.push(now);
    whereClauses.push(`(start_date IS NULL OR start_date <= $${params.length})`);
    whereClauses.push(`(end_date IS NULL OR end_date >= $${params.length})`);
  } else if (filters.active === false) {
    // Inactive: start_date > now OR end_date < now
    params.push(now);
    whereClauses.push(`(start_date > $${params.length} OR end_date < $${params.length})`);
  }
  // If filters.active is undefined, return all (no date filter)

  const whereSql = whereClauses.join(' AND ');

  let data;
  let count;
  try {
    const countResult = await executeDirectSQL(
      `SELECT count(*)::int AS count FROM announcements WHERE ${whereSql}`,
      params
    );
    count = countResult.data[0]?.count ?? 0;

    const dataResult = await executeDirectSQL(
      `SELECT * FROM announcements WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, from]
    );
    data = dataResult.data;
  } catch (error) {
    throw new Error(`Failed to fetch announcements: ${error.message}`);
  }

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
  const from = (page - 1) * limit;

  const whereClauses = [];
  const params = [];

  // Filter by published status
  if (filters.published !== undefined) {
    params.push(filters.published);
    whereClauses.push(`published = $${params.length}`);
  }

  // Filter by plant_id (check if plant_id is in plant_ids array)
  if (filters.plant_id) {
    params.push([parseInt(filters.plant_id, 10)]);
    whereClauses.push(`plant_ids @> $${params.length}`);
  }

  // Filter by active announcements (current date between start_date and end_date)
  if (filters.active) {
    const now = new Date().toISOString();
    params.push(now);
    whereClauses.push(`(start_date IS NULL OR start_date <= $${params.length})`);
    whereClauses.push(`(end_date IS NULL OR end_date >= $${params.length})`);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Apply pagination and ordering
  let data;
  let count;
  try {
    const countResult = await executeDirectSQL(
      `SELECT count(*)::int AS count FROM announcements ${whereSql}`,
      params
    );
    count = countResult.data[0]?.count ?? 0;

    const dataResult = await executeDirectSQL(
      `SELECT * FROM announcements ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, from]
    );
    data = dataResult.data;
  } catch (error) {
    throw new Error(`Failed to fetch announcements: ${error.message}`);
  }

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
  let data;
  try {
    const result = await executeDirectSQL(
      'SELECT * FROM announcements WHERE id = $1 LIMIT 1',
      [id]
    );
    data = result.data[0] || null;
  } catch (error) {
    throw new Error(`Failed to fetch announcement: ${error.message}`);
  }

  // 0 rows → null (mirrors .single() PGRST116 handling)
  return data;
}

/**
 * Create a new announcement
 * @param {Object} announcementData - Announcement data
 * @returns {Object} Created announcement
 */
async function createAnnouncement(announcementData) {
  try {
    // Dynamic column list (mirrors .insert of an arbitrary object);
    // identifiers are double-quoted with embedded quotes escaped to stay safe.
    const columns = Object.keys(announcementData);
    const columnSql = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const values = columns.map(c => announcementData[c]);

    const result = await executeDirectSQL(
      `INSERT INTO announcements (${columnSql}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    return result.data[0];
  } catch (error) {
    throw new Error(`Failed to create announcement: ${error.message}`);
  }
}

/**
 * Update an existing announcement
 * @param {number} id - Announcement ID
 * @param {Object} announcementData - Updated announcement data
 * @returns {Object} Updated announcement
 */
async function updateAnnouncement(id, announcementData) {
  let data;
  try {
    // Dynamic SET list (mirrors .update of an arbitrary object);
    // identifiers are double-quoted with embedded quotes escaped to stay safe.
    const columns = Object.keys(announcementData);
    const setClauses = columns.map((c, i) => `"${c.replace(/"/g, '""')}" = $${i + 1}`);
    const values = columns.map(c => announcementData[c]);
    values.push(id);

    const result = await executeDirectSQL(
      `UPDATE announcements SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    data = result.data[0] || null;
  } catch (error) {
    throw new Error(`Failed to update announcement: ${error.message}`);
  }

  // 0 rows updated → null (mirrors .single() PGRST116 handling)
  return data;
}

/**
 * Delete an announcement
 * @param {number} id - Announcement ID
 * @returns {boolean} True if deleted successfully
 */
async function deleteAnnouncement(id) {
  try {
    await executeDirectSQL(
      'DELETE FROM announcements WHERE id = $1',
      [id]
    );
  } catch (error) {
    throw new Error(`Failed to delete announcement: ${error.message}`);
  }

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
