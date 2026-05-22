const express = require('express');
const { Hotel, RoomInventory, Reservation } = require('./models');
const { invalidatePrefix } = require('./cache');
const { requireAuth } = require('./auth');
const { publishReservation } = require('./queue');

const router = express.Router();
const LOGIN_DISCOUNT = Number(process.env.LOGIN_DISCOUNT || 0.15);

router.use(requireAuth());

// POST /hotels/:hotelId/book
router.post('/hotels/:hotelId/book', async (req, res) => {
  const { hotelId } = req.params;
  const { roomType, startDate, endDate, guests = 2 } = req.body || {};
  if (!roomType || !startDate || !endDate) {
    return res.status(400).json({ error: 'roomType, startDate, endDate required' });
  }
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end <= start) return res.status(400).json({ error: 'end must be after start' });

  try {
    // Atomic capacity decrement. A single findOneAndUpdate with the
    // `availableRooms: { $gt: 0 }` guard is itself concurrency-safe, so no
    // multi-document transaction is needed — this keeps the booking flow
    // compatible with Azure Cosmos DB for MongoDB.
    const inv = await RoomInventory.findOneAndUpdate(
      {
        hotelId,
        roomType,
        startDate: { $lte: start },
        endDate: { $gte: end },
        availableRooms: { $gt: 0 },
        status: 'Bos'
      },
      { $inc: { availableRooms: -1 } },
      { new: true }
    );
    if (!inv) {
      return res.status(409).json({ error: 'no availability for requested dates/room' });
    }

    const nights = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)));
    const totalPrice = round2(inv.pricePerNight * nights * (1 - LOGIN_DISCOUNT));
    const hotel = await Hotel.findById(hotelId);

    let reservation;
    try {
      reservation = await Reservation.create({
        hotelId,
        userId: req.user.sub,
        userEmail: req.user.email,
        roomType,
        startDate: start,
        endDate: end,
        guests,
        totalPrice
      });
    } catch (err) {
      // Compensating action: give the room back if the reservation insert failed.
      await RoomInventory.updateOne({ _id: inv._id }, { $inc: { availableRooms: 1 } });
      throw err;
    }

    // Publish to the reservation queue (best-effort).
    publishReservation({
      type: 'reservation.confirmed',
      reservationId: reservation._id.toString(),
      hotelId,
      hotelName: hotel ? hotel.name : hotelId,
      userId: req.user.sub,
      userEmail: req.user.email,
      roomType,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      guests,
      totalPrice
    });

    await invalidatePrefix('search:');
    await invalidatePrefix(`hotel:${hotelId}`);
    res.status(201).json(reservation);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /reservations  - reservations for the current user
router.get('/reservations', async (req, res) => {
  try {
    const items = await Reservation.find({ userId: req.user.sub }).lean();
    items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = router;
