/**
 * Quick Diagnostic Script - Check Email Deduplication Setup
 *
 * This script checks if the email deduplication system is properly configured.
 * Run this to diagnose why duplicate emails might be sent.
 *
 * Usage: node check-deduplication-setup.js
 */

require('dotenv').config();
const { executeDirectSQL } = require('./src/utils/postgresExecutor');

async function checkDatabaseConnection() {
  console.log('\n1️⃣  Checking DATABASE_URL configuration...');

  if (!process.env.DATABASE_URL) {
    console.log('❌ DATABASE_URL is NOT configured in .env file');
    console.log('   ⚠️  Email deduplication will NOT work without a database!');
    console.log('   Add DATABASE_URL to your .env file:');
    console.log('   DATABASE_URL=postgresql://user:password@host:port/database');
    return false;
  }

  console.log('✅ DATABASE_URL is configured');

  // Test connection
  try {
    const result = await executeDirectSQL('SELECT NOW() as current_time', []);
    if (result.success) {
      console.log(`✅ Database connection successful (${result.data[0].current_time})`);
      return true;
    } else {
      console.log(`❌ Database connection failed: ${result.error}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ Database connection error: ${error.message}`);
    return false;
  }
}

async function checkTableExists() {
  console.log('\n2️⃣  Checking if scraped_order_imports table exists...');

  const sql = `
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'scraped_order_imports'
    ) AS table_exists;
  `;

  try {
    const result = await executeDirectSQL(sql, []);

    if (!result.success) {
      console.log(`❌ Failed to check table: ${result.error}`);
      return false;
    }

    const exists = result.data[0]?.table_exists;

    if (exists) {
      console.log('✅ scraped_order_imports table EXISTS');
      return true;
    } else {
      console.log('❌ scraped_order_imports table does NOT exist');
      console.log('   This should already exist. Check your database setup.');
      return false;
    }
  } catch (error) {
    console.log(`❌ Error checking table: ${error.message}`);
    return false;
  }
}

async function checkEmailedOrdersJsonColumn() {
  console.log('\n3️⃣  Checking if emailed_orders_json column exists...');

  const sql = `
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'scraped_order_imports'
      AND column_name = 'emailed_orders_json';
  `;

  try {
    const result = await executeDirectSQL(sql, []);

    if (result.success && result.data && result.data.length > 0) {
      console.log('✅ emailed_orders_json column EXISTS');
      console.log('   Column details:');
      console.table(result.data);
      return true;
    } else {
      console.log('❌ emailed_orders_json column does NOT exist');
      console.log('\n   ⚠️  This is why duplicates are happening!');
      console.log('\n   To fix, run this migration:');
      console.log('   psql -d your_database -f migrations/add_emailed_orders_to_scraped_imports.sql');
      return false;
    }
  } catch (error) {
    console.log(`❌ Error checking column: ${error.message}`);
    return false;
  }
}

async function checkIndexes() {
  console.log('\n4️⃣  Checking table indexes...');

  const sql = `
    SELECT
      indexname,
      indexdef
    FROM pg_indexes
    WHERE tablename = 'scraped_order_imports'
      AND indexname LIKE '%emailed_orders%';
  `;

  try {
    const result = await executeDirectSQL(sql, []);

    if (result.success && result.data && result.data.length > 0) {
      console.log(`✅ Found ${result.data.length} GIN index(es) on emailed_orders_json:`);
      for (const idx of result.data) {
        console.log(`   - ${idx.indexname}`);
      }
      return true;
    } else {
      console.log('⚠️  No index found on emailed_orders_json (will run slower)');
      console.log('   Run migration to add index:');
      console.log('   psql -d your_database -f migrations/add_emailed_orders_to_scraped_imports.sql');
      return false;
    }
  } catch (error) {
    console.log(`❌ Error checking indexes: ${error.message}`);
    return false;
  }
}

async function checkEmailedData() {
  console.log('\n5️⃣  Checking emailed orders data...');

  try {
    // Count batches with emailed orders
    const countSQL = `
      SELECT COUNT(*) as count
      FROM scraped_order_imports
      WHERE email_sent_at IS NOT NULL
        AND emailed_orders_json IS NOT NULL
    `;

    const countResult = await executeDirectSQL(countSQL, []);
    if (countResult.success) {
      const count = countResult.data[0]?.count || 0;
      console.log(`✅ Found ${count} batch(es) with emailed orders tracked`);

      if (count === 0) {
        console.log('   ℹ️  No orders have been tracked yet (normal for first time)');
        return true;
      }

      // Show recent batches with emailed orders
      const recentSQL = `
        SELECT
          batch_id,
          email_sent_at,
          jsonb_array_length(emailed_orders_json) as order_count,
          emailed_orders_json
        FROM scraped_order_imports
        WHERE email_sent_at IS NOT NULL
          AND emailed_orders_json IS NOT NULL
        ORDER BY email_sent_at DESC
        LIMIT 3
      `;

      const recentResult = await executeDirectSQL(recentSQL, []);
      if (recentResult.success && recentResult.data.length > 0) {
        console.log('\n   Recent batches with emailed orders:');
        for (const row of recentResult.data) {
          console.log(`\n   Batch: ${row.batch_id}`);
          console.log(`   Emailed at: ${row.email_sent_at}`);
          console.log(`   Orders count: ${row.order_count}`);

          // Show first 3 orders
          const orders = row.emailed_orders_json || [];
          console.log('   Sample orders:');
          console.table(orders.slice(0, 3));
        }
      }

      return true;
    } else {
      console.log(`❌ Failed to query data: ${countResult.error}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ Error checking emailed data: ${error.message}`);
    return false;
  }
}

async function testDeduplicationFunction() {
  console.log('\n6️⃣  Testing deduplication function...');

  try {
    const { filterAlreadyEmailedOrders } = require('./src/services/database/emailedOrdersService');

    // Create a test comparison result with your actual orders
    const testResult = {
      matched_orders: [],
      mismatched_orders: [
        {
          external_order: {
            order_code: '22301',
            order_date: '2026-01-15',
            plant_code: '223',
            product_code: 'A405N3'
          }
        },
        {
          external_order: {
            order_code: '23002',
            order_date: '2026-01-15',
            plant_code: '230',
            product_code: 'A405N0'
          }
        }
      ],
      missing_in_system_orders: [],
      new_in_system_orders: []
    };

    console.log('   Testing with 2 mismatched orders (22301 and 23002)...');

    const { filteredResult, filteredCount, newOrdersCount } = await filterAlreadyEmailedOrders(testResult);

    console.log(`   ✅ Function executed successfully`);
    console.log(`   📊 Results:`);
    console.log(`      - Orders before filtering: 2`);
    console.log(`      - Orders filtered out: ${filteredCount}`);
    console.log(`      - New orders to email: ${newOrdersCount}`);

    if (filteredCount > 0) {
      console.log(`   ✅ Deduplication is WORKING! ${filteredCount} orders were filtered.`);
      console.log(`   This means these orders have been emailed before.`);
    } else {
      console.log(`   ℹ️  No orders were filtered (they haven't been emailed yet).`);
      console.log(`   Send these orders via API and they will be tracked.`);
    }

    return true;
  } catch (error) {
    console.log(`❌ Error testing deduplication: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

async function showSolution() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('📋 SOLUTION TO FIX DUPLICATE EMAILS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('\nStep 1: Add the emailed_orders_json column to your table:');
  console.log('\n   psql -d your_database -f migrations/add_emailed_orders_to_scraped_imports.sql');
  console.log('\nOr copy the DATABASE_URL from your .env and run:');
  console.log('\n   psql "YOUR_DATABASE_URL" -f migrations/add_emailed_orders_to_scraped_imports.sql');
  console.log('\nStep 2: Restart your application:');
  console.log('\n   npm run dev');
  console.log('\nStep 3: Test with the same payload twice:');
  console.log('   - FIRST API call → Email sent ✅');
  console.log('   - SECOND API call → No email (duplicates filtered) ❌');
  console.log('═══════════════════════════════════════════════════════════\n');
}

async function main() {
  let allChecksPass = true;

  // Check 1: Database connection
  const dbOk = await checkDatabaseConnection();
  if (!dbOk) {
    allChecksPass = false;
  }

  if (dbOk) {
    // Check 2: Table exists
    const tableOk = await checkTableExists();
    if (!tableOk) {
      allChecksPass = false;
    }

    if (tableOk) {
      // Check 3: Column exists
      const columnOk = await checkEmailedOrdersJsonColumn();
      if (!columnOk) {
        allChecksPass = false;
      }

      if (columnOk) {
        // Check 4: Indexes
        await checkIndexes();

        // Check 5: Data
        await checkEmailedData();

        // Check 6: Function test
        await testDeduplicationFunction();
      }
    }
  }

  if (!allChecksPass) {
    await showSolution();
  } else {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ All checks passed! Email deduplication should work.');
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log('💡 If you\'re still getting duplicate emails, check the logs');
    console.log('   for messages like:');
    console.log('   - "Checking X orders against previously emailed batches..."');
    console.log('   - "Found X unique orders from Y previous batch(es)"');
    console.log('   - "Filtered out X already-emailed orders"');
    console.log('   - "No new orders to email - skipping email notification"');
    console.log('\n');
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  });
}

module.exports = { checkDatabaseConnection, checkTableExists, checkEmailedOrdersJsonColumn };
