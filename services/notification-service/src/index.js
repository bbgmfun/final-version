/**
 * Notification Service
 * --------------------
 * Two scheduled responsibilities (per spec):
 *   1) Nightly job: scan all hotel capacities and notify admins when, for any room
 *      type, the availability for the next month falls below 20%.
 *   2) Queue drain: pull new reservations from the `reservations` RabbitMQ queue
 *      and "send" the user a confirmation message. We persist every notification
 *      to Mongo so it can be inspected from the API and shown in the UI.
 *
 * Notifications are written to the `notifications` collection. In production we
 * would forward them to SES / SendGrid / Twilio; here we log + persist them.
 *
 * Endpoints:
 *   GET /v1/notifications?to=email&limit=
 *   POST /v1/jobs/capacity-scan        (manual trigger for demos)
 *   POST /v1/jobs/drain                 (manual trigger for demos)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const amqp = require('amqplib');
const { CronJob } = require('cron');

const PORT = Number(process.env.PORT || 4004);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/hotelbooking';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';
const RESERVATION_QUEUE = process.env.RESERVATION_QUEUE || 'reservations';
const NIGHTLY_CRON = process.env.NIGHTLY_CRON || '0 2 * * *';
const RESERVATION_DRAIN_CRON = process.env.RESERVATION_DRAIN_CRON || '*/1 * * * *';
const CAPACITY_ALERT_THRESHOLD = Number(process.env.CAPACITY_ALERT_THRESHOLD || 0.2);

// ---------- Models (re-declared locally so the service owns its schema) ----------
const notificationSchema = new mongoose.Schema(
  {
    to: { type: String, required: true, index: true },
    channel: { type: String, enum: ['email', 'sms', 'in-app'], default: 'email' },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    meta: { type: Object, default: {} },
    sentAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);
const Notification = mongoose.model('Notification', notificationSchema);

// Reference models for the nightly capacity scan (read-only here)
const hotelSchema = new mongoose.Schema(
  {
    _id: { type: String },
    name: String,
    city: String
  },
  { _id: false, strict: false }
);
const roomInventorySchema = new mongoose.Schema(
  {
    hotelId: String,
    roomType: String,
    startDate: Date,
    endDate: Date,
    totalRooms: Number,
    availableRooms: Number,
    status: String
  },
  { strict: false }
);
const Hotel = mongoose.model('Hotel', hotelSchema);
const RoomInventory = mongoose.model('RoomInventory', roomInventorySchema);

async function connectMongo() {
  let attempts = 0;
  while (attempts < 20) {
    try {
      await mongoose.connect(MONGO_URI, { dbName: 'hotelbooking', autoIndex: false });
      console.log('[notify] mongo connected');
      return;
    } catch (err) {
      attempts += 1;
      console.warn(`[notify] mongo connect failed (attempt ${attempts}):`, err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Could not connect to MongoDB');
}

// ---------- RabbitMQ consumer ----------
let channel = null;
async function connectQueue() {
  let attempts = 0;
  while (attempts < 30) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      conn.on('close', () => {
        console.warn('[notify] rabbitmq closed, reconnecting');
        channel = null;
        setTimeout(connectQueue, 3000);
      });
      const ch = await conn.createChannel();
      await ch.assertQueue(RESERVATION_QUEUE, { durable: true });
      await ch.prefetch(10);
      ch.consume(RESERVATION_QUEUE, async (msg) => {
        if (!msg) return;
        try {
          const payload = JSON.parse(msg.content.toString());
          await handleReservation(payload);
          ch.ack(msg);
        } catch (err) {
          console.error('[notify] consume error', err);
          ch.nack(msg, false, false); // drop the bad message
        }
      });
      channel = ch;
      console.log('[notify] consuming from', RESERVATION_QUEUE);
      return;
    } catch (err) {
      attempts += 1;
      console.warn(`[notify] rabbitmq connect failed (attempt ${attempts}):`, err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function handleReservation(p) {
  const subject = `Rezervasyonunuz onaylandı: ${p.hotelName || p.hotelId}`;
  const body =
    `Sayın ${p.userEmail},\n\n` +
    `${p.hotelName || p.hotelId} otelinde ${formatDate(p.startDate)} - ${formatDate(p.endDate)} ` +
    `tarihleri için ${p.roomType} oda rezervasyonunuz onaylandı.\n` +
    `Misafir sayısı: ${p.guests}\nToplam ücret: ${p.totalPrice} TL\n\n` +
    `Rezervasyon No: ${p.reservationId}\n\nİyi tatiller dileriz!`;
  await Notification.create({
    to: p.userEmail,
    channel: 'email',
    subject,
    body,
    meta: { reservationId: p.reservationId, hotelId: p.hotelId }
  });
  console.log('[notify] -> sent reservation email to', p.userEmail);
}

// ---------- Nightly capacity scan ----------
async function capacityScan() {
  console.log('[notify] running nightly capacity scan');
  const now = new Date();
  const monthLater = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30);

  // For every active inventory window in the next 30 days, compute
  // remaining ratio. Group by hotel to issue one email per hotel.
  const inventories = await RoomInventory.find({
    endDate: { $gte: now },
    startDate: { $lte: monthLater }
  }).lean();

  const byHotel = new Map();
  for (const inv of inventories) {
    if (!inv.totalRooms) continue;
    const ratio = (inv.availableRooms || 0) / inv.totalRooms;
    if (ratio < CAPACITY_ALERT_THRESHOLD) {
      const list = byHotel.get(inv.hotelId) || [];
      list.push({ ...inv, ratio });
      byHotel.set(inv.hotelId, list);
    }
  }

  let sent = 0;
  for (const [hotelId, low] of byHotel.entries()) {
    const hotel = await Hotel.findById(hotelId).lean();
    const lines = low.map(
      (r) =>
        `• ${r.roomType}: ${r.availableRooms}/${r.totalRooms} (${Math.round(r.ratio * 100)}%) ` +
        `tarih ${formatDate(r.startDate)} - ${formatDate(r.endDate)}`
    );
    await Notification.create({
      to: `admin+${hotelId}@hotelswiss.com`,
      channel: 'email',
      subject: `[Kapasite uyarısı] ${hotel ? hotel.name : hotelId} doluluğu %20 altında`,
      body:
        `Aşağıdaki oda tipleri için önümüzdeki 30 günde doluluk eşiğin altına düştü:\n\n` +
        lines.join('\n') +
        `\n\nLütfen kapasite/satış stratejinizi gözden geçirin.`,
      meta: { hotelId, kind: 'capacity-alert', rows: low.length }
    });
    sent += 1;
  }
  console.log(`[notify] capacity scan done; ${sent} alert(s) generated`);
  return { hotelsAlerted: sent };
}

// ---------- HTTP ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'notification' }));

const v1 = express.Router();
v1.get('/health', (_req, res) => res.json({ status: 'ok', service: 'notification' }));

v1.get('/notifications', async (req, res) => {
  try {
    const to = req.query.to;
    const limit = Math.min(100, Number(req.query.limit || 20));
    const filter = to ? { to } : {};
    const items = await Notification.find(filter).lean();
    items.sort((a, b) => new Date(b.sentAt || b.createdAt || 0) - new Date(a.sentAt || a.createdAt || 0));
    res.json({ items: items.slice(0, limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

v1.post('/jobs/capacity-scan', async (_req, res) => {
  try {
    const result = await capacityScan();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Note: drain is automatic via the queue consumer. This endpoint exists for demos.
v1.post('/jobs/drain', async (_req, res) => {
  if (!channel) return res.status(503).json({ error: 'queue not connected' });
  res.json({ ok: true, info: 'consumer is always-on; messages are drained continuously' });
});

app.use('/v1', v1);

function formatDate(d) {
  const dt = new Date(d);
  return dt.toISOString().slice(0, 10);
}

(async () => {
  await connectMongo();
  await connectQueue();

  new CronJob(NIGHTLY_CRON, () => capacityScan().catch((e) => console.error(e)), null, true);
  console.log('[notify] nightly capacity scan scheduled:', NIGHTLY_CRON);

  // Run capacity scan once at boot for demo convenience (in addition to cron)
  setTimeout(() => capacityScan().catch((e) => console.warn('[notify] initial scan failed', e.message)), 10000);

  app.listen(PORT, () => console.log(`[notify] listening on :${PORT}`));
})().catch((err) => {
  console.error('[notify] fatal', err);
  process.exit(1);
});
