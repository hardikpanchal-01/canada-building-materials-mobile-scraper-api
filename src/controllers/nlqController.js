const crypto = require('crypto');
const nlqService = require('../services/nlqService');

/**
 * @swagger
 * /api/ai/chat:
 *   post:
 *     summary: Ask a question in plain English and get an answer from the database
 *     description: |
 *       Converts a natural language question into a SQL query using AI, executes it against the database,
 *       and returns a human-readable answer.
 *
 *       **Read-only**: Only SELECT queries are allowed. Any attempt to modify, delete, insert, update,
 *       drop, alter, or truncate data will be blocked.
 *
 *       **Conversational**: Pass a `session_id` to maintain multi-turn context (e.g., "now filter that by plant OKC").
 *       If omitted, a new session is created automatically.
 *
 *       **Blocked words in prompt**: delete, drop, truncate, alter, insert, update, create, grant, revoke,
 *       modify, remove, rename, replace, merge, upsert, execute, exec, destroy, purge, wipe, overwrite,
 *       rollback, commit, vacuum.
 *     tags: [NLQ]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [prompt]
 *             properties:
 *               prompt:
 *                 type: string
 *                 description: The natural language question to ask (max 2000 characters)
 *                 example: "How many orders were delivered today?"
 *               session_id:
 *                 type: string
 *                 format: uuid
 *                 description: Optional session ID for multi-turn conversation. If omitted, a new session is created.
 *                 example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 *     responses:
 *       200:
 *         description: Query processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Query processed successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     answer:
 *                       type: string
 *                       description: Human-readable answer to the user's question
 *                       example: "There were 42 orders delivered today, totaling 1,234 cubic yards."
 *                     sql:
 *                       type: string
 *                       description: The generated SQL query that was executed
 *                       example: "SELECT COUNT(*) AS total FROM orders WHERE order_date::date = CURRENT_DATE"
 *                     row_count:
 *                       type: integer
 *                       description: Number of rows returned by the query
 *                       example: 1
 *                     session_id:
 *                       type: string
 *                       format: uuid
 *                       description: Session ID for continuing the conversation
 *                       example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 *                     usage:
 *                       type: object
 *                       nullable: true
 *                       description: AI token usage stats
 *                       properties:
 *                         input_tokens:
 *                           type: integer
 *                           example: 1500
 *                         output_tokens:
 *                           type: integer
 *                           example: 120
 *       400:
 *         description: Bad request - Missing or invalid prompt
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "prompt is required and must be a non-empty string"
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       403:
 *         description: Forbidden - Write operation blocked
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "This assistant only supports read/query operations. The word \"delete\" indicates a write operation which is not allowed."
 *                 error_code:
 *                   type: string
 *                   example: "WRITE_OPERATION_BLOCKED"
 *                 data:
 *                   type: object
 *                   properties:
 *                     session_id:
 *                       type: string
 *       429:
 *         description: Rate limit exceeded on AI service
 *       502:
 *         description: AI service error
 */
async function generateSQL(req, res) {
  try {
    const { prompt, session_id } = req.body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'prompt is required and must be a non-empty string'
      });
    }

    if (prompt.trim().length > 2000) {
      return res.status(400).json({
        success: false,
        message: 'prompt must be 2000 characters or fewer'
      });
    }

    // Use provided session_id or generate a new one
    const resolvedSessionId = session_id || crypto.randomUUID();

    const result = await nlqService.processQuery(prompt, resolvedSessionId);

    // If the query was blocked due to write-intent, return 403
    if (result.blocked) {
      return res.status(403).json({
        success: false,
        message: result.answer,
        error_code: 'WRITE_OPERATION_BLOCKED',
        data: {
          session_id: result.session_id
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Query processed successfully',
      data: {
        answer: result.answer,
        sql: result.sql,
        row_count: result.row_count,
        session_id: result.session_id,
        usage: result.usage || null
      }
    });
  } catch (error) {
    console.error('Error processing NLQ:', error);

    const statusMap = {
      VALIDATION_ERROR: 400,
      CONFIG_ERROR: 500,
      AUTH_ERROR: 401,
      RATE_LIMIT: 429,
      API_ERROR: 502
    };

    const status = statusMap[error.code] || 500;

    return res.status(status).json({
      success: false,
      message: error.message || 'Failed to process query',
      error_code: error.code || 'INTERNAL_ERROR'
    });
  }
}

/**
 * @swagger
 * /api/ai/history/{sessionId}:
 *   get:
 *     summary: Get conversation history for a session
 *     description: Returns all messages (user prompts and AI answers) for the given session ID.
 *     tags: [NLQ]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The session ID to retrieve history for
 *         example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 *     responses:
 *       200:
 *         description: Conversation history retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Conversation history retrieved"
 *                 data:
 *                   type: object
 *                   properties:
 *                     session_id:
 *                       type: string
 *                       format: uuid
 *                     messages:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           index:
 *                             type: integer
 *                             example: 0
 *                           role:
 *                             type: string
 *                             enum: [user, assistant]
 *                             example: "user"
 *                           content:
 *                             type: string
 *                             example: "How many orders today?"
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
async function getHistory(req, res) {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'sessionId is required'
      });
    }

    const history = nlqService.getConversationHistory(sessionId);

    return res.status(200).json({
      success: true,
      message: 'Conversation history retrieved',
      data: {
        session_id: sessionId,
        messages: history
      }
    });
  } catch (error) {
    console.error('Error getting conversation history:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve conversation history'
    });
  }
}

/**
 * @swagger
 * /api/ai/history/{sessionId}:
 *   delete:
 *     summary: Clear conversation history for a session
 *     description: Deletes all messages for the given session ID. Use this to start a fresh conversation.
 *     tags: [NLQ]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The session ID to clear
 *         example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 *     responses:
 *       200:
 *         description: Conversation cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Conversation cleared"
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
async function clearHistory(req, res) {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'sessionId is required'
      });
    }

    const deleted = nlqService.clearConversation(sessionId);

    return res.status(200).json({
      success: true,
      message: deleted ? 'Conversation cleared' : 'No conversation found for this session'
    });
  } catch (error) {
    console.error('Error clearing conversation:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to clear conversation'
    });
  }
}

module.exports = {
  generateSQL,
  getHistory,
  clearHistory
};
