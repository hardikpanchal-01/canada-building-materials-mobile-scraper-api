const { getSupabaseAdmin } = require('../config/database');
const { getAuthSupabaseAdmin } = require('../config/authDatabase');
const { requestEmailOtp, requestPhoneOtp, verifyOtp, isVerified } = require('./otpService');
const { hashPassword } = require('../utils/encryptionUtils');

/**
 * Normalize phone number for comparison — strips +, spaces, dashes
 * Supabase Auth stores phones inconsistently (sometimes with +, sometimes without)
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
 * Step 1: Initial signup - collect basic info and send email OTP
 *
 * Creates a pending signup record in signup_pending table and sends
 * an email OTP. The user is NOT created in Supabase Auth until both
 * email and phone are verified.
 *
 * Password is NOT required at signup. A random password is generated
 * when the account is finalized in Step 4. Users can set their own
 * password via "forgot password" after admin approval.
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.full_name
 * @returns {Object} { success, message, error, code }
 */
async function signup({ email, full_name }) {
  const supabase = getSupabaseAdmin();
  const normalizedEmail = email.toLowerCase().trim();

  console.log('[Signup] Checking email:', normalizedEmail);

  // Check if email already exists as a fully registered user in public.users
  const { data: existingUser, error: userQueryError } = await supabase
    .from('users')
    .select('id, active')
    .eq('email', normalizedEmail)
    .limit(1);

  console.log('[Signup] public.users query result:', { found: existingUser?.length || 0, error: userQueryError?.message || null });

  if (existingUser && existingUser.length > 0) {
    if (existingUser[0].active) {
      return { success: false, error: 'A user with this email already exists', code: 'EMAIL_EXISTS' };
    }
    // Inactive user — allow re-signup to update phone/password
    console.log('[Signup] Inactive user found, allowing re-signup for:', normalizedEmail);
  }

  // Check Supabase Auth for existing user with this email (skip if inactive user found — they'll be in auth already)
  if (!existingUser || existingUser.length === 0) {
    try {
      const { data: authList, error: authListError } = await supabase.auth.admin.listUsers({
        page: 1,
        perPage: 1000
      });

      if (!authListError && authList?.users) {
        const authMatch = authList.users.find(
          u => u.email?.toLowerCase() === normalizedEmail
        );
        console.log('[Signup] auth.users check: scanned', authList.users.length, 'users, match:', !!authMatch);
        if (authMatch) {
          return { success: false, error: 'A user with this email already exists', code: 'EMAIL_EXISTS' };
        }
      }
    } catch (authCheckErr) {
      // Non-fatal: Step 5 createUser will catch auth duplicates
      console.log('[Signup] auth.users check skipped:', authCheckErr.message);
    }
  }

  // Check if there's already a pending signup with verified steps
  // This applies to ALL users (new, inactive, or re-signup) so they can resume where they left off
  const { data: existingPending } = await supabase
    .from('signup_pending')
    .select('email_verified, phone_verified')
    .eq('email', normalizedEmail)
    .limit(1);

  if (existingPending && existingPending.length > 0 && existingPending[0].email_verified) {
    // Update name in case it changed (don't reset verification flags)
    await supabase
      .from('signup_pending')
      .update({ full_name, updated_at: new Date().toISOString() })
      .eq('email', normalizedEmail);

    if (existingPending[0].phone_verified) {
      // Both verified — redirect to set password
      return { success: false, error: 'Email and phone are already verified. Please set your password to complete signup.', code: 'VERIFICATION_COMPLETE' };
    }
    // Email verified but phone not — redirect to phone verification
    return { success: false, error: 'Email is already verified. Please proceed to phone verification.', code: 'EMAIL_ALREADY_VERIFIED' };
  }

  // No verified steps — upsert a fresh pending record
  const { error: pendingError } = await supabase
    .from('signup_pending')
    .upsert({
      email: normalizedEmail,
      full_name,
      password_hash: '',
      phone_number: '',
      phone_country_code: '',
      title: '',
      email_verified: false,
      phone_verified: false,
      updated_at: new Date().toISOString()
    }, { onConflict: 'email' });

  if (pendingError) {
    console.error('[Signup] Error creating pending signup:', pendingError.message, pendingError.details, pendingError.hint);
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
  const supabase = getSupabaseAdmin();

  // Ensure there's a pending signup for this email
  const { data: pending } = await supabase
    .from('signup_pending')
    .select('*')
    .eq('email', normalizedEmail)
    .limit(1);

  if (!pending || pending.length === 0) {
    return { success: false, error: 'No pending signup found for this email. Please sign up first.', code: 'NO_PENDING_SIGNUP' };
  }

  // Reject if email is already verified — prevent re-verification
  if (pending[0].email_verified) {
    return { success: false, error: 'Email is already verified. Please proceed to phone verification.', code: 'ALREADY_VERIFIED' };
  }

  const result = await verifyOtp(normalizedEmail, 'email', otp);
  if (!result.success) {
    return result;
  }

  // Mark email as verified in pending record
  await supabase
    .from('signup_pending')
    .update({ email_verified: true, updated_at: new Date().toISOString() })
    .eq('email', normalizedEmail);

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
  const supabase = getSupabaseAdmin();

  // Check pending signup exists and email is verified
  const { data: pending } = await supabase
    .from('signup_pending')
    .select('*')
    .eq('email', normalizedEmail)
    .limit(1);

  if (!pending || pending.length === 0) {
    return { success: false, error: 'No pending signup found. Please sign up first.', code: 'NO_PENDING_SIGNUP' };
  }

  if (!pending[0].email_verified) {
    return { success: false, error: 'Please verify your email first.', code: 'EMAIL_NOT_VERIFIED' };
  }

  // Compose full phone number
  const fullPhone = `${phone_country_code}${phone_number}`.replace(/\s+/g, '');

  // Check if phone number belongs to a different active user
  const { data: phoneOwners } = await supabase
    .from('users')
    .select('email, active')
    .eq('phone_number', phone_number)
    .eq('phone_country_code', phone_country_code);

  if (phoneOwners && phoneOwners.length > 0) {
    // Allow if the phone belongs to the same user (case-insensitive) or to an inactive user
    const activeConflict = phoneOwners.find(
      p => p.email.toLowerCase().trim() !== normalizedEmail && p.active
    );
    if (activeConflict) {
      return { success: false, error: 'Phone number already exists for another user.', code: 'PHONE_EXISTS' };
    }
  }

  // Update phone in pending record
  await supabase
    .from('signup_pending')
    .update({
      phone_number,
      phone_country_code,
      updated_at: new Date().toISOString()
    })
    .eq('email', normalizedEmail);

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
  const supabase = getSupabaseAdmin();

  const { data: pending } = await supabase
    .from('signup_pending')
    .select('*')
    .eq('email', normalizedEmail)
    .limit(1);

  if (!pending || pending.length === 0) {
    return { success: false, error: 'No pending signup found.', code: 'NO_PENDING_SIGNUP' };
  }

  const record = pending[0];

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
  await supabase
    .from('signup_pending')
    .update({ phone_verified: true, updated_at: new Date().toISOString() })
    .eq('email', normalizedEmail);

  return {
    success: true,
    message: 'Phone verified successfully. Please set your password to complete signup.'
  };
}

/**
 * Step 5: Set password and complete registration
 *
 * Creates the real user in Supabase Auth + public.users with the user-chosen password.
 * Only allowed after both email and phone are verified.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Object} { success, message, error, code }
 */
async function setPasswordAndComplete(email, password) {
  const normalizedEmail = email.toLowerCase().trim();
  const supabase = getSupabaseAdmin();

  // Load pending signup
  const { data: pending } = await supabase
    .from('signup_pending')
    .select('*')
    .eq('email', normalizedEmail)
    .limit(1);

  if (!pending || pending.length === 0) {
    return { success: false, error: 'No pending signup found.', code: 'NO_PENDING_SIGNUP' };
  }

  const record = pending[0];

  // Strict step validation
  if (!record.email_verified) {
    return { success: false, error: 'Please verify your email first.', code: 'EMAIL_NOT_VERIFIED' };
  }

  if (!record.phone_verified) {
    return { success: false, error: 'Please verify your phone number first.', code: 'PHONE_NOT_VERIFIED' };
  }

  // ── Email uniqueness validation across all user tables ──

  // 1. Check public.users (no limit — need full count for duplicate detection)
  const { data: publicUsers, error: publicQueryErr } = await supabase
    .from('users')
    .select('id, active, phone_number, phone_country_code')
    .eq('email', normalizedEmail);

  if (publicQueryErr) {
    console.error('[Signup] public.users query failed:', publicQueryErr.message);
    return { success: false, error: 'Unable to verify account. Please try again.', code: 'DB_QUERY_FAILED' };
  }

  if (publicUsers && publicUsers.length > 1) {
    console.error('[Signup] Duplicate email in public.users:', normalizedEmail, 'count:', publicUsers.length);
    return { success: false, error: 'This email is associated with multiple accounts. Please contact support.', code: 'DUPLICATE_EMAIL' };
  }

  // 2. Check auth_tenant.users
  const authSupabase = getAuthSupabaseAdmin();
  const { data: tenantUsers, error: tenantQueryErr } = await authSupabase
    .schema('auth_tenant')
    .from('users')
    .select('id')
    .eq('email', normalizedEmail);

  if (tenantQueryErr) {
    console.error('[Signup] auth_tenant.users query failed:', tenantQueryErr.message);
    return { success: false, error: 'Unable to verify account. Please try again.', code: 'DB_QUERY_FAILED' };
  }

  if (tenantUsers && tenantUsers.length > 1) {
    console.error('[Signup] Duplicate email in auth_tenant.users:', normalizedEmail, 'count:', tenantUsers.length);
    return { success: false, error: 'This email is associated with multiple accounts. Please contact support.', code: 'DUPLICATE_EMAIL' };
  }

  // 3. Check Supabase Auth (auth.users) — also save the match for reuse
  let existingAuthUser = null;
  try {
    const { data: authList } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (authList?.users) {
      const authMatches = authList.users.filter(u => u.email?.toLowerCase() === normalizedEmail);
      if (authMatches.length > 1) {
        console.error('[Signup] Duplicate email in Supabase Auth:', normalizedEmail, 'count:', authMatches.length);
        return { success: false, error: 'This email is associated with multiple accounts. Please contact support.', code: 'DUPLICATE_EMAIL' };
      }
      if (authMatches.length === 1) {
        existingAuthUser = authMatches[0];
        console.log('[Signup] Found existing auth user:', existingAuthUser.id, 'for:', normalizedEmail);
      }
    }
  } catch (authCheckErr) {
    // Non-fatal: createUser / updateUserById will catch auth-level duplicates
    console.warn('[Signup] Supabase Auth duplicate check skipped:', authCheckErr.message);
  }

  // 4. Determine user state
  const existingUser = publicUsers && publicUsers.length === 1 ? publicUsers[0] : null;

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
      const { error: updateError } = await supabase
        .from('users')
        .update({
          phone_number: record.phone_number,
          phone_country_code: record.phone_country_code,
          full_name: record.full_name,
          updated_at: now
        })
        .eq('id', existingUser.id);

      if (updateError) {
        console.error('[Signup] Error updating user phone:', updateError.message);
        return { success: false, error: 'Failed to update user. Please try again.', code: 'UPDATE_FAILED' };
      }
    }

    // Update password (and phone if changed) in Supabase Auth
    const authUpdateData = {
      password,
      user_metadata: {
        full_name: record.full_name,
        phone_number: record.phone_number,
        phone_country_code: record.phone_country_code
      }
    };
    if (phoneChanged) {
      authUpdateData.phone = fullPhone;
      authUpdateData.phone_confirm = true;
    }

    const { error: authUpdateError } = await supabase.auth.admin.updateUserById(existingUser.id, authUpdateData);
    if (authUpdateError) {
      console.error('[Signup] Error updating Supabase Auth user:', authUpdateError.message);
      return { success: false, error: 'Failed to update password. Please try again.', code: 'AUTH_UPDATE_FAILED' };
    }

    // Update auth_tenant.users
    try {
      const bcryptHash = await hashPassword(password);
      const { error: atUpdateError } = await authSupabase
        .schema('auth_tenant')
        .from('users')
        .update({
          password_hash: bcryptHash,
          phone_number: record.phone_number,
          phone_country_code: record.phone_country_code,
          full_name: record.full_name,
          updated_at: now
        })
        .eq('email', normalizedEmail);

      if (atUpdateError) {
        console.error('[Signup] auth_tenant.users update error:', atUpdateError.message);
      }
    } catch (authTenantErr) {
      console.error('[Signup] auth_tenant sync error:', authTenantErr.message);
    }

    // Clean up pending record and OTPs
    await supabase.from('signup_pending').delete().eq('email', normalizedEmail);
    await supabase.from('signup_otps').delete().eq('identifier', normalizedEmail);
    await supabase.from('signup_otps').delete().eq('identifier', fullPhone);

    return {
      success: true,
      message: 'Account updated successfully. Once admin approves your request, you will be notified via email or phone.'
    };
  }

  // --- CREATE OR UPDATE PATH based on Supabase Auth state ---
  let supabaseUser;

  if (existingAuthUser) {
    // Auth user already exists (previous incomplete signup) — update instead of create
    console.log('[Signup] Auth user already exists, updating:', existingAuthUser.id);

    // If phone is owned by a DIFFERENT auth user, clear it first
    try {
      const { data: authList } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const phoneOwner = authList?.users?.find(u => phonesMatch(u.phone, fullPhone) && u.id !== existingAuthUser.id);
      if (phoneOwner) {
        const { data: ownerProfile } = await supabase
          .from('users')
          .select('id, active')
          .eq('id', phoneOwner.id)
          .limit(1);

        if (ownerProfile && ownerProfile.length > 0 && ownerProfile[0].active) {
          return { success: false, error: 'Phone number is already in use by another account.', code: 'PHONE_EXISTS' };
        }
        console.log('[Signup] Clearing phone from orphaned auth user:', phoneOwner.id);
        await supabase.auth.admin.updateUserById(phoneOwner.id, { phone: '+10000000000' });
      }
    } catch (phoneCheckErr) {
      console.warn('[Signup] Phone conflict check skipped:', phoneCheckErr.message);
    }

    const { error: authUpdateErr } = await supabase.auth.admin.updateUserById(existingAuthUser.id, {
      password,
      phone: fullPhone,
      phone_confirm: true,
      user_metadata: {
        full_name: record.full_name,
        phone_number: record.phone_number,
        phone_country_code: record.phone_country_code
      }
    });

    if (authUpdateErr) {
      console.error('[Signup] Failed to update existing auth user:', authUpdateErr.message);
      return { success: false, error: 'Failed to set password. Please try again.', code: 'AUTH_UPDATE_FAILED' };
    }

    supabaseUser = existingAuthUser;
  } else {
    // No auth user exists — create new
    let { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
      phone: fullPhone,
      phone_confirm: true,
      user_metadata: {
        full_name: record.full_name,
        phone_number: record.phone_number,
        phone_country_code: record.phone_country_code
      }
    });

    // If phone conflict — clear orphaned phone and retry
    if (authError && authError.message?.includes('Phone number already registered')) {
      console.log('[Signup] Phone conflict on createUser, checking owner for:', fullPhone);
      try {
        const { data: authList } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const allUsers = authList?.users || [];
        const phoneOwner = allUsers.find(u => phonesMatch(u.phone, fullPhone));

        if (phoneOwner) {
          const { data: ownerProfile } = await supabase
            .from('users')
            .select('id, active')
            .eq('id', phoneOwner.id)
            .limit(1);

          if (ownerProfile && ownerProfile.length > 0 && ownerProfile[0].active) {
            return { success: false, error: 'Phone number is already in use by another account.', code: 'PHONE_EXISTS' };
          }

          // Orphaned — clear phone and retry
          console.log('[Signup] Clearing phone from orphaned auth user:', phoneOwner.id);
          await supabase.auth.admin.updateUserById(phoneOwner.id, { phone: '+10000000000' });

          const retry = await supabase.auth.admin.createUser({
            email: normalizedEmail,
            password,
            email_confirm: true,
            phone: fullPhone,
            phone_confirm: true,
            user_metadata: {
              full_name: record.full_name,
              phone_number: record.phone_number,
              phone_country_code: record.phone_country_code
            }
          });
          authData = retry.data;
          authError = retry.error;
        }
      } catch (phoneFixErr) {
        console.error('[Signup] Phone conflict resolution failed:', phoneFixErr.message);
      }
    }

    if (authError) {
      console.error('[Signup] createUser failed:', authError.message);
      return { success: false, error: authError.message || 'Failed to create user', code: 'AUTH_CREATE_FAILED' };
    }

    supabaseUser = authData.user;
  }

  // Create or update user profile in public.users
  const { error: profileError } = await supabase
    .from('users')
    .upsert({
      id: supabaseUser.id,
      email: normalizedEmail,
      full_name: record.full_name,
      phone_number: record.phone_number,
      phone_country_code: record.phone_country_code,
      title: record.title,
      user_type: 'QR',
      active: false,
      created_at: now,
      updated_at: now
    }, { onConflict: 'id' });

  if (profileError) {
    console.error('Profile creation error:', profileError.message);
  }

  // Create or update user in auth_tenant database (used by mobile login)
  try {
    const bcryptHash = await hashPassword(password);

    // Upsert into auth_tenant.users
    const { data: authUser, error: authUserError } = await authSupabase
      .schema('auth_tenant')
      .from('users')
      .upsert({
        email: normalizedEmail,
        password_hash: bcryptHash,
        full_name: record.full_name,
        phone_number: record.phone_number,
        phone_country_code: record.phone_country_code,
        title: record.title,
        user_role: 'user',
        active: false,
        email_verified_at: now,
        created_at: now,
        updated_at: now
      }, { onConflict: 'email' })
      .select('id')
      .single();

    if (authUserError) {
      console.error('[Signup] auth_tenant.users insert error:', authUserError.message);
    } else if (authUser) {
      // Link to all QR-enabled tenants
      const { data: qrTenants } = await authSupabase
        .schema('auth_tenant')
        .from('tenants')
        .select('id')
        .eq('qr_enabled', true)
        .eq('status', 'active')
        .is('deleted_at', null);

      if (qrTenants && qrTenants.length > 0) {
        const tenantUserRows = qrTenants.map(t => ({
          tenant_id: t.id,
          user_id: authUser.id,
          role: 'member',
          status: 'active',
          created_at: now,
          updated_at: now
        }));

        const { error: tuError } = await authSupabase
          .schema('auth_tenant')
          .from('tenant_users')
          .insert(tenantUserRows);

        if (tuError) {
          console.error('[Signup] auth_tenant.tenant_users insert error:', tuError.message);
        }
      }
    }
  } catch (authTenantErr) {
    // Non-fatal: user is created in main DB, auth_tenant sync can be retried
    console.error('[Signup] auth_tenant sync error:', authTenantErr.message);
  }

  // Clean up pending record and OTPs
  await supabase.from('signup_pending').delete().eq('email', normalizedEmail);
  await supabase.from('signup_otps').delete().eq('identifier', normalizedEmail);
  await supabase.from('signup_otps').delete().eq('identifier', fullPhone);

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
