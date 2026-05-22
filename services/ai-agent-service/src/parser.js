/**
 * Rule-based fallback agent.
 * --------------------------
 * Used only when no LLM is configured (LLM_API_KEY unset). It keeps the chat
 * window functional offline / without an API key: a regex + dictionary intent
 * parser that recognises destination, dates, guest count and amenities, then
 * calls the same hotel-service endpoints. The primary path is the real LLM
 * tool-calling agent in agent.js.
 */

const axios = require('axios');

const HOTEL_URL = process.env.HOTEL_URL || 'http://hotel-service:4002';

const MONTH_MAP = {
  january: 0, jan: 0, ocak: 0,
  february: 1, feb: 1, şubat: 1, subat: 1,
  march: 2, mar: 2, mart: 2,
  april: 3, apr: 3, nisan: 3,
  may: 4, mayis: 4, mayıs: 4,
  june: 5, jun: 5, haziran: 5,
  july: 6, jul: 6, temmuz: 6,
  august: 7, aug: 7, ağustos: 7, agustos: 7,
  september: 8, sep: 8, sept: 8, eylül: 8, eylul: 8,
  october: 9, oct: 9, ekim: 9,
  november: 10, nov: 10, kasım: 10, kasim: 10,
  december: 11, dec: 11, aralık: 11, aralik: 11
};

const AMENITY_KEYWORDS = {
  pool: 'Pool', havuz: 'Pool', wifi: 'WiFi',
  breakfast: 'Breakfast', kahvaltı: 'Breakfast', kahvalti: 'Breakfast',
  spa: 'Spa', beach: 'Beach', plaj: 'Beach',
  'all-inclusive': 'All-Inclusive', 'her şey dahil': 'All-Inclusive'
};

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  bir: 1, iki: 2, üç: 3, uc: 3, dört: 4, dort: 4, beş: 5, bes: 5, altı: 6, alti: 6
};

const DESTINATION_ALIASES = {
  bodrum: 'Bodrum',
  rome: 'Rome',
  roma: 'Rome',
  istanbul: 'Istanbul',
  izmir: 'Izmir'
};

function isMonthWord(w) {
  return Object.prototype.hasOwnProperty.call(MONTH_MAP, String(w || '').toLowerCase());
}

function parseDates(text) {
  const iso = text.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|until|-|–|—|ile)\s*(\d{4}-\d{2}-\d{2})/i);
  if (iso) return { start: new Date(iso[1]), end: new Date(iso[2]) };

  const monthRegex = Object.keys(MONTH_MAP).join('|');
  const en1 = new RegExp(`(${monthRegex})\\s+(\\d{1,2})\\s*(?:to|until|-|–|—)\\s*(?:(${monthRegex})\\s+)?(\\d{1,2})(?:[,\\s]+(\\d{4}))?`, 'i');
  const m1 = text.match(en1);
  if (m1) {
    const month1 = MONTH_MAP[m1[1].toLowerCase()];
    const day1 = Number(m1[2]);
    const month2 = m1[3] ? MONTH_MAP[m1[3].toLowerCase()] : month1;
    const day2 = Number(m1[4]);
    const year = m1[5] ? Number(m1[5]) : new Date().getFullYear();
    return { start: new Date(year, month1, day1), end: new Date(year, month2, day2) };
  }

  const tr1 = new RegExp(`(\\d{1,2})\\s+(${monthRegex})\\s*(?:to|until|-|–|—|ile)\\s*(\\d{1,2})\\s+(${monthRegex})`, 'i');
  const m2 = text.match(tr1);
  if (m2) {
    const day1 = Number(m2[1]);
    const month1 = MONTH_MAP[m2[2].toLowerCase()];
    const day2 = Number(m2[3]);
    const month2 = MONTH_MAP[m2[4].toLowerCase()];
    const year = new Date().getFullYear();
    return { start: new Date(year, month1, day1), end: new Date(year, month2, day2) };
  }

  const dr = new RegExp(`(\\d{1,2})\\s*(?:-|–|—|to|until|ile)\\s*(\\d{1,2})\\s+(${monthRegex})`, 'i');
  const m3 = text.match(dr);
  if (m3) {
    const day1 = Number(m3[1]);
    const day2 = Number(m3[2]);
    const month = MONTH_MAP[m3[3].toLowerCase()];
    const year = new Date().getFullYear();
    return { start: new Date(year, month, day1), end: new Date(year, month, day2) };
  }
  return null;
}

function stripLocative(w) {
  const m = String(w).match(/^(.{3,})(?:nda|nde|ndan|nden|dan|den|tan|ten|da|de|ta|te)$/i);
  return m ? m[1] : w;
}

function foldText(s) {
  return String(s || '')
    .replace(/[İIı]/g, 'i')
    .replace(/[Ğğ]/g, 'g')
    .replace(/[Üü]/g, 'u')
    .replace(/[Şş]/g, 's')
    .replace(/[Öö]/g, 'o')
    .replace(/[Çç]/g, 'c')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function canonicalDestination(w) {
  return DESTINATION_ALIASES[foldText(w).trim()] || stripLocative(w);
}

function parseDestination(text) {
  const folded = foldText(text);
  for (const [alias, destination] of Object.entries(DESTINATION_ALIASES)) {
    if (new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(folded)) return destination;
  }
  for (const m of text.matchAll(/\b(?:in|at|to|from)\s+([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)/g)) {
    if (!isMonthWord(m[1])) return canonicalDestination(m[1]);
  }
  const trAp = text.match(/([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)'(?:d[ae]|t[ae]|[ae]|n[ıiuü]n)\b/);
  if (trAp) return canonicalDestination(trAp[1]);
  for (const w of text.match(/[A-ZÇĞİÖŞÜ][a-zçğıöşü]+/g) || []) {
    if (!isMonthWord(w)) return canonicalDestination(w);
  }
  return null;
}

function parseGuests(text) {
  const lower = text.toLowerCase();
  const m = lower.match(/(\d+)\s*(?:adults?|kişi|kisi|misafir|guests?|people|yetişkin|yetiskin)/);
  if (m) return Number(m[1]);
  const m2 = lower.match(/for\s+(\d+)/);
  if (m2) return Number(m2[1]);
  const words = Object.keys(WORD_NUMBERS).join('|');
  const m3 = lower.match(new RegExp(`(${words})\\s*(?:adults?|kişi|kisi|misafir|guests?|people|yetişkin|yetiskin)`));
  if (m3) return WORD_NUMBERS[m3[1]];
  const m4 = lower.match(new RegExp(`for\\s+(${words})\\b`));
  if (m4) return WORD_NUMBERS[m4[1]];
  return null;
}

function parseAmenities(text) {
  const lower = text.toLowerCase();
  const out = new Set();
  for (const [k, v] of Object.entries(AMENITY_KEYWORDS)) {
    if (lower.includes(k)) out.add(v);
  }
  return [...out];
}

function parseRating(text) {
  const m = text.match(/(\d(?:\.\d)?)\s*\+\s*star/i);
  return m ? Number(m[1]) : null;
}

function parsePriceCeiling(text) {
  const m = text.match(/under\s+\$?(\d+)/i);
  return m ? Number(m[1]) : null;
}

function parseIntent(text, session) {
  const lower = (text || '').toLowerCase().trim();
  if (!lower) return { intent: 'noop' };

  if (/\b(yes|evet|confirm|book it|onayla|rezerve et|reserve)\b/.test(lower) && session && session.lastResults) {
    let pick = session.lastResults[0];
    for (const r of session.lastResults) {
      if (lower.includes(r.name.toLowerCase())) pick = r;
    }
    return { intent: 'confirm', selection: pick };
  }

  const dates = parseDates(text);
  const destination = parseDestination(text);
  const guests = parseGuests(text);
  const amenities = parseAmenities(text);
  const minRating = parseRating(text);
  const maxPrice = parsePriceCeiling(text);

  if (destination && dates) {
    return { intent: 'search', destination, dates, guests, amenities, minRating, maxPrice };
  }
  if (session && session.pending && (amenities.length || minRating || maxPrice)) {
    return {
      intent: 'search',
      destination: session.pending.destination,
      dates: session.pending.dates,
      guests: session.pending.guests,
      amenities, minRating, maxPrice
    };
  }
  if (destination || dates) return { intent: 'partial', destination, dates, guests };
  return { intent: 'unknown' };
}

function ymd(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function stripUndef(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}

/**
 * Rule-based chat turn. Same response contract as the LLM agent.
 */
async function ruleBasedChat(message, incomingSession, authHeader) {
  const intent = parseIntent(message || '', incomingSession);

  if (intent.intent === 'noop' || intent.intent === 'unknown') {
    return {
      reply:
        'Size yardımcı olmak için hangi şehir, hangi tarihler ve kaç misafir için arama yapmamı istersiniz? ' +
        '(örn: "Rome 15-18 Temmuz, 2 yetişkin")',
      actions: [],
      session: incomingSession
    };
  }

  if (intent.intent === 'partial') {
    const merged = { ...(incomingSession.pending || {}), ...stripUndef(intent) };
    const session = { ...incomingSession, pending: merged };
    const need = [];
    if (!merged.destination) need.push('şehir');
    if (!merged.dates) need.push('tarih aralığı');
    if (!merged.guests) need.push('misafir sayısı');
    return { reply: `Harika! Bana ${need.join(' ve ')} bilgisini de verir misiniz?`, actions: [], session };
  }

  if (intent.intent === 'search') {
    const { destination, dates, guests, amenities, minRating, maxPrice } = intent;
    const params = new URLSearchParams({
      destination,
      start: dates.start.toISOString(),
      end: dates.end.toISOString(),
      guests: String(guests || 2)
    });
    const r = await axios.get(`${HOTEL_URL}/v1/search?${params.toString()}`, {
      headers: authHeader ? { Authorization: authHeader } : {}
    });
    let items = r.data.items || [];
    if (minRating) items = items.filter((x) => (x.rating || 0) >= minRating);
    if (maxPrice) items = items.filter((x) => (x.displayPricePerNight || x.basePricePerNight) <= maxPrice);
    if (amenities && amenities.length) {
      items = items.filter((x) => amenities.every((a) => (x.amenities || []).includes(a)));
    }
    items = items.slice(0, 3);

    const session = {
      ...incomingSession,
      pending: null,
      lastResults: items,
      lastQuery: { destination, dates, guests, amenities, minRating, maxPrice }
    };
    return {
      reply: items.length ? 'İşte size uygun birkaç seçenek:' :
        'Tarihlerinize uygun otel bulamadım. Tarihleri veya tercihleri değiştirmek ister misiniz?',
      actions: items.map((it) => ({
        type: 'hotel',
        hotelId: it.hotelId,
        name: it.name,
        city: it.city,
        rating: it.rating,
        pricePerNight: it.displayPricePerNight || it.basePricePerNight,
        amenities: it.amenities,
        buttons: [{ label: 'Reserve Room', action: 'book', payload: { hotelId: it.hotelId } }]
      })),
      followup: items.length
        ? `Would you like to confirm your reservation at ${items[0].name} from ${ymd(dates.start)} - ${ymd(dates.end)} for ${guests || 2} guests?`
        : null,
      session
    };
  }

  if (intent.intent === 'confirm') {
    if (!authHeader) {
      return {
        reply: 'Rezervasyon yapmak için lütfen önce giriş yapın.',
        actions: [{ type: 'requireLogin' }],
        session: incomingSession
      };
    }
    const pick = intent.selection;
    const q = incomingSession.lastQuery;
    if (!pick || !q) {
      return {
        reply: 'Önce bir arama yapalım. Şehir, tarih ve misafir sayısı söyler misiniz?',
        actions: [],
        session: incomingSession
      };
    }
    const r = await axios.post(
      `${HOTEL_URL}/v1/hotels/${pick.hotelId}/book`,
      { roomType: 'Standard', startDate: q.dates.start, endDate: q.dates.end, guests: q.guests || 2 },
      { headers: { Authorization: authHeader } }
    );
    return {
      reply: `Rezervasyonunuz onaylandı! Onay numaranız ${r.data._id}. Toplam ${r.data.totalPrice} TL.`,
      actions: [{ type: 'reservation', reservation: r.data }],
      session: { ...incomingSession, lastResults: null, lastQuery: null }
    };
  }

  return { reply: 'Anlayamadım, tekrar dener misiniz?', actions: [], session: incomingSession };
}

module.exports = { ruleBasedChat };
