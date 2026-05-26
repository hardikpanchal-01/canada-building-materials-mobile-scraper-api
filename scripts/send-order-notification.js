/**
 * Send an order notification to a specific user via FCM + notification_queue.
 *
 * Usage:
 *   node scripts/send-order-notification.js
 */

require('dotenv').config();

const crypto = require('crypto');
const notificationService = require('../src/services/notificationService');
const { getNotificationSupabase } = require('../src/config/notificationDatabase');

const TARGET_USER_ID = '8dd1b8a3-a794-400d-961b-8a2fa28c2966';
const TENANT_ID = 37;
const ORDER_ID = '9999';
const ORDER_CODE = '98569856';
const ORDER_DATE = '2026-04-13';
const EVENT_CODE = 'ORDER_CREATED';
const TITLE = 'New Order #98569856';
const BODY = 'Test notification - Stevenson Weir OKC';

async function run() {
  console.log('\n=== SEND ORDER NOTIFICATION ===\n');
  console.log(`  User:  ${TARGET_USER_ID}`);
  console.log(`  Order: #${ORDER_CODE} (ID: ${ORDER_ID})`);
  console.log(`  Event: ${EVENT_CODE}`);
  console.log(`  Title: ${TITLE}\n`);

  // 1. Send FCM push to all active devices for this user
  const fcmData = {
    event_code: EVENT_CODE,
    order_id: String(ORDER_ID),
    order_code: String(ORDER_CODE),
    order_date: String(ORDER_DATE),
  };

  try {
    const result = await notificationService.sendNotificationToUser(
      TARGET_USER_ID,
      TITLE,
      BODY,
      fcmData,
    );

    console.log(`  FCM Result: ${result.successCount} sent, ${result.failureCount} failed`);

    if (result.responses) {
      result.responses.forEach((r, i) => {
        console.log(`    Device ${i + 1}: ${r.success ? 'OK' : 'FAILED'} ${r.error || ''}`);
      });
    }
  } catch (err) {
    console.error('  FCM Error:', err.message);
  }

  // 2. Insert into notification_queue for in-app history
  try {
    const supabase = getNotificationSupabase();

    const { error } = await supabase
      .from('notification_queue')
      .insert({
        queue_uuid: crypto.randomUUID(),
        channel_code: 'push',
        user_id: TARGET_USER_ID,
        event_code: EVENT_CODE,
        event_name: EVENT_CODE.replace(/_/g, ' '),
        entity_type: 'order',
        entity_id: ORDER_ID,
        subject: TITLE,
        body: BODY,
        priority: 1,
        status: 'sent',
        tenant_id: TENANT_ID,
      });

    if (error) {
      console.error('  Queue insert error:', error.message);
    } else {
      console.log('  Queue record inserted (status: sent)');
    }
  } catch (err) {
    console.error('  Queue error:', err.message);
  }

  console.log('\n=== DONE ===\n');
}

run().catch(console.error);
