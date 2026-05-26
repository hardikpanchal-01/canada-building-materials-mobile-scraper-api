const Anthropic = require('@anthropic-ai/sdk').default;
const { DB_SCHEMA } = require('../config/dbSchema');
const { executeDirectSQL } = require('../utils/postgresExecutor');

// In-memory conversation store (session_id -> messages[])
const conversations = new Map();

// Max conversation history to send to Claude (to stay within token limits)
const MAX_HISTORY_MESSAGES = 20;

// Session TTL: 1 hour
const SESSION_TTL_MS = 60 * 60 * 1000;

// Max rows returned from query execution
const MAX_RESULT_ROWS = 200;

// Max query execution timeout (15 seconds)
const QUERY_TIMEOUT_MS = 15000;

// Cleanup stale sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of conversations) {
    if (now - session.lastAccess > SESSION_TTL_MS) {
      conversations.delete(sessionId);
    }
  }
}, 10 * 60 * 1000);

// =============================================
// BLOCKED SQL KEYWORDS & PATTERNS
// =============================================

// Dangerous SQL operations that must NEVER be executed
const BLOCKED_SQL_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
  'CREATE', 'REPLACE', 'GRANT', 'REVOKE', 'EXECUTE', 'EXEC',
  'MERGE', 'UPSERT', 'CALL', 'DO',
  'COPY', 'LOAD', 'IMPORT',
  'SET ', 'RESET',
  'VACUUM', 'REINDEX', 'CLUSTER', 'REFRESH',
  'COMMENT ON', 'SECURITY', 'OWNER TO',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
  'LOCK', 'UNLOCK',
  'NOTIFY', 'LISTEN',
  'PREPARE', 'DEALLOCATE',
  'REASSIGN', 'DISCARD',
];

// Single blocked words in user prompts — any one of these triggers a block
const BLOCKED_PROMPT_WORDS = [
  'delete', 'drop', 'truncate', 'alter', 'insert',
  'update', 'create', 'grant', 'revoke', 'modify',
  'remove', 'rename', 'replace', 'merge', 'upsert',
  'execute', 'exec', 'destroy', 'purge', 'wipe',
  'overwrite', 'rollback', 'commit', 'vacuum',
];

// =============================================
// SQL VALIDATION (Server-Side Hard Block)
// =============================================

/**
 * Validate that generated SQL is a read-only SELECT query.
 * This is the critical security gate — never trust the LLM output alone.
 */
function validateSQL(sql) {
  if (!sql || typeof sql !== 'string') {
    return { valid: false, reason: 'Empty or invalid SQL output' };
  }

  const trimmed = sql.trim();

  // Allow Claude's "I can't do that" comments
  if (trimmed.startsWith('--')) {
    return { valid: true, isComment: true };
  }

  // Strip SQL comments before validation
  const stripped = trimmed
    .replace(/--.*$/gm, '')       // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .trim();

  if (!stripped) {
    return { valid: false, reason: 'SQL contains only comments' };
  }

  // Normalize whitespace for keyword detection
  const normalized = stripped.replace(/\s+/g, ' ').toUpperCase();

  // MUST start with SELECT or WITH (CTE)
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    return { valid: false, reason: 'Query must start with SELECT or WITH (CTE). Only read operations are allowed.' };
  }

  // Check every blocked keyword against the normalized SQL
  for (const keyword of BLOCKED_SQL_KEYWORDS) {
    // Use word boundary matching to avoid false positives
    // e.g., "update_time" should not be blocked, but "UPDATE orders" should
    const pattern = keyword.endsWith(' ')
      ? keyword.toUpperCase() // already has trailing space (like "SET ")
      : `\\b${keyword.toUpperCase()}\\b`;

    const regex = new RegExp(pattern);

    // Match against the SQL outside of quoted strings
    const unquoted = stripQuotedStrings(normalized);
    if (regex.test(unquoted)) {
      // False-positive checks: column names that contain keywords
      // e.g., "update_time", "created_date", "set_time" as column identifiers
      if (isFalsePositive(keyword, stripped)) {
        continue;
      }
      return { valid: false, reason: `Blocked operation detected: ${keyword}. Only SELECT queries are allowed.` };
    }
  }

  // Block semicolons (prevent multi-statement injection)
  const unquotedForSemicolon = stripQuotedStrings(stripped);
  const semicolonCount = (unquotedForSemicolon.match(/;/g) || []).length;
  if (semicolonCount > 1) {
    return { valid: false, reason: 'Multiple statements detected. Only single SELECT queries are allowed.' };
  }

  // Block subqueries that contain write operations
  // (already covered by the keyword scan on full normalized text)

  return { valid: true, isComment: false };
}

/**
 * Remove quoted strings so keyword detection doesn't match column values.
 * e.g., SELECT 'DELETE this' should not be blocked.
 */
function stripQuotedStrings(sql) {
  return sql
    .replace(/'[^']*'/g, "''")     // single-quoted strings
    .replace(/"[^"]*"/g, '""');    // double-quoted identifiers
}

/**
 * Check for common false-positive column/alias names that contain blocked keywords.
 * e.g., "update_time", "created_date", "delete_reason", "set_time"
 */
function isFalsePositive(keyword, originalSql) {
  const upper = keyword.toUpperCase().trim();
  const sqlUpper = originalSql.toUpperCase();

  // These keywords commonly appear as parts of column names
  const columnKeywords = ['UPDATE', 'DELETE', 'CREATE', 'SET', 'COMMENT', 'LOCK', 'CALL', 'DO', 'RESET', 'LOAD', 'COPY', 'IMPORT'];
  if (!columnKeywords.includes(upper)) {
    return false;
  }

  // Check if the keyword only appears as part of a column/alias name (word_keyword or keyword_word)
  const unquoted = stripQuotedStrings(sqlUpper);

  // Match standalone keyword usage (not part of underscore-joined identifiers)
  // \bUPDATE\b matches "UPDATE" but also "UPDATE_TIME" — we need to exclude underscore-adjacent
  const standalonePattern = new RegExp(`(?<![_a-zA-Z])${upper}(?![_a-zA-Z])`);
  return !standalonePattern.test(unquoted);
}

// =============================================
// PROMPT VALIDATION
// =============================================

/**
 * Validate the user's prompt for dangerous write-intent words.
 * Single-word check — if ANY blocked word appears, the prompt is rejected.
 * This prevents creative phrasing from bypassing multi-word pattern checks.
 */
function validatePrompt(prompt) {
  const lower = prompt.toLowerCase();

  for (const word of BLOCKED_PROMPT_WORDS) {
    // \b word boundary ensures "updated" doesn't match "update",
    // but "update" as a standalone word is caught
    const regex = new RegExp(`\\b${word}\\b`, 'i');
    if (regex.test(lower)) {
      return {
        valid: false,
        reason: `This assistant only supports read/query operations. The word "${word}" indicates a write operation which is not allowed.`
      };
    }
  }

  return { valid: true };
}

// =============================================
// SYSTEM PROMPTS
// =============================================

const SQL_GENERATION_PROMPT = `You are an expert PostgreSQL SQL query generator for a concrete delivery management system called Truckast. Your ONLY role is to convert natural language questions into read-only SELECT queries.

DATABASE SCHEMA:
${DB_SCHEMA}

🔒 READ-ONLY MODE — ABSOLUTE RESTRICTIONS:
- You may ONLY generate SELECT queries or WITH (CTE) queries that end in SELECT.
- NEVER generate INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, EXECUTE, MERGE, or any data-modifying statement.
- NEVER include multiple statements separated by semicolons.
- If a user asks you to modify, delete, insert, update, or change any data, respond with ONLY this exact text:
  -- READ_ONLY: I only have read-only access.
- Treat any request to "fix", "correct", "change", "remove", "add", or "edit" database records as a write operation and refuse.

📊 ORDER STATUS CODES & CATEGORIES:
- 0=Normal, 1=Will Call, 2=Weather Permitting, 3=Hold Delivery, 4=Completed, 5=Wait List.
- Exclude status 2 (Weather Permitting) from normal order queries unless explicitly asked.
- PRE_POUR statuses: [0, 1, 3, 5] — orders with no delivered quantity yet.
- IN_PROCESS statuses: [0, 3] — orders with some tickets but not all delivered.
- COMPLETED: current_status = 4, or all loads ticketed AND last load completed.
- CANCELED: removed = true AND remove_reason_code IS NOT NULL AND TRIM(remove_reason_code) <> '' (BOTH conditions required, never OR).
- Active orders = NOT cancelled: (removed IS NOT TRUE OR remove_reason_code IS NULL OR TRIM(remove_reason_code) = '').

🎫 TICKET STATUS WATERFALL (check in this exact reverse order — return FIRST match):
1. at_plant_time IS NOT NULL AND TRIM(at_plant_time) <> '' → "At Plant"
2. to_plant_time IS NOT NULL AND TRIM(to_plant_time) <> '' → "To Plant"
3. wash_time IS NOT NULL AND TRIM(wash_time) <> '' → "Washing"
4. unload_time IS NOT NULL AND TRIM(unload_time) <> '' → "Pouring"
5. on_job_time IS NOT NULL AND TRIM(on_job_time) <> '' → "At Job"
6. to_job_time IS NOT NULL AND TRIM(to_job_time) <> '' → "To Job"
7. loaded_time IS NOT NULL AND TRIM(loaded_time) <> '' → "Loaded"
8. load_time IS NOT NULL AND TRIM(load_time) <> '' → "Loading"
9. printed_time IS NOT NULL AND TRIM(printed_time) <> '' → "Ticketed"
10. Otherwise → "Pending"
- Cancelled ticket: remove_reason_code IS NOT NULL AND TRIM(remove_reason_code) <> '' (check BEFORE waterfall).
- Use CASE WHEN in SQL to compute ticket status.

🚛 CONCRETE PRODUCT FILTERING (CRITICAL):
- Concrete products: order_qty_unit = 'YDQ' AND is_mix = true (BOTH required).
- When calculating order volumes (CY), only SUM products where order_qty_unit = 'YDQ' AND is_mix = true.
- For ticket load quantity: prefer the product where is_mix = true; fallback to first product.
- NEVER sum load_qty across multiple products in same ticket (they share the same load).

📏 QUANTITY & PROGRESS CALCULATIONS:
- Ordered quantity: SUM(op.order_qty) WHERE op.order_qty_unit = 'YDQ' AND op.is_mix = true.
- Delivered quantity: SUM(op.delv_qty) WHERE op.order_qty_unit = 'YDQ' AND op.is_mix = true.
- Ticketed quantity: SUM of load_qty from tickets (using is_mix=true product per ticket).
- Progress percentage: (delivered_qty / ordered_qty) * 100.
- Remaining quantity: MAX(0, ordered_qty - delivered_qty).
- All loads ticketed: (ordered_qty - ticketed_qty) <= 0.02 (floating-point safety margin).

🏭 PLANT & REGION LOGIC:
- Order's plant comes from: pricing_plant_code on orders table, or plant_code from order_product_schedules.
- Region mapping: plants.region_id → regions table. Do NOT use zone_name as region.
- Plant summary: group orders by pricing_plant_code, count active/cancelled, sum CY.
- Cancelled orders in plant summary: included in counts but CY = 0.

📈 KPI & DASHBOARD METRICS:
- Scheduled orders: total count of all orders for the period.
- Completed orders: orders where delv_qty > 0 AND NOT cancelled.
- Active trucks: COUNT DISTINCT truck_code from tickets WHERE status is NOT "canceled" AND NOT "At Plant".
- Trucks in transit: tickets with to_job_time set but on_job_time NOT set.
- Late orders: IN_PROCESS orders where (ticketed_qty / ordered_qty) < 50% AND ticketed_qty > 0.
- Producer delay per ticket: MAX(0, on_job_time - scheduled_on_job_time) in minutes.
- Pour rate: (total_poured_qty / total_pour_minutes) * 60 = CY/HR.

🔍 EXCLUSION PATTERN RULES:
- Table: excluded_order_patterns (type, pattern, active).
- Types: 'product' (item_code LIKE), 'customer' (customer_name LIKE, CONCRETE-only patterns), 'delivery_address' (delivery_addr1 LIKE).
- All matching uses substring LIKE '%pattern%' (case-insensitive).
- If ANY pattern matches, the order is excluded from normal queries.

🧠 ACCURACY RULES:
- Do NOT guess or assume missing data. Only query what exists in the schema.
- Validate quantities by using proper aggregation (SUM for totals, COUNT for counts).
- Always qualify column names with table aliases to avoid ambiguity.
- Use COALESCE for nullable fields when doing calculations.
- For date filtering: use order_date::date for day comparisons. Use (CURRENT_TIMESTAMP AT TIME ZONE '${process.env.BUSINESS_TIMEZONE || 'America/Chicago'}')::date for "today".
- Date range: use >= dateFrom AND < dateTo (exclusive upper bound).

✂️ QUERY FORMAT RULES:
1. Return ONLY the raw SQL query — no explanations, no markdown fences, no commentary, no backticks.
2. Always use PostgreSQL syntax (timestamptz, ILIKE, ::date, COALESCE, etc.).
3. Use table aliases for readability (o for orders, op for order_products, t for tickets, etc.).
4. Use LEFT JOIN when related data might not exist (notes, products, schedules).
5. Always include ORDER BY for list queries (default: o.order_date DESC, o.order_code).
6. Use LIMIT for "top N" requests or large result sets (default LIMIT 100 for list queries).
7. For aggregations (COUNT, SUM, AVG), do NOT add LIMIT unless the user requests it.
8. Use ILIKE for case-insensitive text searches.
9. If the user's request is unclear or cannot be translated to a read query, return a comment starting with -- explaining why.
10. If data is insufficient to answer, return: -- Insufficient data to provide accurate answer.`;

const RESPONSE_FORMATTING_PROMPT = `You are a specialized read-only support assistant for a concrete delivery management system called Truckast. Your job is to present query results as precise, non-generic, user-friendly answers.

🔒 READ-ONLY:
- You only have read access. If results suggest a modification is needed, say: "I only have read-only access."
- NEVER suggest creating, updating, deleting, or modifying any data.

✂️ RESPONSE STYLE:
- Write the answer in ONE or TWO simple sentences. No bullet points, no lists, no line breaks.
- Use plain text only — NO HTML, NO markdown (**bold**, etc.), NO bullet points, NO special formatting.
- Write as a single flowing sentence or two, like a human chatting.
- Do NOT return raw JSON, table dumps, or SQL.
- Do NOT mention "database", "query", "SQL", "table", or any technical details.
- No unnecessary text, repetition, generic filler, or disclaimers.
- Every answer must be direct and to the point.

📊 FORMATTING:
- Keep everything in one or two plain sentences. Example: "Order 23305 has 18 CY ordered and 9 CY delivered, with 9 CY remaining."
- Numbers: use commas for large numbers (e.g., "1,234 cubic yards").
- Dates: human readable (e.g., "March 25, 2026").
- Currency: use $ with commas (e.g., "$1,234.56").
- Use "CY" for cubic yards.
- Status codes: translate them — 0=Normal, 1=Will Call, 2=Weather Permitting, 3=Hold Delivery, 4=Completed, 5=Wait List.
- Ticket statuses: Ticketed, Loading, Loaded, To Job, At Job, Pouring, Washing, To Plant, At Plant.

🧠 ACCURACY & SPECIFICITY:
- Prioritize correctness over creativity.
- No hallucinations — only state what the data shows.
- No assumptions beyond the data provided.
- Provide SPECIFIC answers — never generic overviews or "it depends" responses.
- For order/ticket questions: include exact counts, quantities, statuses, customer names, and plant details from the data.
- For data-related questions: give concrete details based on their exact data, not template examples.
- If data is incomplete or unclear, say: "Insufficient data to provide accurate answer."
- If result is empty (0 rows), say so clearly (e.g., "No orders found for today.").

⚙️ CONSISTENCY:
- For large result sets, summarize with totals and highlight key entries — don't list every row.
- For order queries, consider the full lifecycle (partial loads, in-progress deliveries, completed loads).
- Always reference the user's original question for context.
- Make responses easy to understand for non-technical readers while remaining accurate.`;

// =============================================
// SQL EXTRACTION (strip markdown fences, explanations, etc.)
// =============================================

/**
 * Extract pure SQL from Claude's response.
 * Claude may wrap SQL in markdown fences or add explanatory text.
 */
function extractSQL(raw) {
  if (!raw) return raw;

  let text = raw.trim();

  // Extract SQL from markdown code fences: ```sql ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:sql)?\s*\n?([\s\S]*?)```/i);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // If response has text before the SQL (e.g., "Here is the query:\nSELECT ..."),
  // find where SELECT or WITH starts and take everything from there
  const sqlStartMatch = text.match(/^[\s\S]*?((?:SELECT|WITH)\b[\s\S]*)$/im);
  if (sqlStartMatch && !text.toUpperCase().trimStart().startsWith('SELECT') && !text.toUpperCase().trimStart().startsWith('WITH') && !text.trimStart().startsWith('--')) {
    return sqlStartMatch[1].trim();
  }

  return text;
}

// =============================================
// CORE SERVICE FUNCTIONS
// =============================================

/**
 * Full NLQ pipeline: prompt → SQL → execute → format → human response
 */
async function processQuery(prompt, sessionId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY is not configured'), { code: 'CONFIG_ERROR' });
  }

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw Object.assign(new Error('Prompt is required and must be a non-empty string'), { code: 'VALIDATION_ERROR' });
  }

  // LAYER 1: Validate prompt for dangerous intent
  const promptCheck = validatePrompt(prompt);
  if (!promptCheck.valid) {
    return {
      answer: promptCheck.reason,
      sql: null,
      row_count: 0,
      session_id: sessionId,
      blocked: true
    };
  }

  const client = new Anthropic({ apiKey });

  // Get or create session
  let session = conversations.get(sessionId);
  if (!session) {
    session = { messages: [], lastAccess: Date.now() };
    conversations.set(sessionId, session);
  }
  session.lastAccess = Date.now();

  // Add user message to conversation history
  session.messages.push({ role: 'user', content: prompt.trim() });

  // Trim history if too long
  if (session.messages.length > MAX_HISTORY_MESSAGES) {
    session.messages = session.messages.slice(-MAX_HISTORY_MESSAGES);
  }

  try {
    // STEP 1: Generate SQL from natural language
    const sqlResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SQL_GENERATION_PROMPT,
      messages: session.messages
    });

    const generatedSQL = extractSQL(
      sqlResponse.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim()
    );

    // LAYER 2: Server-side SQL validation (hard block)
    const sqlCheck = validateSQL(generatedSQL);
    if (!sqlCheck.valid) {
      // Remove the failed user message
      session.messages.pop();
      return {
        answer: sqlCheck.reason,
        sql: null,
        row_count: 0,
        session_id: sessionId,
        blocked: true
      };
    }

    // Handle Claude's refusal comments (e.g., "-- READ_ONLY: ...")
    if (sqlCheck.isComment) {
      const refusalMessage = generatedSQL.replace(/^--\s*/gm, '').trim();
      session.messages.push({ role: 'assistant', content: refusalMessage });
      return {
        answer: refusalMessage.includes('READ_ONLY')
          ? 'This assistant only supports read/query operations. Data modification is not allowed.'
          : refusalMessage,
        sql: null,
        row_count: 0,
        session_id: sessionId,
        blocked: generatedSQL.includes('READ_ONLY')
      };
    }

    // STEP 2: Execute the validated SQL against the database
    let queryResult;
    try {
      // Add LIMIT safety net if not already present
      const safeSql = ensureLimit(generatedSQL, MAX_RESULT_ROWS);
      queryResult = await executeDirectSQL(safeSql, [], { maxRetries: 1 });
    } catch (dbError) {
      console.error('NLQ query execution error:', dbError.message);
      session.messages.push({
        role: 'assistant',
        content: `I generated a query but it encountered an error: ${dbError.message}`
      });
      return {
        answer: `I understood your question but the query encountered an error. Could you try rephrasing? (Error: ${dbError.message})`,
        sql: generatedSQL,
        row_count: 0,
        session_id: sessionId,
        error: true
      };
    }

    // STEP 3: Format results into human-readable language
    const formattedAnswer = await formatResults(
      client, prompt, generatedSQL, queryResult.data, queryResult.rowCount
    );

    // Store assistant's formatted response in conversation history
    session.messages.push({ role: 'assistant', content: formattedAnswer });

    return {
      answer: formattedAnswer,
      sql: generatedSQL,
      row_count: queryResult.rowCount,
      session_id: sessionId,
      usage: {
        input_tokens: sqlResponse.usage.input_tokens,
        output_tokens: sqlResponse.usage.output_tokens
      }
    };

  } catch (error) {
    // Remove the failed user message from history
    session.messages.pop();

    if (error.status === 401) {
      throw Object.assign(new Error('Invalid Anthropic API key'), { code: 'AUTH_ERROR' });
    }
    if (error.status === 429) {
      throw Object.assign(new Error('Rate limit exceeded. Please try again shortly.'), { code: 'RATE_LIMIT' });
    }
    if (error.status === 400) {
      throw Object.assign(new Error('Bad request to AI service: ' + error.message), { code: 'API_ERROR' });
    }

    throw Object.assign(new Error('AI service error: ' + error.message), { code: 'API_ERROR' });
  }
}

/**
 * Format raw query results into human-readable language using Claude
 */
async function formatResults(client, userPrompt, sql, rows, rowCount) {
  // For empty results, no need to call Claude
  if (!rows || rows.length === 0) {
    return 'No results found for your query. Try broadening your search criteria or checking for a different date range.';
  }

  // For very large result sets, truncate for the formatting prompt
  const displayRows = rows.slice(0, 50);
  const truncated = rows.length > 50;

  const formattingPrompt = `The user asked: "${userPrompt}"

Here are the query results (${rowCount} total row${rowCount !== 1 ? 's' : ''}${truncated ? `, showing first 50` : ''}):

${JSON.stringify(displayRows, null, 2)}

Please present these results in a clear, human-friendly format.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: RESPONSE_FORMATTING_PROMPT,
      messages: [{ role: 'user', content: formattingPrompt }]
    });

    return response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
  } catch (error) {
    // If formatting fails, return a basic summary
    console.error('NLQ formatting error:', error.message);
    return `Found ${rowCount} result${rowCount !== 1 ? 's' : ''} for your query. Raw data is available in the response.`;
  }
}

/**
 * Add a LIMIT clause if the query doesn't already have one (safety net).
 * Only applies to non-aggregate queries.
 */
function ensureLimit(sql, maxRows) {
  const upper = sql.toUpperCase().replace(/\s+/g, ' ').trim();

  // If query already has LIMIT, respect it (but cap at maxRows)
  const limitMatch = upper.match(/LIMIT\s+(\d+)/);
  if (limitMatch) {
    const existingLimit = parseInt(limitMatch[1], 10);
    if (existingLimit > maxRows) {
      // Replace the overly large limit
      return sql.replace(/LIMIT\s+\d+/i, `LIMIT ${maxRows}`);
    }
    return sql;
  }

  // Don't add LIMIT to aggregate-only queries (COUNT, SUM, AVG without GROUP BY detail rows)
  const hasAggregate = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sql);
  const hasGroupBy = /\bGROUP\s+BY\b/i.test(sql);
  if (hasAggregate && !hasGroupBy) {
    return sql; // Pure aggregate, no LIMIT needed
  }

  // Add LIMIT to the end (before trailing semicolon if present)
  const trimmed = sql.replace(/;\s*$/, '');
  return `${trimmed} LIMIT ${maxRows}`;
}

// =============================================
// SESSION MANAGEMENT
// =============================================

/**
 * Get conversation history for a session
 */
function getConversationHistory(sessionId) {
  const session = conversations.get(sessionId);
  if (!session) {
    return [];
  }
  session.lastAccess = Date.now();
  return session.messages.map((msg, index) => ({
    index,
    role: msg.role,
    content: msg.content
  }));
}

/**
 * Clear conversation history for a session
 */
function clearConversation(sessionId) {
  return conversations.delete(sessionId);
}

module.exports = {
  processQuery,
  getConversationHistory,
  clearConversation,
  validateSQL,
  validatePrompt
};
