/**
 * Email Service
 *
 * Sends comparison report emails using configured SMTP settings.
 * Email behavior is controlled via environment variables.
 */

const nodemailer = require('nodemailer');

/**
 * Format date to MM-DD-YYYY format
 *
 * @param {string|Date} dateInput - Date string or Date object
 * @returns {string} Formatted date in MM-DD-YYYY format or 'N/A' if invalid
 */
function formatDateToMMDDYYYY(dateInput) {
  if (!dateInput) return 'N/A';

  try {
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return 'N/A';

    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();

    return `${month}-${day}-${year}`;
  } catch (error) {
    return 'N/A';
  }
}

/**
 * Field name labels for display (snake_case to human-readable)
 */
const FIELD_LABELS = {
  'start_time': 'Start Time',
  'plant_code': 'Plant Code',
  'customer_name': 'Customer Name',
  'delivery_address': 'Delivery Address',
  'product_code': 'Product Code',
  'ordered_qty': 'Ordered Qty',
  'delivered_qty': 'Delivered Qty',
  'status': 'Status',
  'cancelled': 'Cancelled'
};

/**
 * Status code to readable name mapping
 * Must match frontend ORDER_STATUS_LOGIC.md and orderComparisonService STATUS_CODE_TO_NAME
 */
const STATUS_MAP = {
  0: 'Normal',
  1: 'Will Call',
  2: 'Weather Permitting',
  3: 'Hold',
  4: 'Completed',
  5: 'Wait List',
  'normal': 'Normal',
  'will call': 'Will Call',
  'weather permitting': 'Weather Permitting',
  'hold': 'Hold',
  'completed': 'Completed',
  'wait list': 'Wait List',
  'cancelled': 'Cancelled',
  'canceled': 'Cancelled',
  'pre-pour': 'Pre-Pour',
  'in-process': 'In-Process'
};

/**
 * Format field name for display
 * @param {string} field - Field name in snake_case
 * @returns {string} Human-readable field name
 */
function formatFieldName(field) {
  return FIELD_LABELS[field] || field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Format status value to readable name
 * @param {string|number} status - Status code or string
 * @returns {string} Human-readable status name
 */
function formatStatusName(status) {
  if (status === null || status === undefined) return '(empty)';
  const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : status;
  return STATUS_MAP[normalizedStatus] || String(status);
}

/**
 * Get only the difference rows where Command Cloud (scraped) and API (fresh) values
 * actually differ. Used to hide orders that have no "real" mismatch (CG vs API)
 * and to show only these rows in the email.
 *
 * @param {object} revalidatedOrder - Order object from revalidationResults.orders
 * @returns {Array} Subset of differences where scraped_value !== fresh_system_value (formatted)
 */
function getDisplayDifferencesWhereCommandCloudDiffersFromApi(revalidatedOrder) {
  if (!revalidatedOrder || !Array.isArray(revalidatedOrder.differences)) {
    return [];
  }

  return revalidatedOrder.differences.filter(diff => {
    // If we have no fresh API value, keep this difference visible
    if (diff.fresh_system_value === undefined || diff.fresh_system_value === null) {
      return true;
    }
    const scrapedFormatted = formatDifferenceValue(diff.field, diff.scraped_value);
    const freshFormatted = formatDifferenceValue(diff.field, diff.fresh_system_value);
    return scrapedFormatted !== freshFormatted;
  });
}

/**
 * Determine if a re-validated mismatched order should be hidden from the
 * Comparison Results table.
 *
 * Business rule: hide the order only if there are NO displayable differences
 * remaining after filtering out rows where Command Cloud === API.
 * Individual diff rows where Command Cloud === API are already filtered out by
 * getDisplayDifferencesWhereCommandCloudDiffersFromApi — we just need to hide
 * the order when that filter leaves nothing to show.
 *
 * @param {object} revalidatedOrder - Order object from revalidationResults.orders
 * @returns {boolean} True if the order should be hidden from the email table
 */
function shouldHideRevalidatedOrderForFreshMatch(revalidatedOrder) {
  const displayDiffs = getDisplayDifferencesWhereCommandCloudDiffersFromApi(revalidatedOrder);
  return displayDiffs.length === 0;
}

/**
 * Format a value based on field type for display
 * @param {string} field - Field name
 * @param {any} value - Value to format
 * @returns {string} Formatted value string
 */
function formatDifferenceValue(field, value) {
  if (value === null || value === undefined || value === '') {
    return '<em style="color: #999;">(empty)</em>';
  }

  // Format quantities with 2 decimal places
  if (field === 'ordered_qty' || field === 'delivered_qty') {
    const numValue = parseFloat(value);
    return isNaN(numValue) ? String(value) : numValue.toFixed(2);
  }

  // Format status codes to readable names
  if (field === 'status') {
    return formatStatusName(value);
  }

  // Format booleans
  if (field === 'cancelled') {
    return value === true || value === 'true' || value === 1 ? 'Yes' : 'No';
  }

  // Truncate long addresses for readability
  if (field === 'delivery_address' && String(value).length > 50) {
    return String(value).substring(0, 47) + '...';
  }

  return String(value);
}

/**
 * Format differences array into HTML for the email table
 * Shows both Scraper API value and System value for each mismatch
 *
 * @param {Array} differences - Array of difference objects
 * @returns {string} HTML formatted string
 */
function formatDifferencesDetailed(differences) {
  if (!differences || differences.length === 0) {
    return '-';
  }

  const formattedDiffs = differences.map(diff => {
    const fieldLabel = formatFieldName(diff.field);
    const scraperValue = formatDifferenceValue(diff.field, diff.external_value);
    const systemValue = formatDifferenceValue(diff.field, diff.system_value);

    return `
      <div style="margin-bottom: 8px;">
        <strong style="color: #495057;">${fieldLabel}:</strong><br/>
        <span style="color: #dc3545; margin-left: 8px;">Command Cloud: ${scraperValue}</span><br/>
        <span style="color: #28a745; margin-left: 8px;">Truckast: ${systemValue}</span>
      </div>
    `;
  }).join('');

  return `<div style="font-size: 12px; line-height: 1.4;">${formattedDiffs}</div>`;
}

/**
 * Format re-validation results into an HTML section for the email
 *
 * @param {object} revalidationResults - Re-validation results from orderComparisonService
 * @returns {string} HTML section string
 */
function formatRevalidationSection(revalidationResults) {
  const { confirmed_count, resolved_count, revalidated_count, orders } = revalidationResults;

  let html = `
    <div class="section-title">Re-Validation Results (${revalidated_count} order(s) re-checked via Command Cloud API)</div>
    <table class="summary-cards-table" cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout: fixed; width: 100%; margin-bottom: 20px;">
      <tr>
        <td width="33%" style="width: 33%; padding: 0 4px 0 0; vertical-align: top;">
          <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #f39c12; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
            <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Still Mismatched</div>
            <div style="font-size: 22px; font-weight: 700; color: #f39c12;">${confirmed_count}</div>
          </div>
        </td>
        <td width="33%" style="width: 33%; padding: 0 4px; vertical-align: top;">
          <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #27ae60; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
            <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Resolved</div>
            <div style="font-size: 22px; font-weight: 700; color: #27ae60;">${resolved_count}</div>
          </div>
        </td>
        <td width="33%" style="width: 33%; padding: 0 0 0 4px; vertical-align: top;">
          <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #667eea; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
            <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Total Re-Validated</div>
            <div style="font-size: 22px; font-weight: 700; color: #667eea;">${revalidated_count}</div>
          </div>
        </td>
      </tr>
    </table>
  `;

  // Only show mismatched (confirmed) orders — resolved ones are excluded from the table
  const sortedOrders = orders.filter(o => o.order_status === 'confirmed');

  html += `
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Order Code</th>
            <th>Date</th>
            <th>Customer</th>
            <th>Product</th>
            <th>Differences</th>
          </tr>
        </thead>
        <tbody>
  `;

  for (const order of sortedOrders) {
    const isResolved = order.order_status === 'resolved';
    const statusBadgeStyle = isResolved
      ? 'background-color: #d4edda; color: #155724;'
      : 'background-color: #fff3cd; color: #856404;';
    const statusLabel = isResolved ? 'Matched' : 'Mismatched';
    const formattedDate = formatDateToMMDDYYYY(order.order_date);

    // Format differences with Command Cloud vs Truckast values (same as Comparison Results table)
    let diffsHtml = '';
    if (order.differences && order.differences.length > 0) {
      const diffItems = order.differences.map(diff => {
        const fieldLabel = formatFieldName(diff.field);
        const concreteGoVal = formatDifferenceValue(diff.field, diff.scraped_value);
        const truckastVal = formatDifferenceValue(diff.field, diff.initial_system_value);
        const freshApiVal = formatDifferenceValue(diff.field, diff.fresh_system_value);

        // Show "After Truckast Updated" line only if value is available (resolved orders that were re-fetched)
        const afterUpdateLine = (diff.after_update_system_value !== undefined && diff.after_update_system_value !== null)
          ? `<br/><span style="color: #6f42c1; margin-left: 8px;">After Truckast Updated: ${formatDifferenceValue(diff.field, diff.after_update_system_value)}</span>`
          : '';

        return `
          <div style="margin-bottom: 8px;">
            <strong style="color: #495057;">${fieldLabel}:</strong><br/>
            <span style="color: #dc3545; margin-left: 8px;">Command Cloud: ${concreteGoVal}</span><br/>
            <span style="color: #28a745; margin-left: 8px;">Truckast: ${truckastVal}</span><br/>
            <span style="color: #0d6efd; margin-left: 8px;">API: ${freshApiVal}</span>${afterUpdateLine}
          </div>
        `;
      }).join('');

      diffsHtml = `<div style="font-size: 12px; line-height: 1.4;">${diffItems}</div>`;
    } else {
      diffsHtml = '-';
    }

    html += `
      <tr>
        <td><span class="status-badge" style="${statusBadgeStyle} display: inline-block; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; text-transform: uppercase;">${statusLabel}</span></td>
        <td>${order.order_code || 'N/A'}</td>
        <td>${formattedDate}</td>
        <td>${order.customer_name || 'N/A'}</td>
        <td>${order.product_code || 'N/A'}</td>
        <td>${diffsHtml}</td>
      </tr>
    `;
  }

  html += `
        </tbody>
      </table>
    </div>
  `;

  return html;
}

/**
 * Format comparison report email body
 *
 * @param {object} comparisonSummary - Comparison summary object
 * @param {object} fullComparisonResult - Full comparison result
 * @param {object} revalidationResults - Optional re-validation results
 * @param {string} tenantName - Tenant name (e.g. Truckast client)
 * @param {string} [producerName] - Concrete producer name
 * @param {string} [scrapedSystem] - Source system name (e.g. Command Cloud, Command Cloud)
 * @returns {string} HTML email body
 */
function formatEmailBody(
  comparisonSummary,
  fullComparisonResult,
  revalidationResults,
  tenantName = 'Truckast',
  producerName,
  scrapedSystem,
  missingRevalidationResults
) {
  const {
    batch_id,
    total_external_orders,
    total_system_orders,
    matched_count,
    mismatched_count: original_mismatched_count,
    missing_in_system_count,
    new_in_system_count,
    excluded_count = 0,
    match_percentage,
    dashboard_total,
    dashboard_active,
    dashboard_cancelled
  } = comparisonSummary;

  const effectiveTenantName = tenantName || process.env.TENANT_NAME || 'Truckast';
  const effectiveProducerName = producerName || process.env.PRODUCER_NAME || effectiveTenantName;
  const effectiveScrapedSystem = scrapedSystem || process.env.SCRAPED_SYSTEM || 'Command Cloud';

  // Whether we have dashboard counts from the DB (matching web app)
  const hasDashboardCounts = dashboard_total != null;

  // If re-validation results exist, use confirmed_count as the actual mismatched count
  let mismatched_count = (revalidationResults && revalidationResults.orders && revalidationResults.orders.length > 0)
    ? revalidationResults.confirmed_count
    : original_mismatched_count;

  // Adjust mismatched count for email display: hide any confirmed orders where
  // all fields have the same Command Cloud/scraped and API/fresh values. These
  // represent cases where the scraper and fresh API agree, even if Truckast
  // is still different, and should not count as "Mismatched" in the summary
  // cards or Comparison Results table.
  let confirmedOrdersForDisplay = null;
  if (revalidationResults && Array.isArray(revalidationResults.orders) && revalidationResults.orders.length > 0) {
    const confirmedOrders = revalidationResults.orders.filter(o => o.order_status === 'confirmed');

    const visibleConfirmedOrders = confirmedOrders.filter(
      order => !shouldHideRevalidatedOrderForFreshMatch(order)
    );

    mismatched_count = visibleConfirmedOrders.length;
    confirmedOrdersForDisplay = visibleConfirmedOrders;
  }

  // Resolved count from re-validation (mismatched orders resolved + missing orders resolved)
  const mismatch_resolved_count = (revalidationResults && revalidationResults.orders)
    ? (revalidationResults.resolved_count || 0)
    : 0;
  const missing_resolved_count = (missingRevalidationResults && missingRevalidationResults.orders)
    ? (missingRevalidationResults.resolved_count || 0)
    : 0;
  const resolved_count = mismatch_resolved_count + missing_resolved_count;

  // Derive Matched count so all categories add up to dashboard_total:
  //   Total (375) = Active (308) + Cancelled (67)
  //   Active (308) = Matched + Mismatched + Missing + New + Excluded + Resolved
  // This ensures the summary cards always add up, regardless of dedup filtering.
  // Fall back to the comparison matched_count when dashboard counts aren't available.
  let display_matched_count = matched_count;
  if (hasDashboardCounts) {
    const activeCount = dashboard_active || (dashboard_total - (dashboard_cancelled || 0));
    display_matched_count = Math.max(0,
      activeCount - mismatched_count - missing_in_system_count - new_in_system_count - (excluded_count || 0) - resolved_count
    );
  }

  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
          line-height: 1.6; 
          color: #333; 
          background-color: #f5f5f5;
          padding: 20px;
        }
        .container { 
          max-width: 1200px; 
          margin: 0 auto; 
          background-color: #ffffff;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          overflow: hidden;
        }
        .header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 20px;
          text-align: center;
        }
        .header h1 { 
          font-size: 24px; 
          margin: 0;
          font-weight: 600;
        }
        .content {
          padding: 30px;
        }
        .summary-cards-table {
          width: 100%;
          margin-bottom: 30px;
          border-collapse: separate;
          border-spacing: 0;
        }
        .summary-cards-table td {
          padding: 0 5px;
          vertical-align: top;
        }
        .summary-cards-table td:first-child {
          padding-left: 0;
        }
        .summary-cards-table td:last-child {
          padding-right: 0;
        }
        .card {
          background: #ffffff;
          border: 1px solid #e0e0e0;
          border-left: 4px solid #667eea;
          border-radius: 6px;
          padding: 12px;
          text-align: center;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
          width: 100%;
          box-sizing: border-box;
          min-height: 80px;
          height: 80px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
        }
        .card-label {
          font-size: 10px;
          color: #666;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 4px;
          font-weight: 600;
        }
        .card-value {
          font-size: 20px;
          font-weight: 700;
          color: #2c3e50;
          line-height: 1.2;
        }
        .card-percentage {
          font-size: 10px;
          color: #666;
          margin-top: 2px;
        }
        .card.matched { border-left-color: #27ae60; }
        .card.mismatched { border-left-color: #f39c12; }
        .card.missing { border-left-color: #e74c3c; }
        .card.new { border-left-color: #3498db; }
        .card.excluded { border-left-color: #9333ea; }
        .card.external { border-left-color: #667eea; }
        .card.system { border-left-color: #764ba2; }
        .matched .card-value { color: #27ae60; }
        .mismatched .card-value { color: #f39c12; }
        .missing .card-value { color: #e74c3c; }
        .new .card-value { color: #3498db; }
        .excluded .card-value { color: #9333ea; }
        .section-title {
          font-size: 20px;
          font-weight: 600;
          color: #2c3e50;
          margin: 30px 0 15px 0;
          padding-bottom: 10px;
          border-bottom: 2px solid #e0e0e0;
        }
        .table-container {
          overflow-x: auto;
          margin: 20px 0;
          border: 1px solid #e0e0e0;
          border-radius: 8px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          background-color: #ffffff;
          font-size: 14px;
        }
        th {
          background-color: #f8f9fa;
          color: #495057;
          font-weight: 600;
          padding: 12px;
          text-align: left;
          border-bottom: 2px solid #dee2e6;
          white-space: nowrap;
        }
        th:last-child {
          min-width: 200px;
          white-space: normal;
        }
        td {
          padding: 12px;
          border-bottom: 1px solid #e9ecef;
          vertical-align: top;
        }
        td:last-child {
          min-width: 200px;
        }
        tr:hover { background-color: #f8f9fa; }
        .status-badge {
          display: inline-block;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
        }
        .status-matched {
          background-color: #d4edda;
          color: #155724;
        }
        .status-mismatched {
          background-color: #fff3cd;
          color: #856404;
        }
        .status-missing {
          background-color: #f8d7da;
          color: #721c24;
        }
        .status-new {
          background-color: #d1ecf1;
          color: #0c5460;
        }
        .footer {
          margin-top: 40px;
          padding-top: 20px;
          border-top: 1px solid #e0e0e0;
          font-size: 12px;
          color: #7f8c8d;
          text-align: center;
        }

        /* ── Mobile responsive styles ── */
        @media only screen and (max-width: 620px) {
          body {
            padding: 4px !important;
          }
          .container {
            border-radius: 0 !important;
            box-shadow: none !important;
          }
          .content {
            padding: 12px !important;
          }
          .header {
            padding: 14px !important;
          }
          .header h1 {
            font-size: 18px !important;
          }

          /* Summary cards: break tables into stacked inline-blocks, 2 per row */
          .summary-cards-table {
            table-layout: auto !important;
            display: block !important;
            width: 100% !important;
            margin-bottom: 12px !important;
          }
          .summary-cards-table tbody {
            display: block !important;
            width: 100% !important;
          }
          .summary-cards-table > tbody > tr,
          .summary-cards-table > tr {
            display: block !important;
            width: 100% !important;
            font-size: 0 !important; /* collapse whitespace between inline-blocks */
          }
          .summary-cards-table > tbody > tr > td,
          .summary-cards-table > tr > td {
            display: inline-block !important;
            width: 48% !important;
            margin: 0 1% 8px 1% !important;
            padding: 0 !important;
            vertical-align: top !important;
            font-size: 14px !important; /* restore font-size */
          }
          /* Nested table inside each card cell */
          .summary-cards-table table {
            width: 100% !important;
            height: auto !important;
          }
          .summary-cards-table table td {
            width: 100% !important;
            height: auto !important;
          }
          /* Card div sizing */
          .summary-cards-table div[style*="height: 80px"] {
            height: auto !important;
            min-height: 60px !important;
            padding: 8px !important;
          }
          .summary-cards-table .card-label,
          .summary-cards-table div[style*="font-size: 10px"] {
            font-size: 9px !important;
            letter-spacing: 0 !important;
          }
          .summary-cards-table .card-value,
          .summary-cards-table div[style*="font-size: 20px"] {
            font-size: 18px !important;
          }

          /* Make data table horizontally scrollable */
          .table-container {
            overflow-x: auto !important;
            -webkit-overflow-scrolling: touch;
            margin: 12px 0 !important;
          }
          .table-container table {
            font-size: 12px !important;
            min-width: 700px !important;
          }
          .table-container th,
          .table-container td {
            padding: 8px 6px !important;
          }
          .table-container th:last-child,
          .table-container td:last-child {
            min-width: 180px !important;
          }

          .section-title {
            font-size: 16px !important;
            margin: 16px 0 10px 0 !important;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Comparison Results</h1>
        </div>
        <div class="content">
          <div style="margin-bottom: 20px; padding: 12px 0; border-bottom: 1px solid #e0e0e0;">
            <p style="margin: 0 0 4px 0; font-size: 14px; color: #333;"><strong>Tenant Name:</strong> ${effectiveProducerName}</p>
            <p style="margin: 0; font-size: 14px; color: #333;"><strong>Provider:</strong> ${effectiveScrapedSystem}</p>
          </div>
          ${hasDashboardCounts ? `
          <!-- Row 1: Total Orders | Active | Cancelled -->
          <table class="summary-cards-table" cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout: fixed; width: 100%; margin-bottom: 8px;">
            <tr>
              <td width="33%" style="width: 33%; padding: 0 4px 0 0; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #667eea; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Total Orders</div>
                  <div style="font-size: 22px; font-weight: 700; color: #2c3e50;">${dashboard_total}</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 4px; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #27ae60; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Active</div>
                  <div style="font-size: 22px; font-weight: 700; color: #27ae60;">${dashboard_active}</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 0 0 4px; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #e74c3c; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Cancelled</div>
                  <div style="font-size: 22px; font-weight: 700; color: #e74c3c;">${dashboard_cancelled}</div>
                </div>
              </td>
            </tr>
          </table>
          <!-- Row 2: Matched | Mismatched | Missing -->
          <table class="summary-cards-table" cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout: fixed; width: 100%; margin-bottom: 8px;">
            <tr>
              <td width="33%" style="width: 33%; padding: 0 4px 0 0; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #27ae60; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Matched</div>
                  <div style="font-size: 22px; font-weight: 700; color: #27ae60;">${display_matched_count}</div>
                  <div style="font-size: 10px; color: #666; margin-top: 2px;">(${dashboard_total > 0 ? ((display_matched_count / dashboard_total) * 100).toFixed(0) : 0}%)</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 4px; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #f39c12; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Mismatched</div>
                  <div style="font-size: 22px; font-weight: 700; color: #f39c12;">${mismatched_count}</div>
                  <div style="font-size: 10px; color: #666; margin-top: 2px;">(${dashboard_total > 0 ? ((mismatched_count / dashboard_total) * 100).toFixed(0) : 0}%)</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 0 0 4px; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #e74c3c; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Missing in System</div>
                  <div style="font-size: 22px; font-weight: 700; color: #e74c3c;">${missing_in_system_count}</div>
                </div>
              </td>
            </tr>
          </table>
          <!-- Row 3: New in System | Excluded | Resolved -->
          <table class="summary-cards-table" cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout: fixed; width: 100%; margin-bottom: 24px;">
            <tr>
              <td width="33%" style="width: 33%; padding: 0 4px 0 0; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #3498db; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">New in System</div>
                  <div style="font-size: 22px; font-weight: 700; color: #3498db;">${new_in_system_count}</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 4px; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #9333ea; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Excluded</div>
                  <div style="font-size: 22px; font-weight: 700; color: #9333ea;">${excluded_count}</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 0 0 4px; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #27ae60; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Resolved</div>
                  <div style="font-size: 22px; font-weight: 700; color: #27ae60;">${resolved_count}</div>
                </div>
              </td>
            </tr>
          </table>
          ` : `
          <!-- Row 1: External | System | Matched -->
          <table class="summary-cards-table" cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout: fixed; width: 100%; margin-bottom: 8px;">
            <tr>
              <td width="33%" style="width: 33%; padding: 0 4px 0 0; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #667eea; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">External Orders</div>
                  <div style="font-size: 22px; font-weight: 700; color: #2c3e50;">${total_external_orders}</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 4px; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #764ba2; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">System Orders</div>
                  <div style="font-size: 22px; font-weight: 700; color: #2c3e50;">${total_system_orders}</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 0 0 4px; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #27ae60; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Matched</div>
                  <div style="font-size: 22px; font-weight: 700; color: #27ae60;">${display_matched_count}</div>
                  <div style="font-size: 10px; color: #666; margin-top: 2px;">(${total_external_orders > 0 ? ((display_matched_count / total_external_orders) * 100).toFixed(0) : 0}%)</div>
                </div>
              </td>
            </tr>
          </table>
          <!-- Row 2: Mismatched | Missing | New in System -->
          <table class="summary-cards-table" cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout: fixed; width: 100%; margin-bottom: 8px;">
            <tr>
              <td width="33%" style="width: 33%; padding: 0 4px 0 0; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #f39c12; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Mismatched</div>
                  <div style="font-size: 22px; font-weight: 700; color: #f39c12;">${mismatched_count}</div>
                  <div style="font-size: 10px; color: #666; margin-top: 2px;">(${total_external_orders > 0 ? ((mismatched_count / total_external_orders) * 100).toFixed(0) : 0}%)</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 4px; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #e74c3c; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Missing in System</div>
                  <div style="font-size: 22px; font-weight: 700; color: #e74c3c;">${missing_in_system_count}</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 0 0 4px; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #3498db; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">New in System</div>
                  <div style="font-size: 22px; font-weight: 700; color: #3498db;">${new_in_system_count}</div>
                </div>
              </td>
            </tr>
          </table>
          <!-- Row 3: Excluded | Resolved -->
          <table class="summary-cards-table" cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout: fixed; width: 100%; margin-bottom: 24px;">
            <tr>
              <td width="33%" style="width: 33%; padding: 0 4px 0 0; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #9333ea; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Excluded</div>
                  <div style="font-size: 22px; font-weight: 700; color: #9333ea;">${excluded_count}</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 4px; vertical-align: top;">
                <div style="background: #ffffff; border: 1px solid #e0e0e0; border-left: 4px solid #27ae60; border-radius: 6px; padding: 10px 6px; text-align: center; min-height: 70px;">
                  <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600;">Resolved</div>
                  <div style="font-size: 22px; font-weight: 700; color: #27ae60;">${resolved_count}</div>
                </div>
              </td>
              <td width="33%" style="width: 33%; padding: 0 0 0 4px; vertical-align: top;">
                <!-- Empty spacer -->
              </td>
            </tr>
          </table>
          `}
  `;

  // Show still-mismatched (after re-validation) + Missing orders in Comparison Results
  const allComparisonResults = [];

  // Build lookup from original mismatched orders for extra fields (qty, status, plant)
  const originalMismatchedMap = new Map();
  const originalSystemOrderMap = new Map();
  if (fullComparisonResult.mismatched_orders) {
    for (const order of fullComparisonResult.mismatched_orders) {
      const ext = order.external_order || {};
      const sys = order.system_order || {};
      originalMismatchedMap.set(ext.order_code, ext);
      originalSystemOrderMap.set(ext.order_code, sys);
    }
  }

  if (revalidationResults && revalidationResults.orders && revalidationResults.orders.length > 0) {
    // Use re-validation results: only confirmed (still mismatched) orders,
    // after applying Command Cloud-specific hide rules (if any)
    const confirmedOrders = confirmedOrdersForDisplay || revalidationResults.orders.filter(o => o.order_status === 'confirmed');
    for (const revalOrder of confirmedOrders) {
      // Get original order data for fields not in re-validation result
      const originalExt = originalMismatchedMap.get(revalOrder.order_code) || {};
      const originalSys = originalSystemOrderMap.get(revalOrder.order_code) || {};

      // Format only differences where Command Cloud !== API (same filter as hide rule)
      const displayDiffs = getDisplayDifferencesWhereCommandCloudDiffersFromApi(revalOrder);
      let diffDetails = '-';
      if (displayDiffs.length > 0) {
        const diffItems = displayDiffs.map(diff => {
          const fieldLabel = formatFieldName(diff.field);
          const concreteGoVal = formatDifferenceValue(diff.field, diff.scraped_value);
          const truckastVal = formatDifferenceValue(diff.field, diff.initial_system_value);
          // Show "N/A" when API data wasn't available (query failed or order not found)
          const freshApiVal = (diff.fresh_system_value === null || diff.fresh_system_value === undefined) && revalOrder.fresh_data_found === false
            ? '<em style="color: #999;">N/A</em>'
            : formatDifferenceValue(diff.field, diff.fresh_system_value);

          // Show "After Truckast Updated" line only if value is available (resolved orders that were re-fetched)
          const afterUpdateLine = (diff.after_update_system_value !== undefined && diff.after_update_system_value !== null)
            ? `<br/><span style="color: #6f42c1; margin-left: 8px;">After Truckast Updated: ${formatDifferenceValue(diff.field, diff.after_update_system_value)}</span>`
            : '';

          return `
            <div style="margin-bottom: 8px;">
              <strong style="color: #495057;">${fieldLabel}:</strong><br/>
              <span style="color: #dc3545; margin-left: 8px;">Command Cloud: ${concreteGoVal}</span><br/>
              <span style="color: #28a745; margin-left: 8px;">Truckast: ${truckastVal}</span><br/>
              <span style="color: #0d6efd; margin-left: 8px;">API: ${freshApiVal}</span>${afterUpdateLine}
            </div>
          `;
        }).join('');
        diffDetails = `<div style="font-size: 12px; line-height: 1.4;">${diffItems}</div>`;
      }

      // Only show debug status box if there's a status mismatch in the differences
      const hasStatusDiff = displayDiffs.some(diff => diff.field === 'status');
      let statusDebugHtml = '';
      if (hasStatusDiff) {
        statusDebugHtml = `
          <div style="margin-top: 8px; padding: 6px 8px; background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 4px; font-size: 11px; font-family: monospace; line-height: 1.5;">
            <strong style="color: #6c757d;">Debug Status:</strong><br/>
            <span style="color: #28a745;">Truckast DB:</span> currentStatus=${originalSys.current_status ?? 'N/A'} (${formatStatusName(originalSys.current_status)}), removed=${originalSys.removed ?? 'N/A'}, removeReasonCode=${originalSys.remove_reason_code ?? 'N/A'}, status=${originalSys.status || 'N/A'}<br/>
            <span style="color: #0d6efd;">API:</span> currentStatus=${revalOrder.api_current_status ?? 'N/A'} (${formatStatusName(revalOrder.api_current_status)}), removed=${revalOrder.api_removed_raw ?? (revalOrder.api_removed != null ? revalOrder.api_removed : 'N/A')}, removeReasonCode=${revalOrder.api_remove_reason_code ?? 'N/A'}, status=${revalOrder.api_status || 'N/A'}
          </div>
        `;
      }

      allComparisonResults.push({
        status: 'mismatched',
        statusLabel: 'Mismatched',
        order_code: revalOrder.order_code,
        order_date: revalOrder.order_date,
        customer: revalOrder.customer_name || originalExt.customer_name,
        product: revalOrder.product_code || originalExt.product_code,
        qty_del: originalExt.delivered_qty || 0,
        qty_ord: originalExt.ordered_qty || 0,
        order_status: originalExt.status,
        plt: originalExt.plant_code,
        differences: diffDetails + statusDebugHtml
      });
    }
  } else {
    // No re-validation - fall back to original mismatched orders
    if (fullComparisonResult.mismatched_orders) {
      for (const order of fullComparisonResult.mismatched_orders) {
        const ext = order.external_order || {};
        const sys = order.system_order || {};
        const diffDetails = formatDifferencesDetailed(order.differences);

        // Only show debug status box if there's a status mismatch in the differences
        const hasStatusDiff = (order.differences || []).some(diff => diff.field === 'status');
        let statusDebugHtml = '';
        if (hasStatusDiff) {
          statusDebugHtml = `
            <div style="margin-top: 8px; padding: 6px 8px; background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 4px; font-size: 11px; font-family: monospace; line-height: 1.5;">
              <strong style="color: #6c757d;">Debug Status:</strong><br/>
              <span style="color: #28a745;">Truckast DB:</span> currentStatus=${sys.current_status ?? 'N/A'} (${formatStatusName(sys.current_status)}), removed=${sys.removed ?? 'N/A'}, removeReasonCode=${sys.remove_reason_code ?? 'N/A'}, status=${sys.status || 'N/A'}
            </div>
          `;
        }

        allComparisonResults.push({
          status: 'mismatched',
          statusLabel: 'Mismatched',
          order_code: ext.order_code,
          order_date: ext.order_date,
          customer: ext.customer_name,
          product: ext.product_code,
          qty_del: ext.delivered_qty || 0,
          qty_ord: ext.ordered_qty || 0,
          order_status: ext.status,
          plt: ext.plant_code,
          differences: diffDetails + statusDebugHtml
        });
      }
    }
  }

  // Missing in System orders (unchanged)
  if (fullComparisonResult.missing_in_system_orders) {
    for (const order of fullComparisonResult.missing_in_system_orders) {
      const ext = order.external_order || {};
      allComparisonResults.push({
        status: 'missing',
        statusLabel: 'Missing',
        order_code: ext.order_code,
        order_date: ext.order_date,
        customer: ext.customer_name,
        product: ext.product_code,
        qty_del: ext.delivered_qty || 0,
        qty_ord: ext.ordered_qty || 0,
        order_status: ext.status,
        plt: ext.plant_code,
        differences: '-'
      });
    }
  }

  // Sort: mismatched first, then missing
  const statusPriority = { 'mismatched': 1, 'missing': 2 };
  allComparisonResults.sort((a, b) => {
    return (statusPriority[a.status] || 99) - (statusPriority[b.status] || 99);
  });

  if (allComparisonResults.length > 0) {
    html += `
      <div class="section-title">Comparison Results (${allComparisonResults.length} results)</div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Order Code</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Product</th>
              <th>Qty (Del/Ord)</th>
              <th>Order Status</th>
              <th>PLT</th>
              <th>Differences</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const result of allComparisonResults) {
      const statusClass = `status-${result.status}`;
      const formattedDate = formatDateToMMDDYYYY(result.order_date);
      html += `
        <tr>
          <td><span class="status-badge ${statusClass}">${result.statusLabel}</span></td>
          <td>${result.order_code || 'N/A'}</td>
          <td>${formattedDate}</td>
          <td>${result.customer || 'N/A'}</td>
          <td>${result.product || 'N/A'}</td>
          <td>${result.qty_del.toFixed(2)}/${result.qty_ord.toFixed(2)}</td>
          <td>${result.order_status || 'N/A'}</td>
          <td>${result.plt || 'N/A'}</td>
          <td>${result.differences}</td>
        </tr>
      `;
    }

    html += `
          </tbody>
        </table>
      </div>
    `;
  }

  html += `
        </div>
        <div class="footer">
          <p>This is an automated report generated by the Truckast Unified API.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return html;
}

/**
 * Send comparison report email
 *
 * @param {object} comparisonSummary - Comparison summary object
 * @param {object} fullComparisonResult - Full comparison result
 * @param {object} [revalidationResults] - Optional re-validation results for mismatched orders
 * @returns {Promise<boolean>} True if email sent successfully
 */
async function sendComparisonEmail(comparisonSummary, fullComparisonResult, revalidationResults, missingRevalidationResults) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const parsedPort = smtpPort ? parseInt(smtpPort, 10) : 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;
  const smtpFrom = process.env.SMTP_FROM_EMAIL;
  const smtpSecure = process.env.SMTP_SECURE === 'true' || process.env.SMTP_SECURE === '1' || 
                     process.env.MAIL_SECURE === 'true' || process.env.EMAIL_SECURE === 'true';
  const smtpTo = process.env.SMTP_TO;
  const smtpCc = process.env.SMTP_CC || process.env.MAIL_CC || process.env.EMAIL_CC;

  if (!smtpHost || !smtpUser || !smtpPassword) {
    throw new Error('SMTP not configured: SMTP_HOST, SMTP_USER, and SMTP_PASSWORD are required');
  }

  let recipients = [];
  
  const parseEmails = (emailString) => {
    if (!emailString) return [];
    return emailString
      .split(',')
      .map(email => email.trim())
      .filter(email => email.includes('@') && email.length > 0);
  };
  
  if (smtpTo) {
    recipients = parseEmails(smtpTo);
  }
  
  if (recipients.length === 0 && smtpFrom && smtpFrom.includes('@') && smtpFrom !== 'noreply@example.com') {
    recipients = [smtpFrom.trim()];
  }
  
  if (recipients.length === 0 && smtpUser && smtpUser.includes('@')) {
    recipients = [smtpUser.trim()];
  }
  
  if (recipients.length === 0) {
    throw new Error('No email recipients: set SMTP_TO, SMTP_FROM_EMAIL, or SMTP_USER to a valid address');
  }

  const ccRecipients = smtpCc ? parseEmails(smtpCc) : [];
  
  // Tenant / producer configuration and timezone from environment
  const tenantName = process.env.TENANT_NAME || 'Truckast';
  const producerName = process.env.PRODUCER_NAME || tenantName;
  const scrapedSystem = process.env.SCRAPED_SYSTEM || 'Command Cloud';
  const businessTimezone = process.env.BUSINESS_TIMEZONE || 'America/Chicago';

  // Format date and time in tenant's timezone
  const currentDate = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Get date/time components in tenant timezone
  const tzDate = new Date(currentDate.toLocaleString('en-US', { timeZone: businessTimezone }));
  const formattedDate = `${months[tzDate.getMonth()]} ${String(tzDate.getDate()).padStart(2, '0')}, ${tzDate.getFullYear()}`;

  // Format time in tenant timezone (e.g., "2:35 AM CST")
  const timeStr = currentDate.toLocaleString('en-US', {
    timeZone: businessTimezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  const tzAbbr = currentDate.toLocaleString('en-US', {
    timeZone: businessTimezone,
    timeZoneName: 'short'
  }).split(' ').pop();

  const emailSubject = `${producerName} - ${scrapedSystem} - Scraped Orders Comparison Report - ${formattedDate} ${timeStr} ${tzAbbr}`;
  const emailBody = formatEmailBody(
    comparisonSummary,
    fullComparisonResult,
    revalidationResults,
    tenantName,
    producerName,
    scrapedSystem,
    missingRevalidationResults
  );

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parsedPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPassword
      },
      tls: {
        rejectUnauthorized: false
      },
      // Increase timeouts to prevent "451 4.4.2 Timeout waiting for data" errors
      // when sending large HTML emails (comparison reports with many orders)
      connectionTimeout: 30000,  // 30s to establish connection
      greetingTimeout: 30000,    // 30s for SMTP greeting
      socketTimeout: 60000       // 60s for socket inactivity (DATA phase)
    });

    await transporter.verify();

    const mailOptions = {
      from: smtpFrom || smtpUser,
      to: recipients.join(', '),
      subject: emailSubject,
      html: emailBody
    };

    if (ccRecipients.length > 0) {
      mailOptions.cc = ccRecipients.join(', ');
    }

    await transporter.sendMail(mailOptions);
    return true;

  } catch (error) {
    console.error('Error sending comparison email:', error);
    if (error.code === 'EDNS' || error.code === 'ETIMEOUT' || (error.message && error.message.includes('ETIMEOUT'))) {
      console.error('Tip: SMTP host unreachable (DNS/network). Try Gmail SMTP - see docs/EMAIL_SMTP_SETUP.md');
    }
    throw error; // Re-throw so queue processor does not mark email as sent
  }
}

/**
 * ============================================================================
 * LITE email (Connex extension flow) — fully separate from the main email above.
 * Does NOT touch formatEmailBody / sendComparisonEmail. Slim, problems-only.
 * ============================================================================
 */

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function liteQty(v) {
  const n = parseFloat(v);
  return isNaN(n) ? "—" : String(Math.round(n * 100) / 100);
}

/**
 * Build the slim lite-comparison email body.
 * Shows Total/Matched/Mismatched/Missing + a single table of only the problem
 * orders (mismatched + missing), Connex vs Truckast for ordered qty + status.
 */
function formatLiteEmailBody(summary, fullResult, opts = {}) {
  const tenant = process.env.PRODUCER_NAME || process.env.TENANT_NAME || "Truckast";
  const dateStr = opts.dateStr || "";
  const perTab = opts.perTab || null;
  const total = summary.total_external_orders || 0;
  const matched = summary.matched_count || 0;
  const mismatched = summary.mismatched_count || 0;
  const missing = summary.missing_in_system_count || 0;

  const mism = fullResult.mismatched_orders || [];
  const miss = fullResult.missing_in_system_orders || [];
  const problemCount = mism.length + miss.length;

  const card = (label, value, color) => `
    <td style="padding:0 4px;">
      <div style="border:1px solid #e0e0e0;border-left:4px solid ${color};border-radius:6px;padding:10px 6px;text-align:center;">
        <div style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:.5px;font-weight:600;">${label}</div>
        <div style="font-size:22px;font-weight:700;color:${color};">${value}</div>
      </div>
    </td>`;

  // Optional per-tab breakdown line (Active/Completed/Cancelled), rendered only
  // when the extension forwarded metadata.perTab.
  const perTabLine = (() => {
    if (!perTab || typeof perTab !== "object") return "";
    const parts = [];
    for (const k of ["Active", "Completed", "Cancelled"]) {
      if (perTab[k] !== undefined && perTab[k] !== null) parts.push(`${escHtml(k)} ${escHtml(perTab[k])}`);
    }
    return parts.length ? parts.join(" &middot; ") : "";
  })();

  const tenantLine = `<p style="margin:0 0 4px;font-size:14px;"><strong>Tenant:</strong> ${escHtml(tenant)}</p>`;
  const providerLine = `<p style="margin:0 0 ${dateStr ? "4px" : "16px"};font-size:14px;"><strong>Provider:</strong> Connex</p>`;
  const dateLine = dateStr
    ? `<p style="margin:0 0 16px;font-size:13px;color:#7f8c8d;">${escHtml(dateStr)}</p>`
    : "";

  const summaryCards = `
        <table width="100%" style="table-layout:fixed;border-collapse:separate;border-spacing:0;margin-bottom:8px;">
          <tr>
            ${card("Total", total, "#2c3e50")}
            ${card("Matched", matched, "#27ae60")}
            ${card("Mismatched", mismatched, "#f39c12")}
            ${card("Missing", missing, "#e74c3c")}
          </tr>
        </table>`;

  // ---- 100% Accuracy hero (everything matched) -----------------------------
  // When there are no mismatched AND no missing orders, send a polished green
  // "100% Accuracy" email so the client sees a perfect result at a glance.
  if (problemCount === 0) {
    return `
  <!DOCTYPE html>
  <html><head><meta charset="UTF-8"/></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f5f5f5;padding:20px;color:#333;">
    <div style="max-width:900px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,.1);">
      <div style="background:linear-gradient(135deg,#11998e,#38ef7d);color:#fff;padding:32px 20px;text-align:center;">
        <div style="width:64px;height:64px;line-height:64px;margin:0 auto 12px;border-radius:50%;background:rgba(255,255,255,.2);font-size:36px;font-weight:700;">&#10003;</div>
        <h1 style="margin:0;font-size:30px;letter-spacing:.5px;">100% Accuracy</h1>
        <p style="margin:8px 0 0;font-size:15px;opacity:.95;">All ${total} order${total === 1 ? "" : "s"} verified &middot; perfect match</p>
      </div>
      <div style="padding:24px;">
        ${tenantLine}
        ${providerLine}
        ${dateLine}
        ${summaryCards}
        <div style="margin-top:20px;padding:16px;background:#f1fef9;border:1px solid #6ceaba;border-radius:8px;color:#106a40;font-weight:600;text-align:center;">
          &#10003; Every Connex order matched ${escHtml(tenant)} exactly on ordered quantity + status.
        </div>
        ${perTabLine ? `<div style="font-size:12px;color:#7f8c8d;margin-top:12px;text-align:center;">${perTabLine}</div>` : ""}
        <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:12px;color:#7f8c8d;text-align:center;">
          Automated report &mdash; Connex orders compared on ordered quantity + status.
        </div>
      </div>
    </div>
  </body></html>`;
  }

  let rows = "";
  for (const o of mism) {
    const ext = o.external_order || o.externalOrder || {};
    // Render ONLY the fields that actually differ (from order.differences).
    // A matching field shows "—" (so a status-only mismatch doesn't print a
    // confusing equal-value Ordered Qty column).
    const diffs = {};
    for (const d of (o.differences || [])) diffs[d.field] = d;

    const cell = (field, isQty) => {
      const d = diffs[field];
      if (!d) return '<span style="color:#9aa3ad;">—</span>';
      const cx = isQty ? liteQty(d.external_value) : (escHtml(d.external_value) || "—");
      const rv = isQty ? liteQty(d.system_value) : (escHtml(d.system_value) || "—");
      // Status diffs re-validated against Command Cloud are compared to the live
      // Command Cloud status; everything else is compared to the Truckast DB.
      const rightLabel = d.compare_source ? escHtml(d.compare_source) : "Truckast";
      return (
        '<span style="color:#b3141d;">Connex: ' + cx + '</span><br/>' +
        '<span style="color:#198558;">' + rightLabel + ': ' + rv + '</span>'
      );
    };

    rows += `
      <tr>
        <td><span style="background:#fff3cd;color:#856404;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;">Mismatched</span></td>
        <td>${escHtml(ext.order_code)}</td>
        <td>${formatDateToMMDDYYYY(ext.order_date)}</td>
        <td style="${diffs.ordered_qty ? "background:#fff5f5;" : ""}">${cell("ordered_qty", true)}</td>
        <td style="${diffs.status ? "background:#fff5f5;" : ""}">${cell("status", false)}</td>
      </tr>`;
  }
  for (const o of miss) {
    const ext = o.external_order || o.externalOrder || {};
    rows += `
      <tr>
        <td><span style="background:#f8d7da;color:#721c24;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;">Missing</span></td>
        <td>${escHtml(ext.order_code)}</td>
        <td>${formatDateToMMDDYYYY(ext.order_date)}</td>
        <td><span style="color:#b3141d;">Connex: ${liteQty(ext.ordered_qty)}</span><br/><span style="color:#999;">Truckast: Not found</span></td>
        <td><span style="color:#b3141d;">Connex: ${escHtml(ext.status) || "—"}</span><br/><span style="color:#999;">Truckast: Not found</span></td>
      </tr>`;
  }

  const tableOrNote = `
        <div style="font-size:16px;font-weight:600;color:#2c3e50;margin:24px 0 10px;">Orders needing attention (${problemCount})</div>
        <table width="100%" style="border-collapse:collapse;font-size:13px;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">
          <thead>
            <tr style="background:#f8f9fa;color:#495057;text-align:left;">
              <th style="padding:10px;">Status</th>
              <th style="padding:10px;">Order Code</th>
              <th style="padding:10px;">Date</th>
              <th style="padding:10px;">Ordered Qty</th>
              <th style="padding:10px;">Order Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="font-size:11px;color:#888;margin-top:8px;">Connex = scraped board value · Truckast = system (DB) value · Command Cloud = live source status (status re-validated against the Command Cloud API).</div>`;

  return `
  <!DOCTYPE html>
  <html><head><meta charset="UTF-8"/></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f5f5f5;padding:20px;color:#333;">
    <div style="max-width:900px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,.1);">
      <div style="background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:20px;text-align:center;">
        <h1 style="margin:0;font-size:22px;">Orders Comparison (Connex)</h1>
      </div>
      <div style="padding:24px;">
        ${tenantLine}
        ${providerLine}
        ${dateLine}
        ${summaryCards}
        ${tableOrNote}
        ${perTabLine ? `<div style="font-size:12px;color:#7f8c8d;margin-top:12px;">${perTabLine}</div>` : ""}
        <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:12px;color:#7f8c8d;text-align:center;">
          Automated report — Connex orders compared on ordered quantity + status.
        </div>
      </div>
    </div>
  </body></html>`;
}

/**
 * Send the slim lite-comparison email. Self-contained nodemailer send so the
 * main sendComparisonEmail is never touched.
 */
async function sendLiteComparisonEmail(summary, fullResult, opts = {}) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const parsedPort = smtpPort ? parseInt(smtpPort, 10) : 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;
  const smtpFrom = process.env.SMTP_FROM_EMAIL;
  const smtpSecure =
    process.env.SMTP_SECURE === "true" || process.env.SMTP_SECURE === "1";
  const smtpTo = process.env.SMTP_TO;
  const smtpCc = process.env.SMTP_CC || process.env.MAIL_CC || process.env.EMAIL_CC;

  if (!smtpHost || !smtpUser || !smtpPassword) {
    throw new Error("SMTP not configured: SMTP_HOST, SMTP_USER, and SMTP_PASSWORD are required");
  }

  const parseEmails = (s) =>
    !s
      ? []
      : s.split(",").map((e) => e.trim()).filter((e) => e.includes("@") && e.length > 0);

  let recipients = parseEmails(smtpTo);
  if (recipients.length === 0 && smtpFrom && smtpFrom.includes("@") && smtpFrom !== "noreply@example.com") {
    recipients = [smtpFrom.trim()];
  }
  if (recipients.length === 0 && smtpUser && smtpUser.includes("@")) {
    recipients = [smtpUser.trim()];
  }
  if (recipients.length === 0) {
    throw new Error("No email recipients: set SMTP_TO, SMTP_FROM_EMAIL, or SMTP_USER to a valid address");
  }
  const ccRecipients = parseEmails(smtpCc);

  const tenant = process.env.PRODUCER_NAME || process.env.TENANT_NAME || "Truckast";
  const businessTimezone = process.env.BUSINESS_TIMEZONE || "America/Chicago";
  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const tzDate = new Date(now.toLocaleString("en-US", { timeZone: businessTimezone }));
  const formattedDate = `${months[tzDate.getMonth()]} ${String(tzDate.getDate()).padStart(2, "0")}, ${tzDate.getFullYear()}`;
  const timeStr = now.toLocaleString("en-US", {
    timeZone: businessTimezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
  const tzAbbr = now
    .toLocaleString("en-US", { timeZone: businessTimezone, timeZoneName: "short" })
    .split(" ")
    .pop();

  const subject = `${tenant} - Connex - Orders Comparison - ${formattedDate} ${timeStr} ${tzAbbr}`;
  const html = formatLiteEmailBody(summary, fullResult, {
    dateStr: `${formattedDate} · ${timeStr} ${tzAbbr}`,
    perTab: opts.perTab
  });

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parsedPort,
    secure: smtpSecure,
    auth: { user: smtpUser, pass: smtpPassword },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000
  });

  await transporter.verify();

  const mailOptions = {
    from: smtpFrom || smtpUser,
    to: recipients.join(", "),
    subject,
    html
  };
  if (ccRecipients.length > 0) mailOptions.cc = ccRecipients.join(", ");

  await transporter.sendMail(mailOptions);
  return true;
}

module.exports = {
  sendComparisonEmail,
  shouldHideRevalidatedOrderForFreshMatch,
  sendLiteComparisonEmail,
  formatLiteEmailBody
};


