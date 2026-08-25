/**
 * Chat data endpoints — rooms, messages, send.
 * Queries PostgreSQL directly.
 */
const { executeDirectSQL } = require('../utils/postgresExecutor');
const { uploadChatFile } = require('../services/database/s3Storage');

async function getRooms(req, res) {
  try {
    const result = await executeDirectSQL(
      `SELECT * FROM order_chats WHERE is_active = true ORDER BY last_message_at DESC NULLS LAST`
    );
    return res.json({ success: true, data: result.data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function getOrCreateRoom(req, res) {
  try {
    const { order_id } = req.params;
    if (!order_id) return res.status(400).json({ success: false, message: 'order_id is required' });

    // Try RPC first
    let result = await executeDirectSQL(
      `SELECT ensure_chat_exists($1) as chat_id`, [order_id]
    ).catch(() => null);

    if (result?.data?.[0]?.chat_id) {
      return res.json({ success: true, data: { id: result.data[0].chat_id, order_id, is_active: true } });
    }

    // Fallback: find or create
    const existing = await executeDirectSQL(
      `SELECT * FROM order_chats WHERE order_id = $1 LIMIT 1`, [order_id]
    );
    if (existing.data?.length > 0) {
      return res.json({ success: true, data: existing.data[0] });
    }

    const created = await executeDirectSQL(
      `INSERT INTO order_chats (order_id, is_active) VALUES ($1, true) RETURNING *`, [order_id]
    );
    return res.json({ success: true, data: created.data[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function getMessages(req, res) {
  try {
    const { order_id } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before;

    let query = `SELECT * FROM chat_messages WHERE order_id = $1 AND (is_deleted = false OR is_deleted IS NULL)`;
    const params = [order_id];

    if (before) {
      query += ` AND created_at < $${params.length + 1}`;
      params.push(before);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await executeDirectSQL(query, params);
    return res.json({ success: true, data: result.data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function sendMessage(req, res) {
  try {
    let { order_id, chat_id, sender_id, sender_name, sender_role, message_text, content, attachments, timeline_visible } = req.body;
    // Accept both 'content' (mobile) and 'message_text' (web)
    if (!message_text && content) message_text = content;

    if (!order_id || !sender_id) {
      return res.status(400).json({ success: false, message: 'order_id and sender_id are required' });
    }

    // Auto-resolve chat_id if not provided
    if (!chat_id) {
      // Try RPC first
      const rpcResult = await executeDirectSQL(
        `SELECT ensure_chat_exists($1) as chat_id`, [order_id]
      ).catch(() => null);

      if (rpcResult?.data?.[0]?.chat_id) {
        chat_id = rpcResult.data[0].chat_id;
      } else {
        // Fallback: find or create
        const existing = await executeDirectSQL(
          `SELECT id FROM order_chats WHERE order_id = $1 LIMIT 1`, [order_id]
        );
        if (existing.data?.length > 0) {
          chat_id = existing.data[0].id;
        } else {
          const created = await executeDirectSQL(
            `INSERT INTO order_chats (order_id, is_active, created_at, updated_at) VALUES ($1, true, NOW(), NOW()) RETURNING id`, [order_id]
          );
          chat_id = created.data[0].id;
        }
      }
    }

    const result = await executeDirectSQL(
      `INSERT INTO chat_messages (order_id, chat_id, sender_id, sender_name, sender_role, message_text, attachments, timeline_visible, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, false, NOW(), NOW())
       RETURNING *`,
      [order_id, chat_id, sender_id, sender_name || 'User', sender_role || 'user', message_text, JSON.stringify(attachments || []), timeline_visible ?? false]
    );

    // Update order_chats last_message_at
    await executeDirectSQL(
      `UPDATE order_chats SET last_message_at = NOW(), updated_at = NOW() WHERE order_id = $1`, [order_id]
    ).catch(() => {});

    return res.json({ success: true, data: result.data[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function getUserName(req, res) {
  try {
    const { user_id } = req.params;
    const result = await executeDirectSQL(
      `SELECT full_name FROM users WHERE id = $1 LIMIT 1`, [user_id]
    );
    return res.json({ success: true, data: result.data?.[0] || null });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function deleteMessage(req, res) {
  try {
    const message_id = req.params.id || req.body.message_id;
    if (!message_id) {
      return res.status(400).json({ success: false, message: 'message_id is required' });
    }
    const result = await executeDirectSQL(
      `UPDATE chat_messages SET is_deleted = true, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [parseInt(message_id, 10)]
    );
    if (!result.data || result.data.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }
    return res.json({ success: true, message: 'Message deleted' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function uploadFile(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided' });
    }
    const orderId = req.body.order_id || 'unknown';
    const { path: filePath, publicUrl } = await uploadChatFile(
      orderId,
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );
    return res.json({ success: true, data: { url: publicUrl, path: filePath } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = { getRooms, getOrCreateRoom, getMessages, sendMessage, getUserName, deleteMessage, uploadFile };
