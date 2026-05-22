/**
 * Entra ID auth middleware (comments-service copy).
 * Verifies Microsoft Entra ID bearer tokens via the tenant JWKS keys.
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
    role
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

module.exports = { requireAuth, verifyToken, principalFromClaims };
