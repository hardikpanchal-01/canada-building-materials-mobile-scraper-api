/**
 * QR Code Service
 *
 * Server-side decryption + verification of TK QR payloads.
 * This eliminates the need for client-side crypto on mobile devices.
 *
 * QR payload format: [TK/E] + Base64( IV(12) | AuthTag(16) | Ciphertext(N) )
 */

const crypto = require('crypto');
const ticketService = require('./ticketService');
const truckService = require('./truckService');
const { getSupabaseAdmin } = require('../config/database');
const { getAuthSupabaseAdmin } = require('../config/authDatabase');

/**
 * Fetch all ticket_products for a given ticket_code and attach to ticket object.
 */
async function enrichTicketProducts(ticket, ticketCode) {
  try {
    const supabase = getSupabaseAdmin();
    const { data: tRow } = await supabase
      .from('tickets')
      .select('ticket_id, order_id, verifi_json')
      .eq('ticket_code', ticketCode)
      .limit(1)
      .maybeSingle();
    if (tRow?.ticket_id) {
      const { data: products } = await supabase
        .from('ticket_products')
        .select('id, ticket_id, item_code, description, short_description, is_mix, is_assoc, load_qty, delv_qty, delv_qty_unit, order_qty, order_qty_unit, ticket_qty, ticket_qty_unit, acc_delv_qty, slump')
        .eq('ticket_id', tRow.ticket_id);
      ticket.ticket_products = products || [];

      // Set slump matching web priority: verifi_json → order_products → ticket_products
      if (ticket.slump == null) {
        const vj = tRow.verifi_json;
        if (vj?.slumpFromTicket?.slump) {
          ticket.slump = vj.slumpFromTicket.slumpUnits
            ? `${vj.slumpFromTicket.slump} ${vj.slumpFromTicket.slumpUnits}`
            : String(vj.slumpFromTicket.slump);
        }
      }
      if (ticket.slump == null && tRow.order_id) {
        const { data: opRow } = await supabase
          .from('order_products')
          .select('slump')
          .eq('order_id', tRow.order_id)
          .not('slump', 'is', null)
          .limit(1)
          .maybeSingle();
        if (opRow?.slump) ticket.slump = opRow.slump;
      }
      if (ticket.slump == null && products?.length > 0) {
        const mixProd = products.find(p => p.is_mix) || products[0];
        if (mixProd?.slump != null) ticket.slump = String(mixProd.slump);
      }
    }
  } catch (err) {
    console.error('[QR] enrichTicketProducts failed:', err.message);
  }
  return ticket;
}

const TK_PREFIX = '[TK/E]';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const DEFAULT_QR_KEY_HEX = 'd43e6d3bece53add33e7faaa051c0c9234ae504bb3f33b59556d8103b7c5fc7b';
const DEFAULT_TICKET_SECRET = 'dev-only-ticket-qr-secret-change-me';
const DEFAULT_TRUCK_SECRET = 'dev-only-truck-qr-secret-change-me';

function getQrKey() {
  const hex = process.env.QR_ENCRYPTION_KEY || DEFAULT_QR_KEY_HEX;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error('QR_ENCRYPTION_KEY must be 64-character hex string (32 bytes)');
  }
  return buf;
}

function getTicketSecret() {
  return process.env.TICKET_QR_SECRET || DEFAULT_TICKET_SECRET;
}

function getTruckSecret() {
  return process.env.TRUCK_QR_SECRET || DEFAULT_TRUCK_SECRET;
}

function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signTicketCode(ticketCode) {
  const mac = crypto.createHmac('sha256', getTicketSecret()).update(ticketCode).digest();
  return base64UrlEncode(mac).slice(0, 24);
}

function signTruckCode(truckCode) {
  const mac = crypto.createHmac('sha256', getTruckSecret()).update(truckCode).digest();
  return base64UrlEncode(mac).slice(0, 24);
}

/**
 * Encrypt a plaintext string into a [TK/E] QR payload (AES-256-GCM).
 * Mirror of the web frontend's encryptQrPayload in qrCrypto.ts.
 */
function encryptQrPayload(plaintext) {
  const key = getQrKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, ciphertext]);
  return TK_PREFIX + combined.toString('base64');
}

/**
 * Decrypt a [TK/E] QR payload
 * @param {string} payload - Full QR string including [TK/E] prefix
 * @returns {object} Decrypted JSON data
 */
function decryptQrPayload(payload) {
  if (!payload || !payload.startsWith(TK_PREFIX)) {
    throw new Error('Invalid QR payload: missing [TK/E] prefix');
  }

  const b64 = payload.slice(TK_PREFIX.length).trim();
  if (!b64) {
    throw new Error('Empty QR payload after prefix');
  }

  const combined = Buffer.from(b64, 'base64');
  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('QR payload too short');
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const key = getQrKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString('utf8'));
}

/**
 * Parse a pipe-separated QR fallback string.
 *
 * Supported formats:
 *   - Ticket: orderCode|orderId|ticketCode|ticketId|truckCode|truckId  (6 parts)
 *   - Truck:  truck|truckCode|truckId                                   (3 parts, first = "truck")
 */
function parsePipePayload(payload) {
  const parts = payload.split('|');

  // Truck pipe format: truck|truckCode|truckId
  if (parts.length === 3 && parts[0].toLowerCase() === 'truck') {
    return {
      kind: 'truck',
      truckCode: parts[1],
      truckId: parts[2],
    };
  }

  // Ticket pipe format: orderCode|orderId|ticketCode|ticketId|truckCode|truckId
  if (parts.length === 6) {
    return {
      kind: 'ticket',
      orderCode: parts[0],
      orderId: parts[1],
      ticketCode: parts[2],
      ticketId: parts[3],
      truckCode: parts[4],
      truckId: parts[5],
    };
  }

  return null;
}

/**
 * Fetch tenant-level QR settings for the authenticated user.
 * Resolves user UUID → tenant_id via auth_tenant.tenant_users, then reads
 * qr_enabled, qr_mode, and security_mode from auth_tenant.tenants.
 *
 * @param {object} userAccess - req.user from auth middleware (has .id as UUID)
 * @returns {Promise<object|null>} { qr_enabled, qr_mode, security_mode } or null
 */
async function getTenantQrSettings(userAccess) {
  if (!userAccess?.id) return null;

  try {
    const supabase = getAuthSupabaseAdmin();

    // Step 1: Resolve UUID → integer user id in auth_tenant.users
    let numericUserId = null;
    if (typeof userAccess.id === 'number' || /^\d+$/.test(userAccess.id)) {
      numericUserId = Number(userAccess.id);
    } else {
      const { data: uData } = await supabase
        .schema('auth_tenant')
        .from('users')
        .select('id')
        .eq('uuid', userAccess.id)
        .is('deleted_at', null)
        .limit(1);

      if (!uData || uData.length === 0) return null;
      numericUserId = uData[0].id;
    }

    // Step 2: Get tenant_id from tenant_users
    const { data: tuData } = await supabase
      .schema('auth_tenant')
      .from('tenant_users')
      .select('tenant_id')
      .eq('user_id', numericUserId)
      .eq('status', 'active')
      .limit(1);

    if (!tuData || tuData.length === 0) return null;

    // Step 3: Get QR-related tenant columns
    const { data: tData, error: tError } = await supabase
      .schema('auth_tenant')
      .from('tenants')
      .select('qr_enabled, qr_mode, security_mode')
      .eq('id', tuData[0].tenant_id)
      .is('deleted_at', null)
      .limit(1);

    if (tError || !tData || tData.length === 0) return null;

    const t = tData[0];
    return {
      qr_enabled: t.qr_enabled ?? false,
      qr_mode: t.qr_mode || null,
      security_mode: t.security_mode || null,
    };
  } catch (err) {
    console.error('[QR] getTenantQrSettings failed:', err.message);
    return null;
  }
}

/**
 * Decrypt + verify a QR payload end-to-end.
 * Returns decrypted data + enriched API details in one call.
 *
 * @param {string} payload - Raw QR string (encrypted or pipe-format)
 * @param {object} userAccess - User access info from auth middleware (for row-level filtering)
 * @returns {object} { success, kind, qrData, details, security_mode }
 */
async function verifyQrPayload(payload, userAccess) {
  // Step 1: Decrypt or parse the QR data
  let qrData;

  if (payload.startsWith(TK_PREFIX)) {
    try {
      qrData = decryptQrPayload(payload);
    } catch (err) {
      return {
        success: false,
        error_code: 'DECRYPT_FAILED',
        message: `Decryption failed: ${err.message}`,
      };
    }
  } else if (payload.includes('|')) {
    qrData = parsePipePayload(payload);
    if (!qrData) {
      return {
        success: false,
        error_code: 'INVALID_FORMAT',
        message: 'Invalid QR format',
      };
    }
  } else {
    return {
      success: false,
      error_code: 'UNKNOWN_FORMAT',
      message: 'Unrecognized QR code format',
    };
  }

  // Step 2: Look up the actual data from the database
  // Fetch tenant security_mode once and attach to every success branch
  const tenantSettings = await getTenantQrSettings(userAccess);
  const security_mode = tenantSettings?.security_mode ?? null;

  try {
    if (qrData.kind === 'ticket') {
      const orderId = parseInt(qrData.orderId, 10);

      // Try by order ID first (if valid)
      if (!isNaN(orderId) && orderId > 0) {
        try {
          const orderData = await ticketService.getTicketsByOrderId(orderId, {});

          if (orderData) {
            const ticket = orderData.tickets.find(
              t => t.ticket_code === qrData.ticketCode
            );

            if (ticket) {
              await enrichTicketProducts(ticket, qrData.ticketCode);
              return {
                success: true,
                kind: 'ticket',
                qrData,
                security_mode,
                details: {
                  ticket,
                  order: orderData.order,
                  summary: orderData.summary,
                },
              };
            }
          }
        } catch (err) {
          console.error('[QR] by-order-id lookup failed:', err.message);
        }
      }

      // Try by order code — look up order_id from orders table
      if (qrData.orderCode) {
        try {
          const supabase = getSupabaseAdmin();
          const { data: orderRow } = await supabase
            .from('orders')
            .select('order_id')
            .eq('order_code', qrData.orderCode)
            .order('order_date', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (orderRow?.order_id) {
            console.log('[QR] Found order_id via order_code:', qrData.orderCode, '→', orderRow.order_id);
            const orderData = await ticketService.getTicketsByOrderId(orderRow.order_id, {});

            if (orderData) {
              const ticket = orderData.tickets.find(
                t => t.ticket_code === qrData.ticketCode
              );

              if (ticket) {
                await enrichTicketProducts(ticket, qrData.ticketCode);
                return {
                  success: true,
                  kind: 'ticket',
                  qrData,
                  security_mode,
                  details: {
                    ticket,
                    order: orderData.order,
                    summary: orderData.summary,
                  },
                };
              }
            }
          }
        } catch (err) {
          console.error('[QR] by-order-code lookup failed:', err.message);
        }
      }

      // Fallback: direct DB lookup by ticket_code (no date filter)
      if (qrData.ticketCode) {
        try {
          const supabase = getSupabaseAdmin();
          const { data: ticketRow, error: ticketErr } = await supabase
            .from('tickets')
            .select('*')
            .eq('ticket_code', qrData.ticketCode)
            .limit(1)
            .maybeSingle();

          if (!ticketErr && ticketRow) {
            console.log('[QR] ✅ Ticket found via direct DB lookup:', ticketRow.ticket_code);

            // Get ALL product info for this ticket
            const { data: allProductRows } = await supabase
              .from('ticket_products')
              .select('id, ticket_id, item_code, description, short_description, is_mix, is_assoc, load_qty, delv_qty, delv_qty_unit, order_qty, order_qty_unit, ticket_qty, ticket_qty_unit, acc_delv_qty, slump')
              .eq('ticket_id', ticketRow.ticket_id);
            const productRow = (allProductRows || []).find(p => p.is_mix) || (allProductRows || [])[0];
            const productName = productRow?.item_code || null;
            const loadQty = productRow
              ? `${productRow.load_qty || productRow.delv_qty || ''} ${productRow.delv_qty_unit || ''}`.trim() || null
              : null;

            // Get truck description and plant address
            let truckDesc = null;
            if (ticketRow.truck_code) {
              const { data: truckRow } = await supabase
                .from('trucks')
                .select('description')
                .eq('code', ticketRow.truck_code)
                .limit(1)
                .maybeSingle();
              truckDesc = truckRow?.description || null;
            }

            let plantAddress = null;
            if (ticketRow.plant_code) {
              const { data: plantRow } = await supabase
                .from('plants')
                .select('address1, address2, address3')
                .eq('code', ticketRow.plant_code)
                .limit(1)
                .maybeSingle();
              if (plantRow) {
                plantAddress = [plantRow.address1, plantRow.address2, plantRow.address3]
                  .filter(Boolean).join(', ') || null;
              }
            }

            // Fetch order-level fields (ordered_by, purchase_order, customer_job live on orders table)
            let orderRow = null;
            let orderSlump = null;
            if (ticketRow.order_id) {
              const { data: oRow } = await supabase
                .from('orders')
                .select('ordered_by_name, ordered_by_phone, purchase_order, customer_job')
                .eq('order_id', ticketRow.order_id)
                .limit(1)
                .maybeSingle();
              orderRow = oRow;

              // Get slump from order_products as fallback (ticket_products.slump may be null)
              const { data: opRow } = await supabase
                .from('order_products')
                .select('slump')
                .eq('order_id', ticketRow.order_id)
                .eq('is_mix', true)
                .limit(1)
                .maybeSingle();
              orderSlump = opRow?.slump || null;
            }

            // Build ticket details
            const derived = ticketService.deriveTicketStatus(ticketRow);
            const ticket = {
              load: null,
              ticket_code: ticketRow.ticket_code,
              truck: {
                truck_code: ticketRow.truck_code || null,
                truck_description: truckDesc,
                latitude: null,
                longitude: null,
              },
              plant_location: { latitude: null, longitude: null },
              order_location: { latitude: null, longitude: null },
              load_qty: loadQty,
              run_qty_ord_qty: null,
              running_qty: 0,
              ordered_qty: 0,
              status: derived.status,
              status_display: ticketService.getStatusLabel(derived.status, derived.remove_reason_code),
              remove_reason_code: ticketRow.remove_reason_code || null,
              product: productName,
              timestamps: {
                eta_at_job: null,
                ticketed: ticketRow.printed_time || null,
                loading: ticketRow.load_time || null,
                loaded: ticketRow.loaded_time || null,
                to_job: ticketRow.to_job_time || null,
                at_job: ticketRow.on_job_time || null,
                pouring: ticketRow.unload_time || null,
                washing: ticketRow.wash_time || null,
                to_plant: ticketRow.to_plant_time || null,
                at_plant: ticketRow.at_plant_time || null,
              },
              order_code: ticketRow.order_code || qrData.orderCode || null,
              order_date: ticketRow.order_date || null,
              customer_name: ticketRow.customer_name || null,
              project_name: ticketRow.project_name || null,
              delivery_address: [ticketRow.delivery_addr1, ticketRow.delivery_addr2, ticketRow.delivery_addr3]
                .filter(Boolean).join(', ') || null,
              driver_name: ticketRow.driver_name || null,
              plant_name: ticketRow.plant_name || null,
              ordered_by_name: orderRow?.ordered_by_name ?? null,
              ordered_by_phone: orderRow?.ordered_by_phone ?? null,
              purchase_order: orderRow?.purchase_order ?? null,
              customer_job: orderRow?.customer_job ?? null,
              slump: (() => {
                // Match web: verifi_json first, then order_products, then ticket_products
                const vj = ticketRow.verifi_json;
                if (vj?.slumpFromTicket?.slump) {
                  return vj.slumpFromTicket.slumpUnits
                    ? `${vj.slumpFromTicket.slump} ${vj.slumpFromTicket.slumpUnits}`
                    : String(vj.slumpFromTicket.slump);
                }
                if (orderSlump) return orderSlump;
                if (productRow?.slump != null) return String(productRow.slump);
                return null;
              })(),
              plant_address: plantAddress,
              ticket_products: allProductRows || [],
            };

            // Try to get order details for enrichment
            let order = null;
            let summary = null;
            const ticketOrderId = ticketRow.order_id;
            if (ticketOrderId) {
              try {
                const orderData = await ticketService.getTicketsByOrderId(ticketOrderId, {});
                if (orderData) {
                  order = orderData.order;
                  summary = orderData.summary;

                  // Find the formatted ticket from order data for richer details
                  const richTicket = orderData.tickets.find(
                    t => t.ticket_code === qrData.ticketCode
                  );
                  if (richTicket) {
                    richTicket.ticket_products = allProductRows || [];
                    richTicket.ordered_by_name = orderRow?.ordered_by_name || null;
                    richTicket.ordered_by_phone = orderRow?.ordered_by_phone || null;
                    richTicket.purchase_order = orderRow?.purchase_order || null;
                    richTicket.customer_job = orderRow?.customer_job || null;
                    if (!richTicket.slump && productRow?.slump != null) richTicket.slump = String(productRow.slump);
                    if (!richTicket.plant_address) richTicket.plant_address = plantAddress;
                    return {
                      success: true,
                      kind: 'ticket',
                      qrData,
                      security_mode,
                      details: { ticket: richTicket, order, summary },
                    };
                  }
                }
              } catch (enrichErr) {
                console.error('[QR] Order enrichment failed:', enrichErr.message);
              }
            }

            return {
              success: true,
              kind: 'ticket',
              qrData,
              security_mode,
              details: { ticket, order, summary },
            };
          }
        } catch (dbErr) {
          console.error('[QR] Direct DB lookup failed:', dbErr.message);
        }
      }

      return {
        success: false,
        error_code: 'NOT_FOUND',
        message: 'Ticket not found',
      };
    }

    if (qrData.kind === 'truck') {
      const trucks = await truckService.getTrucks({
        search: qrData.truckCode,
        pageSize: 5,
        page: 1,
      });

      const truck = trucks?.data?.find(t => t.code === qrData.truckCode);
      if (!truck) {
        return {
          success: false,
          error_code: 'NOT_FOUND',
          message: 'Truck not found',
        };
      }

      return {
        success: true,
        kind: 'truck',
        qrData,
        security_mode,
        details: { truck },
      };
    }

    return {
      success: false,
      error_code: 'UNKNOWN_KIND',
      message: `Unknown QR kind: ${qrData.kind}`,
    };
  } catch (err) {
    console.error('[QR] Verification error:', err);
    return {
      success: false,
      error_code: 'SERVER_ERROR',
      message: 'Failed to look up QR data',
    };
  }
}

/**
 * Fetch full tenant info for QR encryption (id, uuid, name, subdomain, status, qr_user_active).
 * Reuses the same user → tenant_users → tenants resolution as getTenantQrSettings.
 */
async function getTenantInfo(userAccess) {
  if (!userAccess?.id) return null;

  try {
    const supabase = getAuthSupabaseAdmin();

    let numericUserId = null;
    if (typeof userAccess.id === 'number' || /^\d+$/.test(userAccess.id)) {
      numericUserId = Number(userAccess.id);
    } else {
      const { data: uData } = await supabase
        .schema('auth_tenant')
        .from('users')
        .select('id')
        .eq('uuid', userAccess.id)
        .is('deleted_at', null)
        .limit(1);
      if (!uData || uData.length === 0) return null;
      numericUserId = uData[0].id;
    }

    const { data: tuData } = await supabase
      .schema('auth_tenant')
      .from('tenant_users')
      .select('tenant_id')
      .eq('user_id', numericUserId)
      .eq('status', 'active')
      .limit(1);
    if (!tuData || tuData.length === 0) return null;

    const { data: tData } = await supabase
      .schema('auth_tenant')
      .from('tenants')
      .select('id, uuid, name, subdomain, status, qr_user_active')
      .eq('id', tuData[0].tenant_id)
      .is('deleted_at', null)
      .limit(1);
    if (!tData || tData.length === 0) return null;

    const t = tData[0];
    return {
      tenantId: t.id,
      tenantUuid: t.uuid,
      tenantSubdomain: t.subdomain,
      tenantStatus: t.status,
      tenantName: t.name,
      qrUserActive: t.qr_user_active === true,
    };
  } catch (err) {
    console.error('[QR] getTenantInfo failed:', err.message);
    return null;
  }
}

/**
 * Build an encrypted ticket QR payload — mirrors web's buildEncryptedTicketPayload.
 */
function buildEncryptedTicketPayload(params, tenant) {
  const inner = JSON.stringify({
    kind: 'ticket',
    orderCode: params.orderCode || '',
    orderId: String(params.orderId || ''),
    ticketCode: params.ticketCode || '',
    ticketId: String(params.ticketId || ''),
    truckCode: params.truckCode || '',
    truckId: String(params.truckId || ''),
    tenantId: tenant?.tenantId != null ? String(tenant.tenantId) : '',
    tenantUuid: tenant?.tenantUuid || '',
    tenantSubdomain: tenant?.tenantSubdomain || '',
    tenantStatus: tenant?.tenantStatus || '',
    tenantName: tenant?.tenantName || '',
    qrUserActive: tenant?.qrUserActive === true,
    sig: signTicketCode(params.ticketCode || ''),
    iat: Date.now(),
  });
  return encryptQrPayload(inner);
}

/**
 * Build an encrypted truck QR payload — mirrors web's buildEncryptedTruckPayload.
 */
function buildEncryptedTruckPayload(truckCode, tenant) {
  const inner = JSON.stringify({
    kind: 'truck',
    truckCode: truckCode || '',
    tenantId: tenant?.tenantId != null ? String(tenant.tenantId) : '',
    tenantUuid: tenant?.tenantUuid || '',
    tenantSubdomain: tenant?.tenantSubdomain || '',
    tenantStatus: tenant?.tenantStatus || '',
    tenantName: tenant?.tenantName || '',
    qrUserActive: tenant?.qrUserActive === true,
    sig: signTruckCode(truckCode || ''),
    iat: Date.now(),
  });
  return encryptQrPayload(inner);
}

/**
 * Encrypt a QR payload for the mobile app.
 * Mirrors the web's POST /api/qr/encrypt Next.js route.
 *
 * @param {object} body - { kind, orderCode, orderId, ticketCode, ticketId, truckCode, truckId }
 * @param {object} userAccess - req.user from auth middleware
 * @returns {object} { ok, payload, tenant } or { ok: false, error }
 */
async function encryptPayload(body, userAccess) {
  const kind = body?.kind;
  const tenant = await getTenantInfo(userAccess);

  if (kind === 'ticket') {
    const payload = buildEncryptedTicketPayload({
      orderCode: body.orderCode || '',
      orderId: body.orderId || '',
      ticketCode: body.ticketCode || '',
      ticketId: body.ticketId || '',
      truckCode: body.truckCode || '',
      truckId: body.truckId || '',
    }, tenant);
    return { ok: true, payload, tenant };
  }

  if (kind === 'truck') {
    const payload = buildEncryptedTruckPayload(body.truckCode || '', tenant);
    return { ok: true, payload, tenant };
  }

  return { ok: false, error: "Invalid kind. Expected 'ticket' or 'truck'." };
}

module.exports = {
  decryptQrPayload,
  parsePipePayload,
  verifyQrPayload,
  getTenantQrSettings,
  encryptPayload,
};
