/**
 * ARK Touch-Up API (server.js)
 * - POST /api/ark/create-payment-link
 * - GET  /api/ark/verify
 * - GET  /healthz
 *
 * ENV (Fly secrets):
 *   SQUARE_ACCESS_TOKEN=xxxx
 *   SQUARE_LOCATION_ID=xxxx
 *   SQUARE_ENV=sandbox|production
 *   SITE_BASE_URL=https://www.arkfurniture.ca
 *   CURRENCY=CAD
 *   ALLOWED_ORIGINS=https://www.arkfurniture.ca,https://arkfurniture.ca,https://arkfurniture.myshopify.com
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { Client, Environment } = require('square');

const app = express();
app.use(express.json());

// ---------- Config & Helpers ----------
const PORT = process.env.PORT || 3000;
const CURRENCY = process.env.CURRENCY || 'CAD';
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://www.arkfurniture.ca';
const SQUARE_ENV = (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'production'
  ? Environment.Production
  : Environment.Sandbox;

const REQUIRED_ENVS = ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID'];
for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    console.warn(`[WARN] Missing env ${key}. Set it with: flyctl secrets set ${key}=VALUE -a ark-touchup-api`);
  }
}

const defaultAllowed = new Set([
  'https://www.arkfurniture.ca',
  'https://arkfurniture.ca',
  'https://arkfurniture.myshopify.com'
]);
if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean).forEach(o => defaultAllowed.add(o));
}

// Tiny in-memory ref→orderId cache (OK for testing; use Redis for HA)
const sessions = new Map();

// Manual CORS (no extra deps)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && defaultAllowed.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function squareClient() {
  return new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: SQUARE_ENV,
    userAgentDetail: 'ark-touchup-api/1.0' // shows up in Square logs
  });
}

// ---------- Routes ----------
app.get('/healthz', (req, res) => res.status(200).send('ok'));

/**
 * Create a Square Payment Link and return { url, orderId?, ref }.
 * Body JSON:
 *  {
 *    "displayMinutes": 150,
 *    "totalPrice": 300,
 *    "subtotal": 300
 *  }
 */
app.post('/api/ark/create-payment-link', async (req, res) => {
  try {
    const { displayMinutes, totalPrice, subtotal } = req.body;
    const currency = process.env.CURRENCY || 'CAD';
    const locationId = process.env.SQUARE_LOCATION_ID;
    const site = process.env.SITE_BASE_URL || 'https://www.arkfurniture.ca';

    const ref = randomUUID();
    const amountCents = Math.round(Number(subtotal) * 100);

    const body = {
      idempotencyKey: randomUUID(),
      order: {
        locationId,
        referenceId: ref, // <-- critical
        lineItems: [{
          name: 'In-home Touch-Up Visit',
          quantity: '1',
          basePriceMoney: { amount: amountCents, currency }
        }]
      },
      checkoutOptions: {
        redirectUrl: `${site}/pages/book-touchup?ref=${encodeURIComponent(ref)}&minutes=${encodeURIComponent(displayMinutes || 60)}&price=${encodeURIComponent(totalPrice || subtotal)}&currency=${encodeURIComponent(currency)}`
      }
    };

    const client = squareClient();
    const { result } = await client.checkoutApi.createPaymentLink(body);
    const link = result.paymentLink;

    // Cache both orderId and linkId for this ref (best-effort)
    sessions.set(ref, {
      orderId: link?.orderId || null,
      linkId: link?.id || null,
      at: Date.now()
    });

    // Helpful log (view with: flyctl logs -a ark-touchup-api --since 10m)
    console.log('create-link', { ref, orderId: link?.orderId, linkId: link?.id, locationId });

    res.json({ url: link.url, orderId: link.orderId, ref });
  } catch (e) {
    console.error('create-payment-link error', e);
    res.status(200).json({ error: 'CREATE_LINK_FAILED' });
  }
});

/**
 * Verify a payment by orderId OR ref.
 * Query:
 *   /api/ark/verify?ref=UUID[&orderId=xxxx]
 * Returns { ok, state, orderId, matchesRef }
 */
app.get('/api/ark/verify', async (req, res) => {
  try {
    const { ref, orderId } = req.query;
    if (!ref && !orderId) return res.status(200).json({ ok: false, error: 'MISSING_REF_OR_ORDERID' });

    const client = squareClient();

    // 1) direct or cached orderId
    let oid = orderId || sessions.get(ref)?.orderId;

    // 2) try to recover orderId from the stored paymentLink id
    if (!oid && sessions.get(ref)?.linkId) {
      try {
        const { result } = await client.checkoutApi.getPaymentLink(sessions.get(ref).linkId);
        oid = result?.paymentLink?.orderId || oid;
        if (oid) sessions.set(ref, { ...sessions.get(ref), orderId: oid });
      } catch (e) {
        console.warn('getPaymentLink failed for ref', ref, e?.message || e);
      }
    }

    // 3) last resort: search all locations and match referenceId
    if (!oid) {
      // list locations once, cache in memory to reduce calls
      if (!sessions.get('__locations__')) {
        const { result } = await client.locationsApi.listLocations();
        sessions.set('__locations__', result.locations?.map(l => l.id) || []);
      }
      const locations = sessions.get('__locations__');
      const since = new Date(Date.now() - 1000 * 60 * 24 * 60).toISOString(); // last 24h

      // search each location (stop on first match)
      for (const locId of locations) {
        const { result } = await client.ordersApi.searchOrders({
          locationIds: [locId],
          query: {
            sort: { sortField: 'CREATED_AT', sortOrder: 'DESC' },
            filter: {
              dateTimeFilter: { createdAt: { startAt: since } },
              stateFilter: { states: ['OPEN','COMPLETED','CANCELED','DRAFT'] }
            }
          }
        });
        const orders = result.orders || [];
        const match = orders.find(o => (o.referenceId || o.reference_id) === ref);
        if (match) { oid = match.id; break; }
      }
    }

    if (!oid) return res.status(200).json({ ok: false, error: 'Order not found', ref });

    // retrieve and require COMPLETED
    const { result: ro } = await client.ordersApi.retrieveOrder(oid);
    const order = ro.order;
    const state = order?.state; // DRAFT | OPEN | COMPLETED | CANCELED
    const ok = state === 'COMPLETED';

    // small nicety: store back the orderId if we learned it
    if (!sessions.get(ref)?.orderId) sessions.set(ref, { ...sessions.get(ref), orderId: oid });

    return res.status(200).json({
      ok,
      orderId: oid,
      state,
      matchesRef: (order?.referenceId || order?.reference_id) === ref
    });
  } catch (e) {
    console.error('verify error', e);
    return res.status(200).json({ ok: false, error: 'VERIFY_EXCEPTION' });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`[ark-touchup-api] listening on ${PORT}`);
});
