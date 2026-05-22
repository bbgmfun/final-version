/**
 * Hotel Service
 * -------------
 * Implements:
 *   - Hotel Admin Service (authenticated)  - PUT /v1/admin/hotels/:id, POST/PUT rooms
 *   - Hotel Search Service                 - GET  /v1/search (15% discount for logged-in)
 *   - Book Hotel Service                   - POST /v1/hotels/:id/book (auth required, decrements capacity, queues message)
 *
 * Hotel details are cached in Redis (distributed cache) with in-memory fallback.
 * New reservations are published to RabbitMQ `reservations` queue for the notification service.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');

const adminRoutes = require('./routes.admin');
const searchRoutes = require('./routes.search');
const bookRoutes = require('./routes.book');
const { connect: connectQueue } = require('./queue');
const { seedSampleHotels } = require('./seed');

const PORT = Number(process.env.PORT || 4002);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/hotelbooking';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'hotel' }));

const v1 = express.Router();
v1.use('/admin', adminRoutes);
v1.use('/', searchRoutes);
v1.use('/', bookRoutes);
v1.get('/health', (_req, res) => res.json({ status: 'ok', service: 'hotel' }));
app.use('/v1', v1);

async function connectMongo() {
  let attempts = 0;
  while (attempts < 20) {
    try {
      await mongoose.connect(MONGO_URI, { dbName: 'hotelbooking', autoIndex: false });
      console.log('[hotel] mongo connected');
      return;
    } catch (err) {
      attempts += 1;
      console.warn(`[hotel] mongo connect failed (attempt ${attempts}):`, err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Could not connect to MongoDB');
}

(async () => {
  await connectMongo();
  await seedSampleHotels();
  connectQueue().catch((err) => console.warn('[hotel] queue connect failed', err.message));
  app.listen(PORT, () => console.log(`[hotel] listening on :${PORT}`));
})().catch((err) => {
  console.error('[hotel] fatal', err);
  process.exit(1);
});
