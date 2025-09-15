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
    const { result } = await client.paymentsApi.listPayments({ beginTime: sinceISO, sortOrder: 'DESC', cursor });
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
    const amountCents = Math.round(Number(subtotal) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(200).json({ error: 'INVALID_SUBTOTAL' });
    }

    const client = sq();
    const ref = randomUUID();

    const body = {
      idempotencyKey: randomUUID(),
      order: {
        locationId: process.env.SQUARE_LOCATION_ID, // optional for multi-location sellers; still good to set yours
        referenceId: ref,
        lineItems: [{
          name: 'In-home Touch-Up Visit',
          quantity: '1',
          basePriceMoney: { amount: amountCents, currency: CURRENCY }
        }]
      },
      checkoutOptions: {
        redirectUrl:
          `${SITE}/pages/book-touchup?ref=${encodeURIComponent(ref)}` +
          `&minutes=${encodeURIComponent(displayMinutes || 60)}` +
          `&price=${encodeURIComponent(totalPrice || subtotal)}` +
          `&currency=${encodeURIComponent(CURRENCY)}`
      }
    };

    const { result } = await client.checkoutApi.createPaymentLink(body);
    const link = result.paymentLink;

    sessions.set(ref, {
      orderId: link?.orderId || null,
      linkId: link?.id || null,
      at: Date.now()
    });

    console.log('create-link', { ref, orderId: link?.orderId, linkId: link?.id, site: SITE });
    return res.status(200).json({ url: link.url, orderId: link.orderId, ref });
  } catch (e) {
    return sendErr(res, 'CREATE_LINK_FAILED', e);
  }
});

/**
 * Verify by orderId or ref; searches all locations; falls back to Payments API.
 */
app.get('/api/ark/verify', async (req, res) => {
  try {
    const { ref, orderId } = req.query;
    if (!ref && !orderId) return res.status(200).json({ ok: false, error: 'MISSING_REF_OR_ORDERID' });

    const client = sq();

    // 1) prefer supplied/cached orderId
    let oid = orderId || sessions.get(ref)?.orderId;

    // 2) recover via stored paymentLink
    if (!oid && sessions.get(ref)?.linkId) {
      try {
        const { result } = await client.checkoutApi.getPaymentLink(sessions.get(ref).linkId);
        oid = result?.paymentLink?.orderId || oid;
        if (oid) sessions.set(ref, { ...sessions.get(ref), orderId: oid });
      } catch (e) {
        return sendErr(res, 'VERIFY_EXCEPTION', e);
      }
    }

    // 3) last resort: search orders by referenceId across ALL locations
    if (!oid) {
      const locs = await listAllLocations(client);
      const since = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // last 24h
      const matches = await searchOrdersByRef(client, ref, since, locs);
      if (matches.length) oid = matches[0].id;
    }

    if (!oid) return res.status(200).json({ ok: false, error: 'Order not found', ref });

    // 4) retrieve order
    const { result: ro } = await client.ordersApi.retrieveOrder(oid);
    const order = ro.order;
    const state = order?.state; // DRAFT | OPEN | COMPLETED | CANCELED
    const matchesRef = (order?.referenceId || order?.reference_id) === ref;

    // 5) if order is completed -> OK
    if (state === 'COMPLETED') {
      return res.status(200).json({ ok: true, orderId: oid, state, matchesRef });
    }

    // 6) payments fallback (tender.id == payment.id); accept COMPLETED payment even if order still OPEN
    const sincePay = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // last 24h
    const pays = await listRecentPayments(client, sincePay);
    const pay = pays.find(p => p.orderId === oid && p.status === 'COMPLETED');

    if (pay) {
      return res.status(200).json({
        ok: true,
        orderId: oid,
        state, // may still be OPEN briefly
        paymentStatus: pay.status,
        paymentId: pay.id,
        matchesRef
      });
    }

    // not paid yet
    return res.status(200).json({ ok: false, orderId: oid, state, matchesRef });
  } catch (e) {
    console.error('verify error', e);
    return res.status(200).json({ ok: false, error: 'VERIFY_EXCEPTION' });
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

