/**
 * LLM agent loop.
 * ---------------
 * A real tool-calling agent. The LLM (any OpenAI-compatible chat-completions
 * endpoint — Groq, OpenAI, Together, etc.) is given the tool schema and decides
 * which tools to call. We run a multi-step loop: the model can call a tool,
 * read its result, reason, call another tool, and finally answer — so it can
 * carry out the full "search -> compare -> book" workflow on its own.
 *
 * Configure via env:
 *   LLM_BASE_URL  default https://api.groq.com/openai/v1
 *   LLM_API_KEY   required to enable the LLM path (else the service falls back
 *                 to the rule-based parser in parser.js)
 *   LLM_MODEL     default llama-3.3-70b-versatile
 */

const axios = require('axios');
const { TOOL_SCHEMA, executeTool } = require('./tools');

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'llama-3.3-70b-versatile';
const MAX_STEPS = 6;
const MAX_HISTORY = 14; // messages kept in the rolling session history

function llmEnabled() {
  return Boolean(LLM_API_KEY);
}

function systemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return [
    'You are the booking assistant for a Hotels.com-style web app.',
    `Today is ${today}.`,
    'You help users search hotels and complete bookings by calling the provided tools.',
    'Workflow: understand the destination, date range and guest count; call search_hotels;',
    'present the options briefly; when the user picks one and confirms, call book_hotel.',
    'Known demo cities are Bodrum, Rome, Istanbul and Izmir. Turkish spellings like İstanbul/İzmir map to Istanbul/Izmir.',
    'You may call get_hotel_details to inspect room types before booking.',
    'Always confirm destination, dates and guest count with the user before booking.',
    'Booking requires the user to be signed in. If a tool returns error',
    '"authentication_required", tell the user to sign in with the Microsoft login button.',
    'Resolve relative dates (e.g. "next weekend") against today\'s date.',
    'Reply in the same language the user writes in (Turkish or English). Be concise and friendly.',
    'Do not use emojis in your replies.',
    'Never invent hotels, prices or availability — only use what the tools return.'
  ].join(' ');
}

async function callLLM(messages) {
  const resp = await axios.post(
    `${LLM_BASE_URL}/chat/completions`,
    {
      model: LLM_MODEL,
      messages,
      tools: TOOL_SCHEMA,
      tool_choice: 'auto',
      temperature: 0.2
    },
    {
      headers: { Authorization: `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000
    }
  );
  return resp.data.choices[0].message;
}

/**
 * Run one chat turn through the agent loop.
 * @param {string} message      the user's new message
 * @param {Array}  history      prior {role,content,...} messages from the session
 * @param {string} authHeader   the caller's Authorization header (for booking)
 * @returns {{reply, actions, history}}
 */
async function runAgent(message, history, authHeader) {
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...history,
    { role: 'user', content: message }
  ];

  const actions = [];
  let reply = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    const assistant = await callLLM(messages);
    messages.push(assistant);

    const toolCalls = assistant.tool_calls || [];
    if (toolCalls.length === 0) {
      reply = assistant.content || '';
      break;
    }

    // Execute every tool the model asked for, append results, loop again.
    for (const tc of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      const { result, uiHotels, uiReservation, requireLogin } = await executeTool(
        tc.function.name,
        args,
        authHeader
      );
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result)
      });
      if (uiHotels && uiHotels.length) {
        for (const h of uiHotels) {
          actions.push({
            type: 'hotel',
            hotelId: h.hotelId,
            name: h.name,
            city: h.city,
            rating: h.rating,
            pricePerNight: h.pricePerNight,
            amenities: h.amenities,
            buttons: [{ label: 'Reserve Room', action: 'book', payload: { hotelId: h.hotelId } }]
          });
        }
      }
      if (uiReservation) actions.push({ type: 'reservation', reservation: uiReservation });
      if (requireLogin) actions.push({ type: 'requireLogin' });
    }
  }

  if (!reply) reply = 'İşleminizi tamamlamak için biraz daha bilgi verir misiniz?';

  // Roll the history forward, trimmed, so the next turn keeps context.
  const newHistory = messages
    .filter((m) => m.role !== 'system')
    .slice(-MAX_HISTORY);

  return { reply, actions, history: newHistory };
}

module.exports = { runAgent, llmEnabled, LLM_MODEL };
