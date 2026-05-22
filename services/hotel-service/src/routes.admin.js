const express = require('express');
const { Hotel, RoomInventory } = require('./models');
const { invalidatePrefix } = require('./cache');
const { requireAuth } = require('./auth');

const router = express.Router();

// All admin routes require an authenticated admin
router.use(requireAuth('admin'));

// Upsert a hotel
router.put('/hotels/:hotelId', async (req, res) => {
  try {
    const { hotelId } = req.params;
    const body = req.body || {};
    const update = {
      name: body.name || hotelId,
      city: body.city || 'Bodrum',
      country: body.country || 'Türkiye',
      description: body.description || '',
      imageUrl: body.imageUrl || '',
      location: body.location || undefined,
      amenities: body.amenities || [],
      rating: body.rating || 0
    };
    const hotel = await Hotel.findOneAndUpdate(
      { _id: hotelId },
      { $set: update, $setOnInsert: { _id: hotelId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await invalidatePrefix('hotel:');
    res.json(hotel);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Add or update room inventory for a date range
router.post('/hotels/:hotelId/rooms', async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { roomType, startDate, endDate, totalRooms, pricePerNight, status } = req.body || {};
    if (!roomType || !startDate || !endDate || totalRooms == null || pricePerNight == null) {
      return res.status(400).json({ error: 'missing required fields' });
    }
    const doc = await RoomInventory.create({
      hotelId,
      roomType,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      totalRooms,
      availableRooms: totalRooms,
      pricePerNight,
      status: status || 'Bos'
    });
    await invalidatePrefix('search:');
    await invalidatePrefix(`hotel:${hotelId}`);
    res.status(201).json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.put('/hotels/:hotelId/rooms/:roomId', async (req, res) => {
  try {
    const { hotelId, roomId } = req.params;
    const { roomType, startDate, endDate, totalRooms, pricePerNight, status } = req.body || {};
    const update = {};
    if (roomType) update.roomType = roomType;
    if (startDate) update.startDate = new Date(startDate);
    if (endDate) update.endDate = new Date(endDate);
    if (totalRooms != null) {
      update.totalRooms = totalRooms;
      // If admin reset capacity, also reset available to total (simple semantics)
      update.availableRooms = totalRooms;
    }
    if (pricePerNight != null) update.pricePerNight = pricePerNight;
    if (status) update.status = status;

    const doc = await RoomInventory.findOneAndUpdate(
      { _id: roomId, hotelId },
      { $set: update },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'inventory not found' });
    await invalidatePrefix('search:');
    await invalidatePrefix(`hotel:${hotelId}`);
    res.json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/hotels/:hotelId/rooms', async (req, res) => {
  try {
    const { hotelId } = req.params;
    const rooms = await RoomInventory.find({ hotelId }).lean();
    rooms.sort((a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0));
    res.json({ items: rooms });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
