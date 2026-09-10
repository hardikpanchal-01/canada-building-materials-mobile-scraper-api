/**
 * PostgreSQL LISTEN/NOTIFY → Socket.io Realtime Service
 *
 * Listens on the SAME `realtime_changes` channel that the web frontend uses.
 * The web's triggers (trg_realtime_*) are already installed on all tables and
 * send full row payloads via notify_realtime_change(). This service broadcasts
 * those events to connected mobile clients via Socket.io.
 */

const { Client } = require('pg');
const { Server } = require('socket.io');

let io = null;
let pgListener = null;

/**
 * Initialize Socket.io on the existing HTTP server
 */
function initSocketIO(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    console.log(`[Realtime] Client connected: ${socket.id}`);

    socket.on('join:orders', () => socket.join('orders'));

    socket.on('join:tickets', (orderCode) => {
      if (orderCode) socket.join(`tickets:${orderCode}`);
    });

    socket.on('join:chat', (orderId) => {
      if (orderId) socket.join(`chat:${orderId}`);
    });

    socket.on('join:notifications', (userId) => {
      if (userId) socket.join(`notifications:${userId}`);
    });

    socket.on('leave:tickets', (orderCode) => {
      if (orderCode) socket.leave(`tickets:${orderCode}`);
    });

    socket.on('leave:chat', (orderId) => {
      if (orderId) socket.leave(`chat:${orderId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[Realtime] Client disconnected: ${socket.id}`);
    });
  });

  console.log('[Realtime] Socket.io initialized');
  return io;
}

/**
 * Start PostgreSQL LISTEN on the web's `realtime_changes` channel.
 * Reuses the same triggers the web frontend already installed.
 *
 * Uses REALTIME_DATABASE_URL (direct connection) if available, falling back
 * to DATABASE_URL. When DATABASE_URL points at a PgBouncer transaction-mode
 * pooler, LISTEN/NOTIFY is broken — the dedicated REALTIME_DATABASE_URL
 * must point at the direct PostgreSQL host (pm-postgres-rw).
 */
async function startPgListener() {
  const connectionString = process.env.REALTIME_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('[Realtime] DATABASE_URL not set — skipping PG listener');
    return;
  }

  pgListener = new Client({ connectionString, ssl: false });

  pgListener.on('error', (err) => {
    console.error('[Realtime] PG listener error:', err.message);
    pgListener = null;
    setTimeout(() => startPgListener(), 5000);
  });

  try {
    await pgListener.connect();

    // Listen on the SAME channel the web uses
    await pgListener.query('LISTEN realtime_changes');
    console.log('[Realtime] Listening on: realtime_changes (shared with web)');

    pgListener.on('notification', (msg) => {
      if (!io) return;

      let data;
      try {
        data = JSON.parse(msg.payload);
      } catch {
        return;
      }

      const table = data.table;
      const event = data.type || 'UPDATE';
      const row = data.new || data.old || {};

      switch (table) {
        case 'orders':
          io.to('orders').emit('orders:changed', {
            event,
            table,
            new: data.new,
            old: data.old,
          });
          break;

        case 'tickets':
        case 'ticket_products':
          io.to('orders').emit('tickets:changed', {
            event,
            table,
            new: data.new,
            old: data.old,
          });
          // Also emit to specific order room
          if (row.order_code) {
            io.to(`tickets:${row.order_code}`).emit('tickets:changed', {
              event,
              table,
              new: data.new,
              old: data.old,
            });
          }
          break;

        case 'chat_messages': {
          const orderId = row.order_id;
          if (orderId) {
            io.to(`chat:${orderId}`).emit('chat:message', {
              event,
              table,
              new: data.new,
              old: data.old,
            });
          }
          // Also broadcast to orders room for unread count updates
          io.to('orders').emit('chat:message', {
            event,
            table,
            new: data.new,
          });
          break;
        }

        case 'message_reactions':
          // Broadcast reaction changes to the chat room
          if (row.order_id) {
            io.to(`chat:${row.order_id}`).emit('chat:reaction', {
              event,
              table,
              new: data.new,
              old: data.old,
            });
          }
          break;

        case 'order_change_logs':
          if (row.order_id) {
            io.to('orders').emit('order:changelog', {
              event,
              new: data.new,
            });
          }
          break;

        case 'order_products':
        case 'order_product_schedules':
        case 'order_product_schedule_loads':
        case 'order_notes':
          io.to('orders').emit('orders:changed', {
            event,
            table,
            new: data.new,
            old: data.old,
          });
          break;

        case 'daily_intelligence':
          io.to('orders').emit('daily-intelligence:changed', {
            event,
            new: data.new,
          });
          break;
      }
    });
  } catch (err) {
    console.error('[Realtime] PG listener failed:', err.message);
    pgListener = null;
    setTimeout(() => startPgListener(), 5000);
  }
}

/**
 * Initialize the realtime system.
 * No trigger setup needed — uses the web's existing triggers.
 */
async function initRealtime(httpServer) {
  initSocketIO(httpServer);
  await startPgListener();
}

function getIO() {
  return io;
}

function emitNotification(userId, notification) {
  if (io && userId) {
    io.to(`notifications:${userId}`).emit('notification:new', notification);
  }
}

module.exports = { initRealtime, getIO, emitNotification };
