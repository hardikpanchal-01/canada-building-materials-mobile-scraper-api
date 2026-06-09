/**
 * AI Assistant routes (web-parity dashboard chat + thread history).
 *
 * The AI engine is authored as ESM (it uses the ESM-only Vercel AI SDK), so
 * this CommonJS router loads it lazily via dynamic import(). Mounted under
 * /api/ai alongside the existing nlqRoutes.
 */

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { executeDirectSQL } = require('../utils/postgresExecutor');

// All AI per-user data (ai_settings, ai_chat_threads, ai_dashboards, …) is keyed
// by a user_id that FOREIGN KEYs to auth.users(id). The mobile JWT's `id` claim
// is the app's user uuid, which for most users equals their auth.users id — but
// for users MIGRATED from the old auth system it's a legacy uuid that is NOT in
// auth.users (the middleware already resolves access "by email if migrated").
// Writing per-user rows with that legacy id violates the FK
// (ai_settings_user_id_fkey). This resolver maps req.user.id to the canonical
// auth.users id (by id, then by email) so reads/writes target the right row.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveAuthUserId(rawId, email) {
  try {
    if (rawId && UUID_RE.test(rawId)) {
      const byId = await executeDirectSQL('SELECT id FROM auth.users WHERE id = $1 LIMIT 1', [rawId]);
      if (byId.success && byId.data.length) return byId.data[0].id;
    }
    if (email) {
      const byEmail = await executeDirectSQL(
        'SELECT id FROM auth.users WHERE lower(email) = lower($1) ORDER BY created_at NULLS LAST LIMIT 1',
        [email],
      );
      if (byEmail.success && byEmail.data.length) return byEmail.data[0].id;
    }
  } catch (err) {
    console.error('[ai/resolveAuthUserId]', err.message);
  }
  return rawId; // fall back; the FK will surface a clear error if still invalid
}

// Middleware: normalize req.user.id to the canonical auth.users id (once).
async function resolveAiUser(req, res, next) {
  try {
    if (req.user && !req.user._aiIdResolved) {
      req.user.id = await resolveAuthUserId(req.user.id, req.user.email);
      req.user._aiIdResolved = true;
    }
  } catch (err) {
    console.error('[ai/resolveAiUser]', err.message);
  }
  next();
}

// Cache the dynamically-imported ESM modules after first load.
let _chatMod = null;
let _threadsMod = null;
let _verifyMod = null;
async function chatMod() {
  if (!_chatMod) _chatMod = await import('../ai/dashboard-chat.mjs');
  return _chatMod;
}
async function threadsMod() {
  if (!_threadsMod) _threadsMod = await import('../ai/threads.mjs');
  return _threadsMod;
}
async function verifyMod() {
  if (!_verifyMod) _verifyMod = await import('../ai/verify-widget.mjs');
  return _verifyMod;
}
let _dashMod = null;
async function dashMod() {
  if (!_dashMod) _dashMod = await import('../ai/dashboards.mjs');
  return _dashMod;
}
let _configMod = null;
async function configMod() {
  if (!_configMod) _configMod = await import('../ai/config-admin.mjs');
  return _configMod;
}
const _mods = {};
const lazy = (key, path) => async () => {
  if (!_mods[key]) _mods[key] = await import(path);
  return _mods[key];
};
const feedbackMod = lazy('feedback', '../ai/feedback.mjs');
const suggestionsMod = lazy('suggestions', '../ai/suggestions.mjs');
const rawRowsMod = lazy('rawRows', '../ai/raw-rows.mjs');
const explainMod = lazy('explain', '../ai/explain-cell.mjs');
const emptyHintMod = lazy('emptyHint', '../ai/empty-hint.mjs');
const shareMod = lazy('share', '../ai/dashboard-share.mjs');
const commentsMod = lazy('comments', '../ai/comments.mjs');

// POST /api/ai/dashboard-chat — streams the assistant turn as SSE.
router.post('/dashboard-chat', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { messages, threadId, modelId } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }
    const { handleDashboardChat } = await chatMod();
    await handleDashboardChat(
      {
        messages,
        threadId: threadId ?? null,
        modelId,
        userId: req.user?.id ?? null,
        userType: req.user?.userType ?? null,
        allowedCustomerIds: req.user?.allowedCustomerIds ?? [],
      },
      res,
    );
  } catch (err) {
    console.error('[ai/dashboard-chat]', err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message || 'AI request failed' });
    } else {
      try { res.end(); } catch (_) { /* ignore */ }
    }
  }
});

// POST /api/ai/verify-widget — re-aggregate + ground-truth count + anomaly check.
router.post('/verify-widget', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { verifyWidget } = await verifyMod();
    const result = await verifyWidget(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'verify failed' });
  }
});

// Provider keys are PER-USER, so any authenticated user may update their OWN
// keys. The org-wide settings (model enablement, default model, token bank,
// top-ups) remain admin-only — for non-admins we drop everything but
// `providerKeys`.
function scopeConfigBody(req) {
  const body = req.body || {};
  if (req.user.isAdmin) return body;
  return body.providerKeys ? { providerKeys: body.providerKeys } : {};
}

// GET /api/ai/suggestions — role-aware starter questions (producer vs contractor).
router.get('/suggestions', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { getSuggestions } = await suggestionsMod();
    res.json(getSuggestions(req.user?.userType));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- AI configuration ----
router.get('/config', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { getConfigPayload } = await configMod();
    res.json(await getConfigPayload(req.user.id, !!req.user.isAdmin));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/config', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { updateConfig } = await configMod();
    res.json(await updateConfig(req.user.id, scopeConfigBody(req)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/config/usage', authenticate, resolveAiUser, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const { getUsage } = await configMod();
    res.json(await getUsage(req.query.from, req.query.to));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Feedback / raw-rows / explain / empty-hint ----
router.post('/feedback', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { recordFeedback } = await feedbackMod();
    res.json(await recordFeedback(req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/raw-rows', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { getRawRows } = await rawRowsMod();
    res.json(await getRawRows(req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/explain-cell', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { explainCell } = await explainMod();
    res.json(await explainCell(req.body || {}, req.user.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/empty-hint', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { emptyHint } = await emptyHintMod();
    res.json(await emptyHint(req.body || {}, req.user.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- Settings (alias of /config for web parity) ----
router.get('/settings', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { getConfigPayload } = await configMod();
    res.json(await getConfigPayload(req.user.id, !!req.user.isAdmin));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.put('/settings', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { updateConfig } = await configMod();
    res.json(await updateConfig(req.user.id, scopeConfigBody(req)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- Public (no auth) dashboard view ----
router.get('/dashboards/public/:token', async (req, res) => {
  try {
    const { getPublicDashboard } = await shareMod();
    res.json(await getPublicDashboard(req.params.token));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- Saved & shared dashboards ----
router.get('/dashboards', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { listDashboards } = await dashMod();
    res.json(await listDashboards(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/dashboards', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { saveDashboard } = await dashMod();
    res.status(201).json({ dashboard: await saveDashboard(req.user.id, req.body || {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dashboards/:id', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { getDashboard } = await dashMod();
    const dashboard = await getDashboard(req.user.id, req.params.id);
    if (!dashboard) return res.status(404).json({ error: 'Not found' });
    res.json({ dashboard });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/dashboards/:id', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { updateDashboard } = await dashMod();
    res.json({ dashboard: await updateDashboard(req.user.id, req.params.id, req.body || {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/dashboards/:id', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { deleteDashboard } = await dashMod();
    await deleteDashboard(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Dashboard sharing ----
router.get('/dashboards/:id/share', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { getShareInfo } = await shareMod();
    res.json(await getShareInfo(req.user.id, req.params.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
router.post('/dashboards/:id/share', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { applyShare } = await shareMod();
    res.json(await applyShare(req.user.id, req.params.id, req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
router.delete('/dashboards/:id/share', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { revokeUserShare } = await shareMod();
    res.json(await revokeUserShare(req.user.id, req.params.id, (req.body || {}).sharedWithUserId));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- Widget comments ----
router.get('/dashboards/:id/comments', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { listComments } = await commentsMod();
    res.json(await listComments(req.user.id, req.params.id, req.query.widgetId));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
router.post('/dashboards/:id/comments', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { addComment } = await commentsMod();
    res.status(201).json(await addComment(req.user.id, req.params.id, req.body || {}));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
router.patch('/dashboards/:id/comments/:commentId', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { editComment } = await commentsMod();
    res.json(await editComment(req.user.id, req.params.commentId, (req.body || {}).body));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
router.delete('/dashboards/:id/comments/:commentId', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { deleteComment } = await commentsMod();
    res.json(await deleteComment(req.user.id, req.params.commentId));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/ai/threads — list the user's conversations.
router.get('/threads', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { listThreads } = await threadsMod();
    res.json({ threads: await listThreads(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/threads — create an empty conversation.
router.post('/threads', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { createThread } = await threadsMod();
    res.status(201).json({ thread: await createThread(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/threads/:id — load a conversation + messages.
router.get('/threads/:id', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { getThread } = await threadsMod();
    const thread = await getThread(req.user.id, req.params.id);
    if (!thread) return res.status(404).json({ error: 'Not found' });
    res.json({ thread });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/ai/threads/:id — persist messages / title.
router.patch('/threads/:id', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { saveThread } = await threadsMod();
    const { messages, title } = req.body || {};
    const thread = await saveThread(req.user.id, req.params.id, { messages, title });
    res.json({ thread });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ai/threads/:id
router.delete('/threads/:id', authenticate, resolveAiUser, async (req, res) => {
  try {
    const { deleteThread } = await threadsMod();
    await deleteThread(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
