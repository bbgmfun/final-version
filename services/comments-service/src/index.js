/**
 * Comments Service
 * ----------------
 * Stores hotel comments and per-service ratings in MongoDB (the
 * non-functional requirement asks for a separate NoSQL DB; we use a
 * dedicated `comments` collection on the shared Mongo cluster but the
 * collection is fully owned by this service - in a production deployment
 * this would point to its own Mongo Atlas / Cosmos DB instance).
 *
 * Endpoints (versioned under /v1):
 *   GET  /v1/hotels/:hotelId/comments?page=&pageSize=
 *   GET  /v1/hotels/:hotelId/comments/summary   -> per-service rating breakdown
 *   POST /v1/hotels/:hotelId/comments           (auth required)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const { requireAuth } = require('./auth');

const PORT = Number(process.env.PORT || 4003);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/hotelbooking';

const SERVICES = ['Temizlik', 'Personel ve servis', 'İmkân ve özellikler', 'Konaklama yeri', 'Çevre dostluğu'];

const commentSchema = new mongoose.Schema(
  {
    hotelId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    userName: { type: String, required: true },
    body: { type: String, required: true },
    overall: { type: Number, required: true, min: 0, max: 10 },
    serviceRatings: {
      type: Map,
      of: Number,
      default: {}
    },
    tripType: { type: String, default: '' }
  },
  { timestamps: true }
);

const Comment = mongoose.model('Comment', commentSchema);

async function connectMongo() {
  let attempts = 0;
  while (attempts < 20) {
    try {
      await mongoose.connect(MONGO_URI, { dbName: 'hotelbooking', autoIndex: false });
      console.log('[comments] mongo connected');
      return;
    } catch (err) {
      attempts += 1;
      console.warn(`[comments] mongo connect failed (attempt ${attempts}):`, err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Could not connect to MongoDB');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'comments' }));

const v1 = express.Router();
v1.get('/health', (_req, res) => res.json({ status: 'ok', service: 'comments' }));

// list with pagination
v1.get('/hotels/:hotelId/comments', async (req, res) => {
  try {
    const { hotelId } = req.params;
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || 10)));
    const all = await Comment.find({ hotelId }).lean();
    all.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const total = all.length;
    const items = all.slice((page - 1) * pageSize, page * pageSize);
    res.json({ total, page, pageSize, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// summary: per-service rating breakdown
v1.get('/hotels/:hotelId/comments/summary', async (req, res) => {
  try {
    const { hotelId } = req.params;
    const comments = await Comment.find({ hotelId }).lean();
    const total = comments.length;
    if (!total) {
      return res.json({
        total: 0,
        overall: 0,
        breakdown: SERVICES.map((s) => ({ service: s, average: 0 }))
      });
    }
    const totals = Object.fromEntries(SERVICES.map((s) => [s, { sum: 0, n: 0 }]));
    let overallSum = 0;
    for (const c of comments) {
      overallSum += c.overall;
      const map = c.serviceRatings || {};
      for (const s of SERVICES) {
        const val = map[s] != null ? map[s] : (map.get ? map.get(s) : undefined);
        if (typeof val === 'number') {
          totals[s].sum += val;
          totals[s].n += 1;
        }
      }
    }
    const breakdown = SERVICES.map((s) => ({
      service: s,
      average: totals[s].n ? round1(totals[s].sum / totals[s].n) : 0,
      count: totals[s].n
    }));
    res.json({
      total,
      overall: round1(overallSum / total),
      breakdown
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

v1.post('/hotels/:hotelId/comments', requireAuth(), async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { body, overall, serviceRatings = {}, tripType = '' } = req.body || {};
    if (!body || overall == null) {
      return res.status(400).json({ error: 'body and overall rating required' });
    }
    const doc = await Comment.create({
      hotelId,
      userId: req.user.sub,
      userName: req.user.email,
      body,
      overall,
      serviceRatings,
      tripType
    });
    res.status(201).json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.use('/v1', v1);

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function seed() {
  const count = await Comment.estimatedDocumentCount();
  if (count > 0) return;
  console.log('[comments] seeding sample comments');
  const samples = [
    {
      hotelId: 'hyde-bodrum',
      userId: 'seed',
      userName: 'Simge',
      body: 'Harika bir konaklama, personel çok ilgiliydi.',
      overall: 8,
      serviceRatings: {
        'Temizlik': 9.6,
        'Personel ve servis': 9.6,
        'İmkân ve özellikler': 9.4,
        'Konaklama yeri': 9.6,
        'Çevre dostluğu': 9.4
      },
      tripType: '4 gecelik seyahat'
    },
    {
      hotelId: 'hyde-bodrum',
      userId: 'seed',
      userName: 'Ahmet',
      body: 'Yetişkin konsepti çok keyifliydi.',
      overall: 9.4,
      serviceRatings: {
        'Temizlik': 9.5,
        'Personel ve servis': 9.7,
        'İmkân ve özellikler': 9.3,
        'Konaklama yeri': 9.7,
        'Çevre dostluğu': 9.2
      },
      tripType: '2 gecelik seyahat'
    },
    {
      hotelId: 'roma-plaza',
      userId: 'seed',
      userName: 'Maria',
      body: 'Great location near city centre, breakfast was excellent.',
      overall: 9.0,
      serviceRatings: {
        'Temizlik': 9.0,
        'Personel ve servis': 9.2,
        'İmkân ve özellikler': 8.8,
        'Konaklama yeri': 9.4,
        'Çevre dostluğu': 8.5
      }
    }
  ];
  await Comment.insertMany(samples);
}

(async () => {
  await connectMongo();
  await seed();
  app.listen(PORT, () => console.log(`[comments] listening on :${PORT}`));
})().catch((err) => {
  console.error('[comments] fatal', err);
  process.exit(1);
});
