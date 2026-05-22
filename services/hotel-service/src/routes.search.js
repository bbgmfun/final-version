const express = require('express');
const { Hotel, RoomInventory } = require('./models');
const { getJSON, setJSON } = require('./cache');
const { optionalAuth } = require('./auth');

const router = express.Router();

const LOGIN_DISCOUNT = Number(process.env.LOGIN_DISCOUNT || 0.15);

router.use(optionalAuth);

// GET /search?destination=Bodrum&start=2026-07-15&end=2026-07-18&guests=2&page=1&pageSize=10
router.get('/search', async (req, res) => {
  try {
    const destination = canonicalDestination(req.query.destination || '');
    const start = req.query.start ? new Date(req.query.start) : null;
    const end = req.query.end ? new Date(req.query.end) : null;
    const guests = Number(req.query.guests || 1);
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || 10)));

    if (!destination || !start || !end) {
      return res.status(400).json({ error: 'destination, start and end are required' });
    }
    if (end <= start) {
      return res.status(400).json({ error: 'end must be after start' });
    }

    const cacheKey = `search:${destination.toLowerCase()}:${start.toISOString()}:${end.toISOString()}:${guests}:p${page}:s${pageSize}`;
    let payload = await getJSON(cacheKey);

    if (!payload) {
      // Find hotels in the destination city
      const hotels = await Hotel.find({
        city: { $regex: new RegExp(`^${escapeRegex(destination)}`, 'i') }
      }).lean();

      const hotelIds = hotels.map((h) => h._id);

      // Find inventory that covers the entire requested window and is "Bos"
      const inventories = await RoomInventory.find({
        hotelId: { $in: hotelIds },
        startDate: { $lte: start },
        endDate: { $gte: end },
        availableRooms: { $gt: 0 },
        status: 'Bos'
      }).lean();

      const byHotel = new Map();
      for (const inv of inventories) {
        const list = byHotel.get(inv.hotelId) || [];
        list.push(inv);
        byHotel.set(inv.hotelId, list);
      }

      const nights = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)));

      const results = [];
      for (const h of hotels) {
        const invs = byHotel.get(h._id);
        if (!invs || invs.length === 0) continue;
        const cheapest = invs.reduce((m, x) => (x.pricePerNight < m.pricePerNight ? x : m), invs[0]);
        results.push({
          hotelId: h._id,
          name: h.name,
          city: h.city,
          country: h.country,
          imageUrl: h.imageUrl,
          location: h.location,
          rating: h.rating,
          amenities: h.amenities,
          fromRoomType: cheapest.roomType,
          basePricePerNight: cheapest.pricePerNight,
          basePriceTotal: cheapest.pricePerNight * nights,
          nights,
          availableRoomCount: invs.reduce((s, x) => s + x.availableRooms, 0)
        });
      }

      payload = {
        total: results.length,
        page,
        pageSize,
        nights,
        items: results.slice((page - 1) * pageSize, page * pageSize)
      };
      await setJSON(cacheKey, payload);
    }

    // Apply login-discount on the fly (we don't cache user-specific prices)
    const loggedIn = !!req.user;
    const discount = loggedIn ? LOGIN_DISCOUNT : 0;
    const items = payload.items.map((it) => ({
      ...it,
      loggedIn,
      discount,
      displayPricePerNight: round2(it.basePricePerNight * (1 - discount)),
      displayPriceTotal: round2(it.basePriceTotal * (1 - discount))
    }));

    res.json({ ...payload, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /hotels/:hotelId  - detail view (uses Redis cache)
router.get('/hotels/:hotelId', async (req, res) => {
  try {
    const { hotelId } = req.params;
    const cacheKey = `hotel:${hotelId}`;
    let payload = await getJSON(cacheKey);
    if (!payload) {
      const hotel = await Hotel.findById(hotelId).lean();
      if (!hotel) return res.status(404).json({ error: 'hotel not found' });
      console.log('[hotel] finding rooms for', hotelId);
      let rooms;
      try {
        rooms = await RoomInventory.find({ hotelId, status: 'Bos' }).lean();
        console.log('[hotel] rooms found count=', (rooms && rooms.length) || 0);
      } catch (dbErr) {
        console.error('[hotel] RoomInventory.find ERROR', dbErr && dbErr.message ? dbErr.message : dbErr);
        throw dbErr;
      }
      try { rooms = rooms.sort((a, b) => (a.pricePerNight || 0) - (b.pricePerNight || 0)); } catch (e) { /* ignore sort errors */ }
      payload = { ...hotel, rooms };
      await setJSON(cacheKey, payload);
    }

    // Login discount applied dynamically
    const loggedIn = !!req.user;
    const discount = loggedIn ? LOGIN_DISCOUNT : 0;
    const rooms = (payload.rooms || []).map((r) => ({
      ...r,
      displayPricePerNight: round2(r.pricePerNight * (1 - discount))
    }));
    res.json({ ...payload, rooms, loggedIn, discount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

function round2(n) {
  return Math.round(n * 100) / 100;
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    .toLowerCase()
    .trim();
}
function canonicalDestination(input) {
  const aliases = {
    bodrum: 'Bodrum',
    rome: 'Rome',
    roma: 'Rome',
    istanbul: 'Istanbul',
    izmir: 'Izmir'
  };
  return aliases[foldText(input)] || String(input || '').trim();
}

module.exports = router;
