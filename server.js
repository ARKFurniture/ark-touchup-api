/**
 * ARK Touch-Up API (debug-friendly)
 * Routes:
 *   POST /api/ark/create-payment-link
 *   GET  /api/ark/verify?ref=... [&orderId=...]
 *   GET  /api/ark/debug?ref=...
 *   GET  /healthz
 *
 * Secrets (Fly):
 *   SQUARE_ACCESS_TOKEN  (sandbox or prod)
 *   SQUARE_LOCATION_ID   (prefer correct location; we also search all)
 *   SQUARE_ENV           ("sandbox" | "production")
 *   SITE_BASE_URL        (e.g., https://www.arkfurniture.ca)
 *   CURRENCY             (e.g., CAD)
 *   ALLOWED_ORIGINS      (comma-separated allowed browser origins)
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { Client, Environment } = require('square');

const app = express();

// Toggle detailed errors by setting DEBUG_VERBOSE=1 in Fly secrets
function sendErr(res, tag, err) {
  console.error(`[${tag}]`, err && err.stack ? err.stack : err);
  const verbose = process.env.DEBUG_VERBOSE === '1';
  const payload = { ok: false, error: tag };
  if (verbose) {
    payload.message = err?.message || String(err);
    if (err?.errors) payload.square = err.errors; // Square SDK error array
  }
  return res.status(200).json(payload);
}

app.use(express.json());

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const CURRENCY = process.env.CURRENCY || 'CAD';
const SITE = process.env.SITE_BASE_URL || 'https://www.arkfurniture.ca';
const SQUARE_ENV =
  (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'production'
    ? Environment.Production
    : Environment.Sandbox;

const REQUIRED = ['SQUARE_ACCESS_TOKEN'];
for (const k of REQUIRED) {
  if (!process.env[k]) console.warn(`[WARN] Missing env ${k}`);
}

// CORS allowlist
const ALLOWED = new Set([
  'https://www.arkfurniture.ca',
  'https://arkfurniture.ca',
  'https://arkfurniture.myshopify.com',
]);
if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean).forEach(o => ALLOWED.add(o));
}
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// simple in-memory cache (fine for sandbox)
const sessions = new Map();

function sq() {
  return new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: SQUARE_ENV,
    userAgentDetail: 'ark-touchup-api/2.0',
  });
}

// ---------- Utils ----------
async function listAllLocations(client) {
  const { result } = await client.locationsApi.listLocations();
  return (result.locations || []).map(l => l.id);
}
async function searchOrdersByRef(client, ref, sinceISO, locationIds /* array or undefined */) {
  const ids = locationIds && locationIds.length ? locationIds : undefined;
  const found = [];
  if (ids) {
    for (const loc of ids) {
      const { result } = await client.ordersApi.searchOrders({
        locationIds: [loc],
        query: {
          sort: { sortField: 'CREATED_AT', sortOrder: 'DESC' },
          filter: {
            dateTimeFilter: { createdAt: { startAt: sinceISO } },
            stateFilter: { states: ['OPEN','COMPLETED','CANCELED','DRAFT'] }
          }
        }
      });
      const orders = result.orders || [];
      for (const o of orders) {
        if ((o.referenceId || o.reference_id) === ref) {
          found.push(o);
        }
      }
      if (found.length) break; // stop at first location with a match
    }
  } else {
    const { result } = await client.ordersApi.searchOrders({
      query: {
        sort: { sortField: 'CREATED_AT', sortOrder: 'DESC' },
        filter: {
          dateTimeFilter: { createdAt: { startAt: sinceISO } },
          stateFilter: { states: ['OPEN','COMPLETED','CANCELED','DRAFT'] }
        }
      }
    });
    const orders = result.orders || [];
    for (const o of orders) {
      if ((o.referenceId || o.reference_id) === ref) {
        found.push(o);
      }
    }
  }
  return found;
}
async function listRecentPayments(client, sinceISO) {
  const payments = [];
  let cursor;
  do {
    const { result } = await client.paymentsApi.listPayments(
      sinceISO,          // beginTime (ISO string)
      undefined,         // endTime
      'DESC',            // sortOrder
      cursor             // cursor (for pagination)
      // you can optionally pass locationId as the 5th arg if you want to filter
    );
    payments.push(...(result.payments || []));
    cursor = result.cursor;
  } while (cursor);
  return payments;
}

// ---------- Routes ----------
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

/**
 * Create payment link with an Order (referenceId=ref)
 */
app.post('/api/ark/create-payment-link', async (req, res) => {
  try {
    const { displayMinutes, totalPrice, subtotal } = req.body || {};
    const ref = randomUUID();
    const bookingBase = process.env.BOOKING_URL ?? 'https://www.arkfurniture.ca/pages/book-touchup';

    const createReq = {
      idempotencyKey: randomUUID(),
      quickPay: {
        name: `In-home touch-up (${displayMinutes} min)`,
        priceMoney: { amount: Math.round(totalPrice * 100), currency: 'CAD' },
        locationId: process.env.SQUARE_LOCATION_ID,
      },
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        referenceId: ref,                     // keep storing your ref on the order
        lineItems: [
          {
            name: `In-home touch-up`,
            quantity: '1',
            basePriceMoney: { amount: Math.round(subtotal * 100), currency: 'CAD' }
          }
        ]
      },
      checkoutOptions: {
        // temp value; we’ll overwrite below once we have orderId
        redirectUrl: bookingBase
      }
    };

    const client = squareClient();
    const { result } = await client.paymentLinksApi.createPaymentLink(createReq);

    const link = result.paymentLink;
    const orderId = link.orderId;               // <<— Square returns it here

    // Build the final redirect URL (now with orderId)
    const redirect = new URL(bookingBase);
    redirect.searchParams.set('ref', ref);
    redirect.searchParams.set('orderId', orderId);
    redirect.searchParams.set('minutes', String(displayMinutes || 60));
    redirect.searchParams.set('price', String(totalPrice || subtotal || 0));
    redirect.searchParams.set('currency', 'CAD');

    // Update the payment link to use the final redirect (optional but nice)
    try {
      await client.paymentLinksApi.updatePaymentLink(link.id, {
        paymentLink: { checkoutOptions: { redirectUrl: redirect.toString() } }
      });
    } catch { /* not fatal */ }

    // Keep a tiny in-memory note (survives until the VM restarts)
    mem.orders ??= new Map();
    mem.orders.set(ref, { orderId, createdAt: Date.now() });

    res.json({ url: link.url, orderId, ref });
  } catch (e) {
    return sendErr(res, 'CREATE_LINK_FAILED', e);
  }
});

/**
 * Verify by orderId or ref; searches all locations; falls back to Payments API.
 */
app.get('/api/ark/verify', async (req, res) => {
  try {
    const { ref = '', orderId = '' } = req.query;
    if (!ref && !orderId) {
      return res.status(400).json({ ok: false, error: 'MISSING_REF_OR_ORDER_ID' });
    }

    const client = squareClient(); // your existing helper
    const locId  = process.env.SQUARE_LOCATION_ID;

    // 1) If we have an orderId, use it directly.
    let order = null;
    if (orderId) {
      const { result } = await client.ordersApi.retrieveOrder(orderId);
      order = result.order || null;
    }

    // 2) If no order yet and you cached it on creation, try memory:
    if (!order && ref && mem.orders?.has(ref)) {
      const cached = mem.orders.get(ref); // you can store orderId when creating the link
      if (cached?.orderId) {
        const { result } = await client.ordersApi.retrieveOrder(cached.orderId);
        order = result.order || null;
      }
    }

    if (!order) {
      return res.status(200).json({ ok: false, error: 'ORDER_NOT_FOUND', ref, orderId });
    }

    // Safety check: same location and your referenceId if you set it
    if (order.locationId && locId && order.locationId !== locId) {
      return res.status(200).json({ ok: false, error: 'LOCATION_MISMATCH', orderLocation: order.locationId, expected: locId });
    }

    // 3) If order is already COMPLETED we're good
    if (order.state === 'COMPLETED') {
      return res.json({ ok: true, state: 'COMPLETED', orderId: order.id });
    }

    // 4) Order isn’t completed yet — see if a payment already completed
    const t = (order.tenders || [])[0];
    if (t?.paymentId) {
      const { result: payRes } = await client.paymentsApi.getPayment(t.paymentId);
      const payment = payRes.payment;
      if (payment?.status === 'COMPLETED') {
        return res.json({
          ok: true,
          state: order.state,            // likely OPEN for a moment
          paymentStatus: 'COMPLETED',
          orderId: order.id,
          paymentId: payment.id
        });
      }
    }

    // 5) Not completed yet
    return res.json({
      ok: false,
      error: 'NOT_COMPLETED_YET',
      state: order.state,
      orderId: order.id
    });
  } catch (e) {
    return sendErr(res, 'VERIFY_EXCEPTION', e); // your verbose helper
  }
});

/**
 * Debug endpoint to see what Square actually has for this ref.
 *  GET /api/ark/debug?ref=UUID
 *  (Safe to keep; returns no secrets.)
 */
app.get('/api/ark/debug', async (req, res) => {
  try {
    const { ref } = req.query;
    if (!ref) return res.status(200).json({ error: 'MISSING_REF' });

    const client = sq();
    const locs = await listAllLocations(client);
    const since = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();

    const orders = await searchOrdersByRef(client, ref, since, locs);
    const pays = await listRecentPayments(client, since);

    const snapshot = {
      env: process.env.SQUARE_ENV || 'sandbox',
      locations: locs,
      cache: sessions.get(ref) || null,
      orders: orders.map(o => ({
        id: o.id,
        state: o.state,
        referenceId: o.referenceId || o.reference_id,
        total: o.totalMoney?.amount,
        currency: o.totalMoney?.currency
      })),
      // show only a few payments to keep output small
      payments: pays.slice(0, 10).map(p => ({
        id: p.id, status: p.status, orderId: p.orderId, amount: p.amountMoney?.amount, currency: p.amountMoney?.currency
      }))
    };
    return res.status(200).json(snapshot);
  } catch (e) {
    return sendErr(res, 'DEBUG_EXCEPTION', e);
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`[ark-touchup-api DEBUG] listening on ${PORT} at ${new Date().toISOString()}`);
});

