const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');

// Fail fast if any configuration is missing
const required = ['PORT', 'REDIS_URL', 'CACHE_TTL_SECONDS', 'PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const PORT = process.env.PORT;
const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS);
const CACHE_KEY = 'products:all';

// pg reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE automatically
const db = new Pool();

const cache = createClient({ url: process.env.REDIS_URL });
cache.on('error', (err) => console.error('Redis error:', err.message));

const app = express();
app.use(express.json());

// Readiness check: healthy only if Postgres and Redis both answer
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    await cache.ping();
    res.json({ status: 'healthy' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// Cache-aside: try Redis first, fall back to Postgres
app.get('/products', async (req, res) => {
  const cached = await cache.get(CACHE_KEY);
  if (cached) {
    return res.json({ source: 'cache', products: JSON.parse(cached) });
  }
  const { rows } = await db.query('SELECT id, name, price FROM products ORDER BY id');
  await cache.setEx(CACHE_KEY, CACHE_TTL, JSON.stringify(rows));
  res.json({ source: 'database', products: rows });
});

app.get('/products/:id', async (req, res) => {
  const { rows } = await db.query('SELECT id, name, price FROM products WHERE id = $1', [req.params.id]);
  if (!rows.length) {
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json(rows[0]);
});

app.post('/products', async (req, res) => {
  const { name, price } = req.body || {};
  if (!name || price === undefined) {
    return res.status(400).json({ error: 'name and price are required' });
  }
  const { rows } = await db.query(
    'INSERT INTO products (name, price) VALUES ($1, $2) RETURNING id, name, price',
    [name, price]
  );
  await cache.del(CACHE_KEY); // cache invalidation
  res.status(201).json(rows[0]);
});

async function start() {
  await cache.connect();
  await db.query(`CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL
  )`);

  const server = app.listen(PORT, () => {
    console.log(`Product service listening on port ${PORT}`);
  });

  // Graceful shutdown: stop new requests, finish current ones, close connections
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 8000).unref(); // force exit before Docker's 10 second limit
    server.close(async () => {
      await db.end();
      await cache.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
