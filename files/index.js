import crypto from 'node:crypto';
import express from 'express';
import Redis from 'ioredis';
import pg from 'pg';

const {
  PORT = 3003,
  DATABASE_URL,
  REDIS_URL,
  CACHE_TTL = 3600,        // seconds a found URL stays cached
  NEG_TTL = 60,            // seconds a "not found" stays cached
  IP_HASH_SALT = 'change-me',
} = process.env;

const NOT_FOUND = '__404__';
const CODE_RE = /^[A-Za-z0-9_-]{4,10}$/;

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
redis.on('error', (err) => console.error('redis error:', err.message));
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

const app = express();
app.disable('x-powered-by');

// Not matched by the gateway's short-code regex, so it is internal only.
app.get('/_/health', (_req, res) => res.json({ ok: true }));

app.get('/:code', async (req, res) => {
  const { code } = req.params;
  if (!CODE_RE.test(code)) return res.status(404).send('Not found');

  const longUrl = await resolve(code);
  if (!longUrl) return res.status(404).send('Not found');

  publishClick(req, code); // fire and forget: never await on the hot path
  res.redirect(302, longUrl); // 302 (not 301) so every click reaches us and is counted
});

async function resolve(code) {
  const key = `url:${code}`;

  // 1. cache
  try {
    const cached = await redis.get(key);
    if (cached === NOT_FOUND) return null;
    if (cached) return cached;
  } catch (err) {
    console.error('cache read failed, falling back to db:', err.message);
  }

  // 2. database
  const { rows } = await pool.query(
    `SELECT long_url, expires_at
       FROM urls
      WHERE code = $1
        AND is_active
        AND (expires_at IS NULL OR expires_at > now())`,
    [code],
  );

  if (rows.length === 0) {
    redis.set(key, NOT_FOUND, 'EX', Number(NEG_TTL)).catch(() => {});
    return null;
  }

  const { long_url: longUrl, expires_at: expiresAt } = rows[0];

  // never cache past the link's own expiry
  let ttl = Number(CACHE_TTL);
  if (expiresAt) {
    const secondsLeft = Math.floor((new Date(expiresAt) - Date.now()) / 1000);
    ttl = Math.min(ttl, Math.max(secondsLeft, 1));
  }
  redis.set(key, longUrl, 'EX', ttl).catch(() => {});
  return longUrl;
}

function publishClick(req, code) {
  const ip = req.get('x-real-ip') || req.ip || '';
  const ipHash = crypto.createHash('sha256').update(IP_HASH_SALT + ip).digest('hex').slice(0, 32);

  redis
    .xadd(
      'clicks', 'MAXLEN', '~', 100000, '*',
      'code', code,
      'ts', new Date().toISOString(),
      'referrer', req.get('referer') || '',
      'ua', (req.get('user-agent') || '').slice(0, 300),
      'ip_hash', ipHash,
    )
    .catch((err) => console.error('click publish failed:', err.message));
}

// Express 5 forwards rejected promises from async handlers here automatically.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send('Internal error');
});

const server = app.listen(PORT, () => console.log(`redirect service on :${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(async () => {
      await pool.end();
      redis.disconnect();
      process.exit(0);
    });
  });
}
