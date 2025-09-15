/**
 * ARK Touch-Up API (debug-friendly, production-ready)
 * Routes:
 *   POST /api/ark/create-payment-link
 *   GET  /api/ark/verify?ref=... [&orderId=...]
 *   GET  /api/ark/debug?ref=...
 *   GET  /api/ark/info
 *   GET  /healthz
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { Client, Environment } = require('square');

const app = express();
app.use(express.json());

// ---------- Helpers ----------
function sendErr(res, tag, err) {
  console.error(`[${tag}]`, err && err.stack ? err.stack : err);
  const verbose = process.env.DEBUG_VERBOSE === '1';
  const payload = { ok: false, error: tag };
  if (verbose) {
    payload.message = err?.message || String(err);
    if (err?.errors) payload.square = err.errors;
  }
  return res.status(200).json(payload);
}

function squareClient() {
  return new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment:
      (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'production'
        ? Environment.Production
        : Environment.Sandbox,
    userAgentDetail: 'ark-touchup-api/3.1',
  });
}

// tiny in-memory cache (survives until VM restarts)
const sessions = new Map();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const CURRENCY = process.env.CURRENCY || 'CAD';
const SITE = process.env.SITE_BASE_URL || 'https://www.arkfurniture.ca';

// NEW: server-side minimums (override via Fly secrets)
const MIN_PRICE = Number(process.env.MIN_PRICE || '120');     // dollars
const MIN_MINUTES = Number(process.env.MIN_MINUTES || '60');  // minutes

// CORS allowlist
const ALLOWED = new Set([
  'https://www.arkfurniture.ca',
  'https://arkfurniture.ca',
  'https://arkfurniture.myshopify.com',
]);
if (process.env.ALLOWED_ORIGINS) {
  for (const o of process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)) {
    ALLOWED.add(o);
  }
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

// ---------- Utils ----------
async function listAllLocations(client) {
  const { result } = await client.locationsApi.listLocations();
  return (result.locations || []).map(l => l.id);
}

async function searchOrdersByRef(client, ref, sinceISO, locationIds /* optional */) {
  const matches = [];
  if (locationIds && locationIds.length) {
    for (const loc of locationIds) {
      const { result } = await client.ordersApi.searchOrders({
        locationIds: [loc],
        query: {
          sort: { sortField: 'CREATED_AT', sortOrder: 'DESC' },
          filter: {
            dateTimeFilter: { createdAt: { startAt: sinceISO } },
            stateFilter: { states: ['OPEN', 'COMPLETED', 'CANCELED', 'DRAFT'] },
          },
        },
      });
      for (const o of result.orders || []) {
        if ((o.referenceId || o.reference_id) === ref) matches.push(o);
      }
      if (matches.length) break;
    }
  } else {
    const { result } = await client.ordersApi.searchOrders({
      query: {
        sort: { sortField: 'CREATED_AT', sortOrder: 'DESC' },
        filter: {
          dateTimeFilter: { createdAt: { startAt: sinceISO } },
          stateFilter: { states: ['OPEN', 'COMPLETED', 'CANCELED', 'DRAFT'] },
        },
      },
    });
    for (const o of result.orders || []) {
      if ((o.referenceId || o.reference_id) === ref) matches.push(o);
    }
  }
  return matches;
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// ---------- Routes ----------
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/api/ark/info', (req, res) => {
  res.json({
    env: (process.env.SQUARE_ENV || 'sandbox').toLowerCase(),
    hasToken: !!process.env.SQUARE_ACCESS_TOKEN,
    tokenLen: (process.env.SQUARE_ACCESS_TOKEN || '').length,
    locationId: process.env.SQUARE_LOCATION_ID || null,
    site: SITE,
    currency: CURRENCY,
    minPrice: MIN_PRICE,
    minMinutes: MIN_MINUTES,
  });
});

/**
 * Create Payment Link
 * - Enforces server-side MIN_PRICE and MIN_MINUTES
 * - Sets order.referenceId = ref
 * - Redirect includes the *effective* (min-applied) price
 */
app.post('/api/ark/create-payment-link', async (req, res) => {
  try {
    let { displayMinutes = 60, totalPrice, subtotal } = req.body || {};

    // Clamp minutes on server
    const minutes = Math.max(MIN_MINUTES, Number(displayMinutes || 0) || MIN_MINUTES);

    // Compute effective price with server-side minimum
    const rawPrice = Number(subtotal ?? totalPrice ?? 0) || 0;
    const charge = Math.max(MIN_PRICE, round2(rawPrice)); // dollars
    const amountCents = Math.round(charge * 100);

    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(200).json({ ok: false, error: 'INVALID_AMOUNT' });
    }

    const ref = randomUUID();
    const bookingBase = process.env.BOOKING_URL || `${SITE}/pages/book-touchup`;

    // Redirect built *before* API call, includes effective price
    const redirect = new URL(bookingBase);
    redirect.searchParams.set('ref', ref);
    redirect.searchParams.set('minutes', String(minutes));
    redirect.searchParams.set('price', String(charge));
    redirect.searchParams.set('currency', CURRENCY);

    const client = squareClient();

    const createBody = {
      idempotencyKey: randomUUID(),
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        referenceId: ref,
        lineItems: [
          {
            name: 'In-home Touch-Up Visit',
            quantity: '1',
            basePriceMoney: { amount: amountCents, currency: CURRENCY },
          },
        ],
      },
      checkoutOptions: { redirectUrl: redirect.toString() },
    };

    const { result } = await client.checkoutApi.createPaymentLink(createBody);
    const link = result.paymentLink;
    const orderId = link?.orderId || null;

    sessions.set(ref, { orderId, linkId: link?.id || null, at: Date.now() });

    console.log('create-link', { ref, orderId, linkId: link?.id, charge, minutes });
    return res.status(200).json({ url: link.url, orderId, ref, charge, minutes });
  } catch (e) {
    return sendErr(res, 'CREATE_LINK_FAILED', e);
  }
});

/**
 * Verify payment by orderId or ref (no listPayments call)
 */
app.get('/api/ark/verify', async (req, res) => {
  try {
    const { ref = '', orderId = '' } = req.query;
    if (!ref && !orderId) {
      return res.status(400).json({ ok: false, error: 'MISSING_REF_OR_ORDER_ID' });
    }

    const client = squareClient();
    const expectedLoc = process.env.SQUARE_LOCATION_ID || '';

    let oid = orderId || sessions.get(ref)?.orderId || null;

    if (!oid && sessions.get(ref)?.linkId) {
      try {
        const { result } = await client.checkoutApi.getPaymentLink(sessions.get(ref).linkId);
        oid = result?.paymentLink?.orderId || oid;
        if (oid) sessions.set(ref, { ...sessions.get(ref), orderId: oid });
      } catch (e) {
        console.warn('getPaymentLink failed:', e?.message || e);
      }
    }

    if (!oid && ref) {
      const locs = await listAllLocations(client);
      const since = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
      const matches = await searchOrdersByRef(client, ref, since, locs);
      if (matches.length) oid = matches[0].id;
    }

    if (!oid) return res.status(200).json({ ok: false, error: 'ORDER_NOT_FOUND', ref });

    const { result: ro } = await client.ordersApi.retrieveOrder(oid);
    const order = ro.order;
    const state = order?.state;

    if (order?.locationId && expectedLoc && order.locationId !== expectedLoc) {
      return res.status(200).json({
        ok: false,
        error: 'LOCATION_MISMATCH',
        orderLocation: order.locationId,
        expected: expectedLoc,
        orderId: oid,
      });
    }

    if (state === 'COMPLETED') {
      return res.status(200).json({ ok: true, state, orderId: oid, matchesRef: (order.referenceId || order.reference_id) === ref });
    }

    const tender = (order?.tenders || [])[0];
    if (tender?.paymentId) {
      const { result: rp } = await client.paymentsApi.getPayment(tender.paymentId);
      const payment = rp.payment;
      if (payment?.status === 'COMPLETED') {
        return res.status(200).json({
          ok: true,
          state,
          paymentStatus: 'COMPLETED',
          orderId: oid,
          paymentId: payment.id,
          matchesRef: (order.referenceId || order.reference_id) === ref,
        });
      }
    }

    return res.status(200).json({
      ok: false,
      error: 'NOT_COMPLETED_YET',
      state,
      orderId: oid,
      matchesRef: (order?.referenceId || order?.reference_id) === ref,
    });
  } catch (e) {
    return sendErr(res, 'VERIFY_EXCEPTION', e);
  }
});

/**
 * Debug snapshot for a given ref
 */
app.get('/api/ark/debug', async (req, res) => {
  try {
    const { ref } = req.query;
    if (!ref) return res.status(200).json({ error: 'MISSING_REF' });

    const client = squareClient();
    const locs = await listAllLocations(client);
    const since = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
    const orders = await searchOrdersByRef(client, ref, since, locs);

    const payments = [];
    for (const o of orders) {
      const t = (o.tenders || [])[0];
      if (t?.paymentId) {
        try {
          const { result } = await client.paymentsApi.getPayment(t.paymentId);
          if (result?.payment) payments.push(result.payment);
        } catch (e) {
          console.warn('getPayment debug warn:', e?.message || e);
        }
      }
    }

    return res.status(200).json({
      env: (process.env.SQUARE_ENV || 'sandbox').toLowerCase(),
      locations: locs,
      cache: sessions.get(ref) || null,
      orders: orders.map(o => ({
        id: o.id,
        state: o.state,
        locationId: o.locationId,
        referenceId: o.referenceId || o.reference_id,
        total: o.totalMoney?.amount,
        currency: o.totalMoney?.currency,
      })),
      payments: payments.map(p => ({
        id: p.id,
        status: p.status,
        orderId: p.orderId,
        amount: p.amountMoney?.amount,
        currency: p.amountMoney?.currency,
      })),
    });
  } catch (e) {
    return sendErr(res, 'DEBUG_EXCEPTION', e);
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`[ark-touchup-api DEBUG] listening on ${PORT} at ${new Date().toISOString()}`);
});
