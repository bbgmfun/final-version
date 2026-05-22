const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const TTL_SECONDS = Number(process.env.HOTEL_CACHE_TTL || 300);

// Lazy redis with retry strategy. Falls back to in-memory if redis is down.
const redis = new Redis(REDIS_URL, {
  lazyConnect: false,
  maxRetriesPerRequest: 2,
  retryStrategy: (times) => Math.min(times * 200, 3000)
});

const memoryCache = new Map();

redis.on('error', (err) => {
  // Don't crash the service on redis blips. We fall back to memory.
  console.warn('[hotel] redis error:', err.code || err.message);
});

async function getJSON(key) {
  try {
    const v = await redis.get(key);
    if (v) return JSON.parse(v);
  } catch (err) {
    const memHit = memoryCache.get(key);
    if (memHit && memHit.exp > Date.now()) return memHit.value;
  }
  return null;
}

async function setJSON(key, value, ttl = TTL_SECONDS) {
  const json = JSON.stringify(value);
  try {
    await redis.set(key, json, 'EX', ttl);
  } catch (err) {
    memoryCache.set(key, { value, exp: Date.now() + ttl * 1000 });
  }
}

async function invalidatePrefix(prefix) {
  try {
    const stream = redis.scanStream({ match: `${prefix}*`, count: 100 });
    for await (const keys of stream) {
      if (keys.length) await redis.del(keys);
    }
  } catch (err) {
    for (const k of [...memoryCache.keys()]) {
      if (k.startsWith(prefix)) memoryCache.delete(k);
    }
  }
}

module.exports = { redis, getJSON, setJSON, invalidatePrefix };
