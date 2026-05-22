/**
 * Entra ID (Microsoft Identity) auth middleware.
 * ----------------------------------------------
 * Verifies the bearer token issued by Microsoft Entra ID using the tenant's
 * public JWKS keys. No local password store, no shared secret — the only
 * trust anchor is Microsoft's signing keys.
 *
 * Role model: Entra does not know about our app's "admin" concept, so we
 * derive the role from the ADMIN_EMAILS allow-list (env). An admin's managed
 * hotels come from ADMIN_HOTEL_IDS (env).
 */

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const TENANT_ID = process.env.ENTRA_TENANT_ID || '';
const CLIENT_ID = process.env.ENTRA_CLIENT_ID || '';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ADMIN_HOTEL_IDS = (process.env.ADMIN_HOTEL_IDS || 'hotel-swiss')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Entra v2 issuer + JWKS endpoint for this tenant
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const JWKS_URI = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;

const client = jwksClient({
  jwksUri: JWKS_URI,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000,
  rateLimit: true
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        // ID tokens are audience = client id. We accept either the bare
        // client id or the api://<client-id> form so the same code works
        // if you later switch to a custom-scoped access token.
        audience: [CLIENT_ID, `api://${CLIENT_ID}`],
        issuer: ISSUER,
        algorithms: ['RS256']
      },
      (err, payload) => {
        if (err) return reject(err);
        resolve(payload);
      }
    );
  });
}

function principalFromClaims(claims) {
  const email = String(claims.email || claims.preferred_username || claims.upn || '').toLowerCase();
  const role = ADMIN_EMAILS.includes(email) ? 'admin' : 'user';
  return {
    sub: claims.oid || claims.sub,
    email,
    name: claims.name || email,
    role,
    hotelIds: role === 'admin' ? ADMIN_HOTEL_IDS : []
  };
}

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function requireAuth(role = null) {
  return async (req, res, next) => {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
      const claims = await verifyToken(token);
      const user = principalFromClaims(claims);
      if (role && user.role !== role) return res.status(403).json({ error: 'forbidden' });
      req.user = user;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'invalid token', detail: err.message });
    }
  };
}

async function optionalAuth(req, _res, next) {
  const token = bearer(req);
  if (!token) return next();
  try {
    const claims = await verifyToken(token);
    req.user = principalFromClaims(claims);
  } catch {
    /* ignore — treat as anonymous */
  }
  next();
}

module.exports = { requireAuth, optionalAuth, verifyToken, principalFromClaims };
