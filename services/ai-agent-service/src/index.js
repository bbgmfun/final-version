/**
 * AI Agent Service
 * ----------------
 * A real LLM tool-calling agent. The chat window in the web app talks to this
 * service; the service runs a multi-step agent loop where an LLM decides which
 * tools to call (search_hotels, get_hotel_details, book_hotel), executes them
 * against the hotel-service REST API, reads the results, reasons, and can chain
 * tools to carry out the full "search -> compare -> book" workflow.
 *
 *   - LLM path (primary)   : agent.js  — any OpenAI-compatible endpoint (Groq,
 *                            OpenAI, Together...). Enabled when LLM_API_KEY is set.
 *   - Rule-based path      : parser.js — regex/dictionary fallback so the chat
 *                            still works with no API key (offline demo).
 *
 * Endpoint:
 *   POST /v1/chat   { message, session }  -> { reply, actions, session }
 *   GET  /v1/health
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const { runAgent, llmEnabled, LLM_MODEL } = require('./agent');
const { ruleBasedChat } = require('./parser');

const PORT = Number(process.env.PORT || 4005);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'ai-agent', mode: llmEnabled() ? `llm:${LLM_MODEL}` : 'rule-based' })
);

const v1 = express.Router();
v1.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'ai-agent', mode: llmEnabled() ? `llm:${LLM_MODEL}` : 'rule-based' })
);

v1.post('/chat', async (req, res) => {
  try {
    const { message, session: incomingSession = {} } = req.body || {};
    const authHeader = req.headers.authorization || '';

    if (!message || !String(message).trim()) {
      return res.json({
        reply: 'Merhaba! Hangi şehir ve tarihler için otel aramamı istersiniz?',
        actions: [],
        session: incomingSession
      });
    }

    // ---- Primary path: real LLM tool-calling agent ----
    if (llmEnabled()) {
      try {
        const history = Array.isArray(incomingSession.history) ? incomingSession.history : [];
        const { reply, actions, history: newHistory } = await runAgent(message, history, authHeader);
        return res.json({
          reply,
          actions,
          session: { ...incomingSession, history: newHistory }
        });
      } catch (err) {
        // If the LLM call fails, fall through to the rule-based path so the
        // chat window never goes fully dead during a demo.
        console.warn('[ai-agent] LLM path failed, falling back:', err.response?.data || err.message);
      }
    }

    // ---- Fallback path: rule-based parser ----
    const result = await ruleBasedChat(message, incomingSession, authHeader);
    return res.json(result);
  } catch (err) {
    console.error('[ai-agent]', err.response?.data || err.message);
    res.status(500).json({ error: 'agent error', detail: err.response?.data || err.message });
  }
});

app.use('/v1', v1);

app.listen(PORT, () => {
  console.log(`[ai-agent] listening on :${PORT}`);
  console.log(`[ai-agent] mode: ${llmEnabled() ? 'LLM tool-calling agent (' + LLM_MODEL + ')' : 'rule-based fallback (set LLM_API_KEY to enable the LLM agent)'}`);
});
