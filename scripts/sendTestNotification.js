/**
 * Script to send test notification to a user by email
 * Usage: node scripts/sendTestNotification.js <email> [title] [body]
 * Example: node scripts/sendTestNotification.js gondaliyarakesh90@gmail.com "Test Title" "Test Body"
 */

require('dotenv').config();
const { getSupabase, getSupabaseAdmin } = require('../src/config/database');
const notificationService = require('../src/services/notificationService');
const deviceService = require('../src/services/deviceService');

async function findUserByEmail(email) {
  const supabaseAdmin = getSupabaseAdmin();

  // Get user from auth.users
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.listUsers();

  if (authError) {
    throw new Error(`Error fetching users: ${authError.message}`);
  }

  const user = authData.users.find(u => u.email === email);
  return user || null;
}

async function sendTestNotification(email, title, body) {
  console.log(`\n🔍 Looking up user: ${email}`);

  // Find user by email
  const user = await findUserByEmail(email);

  if (!user) {
    console.log(`❌ User not found with email: ${email}`);
    return;
  }

  console.log(`✅ Found user: ${user.id}`);

  // Get device tokens for user
  const deviceTokens = await deviceService.getUserDeviceTokens(user.id);

  if (deviceTokens.length === 0) {
    console.log(`⚠️  User has no active devices registered`);
    return;
  }

  console.log(`📱 Found ${deviceTokens.length} active device(s)`);

  // Send notification
  console.log(`📤 Sending notification...`);
  console.log(`   Title: ${title}`);
  console.log(`   Body: ${body}`);

  const result = await notificationService.sendNotificationToUser(user.id, title, body, {
    type: 'test',
    timestamp: new Date().toISOString()
  });

  console.log(`\n📊 Results:`);
  console.log(`   ✅ Success: ${result.successCount}`);
  console.log(`   ❌ Failed: ${result.failureCount}`);

  if (result.responses) {
    result.responses.forEach((resp, i) => {
      if (resp.success) {
        console.log(`   Device ${i + 1}: ✅ Sent`);
      } else {
        console.log(`   Device ${i + 1}: ❌ Failed - ${resp.error?.message || 'Unknown error'}`);
      }
    });
  }

  return result;
}

// Main execution
const args = process.argv.slice(2);
const email = args[0] || 'gondaliyarakesh90@gmail.com';
const title = args[1] || 'Test Notification';
const body = args[2] || 'This is a test notification from Truckast API';

sendTestNotification(email, title, body)
  .then(() => {
    console.log('\n✅ Done!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  });
