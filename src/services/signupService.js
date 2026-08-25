const { executeDirectSQL } = require('../utils/postgresExecutor');
const { executeAuthSQL } = require('../config/authPostgres');
const { requestEmailOtp, requestPhoneOtp, verifyOtp, isVerified } = require('./otpService');
const { hashPassword } = require('../utils/encryptionUtils');

/**
 * Normalize phone number for comparison — strips +, spaces, dashes
 * Auth phone values are stored inconsistently (sometimes with +, sometimes without)
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/[\s\-+]/g, '');
}

/** Check if two phone numbers are the same (format-agnostic) */
function phonesMatch(a, b) {
  return normalizePhone(a) === normalizePhone(b);
}

/**
 * Find an auth.users row by email. Returns null when not found.
 */
async function findAuthUserByEmail(email) {
  const result = await executeDirectSQL(
    'SELECT id, email, phone FROM auth.users WHERE lower(email) = $1 AND deleted_at IS NULL LIMIT 1',
    [email]
  );
  return result.data.length > 0 ? result.data[0] : null;
}

/**
 * Find an auth.users row whose phone matches (format-agnostic). Returns null when not found.
 */
async function findAuthUserByPhone(fullPhone, excludeId = null) {
  const normalized = normalizePhone(fullPhone);
  if (!normalized) return null;
  const result = await executeDirectSQL(
    `SELECT id, email, phone FROM auth.users
     WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1
       AND deleted_at IS NULL
       ${excludeId ? 'AND id <> $2' : ''}
     LIMIT 1`,
    excludeId ? [normalized, excludeId] : [normalized]
  );
  return result.data.length > 0 ? result.data[0] : null;
}

/**
 * Create a user in auth.users (equivalent of the previous Auth
 * admin.createUser with email_confirm + phone_confirm).
 * @returns {Object} { id }
 */
async function createAuthUser({ email, password, phone, userMetadata }) {
  const encryptedPassword = await hashPassword(password);
  const result = await executeDirectSQL(
    `INSERT INTO auth.users
       (instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, phone, phone_confirmed_at,
        raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at)
     VALUES
       ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
        $1, $2, NOW(), $3, NOW(),
        '{"provider":"email","providers":["email"]}'::jsonb, $4::jsonb,
        NOW(), NOW())
     RETURNING id`,
    [email, encryptedPassword, phone, JSON.stringify(userMetadata || {})]
  );
  return result.data[0];
}

/**
 * Update an auth.users row (equivalent of admin.updateUserById).
 * Only the fields supported by the signup flow: password, phone (+confirm), user_metadata.
 */
async function updateAuthUser(userId, { password, phone, userMetadata }) {
  const sets = ['updated_at = NOW()'];
  const params = [];
  let i = 1;

  if (password !== undefined) {
    const encryptedPassword = await hashPassword(password);
    sets.push(`encrypted_password = $${i++}`);
    params.push(encryptedPassword);
  }
  if (phone !== undefined) {
    sets.push(`phone = $${i++}`, 'phone_confirmed_at = NOW()');
    params.push(phone);
  }
  if (userMetadata !== undefined) {
    sets.push(`raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || $${i++}::jsonb`);
    params.push(JSON.stringify(userMetadata));
  }

  params.push(userId);
  await executeDirectSQL(
    `UPDATE auth.users SET ${sets.join(', ')} WHERE id = $${i}`,
    params
  );
}

/**
 * Step 1: Initial signup - collect basic info and send email OTP
 *
 * Creates a pending signup record in signup_pending table and sends
 * an email OTP. The user is NOT created in auth.users until both
 * email and phone are verified.
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.full_name
 * @returns {Object} { success, message, error, code }
 */
async function signup({ email, full_name }) {
  const normalizedEmail = email.toLowerCase().trim();

  console.log('[Signup] Checking email:', normalizedEmail);

  // Check if email already exists as a fully registered user in public.users
  let existingUser = null;
  try {
    const userResult = await executeDirectSQL(
      'SELECT id, active FROM users WHERE email = $1 LIMIT 1',
      [normalizedEmail]
    );
    existingUser = userResult.data;
    console.log('[Signup] public.users query result:', { found: existingUser.length, error: null });
  } catch (userQueryError) {
    console.log('[Signup] public.users query result:', { found: 0, error: userQueryError.message });
    existingUser = [];
  }

  if (existingUser && existingUser.length > 0) {
    if (existingUser[0].active) {
      return { success: false, error: 'A user with this email already exists', code: 'EMAIL_EXISTS' };
    }
    // Inactive user — allow re-signup to update phone/password
    console.log('[Signup] Inactive user found, allowing re-signup for:', normalizedEmail);
  }

  // Check auth.users for existing user with this email (skip if inactive user found — they'll be in auth already)
  if (!existingUser || existingUser.length === 0) {
    try {
      const authMatch = await findAuthUserByEmail(normalizedEmail);
      console.log('[Signup] auth.users check: match:', !!authMatch);
      if (authMatch) {
        return { success: false, error: 'A user with this email already exists', code: 'EMAIL_EXISTS' };
      }
    } catch (authCheckErr) {
      // Non-fatal: Step 5 createAuthUser will catch auth duplicates
      console.log('[Signup] auth.users check skipped:', authCheckErr.message);
    }
  }

  // Check if there's already a pending signup with verified steps
  // This applies to ALL users (new, inactive, or re-signup) so they can resume where they left off
  const pendingResult = await executeDirectSQL(
    'SELECT email_verified, phone_verified FROM signup_pending WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (pendingResult.data.length > 0 && pendingResult.data[0].email_verified) {
    // Update name in case it changed (don't reset verification flags)
    await executeDirectSQL(
      'UPDATE signup_pending SET full_name = $1, updated_at = NOW() WHERE email = $2',
      [full_name, normalizedEmail]
    );

    if (pendingResult.data[0].phone_verified) {
      // Both verified — redirect to set password
      return { success: false, error: 'Email and phone are already verified. Please set your password to complete signup.', code: 'VERIFICATION_COMPLETE' };
    }
    // Email verified but phone not — redirect to phone verification
    return { success: false, error: 'Email is already verified. Please proceed to phone verification.', code: 'EMAIL_ALREADY_VERIFIED' };
  }

  // No verified steps — upsert a fresh pending record
  try {
    await executeDirectSQL(
      `INSERT INTO signup_pending
         (email, full_name, password_hash, phone_number, phone_country_code, title,
          email_verified, phone_verified, updated_at)
       VALUES ($1, $2, '', '', '', '', false, false, NOW())
       ON CONFLICT (email) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         password_hash = EXCLUDED.password_hash,
         phone_number = EXCLUDED.phone_number,
         phone_country_code = EXCLUDED.phone_country_code,
         title = EXCLUDED.title,
         email_verified = EXCLUDED.email_verified,
         phone_verified = EXCLUDED.phone_verified,
         updated_at = NOW()`,
      [normalizedEmail, full_name]
    );
  } catch (pendingError) {
    console.error('[Signup] Error creating pending signup:', pendingError.message);
    return { success: false, error: 'Failed to initiate signup. Please try again.', code: 'PENDING_CREATE_FAILED' };
  }

  // Send email OTP
  const otpResult = await requestEmailOtp(normalizedEmail);
  if (!otpResult.success) {
    return { success: false, error: otpResult.error, code: otpResult.code || 'OTP_SEND_FAILED' };
  }

  return {
    success: true,
    message: 'Signup initiated. Please verify your email with the OTP sent to your inbox.'
  };
}

/**
 * Step 2: Verify email OTP
 *
 * @param {string} email
 * @param {string} otp
 * @returns {Object} { success, message, error, code }
 */
async function verifyEmailOtp(email, otp) {
  const normalizedEmail = email.toLowerCase().trim();

  // Ensure there's a pending signup for this email
  const pendingResult = await executeDirectSQL(
    'SELECT * FROM signup_pending WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (pendingResult.data.length === 0) {
    return { success: false, error: 'No pending signup found for this email. Please sign up first.', code: 'NO_PENDING_SIGNUP' };
  }

  // Reject if email is already verified — prevent re-verification
  if (pendingResult.data[0].email_verified) {
    return { success: false, error: 'Email is already verified. Please proceed to phone verification.', code: 'ALREADY_VERIFIED' };
  }

  const result = await verifyOtp(normalizedEmail, 'email', otp);
  if (!result.success) {
    return result;
  }

  // Mark email as verified in pending record
  await executeDirectSQL(
    'UPDATE signup_pending SET email_verified = true, updated_at = NOW() WHERE email = $1',
    [normalizedEmail]
  );

  return {
    success: true,
    message: 'Email verified successfully. Please proceed to verify your phone number.'
  };
}

/**
 * Step 3: Send phone OTP (only after email is verified)
 *
 * @param {string} email
 * @param {string} phone_country_code
 * @param {string} phone_number
 * @returns {Object} { success, message, error, code }
 */
async function sendPhoneOtpForSignup(email, phone_country_code, phone_number) {
  const normalizedEmail = email.toLowerCase().trim();

  // Check pending signup exists and email is verified
  const pendingResult = await executeDirectSQL(
    'SELECT * FROM signup_pending WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (pendingResult.data.length === 0) {
    return { success: false, error: 'No pending signup found. Please sign up first.', code: 'NO_PENDING_SIGNUP' };
  }

  if (!pendingResult.data[0].email_verified) {
    return { success: false, error: 'Please verify your email first.', code: 'EMAIL_NOT_VERIFIED' };
  }

  // Compose full phone number
  const fullPhone = `${phone_country_code}${phone_number}`.replace(/\s+/g, '');

  // Check if phone number belongs to a different active user
  const phoneOwnersResult = await executeDirectSQL(
    'SELECT email, active FROM users WHERE phone_number = $1 AND phone_country_code = $2',
    [phone_number, phone_country_code]
  );

  if (phoneOwnersResult.data.length > 0) {
    // Allow if the phone belongs to the same user (case-insensitive) or to an inactive user
    const activeConflict = phoneOwnersResult.data.find(
      p => p.email.toLowerCase().trim() !== normalizedEmail && p.active
    );
    if (activeConflict) {
      return { success: false, error: 'Phone number already exists for another user.', code: 'PHONE_EXISTS' };
    }
  }

  // Update phone in pending record
  await executeDirectSQL(
    'UPDATE signup_pending SET phone_number = $1, phone_country_code = $2, updated_at = NOW() WHERE email = $3',
    [phone_number, phone_country_code, normalizedEmail]
  );

  const otpResult = await requestPhoneOtp(fullPhone);
  if (!otpResult.success) {
    return { success: false, error: otpResult.error, code: otpResult.code || 'OTP_SEND_FAILED' };
  }

  return {
    success: true,
    message: 'OTP sent to your phone number.'
  };
}

/**
 * Step 4: Verify phone OTP (does NOT complete registration)
 *
 * Marks phone as verified in pending record. User must still set password in Step 5.
 *
 * @param {string} email
 * @param {string} otp
 * @returns {Object} { success, message, error, code }
 */
async function verifyPhoneOtp(email, otp) {
  const normalizedEmail = email.toLowerCase().trim();

  const pendingResult = await executeDirectSQL(
    'SELECT * FROM signup_pending WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (pendingResult.data.length === 0) {
    return { success: false, error: 'No pending signup found.', code: 'NO_PENDING_SIGNUP' };
  }

  const record = pendingResult.data[0];

  if (!record.email_verified) {
    return { success: false, error: 'Please verify your email first.', code: 'EMAIL_NOT_VERIFIED' };
  }

  if (!record.phone_number || !record.phone_country_code) {
    return { success: false, error: 'Please submit your phone number first.', code: 'PHONE_NOT_SUBMITTED' };
  }

  const fullPhone = `${record.phone_country_code}${record.phone_number}`.replace(/\s+/g, '');
  const result = await verifyOtp(fullPhone, 'phone', otp);
  if (!result.success) {
    return result;
  }

  // Mark phone as verified — do NOT create user yet (password step pending)
  await executeDirectSQL(
    'UPDATE signup_pending SET phone_verified = true, updated_at = NOW() WHERE email = $1',
    [normalizedEmail]
  );

  return {
    success: true,
    message: 'Phone verified successfully. Please set your password to complete signup.'
  };
}

/**
 * Upsert the signup user into public.users and link QR-enabled tenants.
 * Used by the create path of setPasswordAndComplete.
 */
async function syncNewUserToAuthTenant(normalizedEmail, password, record, now) {
  const bcryptHash = await hashPassword(password);

  const upsertResult = await executeAuthSQL(
    `INSERT INTO public.users
       (email, password_hash, full_name, phone_number, phone_country_code, title,
        user_role, active, email_verified_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'user', false, $7, $7, $7)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       full_name = EXCLUDED.full_name,
       phone_number = EXCLUDED.phone_number,
       phone_country_code = EXCLUDED.phone_country_code,
       title = EXCLUDED.title,
       updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [normalizedEmail, bcryptHash, record.full_name, record.phone_number,
     record.phone_country_code, record.title, now]
  );

  if (upsertResult.data.length > 0) {
    const authUserId = upsertResult.data[0].id;

    // Link to all QR-enabled tenants
    const qrTenantsResult = await executeAuthSQL(
      `SELECT id FROM public.tenants
       WHERE qr_enabled = true AND status = 'active' AND deleted_at IS NULL`
    );

    for (const t of qrTenantsResult.data) {
      try {
        await executeAuthSQL(
          `INSERT INTO public.tenant_users (tenant_id, user_id, role, status, created_at, updated_at)
           VALUES ($1, $2, 'member', 'active', $3, $3)`,
          [t.id, authUserId, now]
        );
      } catch (tuError) {
        console.error('[Signup] public.tenant_users insert error:', tuError.message);
      }
    }
  }
}

/**
 * Update the existing signup user in public.users (update path).
 */
async function syncExistingUserToAuthTenant(normalizedEmail, password, record, now) {
  const bcryptHash = await hashPassword(password);

  await executeAuthSQL(
    `UPDATE public.users
     SET password_hash = $1, phone_number = $2, phone_country_code = $3,
         full_name = $4, updated_at = $5
     WHERE email = $6`,
    [bcryptHash, record.phone_number, record.phone_country_code,
     record.full_name, now, normalizedEmail]
  );
}

/**
 * Count public.users rows for a given email (duplicate detection).
 * Returns null when the check could not run.
 */
async function countAuthTenantUsers(normalizedEmail) {
  const result = await executeAuthSQL(
    'SELECT count(*)::int AS count FROM public.users WHERE email = $1',
    [normalizedEmail]
  );
  return result.data[0].count;
}

/**
 * Step 5: Set password and complete registration
 *
 * Creates the real user in auth.users + public.users with the user-chosen password.
 * Only allowed after both email and phone are verified.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Object} { success, message, error, code }
 */
async function setPasswordAndComplete(email, password) {
  const normalizedEmail = email.toLowerCase().trim();

  // Load pending signup
  const pendingResult = await executeDirectSQL(
    'SELECT * FROM signup_pending WHERE email = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (pendingResult.data.length === 0) {
    return { success: false, error: 'No pending signup found.', code: 'NO_PENDING_SIGNUP' };
  }

  const record = pendingResult.data[0];

  // Strict step validation
  if (!record.email_verified) {
    return { success: false, error: 'Please verify your email first.', code: 'EMAIL_NOT_VERIFIED' };
  }

  if (!record.phone_verified) {
    return { success: false, error: 'Please verify your phone number first.', code: 'PHONE_NOT_VERIFIED' };
  }

  // ── Email uniqueness validation across all user tables ──

  // 1. Check public.users (no limit — need full count for duplicate detection)
  let publicUsers;
  try {
    const publicResult = await executeDirectSQL(
      'SELECT id, active, phone_number, phone_country_code FROM users WHERE email = $1',
      [normalizedEmail]
    );
    publicUsers = publicResult.data;
  } catch (publicQueryErr) {
    console.error('[Signup] public.users query failed:', publicQueryErr.message);
    return { success: false, error: 'Unable to verify account. Please try again.', code: 'DB_QUERY_FAILED' };
  }

  if (publicUsers.length > 1) {
    console.error('[Signup] Duplicate email in public.users:', normalizedEmail, 'count:', publicUsers.length);
    return { success: false, error: 'This email is associated with multiple accounts. Please contact support.', code: 'DUPLICATE_EMAIL' };
  }

  // 2. Check public.users
  try {
    const tenantUserCount = await countAuthTenantUsers(normalizedEmail);
    if (tenantUserCount > 1) {
      console.error('[Signup] Duplicate email in public.users:', normalizedEmail, 'count:', tenantUserCount);
      return { success: false, error: 'This email is associated with multiple accounts. Please contact support.', code: 'DUPLICATE_EMAIL' };
    }
  } catch (tenantQueryErr) {
    console.error('[Signup] public.users query failed:', tenantQueryErr.message);
    return { success: false, error: 'Unable to verify account. Please try again.', code: 'DB_QUERY_FAILED' };
  }

  // 3. Check auth.users — also save the match for reuse
  let existingAuthUser = null;
  try {
    const dupResult = await executeDirectSQL(
      'SELECT id, email, phone FROM auth.users WHERE lower(email) = $1 AND deleted_at IS NULL',
      [normalizedEmail]
    );
    if (dupResult.data.length > 1) {
      console.error('[Signup] Duplicate email in auth.users:', normalizedEmail, 'count:', dupResult.data.length);
      return { success: false, error: 'This email is associated with multiple accounts. Please contact support.', code: 'DUPLICATE_EMAIL' };
    }
    if (dupResult.data.length === 1) {
      existingAuthUser = dupResult.data[0];
      console.log('[Signup] Found existing auth user:', existingAuthUser.id, 'for:', normalizedEmail);
    }
  } catch (authCheckErr) {
    // Non-fatal: createAuthUser will catch auth-level duplicates
    console.warn('[Signup] auth.users duplicate check skipped:', authCheckErr.message);
  }

  // 4. Determine user state
  const existingUser = publicUsers.length === 1 ? publicUsers[0] : null;

  if (existingUser && existingUser.active) {
    return { success: false, error: 'Account already created. Please login.', code: 'ALREADY_REGISTERED' };
  }

  const fullPhone = `${record.phone_country_code}${record.phone_number}`.replace(/\s+/g, '');
  const now = new Date().toISOString();

  // --- UPDATE PATH: Inactive user exists — update phone + password ---
  if (existingUser) {
    console.log('[Signup] Inactive user found, updating:', normalizedEmail);

    // Update phone in public.users if different
    const phoneChanged = existingUser.phone_number !== record.phone_number || existingUser.phone_country_code !== record.phone_country_code;
    if (phoneChanged) {
      console.log('[Signup] Updating phone number for:', normalizedEmail);
      try {
        await executeDirectSQL(
          `UPDATE users SET phone_number = $1, phone_country_code = $2, full_name = $3, updated_at = $4
           WHERE id = $5`,
          [record.phone_number, record.phone_country_code, record.full_name, now, existingUser.id]
        );
      } catch (updateError) {
        console.error('[Signup] Error updating user phone:', updateError.message);
        return { success: false, error: 'Failed to update user. Please try again.', code: 'UPDATE_FAILED' };
      }
    }

    // Update password (and phone if changed) in auth.users
    try {
      await updateAuthUser(existingUser.id, {
        password,
        ...(phoneChanged ? { phone: fullPhone } : {}),
        userMetadata: {
          full_name: record.full_name,
          phone_number: record.phone_number,
          phone_country_code: record.phone_country_code
        }
      });
    } catch (authUpdateError) {
      console.error('[Signup] Error updating auth user:', authUpdateError.message);
      return { success: false, error: 'Failed to update password. Please try again.', code: 'AUTH_UPDATE_FAILED' };
    }

    // Update public.users
    try {
      await syncExistingUserToAuthTenant(normalizedEmail, password, record, now);
    } catch (authTenantErr) {
      console.error('[Signup] auth_tenant sync error:', authTenantErr.message);
    }

    // Clean up pending record and OTPs
    await executeDirectSQL('DELETE FROM signup_pending WHERE email = $1', [normalizedEmail]);
    await executeDirectSQL('DELETE FROM signup_otps WHERE identifier = $1', [normalizedEmail]);
    await executeDirectSQL('DELETE FROM signup_otps WHERE identifier = $1', [fullPhone]);

    return {
      success: true,
      message: 'Account updated successfully. Once admin approves your request, you will be notified via email or phone.'
    };
  }

  // --- CREATE OR UPDATE PATH based on auth.users state ---
  let authUser;

  if (existingAuthUser) {
    // Auth user already exists (previous incomplete signup) — update instead of create
    console.log('[Signup] Auth user already exists, updating:', existingAuthUser.id);

    // If phone is owned by a DIFFERENT auth user, clear it first
    try {
      const phoneOwner = await findAuthUserByPhone(fullPhone, existingAuthUser.id);
      if (phoneOwner) {
        const ownerProfileResult = await executeDirectSQL(
          'SELECT id, active FROM users WHERE id = $1 LIMIT 1',
          [phoneOwner.id]
        );

        if (ownerProfileResult.data.length > 0 && ownerProfileResult.data[0].active) {
          return { success: false, error: 'Phone number is already in use by another account.', code: 'PHONE_EXISTS' };
        }
        console.log('[Signup] Clearing phone from orphaned auth user:', phoneOwner.id);
        await executeDirectSQL(
          "UPDATE auth.users SET phone = '+10000000000', updated_at = NOW() WHERE id = $1",
          [phoneOwner.id]
        );
      }
    } catch (phoneCheckErr) {
      console.warn('[Signup] Phone conflict check skipped:', phoneCheckErr.message);
    }

    try {
      await updateAuthUser(existingAuthUser.id, {
        password,
        phone: fullPhone,
        userMetadata: {
          full_name: record.full_name,
          phone_number: record.phone_number,
          phone_country_code: record.phone_country_code
        }
      });
    } catch (authUpdateErr) {
      console.error('[Signup] Failed to update existing auth user:', authUpdateErr.message);
      return { success: false, error: 'Failed to set password. Please try again.', code: 'AUTH_UPDATE_FAILED' };
    }

    authUser = existingAuthUser;
  } else {
    // No auth user exists — create new

    // Check for phone conflicts first (mirrors the previous "Phone number already
    // registered" handling: active owner blocks signup, orphaned owner is cleared)
    try {
      const phoneOwner = await findAuthUserByPhone(fullPhone);
      if (phoneOwner) {
        const ownerProfileResult = await executeDirectSQL(
          'SELECT id, active FROM users WHERE id = $1 LIMIT 1',
          [phoneOwner.id]
        );

        if (ownerProfileResult.data.length > 0 && ownerProfileResult.data[0].active) {
          return { success: false, error: 'Phone number is already in use by another account.', code: 'PHONE_EXISTS' };
        }

        // Orphaned — clear phone
        console.log('[Signup] Clearing phone from orphaned auth user:', phoneOwner.id);
        await executeDirectSQL(
          "UPDATE auth.users SET phone = '+10000000000', updated_at = NOW() WHERE id = $1",
          [phoneOwner.id]
        );
      }
    } catch (phoneFixErr) {
      console.error('[Signup] Phone conflict resolution failed:', phoneFixErr.message);
    }

    try {
      authUser = await createAuthUser({
        email: normalizedEmail,
        password,
        phone: fullPhone,
        userMetadata: {
          full_name: record.full_name,
          phone_number: record.phone_number,
          phone_country_code: record.phone_country_code
        }
      });
    } catch (authError) {
      console.error('[Signup] createUser failed:', authError.message);
      return { success: false, error: authError.message || 'Failed to create user', code: 'AUTH_CREATE_FAILED' };
    }
  }

  // Create or update user profile in public.users
  try {
    await executeDirectSQL(
      `INSERT INTO users
         (id, email, full_name, phone_number, phone_country_code, title, user_type, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'QR', false, $7, $7)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         full_name = EXCLUDED.full_name,
         phone_number = EXCLUDED.phone_number,
         phone_country_code = EXCLUDED.phone_country_code,
         title = EXCLUDED.title,
         user_type = EXCLUDED.user_type,
         active = EXCLUDED.active,
         updated_at = EXCLUDED.updated_at`,
      [authUser.id, normalizedEmail, record.full_name, record.phone_number,
       record.phone_country_code, record.title, now]
    );
  } catch (profileError) {
    console.error('Profile creation error:', profileError.message);
  }

  // Create or update user in auth_tenant database (used by mobile login)
  try {
    await syncNewUserToAuthTenant(normalizedEmail, password, record, now);
  } catch (authTenantErr) {
    // Non-fatal: user is created in main DB, auth_tenant sync can be retried
    console.error('[Signup] auth_tenant sync error:', authTenantErr.message);
  }

  // Clean up pending record and OTPs
  await executeDirectSQL('DELETE FROM signup_pending WHERE email = $1', [normalizedEmail]);
  await executeDirectSQL('DELETE FROM signup_otps WHERE identifier = $1', [normalizedEmail]);
  await executeDirectSQL('DELETE FROM signup_otps WHERE identifier = $1', [fullPhone]);

  return {
    success: true,
    message: 'Signup completed successfully. Once admin approves your request, you will be notified via email or phone.'
  };
}

module.exports = {
  signup,
  verifyEmailOtp,
  sendPhoneOtpForSignup,
  verifyPhoneOtp,
  setPasswordAndComplete
};
