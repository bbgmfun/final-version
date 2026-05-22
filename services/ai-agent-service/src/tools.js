/**
 * Agent tools.
 * ------------
 * The AI agent is a real multi-tool agent: the LLM decides which tool to call,
 * this module executes the call against the hotel-service REST API (through the
 * same endpoints the UI uses), and the result is fed back to the LLM so it can
 * reason over it and decide the next step (search -> show options -> book).
 */

const axios = require('axios');

const HOTEL_URL = process.env.HOTEL_URL || 'http://hotel-service:4002';

// OpenAI / Groq function-calling tool schema.
const TOOL_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'search_hotels',
      description:
        'Search hotels that have rooms available for the whole given date range in a destination city.',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string', description: 'Destination city, e.g. "Bodrum", "Rome", "Istanbul" or "Izmir".' },
          start_date: { type: 'string', description: 'Check-in date, ISO format YYYY-MM-DD.' },
          end_date: { type: 'string', description: 'Check-out date, ISO format YYYY-MM-DD.' },
          guests: { type: 'integer', description: 'Number of guests. Default 2.' }
        },
        required: ['destination', 'start_date', 'end_date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_hotel_details',
      description: 'Get full details and the list of bookable room types for one hotel.',
      parameters: {
        type: 'object',
        properties: {
          hotelId: { type: 'string', description: 'The hotel id returned by search_hotels.' }
        },
        required: ['hotelId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'book_hotel',
      description:
        'Book a room at a hotel for the given dates. The user must be signed in. ' +
        'Call this only after the user has confirmed which hotel and dates they want.',
      parameters: {
        type: 'object',
        properties: {
          hotelId: { type: 'string' },
          roomType: { type: 'string', description: 'One of: Standard, Aile, Deluxe, Suite. Default Standard.' },
          start_date: { type: 'string', description: 'Check-in date YYYY-MM-DD.' },
          end_date: { type: 'string', description: 'Check-out date YYYY-MM-DD.' },
          guests: { type: 'integer', description: 'Number of guests. Default 2.' }
        },
        required: ['hotelId', 'start_date', 'end_date']
      }
    }
  }
];

function authHeaders(authHeader) {
  return authHeader ? { Authorization: authHeader } : {};
}

// Trim a search result row to the fields the LLM actually needs (saves tokens).
function slimHotel(h) {
  return {
    hotelId: h.hotelId,
    name: h.name,
    city: h.city,
    country: h.country,
    rating: h.rating,
    amenities: h.amenities,
    pricePerNight: h.displayPricePerNight != null ? h.displayPricePerNight : h.basePricePerNight,
    priceTotal: h.displayPriceTotal != null ? h.displayPriceTotal : h.basePriceTotal,
    nights: h.nights
  };
}

/**
 * Execute one tool call. Always resolves (never throws) — a failed HTTP call
 * is returned as { error } so the LLM can read it and react (e.g. ask the user
 * to sign in, or pick different dates).
 *
 * Returns { result, uiHotels?, uiReservation?, requireLogin? } where the ui*
 * fields are extracted so the frontend can render rich cards.
 */
async function executeTool(name, args, authHeader) {
  try {
    if (name === 'search_hotels') {
      const params = new URLSearchParams({
        destination: String(args.destination || ''),
        start: new Date(args.start_date).toISOString(),
        end: new Date(args.end_date).toISOString(),
        guests: String(args.guests || 2)
      });
      const r = await axios.get(`${HOTEL_URL}/v1/search?${params.toString()}`, {
        headers: authHeaders(authHeader),
        timeout: 10000
      });
      const items = (r.data.items || []).map(slimHotel);
      return { result: { count: items.length, hotels: items }, uiHotels: items };
    }

    if (name === 'get_hotel_details') {
      const r = await axios.get(`${HOTEL_URL}/v1/hotels/${encodeURIComponent(args.hotelId)}`, {
        headers: authHeaders(authHeader),
        timeout: 10000
      });
      const d = r.data;
      return {
        result: {
          hotelId: d._id,
          name: d.name,
          city: d.city,
          rating: d.rating,
          amenities: d.amenities,
          rooms: (d.rooms || []).map((rm) => ({
            roomType: rm.roomType,
            pricePerNight: rm.displayPricePerNight != null ? rm.displayPricePerNight : rm.pricePerNight,
            availableRooms: rm.availableRooms
          }))
        }
      };
    }

    if (name === 'book_hotel') {
      if (!authHeader) {
        return { result: { error: 'authentication_required', message: 'The user must sign in before booking.' }, requireLogin: true };
      }
      const r = await axios.post(
        `${HOTEL_URL}/v1/hotels/${encodeURIComponent(args.hotelId)}/book`,
        {
          roomType: args.roomType || 'Standard',
          startDate: new Date(args.start_date).toISOString(),
          endDate: new Date(args.end_date).toISOString(),
          guests: args.guests || 2
        },
        { headers: authHeaders(authHeader), timeout: 10000 }
      );
      return {
        result: { booked: true, reservation: r.data },
        uiReservation: r.data
      };
    }

    return { result: { error: 'unknown_tool', tool: name } };
  } catch (err) {
    const detail = err.response ? err.response.data : err.message;
    const status = err.response ? err.response.status : null;
    if (status === 401 || status === 403) {
      return { result: { error: 'authentication_required', detail }, requireLogin: true };
    }
    return { result: { error: 'tool_failed', tool: name, status, detail } };
  }
}

module.exports = { TOOL_SCHEMA, executeTool };
