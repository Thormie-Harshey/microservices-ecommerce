const express = require('express');

// Fail fast if any configuration is missing
const required = ['PORT', 'PRODUCT_SERVICE_URL', 'ORDER_SERVICE_URL'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const PORT = process.env.PORT;

// Which service owns which path
const routes = {
  '/products': process.env.PRODUCT_SERVICE_URL,
  '/orders': process.env.ORDER_SERVICE_URL,
};

const app = express();
app.use(express.json());

// Liveness check: the gateway has no dependencies of its own
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Request routing: forward each path to the service that owns it
for (const [path, target] of Object.entries(routes)) {
  app.use(path, async (req, res) => {
    try {
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const response = await fetch(`${target}${req.originalUrl}`, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(5000), // give up after 5 seconds
      });
      const data = await response.text();
      res.status(response.status).type('application/json').send(data);
    } catch (err) {
      res.status(502).json({ error: `Could not reach ${path.slice(1)} service`, detail: err.message });
    }
  });
}

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const server = app.listen(PORT, () => {
  console.log(`Gateway listening on port ${PORT}`);
});

// Graceful shutdown: stop new requests, finish current ones
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 8000).unref();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
