const express = require('express');
const { Pool } = require('pg');

// Fail fast if any configuration is missing
const required = ['PORT', 'PRODUCT_SERVICE_URL', 'PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const PORT = process.env.PORT;
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL;

// pg reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE automatically
const db = new Pool();

const app = express();
app.use(express.json());

// Readiness check: healthy only if Postgres answers
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'healthy' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/orders', async (req, res) => {
  const { rows } = await db.query('SELECT id, product_id, quantity, total, created_at FROM orders ORDER BY id');
  res.json(rows);
});

app.post('/orders', async (req, res) => {
  const { product_id, quantity } = req.body || {};
  if (!Number.isInteger(product_id) || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: 'product_id and quantity must be positive whole numbers' });
  }

  // Ask the product service whether the product exists, and its price
  let product;
  try {
    const response = await fetch(`${PRODUCT_SERVICE_URL}/products/${product_id}`, {
      signal: AbortSignal.timeout(3000), // give up after 3 seconds
    });
    if (response.status === 404) {
      return res.status(400).json({ error: 'Product does not exist' });
    }
    if (!response.ok) {
      throw new Error(`Product service returned ${response.status}`);
    }
    product = await response.json();
  } catch (err) {
    return res.status(503).json({ error: 'Product service unavailable', detail: err.message });
  }

  const total = Number(product.price) * quantity;
  const { rows } = await db.query(
    'INSERT INTO orders (product_id, quantity, total) VALUES ($1, $2, $3) RETURNING id, product_id, quantity, total, created_at',
    [product_id, quantity, total]
  );
  res.status(201).json(rows[0]);
});

async function start() {
  await db.query(`CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    total NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const server = app.listen(PORT, () => {
    console.log(`Order service listening on port ${PORT}`);
  });

  // Graceful shutdown: stop new requests, finish current ones, close connections
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 8000).unref();
    server.close(async () => {
      await db.end();
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
