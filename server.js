/**
 * ARK Touch-Up API (debug-friendly, production-ready)
 * Routes:
 *   POST /api/ark/create-payment-link
 *   GET  /api/ark/verify?ref=... [&orderId=...]
 *   GET  /api/ark/debug?ref=...
 *   GET  /api/ark/info
 *   GET  /healthz
 *
 * Env (Fly secrets):
 *   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENV ("sandbox"|"production")
 *   SITE_BASE_URL (e.g. https://www.arkfurniture.ca)
 *   CURRENCY (e.g. CAD)
 *   ALLOWED_ORIGINS (comma-separated origins for CORS)
 *   DEBUG_VERBOSE=1 (optional; returns error details in JSON)
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
    userAgentDetail: 'ark-touchup-api/3.0',
  });
}

// tiny in-memory cache (survives until VM restarts)
const sessions = new Map();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const CURRENCY = process.env.CURRENCY || 'CAD';
const SITE = process.env.SITE_BASE_URL || 'https://www.arkfurniture.ca';

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
  });
});

/**
 * Create Payment Link
 * - Uses ORDER (not quickPay) so we always get an orderId
 * - Sets order.referenceId = ref (so /verify can search by ref)
 * - After creating, updates redirectUrl to include orderId in query
 */
app.post('/api/ark/create-payment-link', async (req, res) => {
  try {
    const { displayMinutes = 60, totalPrice, subtotal } = req.body || {};
    const amountCents = Math.round(Number(subtotal ?? totalPrice ?? 0) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(200).json({ ok: false, error: 'INVALID_AMOUNT' });
    }

    const ref = randomUUID();
    const bookingBase = process.env.BOOKING_URL || `${SITE}/pages/book-touchup`;

    const client = squareClient();

    // 1) Create link with ORDER + initial redirect (we'll update after we learn orderId)
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
      checkoutOptions: {
        redirectUrl: bookingBase, // temporary; we update below
      },
    };

    const { result } = await client.checkoutApi.createPaymentLink(createBody);
    const link = result.paymentLink;
    const orderId = link?.orderId || null;

    // cache ref → {orderId, linkId}
    sessions.set(ref, { orderId, linkId: link?.id || null, at: Date.now() });

    // 2) Build final redirect including orderId + other params
    const redirect = new URL(bookingBase);
    redirect.searchParams.set('ref', ref);
    if (orderId) redirect.searchParams.set('orderId', orderId);
    redirect.searchParams.set('minutes', String(displayMinutes));
    redirect.searchParams.set('price', String(Number(totalPrice ?? subtotal ?? 0)));
    redirect.searchParams.set('currency', CURRENCY);

    // 3) Update the link to use the final redirect (best-effort)
    try {
      if (link?.id) {
        await client.checkoutApi.updatePaymentLink(link.id, {
          paymentLink: { checkoutOptions: { redirectUrl: redirect.toString() } },
        });
      }
    } catch (e) {
      console.warn('updatePaymentLink warning:', e?.message || e);
    }

    console.log('create-link', { ref, orderId, linkId: link?.id });
    return res.status(200).json({ url: link.url, orderId, ref });
  } catch (e) {
    return sendErr(res, 'CREATE_LINK_FAILED', e);
  }
});

/**
 * Verify payment by orderId or ref
 * - Prefer orderId (fastest & most reliable)
 * - Else recover via cached link/order
 * - Else search all locations for order.referenceId === ref
 * - Accept COMPLETED order OR COMPLETED payment on the order's tender
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

    // recover orderId via stored payment link id
    if (!oid && sessions.get(ref)?.linkId) {
      try {
        const { result } = await client.checkoutApi.getPaymentLink(sessions.get(ref).linkId);
        oid = result?.paymentLink?.orderId || oid;
        if (oid) sessions.set(ref, { ...sessions.get(ref), orderId: oid });
      } catch (e) {
        console.warn('getPaymentLink failed:', e?.message || e);
      }
    }

    // last resort: search by referenceId across all locations (last 24h)
    if (!oid && ref) {
      const locs = await listAllLocations(client);
      const since = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
      const matches = await searchOrdersByRef(client, ref, since, locs);
      if (matches.length) oid = matches[0].id;
    }

    if (!oid) {
      return res.status(200).json({ ok: false, error: 'ORDER_NOT_FOUND', ref });
    }

    // retrieve order
    const { result: ro } = await client.ordersApi.retrieveOrder(oid);
    const order = ro.order;
    const state = order?.state; // DRAFT | OPEN | COMPLETED | CANCELED

    // optional safety: location check
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

    // payments fallback via tender → getPayment
    const tender = (order?.tenders || [])[0];
    if (tender?.paymentId) {
      const { result: rp } = await client.paymentsApi.getPayment(tender.paymentId);
      const payment = rp.payment;
      if (payment?.status === 'COMPLETED') {
        return res.status(200).json({
          ok: true,
          state, // likely OPEN while order closes out
          paymentStatus: 'COMPLETED',
          orderId: oid,
          paymentId: payment.id,
          matchesRef: (order.referenceId || order.reference_id) === ref,
        });
      }
    }

    // not completed yet
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
 * - Shows locations, cache, matching orders, and any payments linked via tenders
 */
app.get('/api/ark/debug', async (req, res) => {
  try {
    const { ref } = req.query;
    if (!ref) return res.status(200).json({ error: 'MISSING_REF' });

    const client = squareClient();
    const locs = await listAllLocations(client);
    const since = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();

    const orders = await searchOrdersByRef(client, ref, since, locs);

    // look up payments via each order's tender IDs
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
