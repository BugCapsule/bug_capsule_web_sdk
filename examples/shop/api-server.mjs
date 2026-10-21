// Demo shop API on its own origin (http://127.0.0.1:4318), with randomized
// latency and data so the planted bugs happen only sometimes during capture.
// Replay never reaches it: the capsule serves every recorded response.
import { createServer } from 'node:http';

const port = Number(process.env.SHOP_API_PORT ?? 4318);
const origins = new Set((process.env.SHOP_API_ORIGINS ?? 'http://127.0.0.1:4317,http://localhost:4317').split(','));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const catalog = [
  { sku: 'A1', name: 'Canvas tote', price: { amount: 2499, currency: 'USD' } },
  { sku: 'B2', name: 'Enamel mug', price: { amount: 1599, currency: 'USD' } },
  { sku: 'C3', name: 'Field notebook', price: { amount: 899, currency: 'USD' } },
  { sku: 'D4', name: 'Wool beanie', price: { amount: 3299, currency: 'USD' } },
];
const orders = [];

function send(res, status, body, origin) {
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(origins.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(origins.has(origin) ? 204 : 403, origins.has(origin) ? {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type, authorization',
      vary: 'Origin',
    } : {});
    res.end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/profile':
      await sleep(rand(40, 320));
      return send(res, 200, { name: 'QA Tester', tier: 'gold', session_token: 'st_' + Math.random().toString(36).slice(2) }, origin);
    case 'GET /api/recommendations':
      await sleep(rand(40, 320));
      return send(res, 200, { items: catalog.slice(0, 3).map((c) => ({ sku: c.sku, name: c.name, boost: { gold: 2, silver: 1 } })) }, origin);
    case 'GET /api/cart': {
      await sleep(rand(60, 220));
      const items = catalog.slice(0, rand(2, 4)).map((c) => ({ ...c, qty: rand(1, 2) }));
      // ~1 in 3 carts contain a discontinued item whose price is null.
      if (Math.random() < 0.34) items[items.length - 1] = { ...items[items.length - 1], price: null, discontinued: true };
      return send(res, 200, { cartId: 'cart-' + rand(1000, 9999), items }, origin);
    }
    case 'POST /api/checkout': {
      await sleep(rand(80, 200));
      const order = { orderId: 'ord-' + rand(10000, 99999), status: 'placed' };
      orders.push(order);
      return send(res, 201, order, origin);
    }
    case 'GET /api/orders':
      await sleep(rand(50, 150));
      return send(res, 200, { orders }, origin);
    default:
      return send(res, 404, { error: 'not found' }, origin);
  }
}).listen(port, '127.0.0.1', () => console.log(`shop API on http://127.0.0.1:${port}`));
