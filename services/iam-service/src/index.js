/**
 * IAM / User-Profile Service
 * --------------------------
 * Authentication itself is fully delegated to **Microsoft Entra ID** — there
 * is NO local password store. Microsoft issues the tokens; every service in
 * this system verifies them against the Entra JWKS keys.
 *
 * What this service still owns:
 *   - Resolving an Entra identity to our app's profile (role + managed hotels)
 *   - A first-login "upsert" so we keep a local record of who has signed in
 *     (useful for the admin to see users, and to store app preferences later)
 *
 * Endpoints (versioned under /v1):
 *   GET  /v1/auth/me        Authorization: Bearer <Entra token>  -> { user }
 *   GET  /v1/auth/verify    Authorization: Bearer <Entra token>  -> { user, claims }
 *   GET  /v1/users          (admin only) list of seen users
 *   GET  /v1/health
 *
 * Role is derived from the ADMIN_EMAILS allow-list (env). This keeps the
 * app's authorization model independent of Entra's directory roles, which
 * is the documented assumption in the README.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const { requireAuth } = require('./auth');

const PORT = Number(process.env.PORT || 4001);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/hotelbooking';

// ---------- Mongo ----------
// We keep a lightweight profile record keyed by the Entra object id (oid).
const profileSchema = new mongoose.Schema(
  {
    _id: { type: String }, // Entra oid
    email: { type: String, index: true },
    name: { type: String },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    hotelIds: [{ type: String }],
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now }
  },
  { _id: false, timestamps: true }
);
const Profile = mongoose.model('Profile', profileSchema);

async function connectMongo() {
  let attempts = 0;
  while (attempts < 20) {
    try {
      await mongoose.connect(MONGO_URI, { dbName: 'hotelbooking', autoIndex: false });
      console.log('[iam] mongo connected');
      return;
    } catch (err) {
      attempts += 1;
      console.warn(`[iam] mongo connect failed (attempt ${attempts}):`, err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Could not connect to MongoDB');
}

async function upsertProfile(user) {
  try {
    await Profile.findOneAndUpdate(
      { _id: user.sub },
      {
        $set: { email: user.email, name: user.name, role: user.role, hotelIds: user.hotelIds, lastSeenAt: new Date() },
        $setOnInsert: { _id: user.sub, firstSeenAt: new Date() }
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.warn('[iam] profile upsert failed:', err.message);
  }
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'iam' }));

const v1 = express.Router();
v1.get('/health', (_req, res) => res.json({ status: 'ok', service: 'iam' }));

// Canonical "who am I" — the frontend calls this right after Entra login.
v1.get('/auth/me', requireAuth(), async (req, res) => {
  await upsertProfile(req.user);
  res.json({ user: req.user });
});

// Same identity check but also returns the raw Entra claims (debug aid).
v1.get('/auth/verify', requireAuth(), (req, res) => {
  res.json({ user: req.user, claims: req.claims });
});

// Admin-only: list every Entra user that has signed in at least once.
v1.get('/users', requireAuth('admin'), async (_req, res) => {
  try {
    const items = await Profile.find().lean();
    items.sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

app.use('/v1', v1);

(async () => {
  await connectMongo();
  app.listen(PORT, () => {
    console.log(`[iam] listening on :${PORT}`);
    console.log('[iam] auth provider: Microsoft Entra ID (tenant ' + (process.env.ENTRA_TENANT_ID || 'NOT SET') + ')');
  });
})().catch((err) => {
  console.error('[iam] fatal', err);
  process.exit(1);
});
