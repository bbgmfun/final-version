/**
 * API Gateway
 * -----------
 * Single public entry-point for the client. Routes versioned `/v1/...` paths
 * to the appropriate internal service. All REST APIs use the `/v1` prefix and
 * support pagination via `?page=&pageSize=`.
 *
 * Each proxy is mounted at the root with a `pathFilter` predicate. This is
 * important: mounting with `app.use('/v1/xxx', proxy)` makes Express strip the
 * prefix before the proxy sees it, so the upstream would receive `/` instead
 * of `/v1/xxx`. With a root mount + pathFilter the FULL original path is
 * forwarded unchanged.
 *
 * Routing table:
 *   /v1/auth/*                 -> iam-service
 *   /v1/hotels/:id/comments*   -> comments-service   (checked before /v1/hotels)
 *   /v1/notifications, /v1/jobs-> notification-service
 *   /v1/chat                   -> ai-agent-service
 *   /v1/admin, /v1/search,
 *   /v1/reservations, /v1/hotels -> hotel-service
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = Number(process.env.PORT || 8080);
const IAM_URL = process.env.IAM_URL || 'http://iam-service:4001';
const HOTEL_URL = process.env.HOTEL_URL || 'http://hotel-service:4002';
const COMMENTS_URL = process.env.COMMENTS_URL || 'http://comments-service:4003';
const NOTIFICATION_URL = process.env.NOTIFICATION_URL || 'http://notification-service:4004';
const AI_AGENT_URL = process.env.AI_AGENT_URL || 'http://ai-agent-service:4005';

const app = express();
app.use(cors());
app.use(morgan('dev'));

// Health endpoints (matched before the proxies).
app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    service: 'api-gateway',
    upstreams: { IAM_URL, HOTEL_URL, COMMENTS_URL, NOTIFICATION_URL, AI_AGENT_URL }
  })
);
app.get('/v1/health', (_req, res) => res.json({ status: 'ok', service: 'api-gateway' }));
app.get('/v1', (_req, res) =>
  res.json({
    status: 'ok',
    service: 'api-gateway',
    version: 'v1',
    endpoints: [
      'GET  /v1/health',
      'GET  /v1/auth/me',
      'GET  /v1/search',
      'GET  /v1/hotels/:id',
      'POST /v1/hotels/:id/book',
      'GET  /v1/reservations',
      'GET  /v1/hotels/:id/comments',
      'GET  /v1/hotels/:id/comments/summary',
      'POST /v1/hotels/:id/comments',
      'POST /v1/admin/hotels/:id/rooms',
      'GET  /v1/notifications',
      'POST /v1/jobs/capacity-scan',
      'POST /v1/chat'
    ]
  })
);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host'
]);

function filteredHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', reject);
  });
}

function forwardWithFetch(predicate, target) {
  app.use(async (req, res, next) => {
    if (!predicate(req.path)) return next();
    try {
      const upstreamUrl = new URL(req.originalUrl, target);
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers: filteredHeaders(req.headers),
        body,
        redirect: 'manual'
      });
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch (err) {
      console.error('[gateway] fetch forward failed:', err.message);
      res.status(503).json({ error: 'upstream unavailable', detail: err.message });
    }
  });
}

// Mount a proxy at the root that only handles paths matching `predicate`.
// The full original path is forwarded to the target unchanged.
function route(predicate, target) {
  app.use(
    createProxyMiddleware({
      target,
      changeOrigin: true,
      xfwd: true,
      logLevel: 'warn',
      pathFilter: (path) => predicate(path.split('?')[0])
    })
  );
}

// Order matters — the first matching proxy handles the request.
// Comments is more specific than /v1/hotels, so it is registered first.
route((p) => /^\/v1\/hotels\/[^/]+\/comments(\/|$)/.test(p), COMMENTS_URL);
route((p) => p.startsWith('/v1/auth'), IAM_URL);
forwardWithFetch((p) => p.startsWith('/v1/notifications') || p.startsWith('/v1/jobs'), NOTIFICATION_URL);
route((p) => p.startsWith('/v1/chat'), AI_AGENT_URL);
route(
  (p) =>
    p.startsWith('/v1/admin') ||
    p.startsWith('/v1/search') ||
    p.startsWith('/v1/reservations') ||
    p.startsWith('/v1/hotels'),
  HOTEL_URL
);

app.listen(PORT, () => {
  console.log(`[gateway] listening on :${PORT}`);
  console.log('[gateway] routes ->');
  console.log('  /v1/auth/*                   ->', IAM_URL);
  console.log('  /v1/hotels/:id/comments*     ->', COMMENTS_URL);
  console.log('  /v1/notifications, /v1/jobs  ->', NOTIFICATION_URL);
  console.log('  /v1/chat                     ->', AI_AGENT_URL);
  console.log('  /v1/admin, /v1/search,');
  console.log('  /v1/reservations, /v1/hotels ->', HOTEL_URL);
});
