/**
 * Quick test script to debug order notifications.
 *
 * Usage:
 *   node scripts/test-order-notification.js                    # auto-picks latest device
 *   node scripts/test-order-notification.js TOKEN_HERE         # send to specific token
 */

require('dotenv').config();

const { getSupabaseAdmin: getSupabase } = require('../src/config/database');
const { getMessaging } = require('../src/config/Firebase');

const TOKEN_ARG = process.argv[2]; // optional: pass token as CLI arg

async function sendTest(token) {
  console.log(`\nSending test notification to token: ${token.substring(0, 40)}...\n`);

  try {
    const messaging = getMessaging();
    const result = await messaging.send({
      token,
      notification: {
        title: 'Test Order Notification',
        body: 'If you see this, notifications are working!',
      },
      data: {
        event_code: 'ORDER_CREATED',
        order_id: '99999',
        order_code: '99999',
        order_date: '2026-04-13',
      },
    });

    console.log('SUCCESS! Message ID:', result);
    console.log('-> Check your device/emulator for the notification.');
    console.log('-> Tapping it should navigate to OrderDetail screen.');
  } catch (err) {
    console.error('FAILED:', err.code || err.message);
    if (err.code === 'messaging/registration-token-not-registered') {
      console.log('-> Token is expired/invalid. Log out & log back in from the app.');
    } else if (err.code === 'messaging/invalid-argument') {
      console.log('-> Token format is invalid.');
    } else {
      console.log('-> Check Firebase service account config.');
    }
  }
}

async function run() {
  console.log('\n=== NOTIFICATION DEBUG ===\n');

  // If token passed as argument, send directly
  if (TOKEN_ARG) {
    await sendTest(TOKEN_ARG);
    return;
  }

  // Otherwise list devices and send to the latest
  const supabase = getSupabase();

  const { data: devices, error } = await supabase
    .from('user_devices')
    .select('id, user_id, device_token, device_type, device_name, last_active_at')
    .eq('is_active', true)
    .order('last_active_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('Error querying user_devices:', error.message);
    return;
  }

  if (!devices || devices.length === 0) {
    console.log('No active devices found. Log in from the app first.');
    return;
  }

  console.log('Active devices:\n');
  devices.forEach((d, i) => {
    console.log(`  [${i + 1}] user: ${d.user_id}  type: ${d.device_type}  last: ${d.last_active_at}`);
    console.log(`      token: ${d.device_token?.substring(0, 50)}...`);
  });

  await sendTest(devices[0].device_token);
}

run().catch(console.error);
