require('dotenv').config();
const { executeDirectSQL } = require('../src/utils/postgresExecutor');
const { getAuthSupabaseAdmin } = require('../src/config/authDatabase');

const JWT_ID = process.argv[2] || 'a4e036da-b592-441e-814f-d18b9275c3b3';
const EMAIL  = process.argv[3] || 'jaydeep@truckcast.com';

(async () => {
  console.log('JWT user id:', JWT_ID);
  console.log('email:      ', EMAIL, '\n');

  // 1. Look up in auth_tenant.users (federated auth DB)
  const sb = getAuthSupabaseAdmin();
  const { data: authUsers } = await sb.schema('auth_tenant').from('users')
    .select('id, uuid, email, full_name').eq('email', EMAIL).limit(5);
  console.log('auth_tenant.users by email:', authUsers);

  // 2. Look up in MAIN DB by UUID (this is what user_roles/user_customers key on)
  const mainByUuid = await executeDirectSQL(`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_name = 'users' AND table_schema IN ('public','auth')
  `, []);
  console.log('\nMain-DB "users" tables found:', mainByUuid.data);

  // 3. Try auth.users (Supabase auth) by email
  try {
    const authAuth = await executeDirectSQL(`SELECT id, email FROM auth.users WHERE email = $1 LIMIT 5`, [EMAIL]);
    console.log('\nmain auth.users by email:', authAuth.data);
  } catch (e) { console.log('auth.users query failed:', e.message); }

  // 4. Check user_roles for JWT id
  const rolesByJwt = await executeDirectSQL(`
    SELECT ur.user_id, r.code, r.name
    FROM user_roles ur LEFT JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = $1
  `, [JWT_ID]);
  console.log('\nuser_roles for JWT id:', rolesByJwt.data);

  // 5. Try to find by email across likely tables
  try {
    const possibleEmailCol = await executeDirectSQL(`
      SELECT id, email FROM public.users WHERE email = $1 LIMIT 5
    `, [EMAIL]);
    console.log('\npublic.users by email:', possibleEmailCol.data);
  } catch (e) { console.log('public.users by email failed:', e.message); }

  // 6. user_customers for JWT id
  const uc = await executeDirectSQL(`SELECT user_id, customer_id FROM user_customers WHERE user_id = $1`, [JWT_ID]);
  console.log('\nuser_customers for JWT id:', uc.data);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
