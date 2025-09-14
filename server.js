// ARK Touch-Up API (Pay → then Book)
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Client, Environment } = require('square');
require('dotenv').config();

const app = express();
app.use(express.json());

// --- CORS: allow your Shopify domains to call this API from the browser
const ALLOWED = [
  'https://arkfurniture.ca',
  'https://www.arkfurniture.ca',
  'https://arkfurniture.myshopify.com'
].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    cb(null, ALLOWED.includes(origin));
  }
}));

// --- Square client
const square = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENV === 'production' ? Environment.Production : Environment.Sandbox
});

const PORT        = process.env.PORT || 3000;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const SITE_BASE   = (process.env.SITE_BASE_URL || 'https://arkfurniture.ca').replace(/\/$/, ''); // no trailing slash
const CURRENCY    = process.env.CURRENCY || 'CAD';

const toCents = n => Math.round(Number(n) * 100);

// Health check for Fly
app.get('/healthz', (_, res) => res.status(200).send('ok'));

// Create a Square-hosted payment link for exact total
app.post('/api/ark/create-payment-link', async (req, res) => {
  try {
    const {
      displayMinutes = 60,
      totalPrice,           // required (your calculator’s final price)
      subtotal,             // optional (for logging/metrics)
      breakdown = {},       // optional
      currency = CURRENCY
    } = req.body || {};

    if (!LOCATION_ID) return res.status(500).json({ error: 'Missing SQUARE_LOCATION_ID' });
    if (!process.env.SQUARE_ACCESS_TOKEN) return res.status(500).json({ error: 'Missing SQUARE_ACCESS_TOKEN' });
    if (!totalPrice || Number(totalPrice) <= 0) {
      return res.status(400).json({ error: 'Missing/invalid totalPrice' });
    }

    const ref = uuidv4(); // our cross-check token
    const { result } = await square.checkoutApi.createPaymentLink({
      idempotencyKey: uuidv4(),
      order: {
        locationId: LOCATION_ID,
        referenceId: ref,
        lineItems: [
          {
            name: `Touch‑Up visit (${displayMinutes} min)`,
            quantity: '1',
            basePriceMoney: { amount: toCents(totalPrice), currency }
          }
        ]
      },
      checkoutOptions: {
        redirectUrl: `${SITE_BASE}/pages/book-touchup?ref=${encodeURIComponent(ref)}&minutes=${encodeURIComponent(displayMinutes)}&price=${encodeURIComponent(totalPrice)}&currency=${encodeURIComponent(currency)}`
      }
    });

    const link = result?.paymentLink;
    if (!link?.url && !link?.longUrl) return res.status(500).json({ error: 'No payment link returned' });

    return res.json({
      url: link.url || link.longUrl,
      orderId: link.orderId,
      ref
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Square createPaymentLink failed', detail: err?.message });
  }
});

// Verify payment completed before showing scheduler
app.get('/api/ark/verify', async (req, res) => {
  try {
    const { orderId, ref } = req.query || {};
    if (!orderId && !ref) return res.status(400).json({ ok: false, error: 'Missing orderId or ref' });

    let order;
    if (orderId) {
      const { result } = await square.ordersApi.retrieveOrder(orderId);
      order = result?.order;
    } else {
      // Fallback: search recent completed orders by referenceId
      const { result } = await square.ordersApi.searchOrders({
        locationIds: [LOCATION_ID],
        query: { filter: { stateFilter: { states: ['COMPLETED'] } } },
        returnEntries: false,
        limit: 50
      });
      order = (result?.orders || []).find(o => o.referenceId === ref);
    }

    if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
    const paid = order.state === 'COMPLETED';
    const matchesRef = ref ? (order.referenceId === ref) : true;

    return res.json({ ok: paid && matchesRef, orderId: order.id, state: order.state, matchesRef });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Verify failed', detail: err?.message });
  }
});

app.listen(PORT, () => console.log(`ARK API listening on :${PORT}`));
