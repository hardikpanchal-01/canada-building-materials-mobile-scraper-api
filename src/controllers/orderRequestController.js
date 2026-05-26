const orderRequestService = require('../services/orderRequestService');
const { sendOrderStatusEmail, sendOrderCreatedEmail, sendOrderUpdatedEmail } = require('../services/orderRequestEmailService');
const { getSupabaseAdmin } = require('../config/database');
const { getTenantShowRegionForUser, resolveEffectiveUserId } = require('../middleware/auth');

/**
 * @swagger
 * /api/order-requests:
 *   get:
 *     summary: Get order requests
 *     description: Fetches order requests. Admin/producers see all, contractors see their own.
 *     tags: [Order Requests]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Order requests retrieved successfully
 */
async function getOrderRequests(req, res) {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?.sub;
    const userEmail = req.user?.email;
    const userType = req.user?.userType;
    const isAdmin = req.user?.isAdmin;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated', error_code: 'UNAUTHORIZED' });
    }

    // Resolve effective user ID (central auth UUID → public.users UUID)
    const effectiveUserId = await resolveEffectiveUserId(userId, userEmail);

    const page = req.query.page ? parseInt(req.query.page, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 15;
    const status = req.query.status || null;
    const search = req.query.search || null;

    // Pass both UUIDs so contractor filter matches records created with either UUID
    const userIds = [...new Set([userId, effectiveUserId].filter(Boolean))];

    const tz = req.user?.timezone || null;
    const tenantTz = req.user?.tenantTimezone || null;
    const data = await orderRequestService.getOrderRequests({
      userId,
      userIds,
      isAdmin,
      userType,
      page,
      limit,
      status,
      search,
      tz,
      tenantTz,
    });

    return res.status(200).json({
      success: true,
      message: 'Order requests retrieved successfully',
      data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch order requests',
      error_code: 'INTERNAL_ERROR'
    });
  }
}

async function getOrderRequestById(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: 'Order request ID is required', error_code: 'VALIDATION_ERROR' });
    }

    const tz = req.user?.timezone || null;
    const tenantTz = req.user?.tenantTimezone || null;
    const data = await orderRequestService.getOrderRequestById(id, tz, tenantTz);
    if (!data) {
      return res.status(404).json({ success: false, message: 'Order request not found', error_code: 'NOT_FOUND' });
    }

    return res.status(200).json({ success: true, message: 'Order request retrieved successfully', data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch order request', error_code: 'INTERNAL_ERROR' });
  }
}

async function createOrderRequest(req, res) {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?.sub;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User not authenticated', error_code: 'UNAUTHORIZED' });
    }

    const { company_id, on_job_date, on_job_time, job_address, job_city, job_contact_name, job_contact_phone } = req.body;
    if (!company_id || !on_job_date || !on_job_time || !job_address || !job_city || !job_contact_name || !job_contact_phone) {
      return res.status(400).json({ success: false, message: 'Missing required fields: company_id, on_job_date, on_job_time, job_address, job_city, job_contact_name, job_contact_phone', error_code: 'VALIDATION_ERROR' });
    }

    const tz = req.user?.timezone || null;
    const tenantTz = req.user?.tenantTimezone || null;
    const data = await orderRequestService.createOrderRequest({ ...req.body, user_id: userId }, tenantTz);

    // Send email notification to creator (non-blocking)
    (async () => {
      try {
        const supabase = getSupabaseAdmin();
        const order = await orderRequestService.getOrderRequestById(data.id);
        if (!order) return;

        const showRegion = await getTenantShowRegionForUser(userId);

        const { data: creator } = await supabase
          .from('users')
          .select('email, full_name')
          .eq('id', userId)
          .single();

        if (creator?.email) {
          await sendOrderCreatedEmail({
            recipientEmail: creator.email,
            recipientName: creator.full_name || 'User',
            order,
            showRegion,
            tz,
          });
        }
      } catch (emailErr) {
        console.error('[OrderRequest] Create email notification failed:', emailErr.message);
      }
    })();

    return res.status(201).json({ success: true, message: 'Order request created successfully', data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to create order request', error_code: 'INTERNAL_ERROR' });
  }
}

async function updateOrderRequest(req, res) {
  try {
    const { id } = req.params;
    const updaterUserId = req.user?.userId || req.user?.id || req.user?.sub;
    if (!id) {
      return res.status(400).json({ success: false, message: 'Order request ID is required', error_code: 'VALIDATION_ERROR' });
    }

    const tz = req.user?.timezone || null;
    const tenantTz = req.user?.tenantTimezone || null;
    const data = await orderRequestService.updateOrderRequest(id, req.body, tenantTz);

    // Send update email notification (non-blocking)
    (async () => {
      try {
        const supabase = getSupabaseAdmin();
        const order = await orderRequestService.getOrderRequestById(id);
        if (!order) return;

        const showRegion = await getTenantShowRegionForUser(updaterUserId);

        // Collect recipient IDs: updater + original creator (deduplicated)
        const recipientIds = [...new Set([updaterUserId, order.user_id].filter(Boolean))];
        const { data: users } = await supabase
          .from('users')
          .select('id, email, full_name')
          .in('id', recipientIds);

        if (!users || users.length === 0) return;

        const updater = users.find(u => u.id === updaterUserId);
        const recipientEmails = users.map(u => u.email).filter(Boolean);

        if (recipientEmails.length > 0) {
          await sendOrderUpdatedEmail({
            recipientEmails,
            updaterName: updater?.full_name || 'User',
            order,
            showRegion,
            tz,
          });
        }
      } catch (emailErr) {
        console.error('[OrderRequest] Update email notification failed:', emailErr.message);
      }
    })();

    return res.status(200).json({ success: true, message: 'Order request updated successfully', data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to update order request', error_code: 'INTERNAL_ERROR' });
  }
}

async function updateOrderRequestStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!id) {
      return res.status(400).json({ success: false, message: 'Order request ID is required', error_code: 'VALIDATION_ERROR' });
    }
    if (!status) {
      return res.status(400).json({ success: false, message: 'Status is required', error_code: 'VALIDATION_ERROR' });
    }

    const tz = req.user?.timezone || null;
    const data = await orderRequestService.updateOrderRequestStatus(id, status);

    // Send email notification for accept/reject (non-blocking)
    if (status === 'approved' || status === 'rejected') {
      (async () => {
        try {
          const supabase = getSupabaseAdmin();
          const order = await orderRequestService.getOrderRequestById(id);
          if (!order || !order.user_id) return;

          const { data: creator } = await supabase
            .from('users')
            .select('email, full_name')
            .eq('id', order.user_id)
            .single();

          if (creator?.email) {
            await sendOrderStatusEmail({
              recipientEmail: creator.email,
              recipientName: creator.full_name || 'User',
              order,
              newStatus: status,
              tz,
            });
          }
        } catch (emailErr) {
          console.error('[OrderRequest] Email notification failed:', emailErr.message);
        }
      })();
    }

    return res.status(200).json({ success: true, message: 'Status updated successfully', data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to update status', error_code: 'INTERNAL_ERROR' });
  }
}

async function updateOrderVerification(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: 'Order request ID is required', error_code: 'VALIDATION_ERROR' });
    }

    const tenantTz = req.user?.tenantTimezone || null;
    const data = await orderRequestService.updateOrderVerification(id, req.body, tenantTz);

    return res.status(200).json({ success: true, message: 'Verification updated successfully', data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to update verification', error_code: 'INTERNAL_ERROR' });
  }
}

async function getMessages(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: 'Order request ID is required', error_code: 'VALIDATION_ERROR' });
    }

    const tz = req.user?.timezone || null;
    const messages = await orderRequestService.getMessages(id, tz);

    return res.status(200).json({ success: true, message: 'Messages retrieved successfully', data: { messages } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch messages', error_code: 'INTERNAL_ERROR' });
  }
}

async function sendMessage(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user?.userId || req.user?.id || req.user?.sub;
    const { message_text, sender_role } = req.body;

    if (!id || !userId || !message_text?.trim()) {
      return res.status(400).json({ success: false, message: 'Missing required fields', error_code: 'VALIDATION_ERROR' });
    }

    const tz = req.user?.timezone || null;
    const data = await orderRequestService.sendMessage(id, userId, message_text, sender_role || 'contractor', tz);

    return res.status(201).json({ success: true, message: 'Message sent successfully', data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to send message', error_code: 'INTERNAL_ERROR' });
  }
}

async function getFormData(req, res) {
  try {
    const data = await orderRequestService.getFormData();
    const userId = req.user?.userId || req.user?.id || req.user?.sub;
    const showRegion = await getTenantShowRegionForUser(userId);
    if (!showRegion) {
      data.regions = [];
    }
    return res.status(200).json({ success: true, message: 'Form data retrieved successfully', data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch form data', error_code: 'INTERNAL_ERROR' });
  }
}

async function getOrdersByProjectCode(req, res) {
  try {
    const { projectCode } = req.query;
    if (!projectCode) {
      return res.status(400).json({ success: false, message: 'projectCode is required', error_code: 'VALIDATION_ERROR' });
    }
    const orders = await orderRequestService.getOrdersByProjectCode(projectCode);
    return res.status(200).json({ success: true, data: { orders } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch orders by project code', error_code: 'INTERNAL_ERROR' });
  }
}

async function searchOrders(req, res) {
  try {
    const { q } = req.query;
    const orders = await orderRequestService.searchOrders(q);
    return res.status(200).json({ success: true, data: { orders } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to search orders', error_code: 'INTERNAL_ERROR' });
  }
}

async function searchProducts(req, res) {
  try {
    const { q, offset, limit } = req.query;
    const result = await orderRequestService.searchProducts(q || '', parseInt(offset) || 0, parseInt(limit) || 50);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to search products', error_code: 'INTERNAL_ERROR' });
  }
}

async function getRecentOrderEntities(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required', error_code: 'VALIDATION_ERROR' });
    }
    const orders = await orderRequestService.getRecentOrderEntities(userId);
    return res.status(200).json({ success: true, data: { orders } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to fetch recent order entities', error_code: 'INTERNAL_ERROR' });
  }
}

module.exports = {
  getOrderRequests,
  getOrderRequestById,
  createOrderRequest,
  updateOrderRequest,
  updateOrderRequestStatus,
  updateOrderVerification,
  getMessages,
  sendMessage,
  getFormData,
  getOrdersByProjectCode,
  searchOrders,
  searchProducts,
  getRecentOrderEntities,
};
