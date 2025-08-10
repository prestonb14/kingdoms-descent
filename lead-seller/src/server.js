import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import fastifyFormBody from '@fastify/formbody';
import ejs from 'ejs';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { getDb } from './storage.js';
import { nanoid } from 'nanoid';

dotenv.config();

const app = Fastify({ logger: true });

// Config
const APP_PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${APP_PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_METERED_PRICE_ID = process.env.STRIPE_METERED_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

if (!STRIPE_SECRET_KEY) {
  app.log.warn('STRIPE_SECRET_KEY not set. Stripe features will not work until configured.');
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;

// Plugins
await app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
  prefix: '/public/'
});
await app.register(fastifyFormBody);
await app.register(fastifyView, {
  engine: { ejs },
  root: path.join(process.cwd(), 'views')
});

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Routes
app.get('/', async (req, reply) => {
  return reply.view('index.ejs', {
    appUrl: APP_URL
  });
});

app.get('/buyers/signup', async (req, reply) => {
  return reply.view('signup.ejs', {
    appUrl: APP_URL,
    error: null
  });
});

app.post('/buyers/signup', async (req, reply) => {
  try {
    const { name, email, company } = req.body || {};
    if (!name || !email) {
      return reply.view('signup.ejs', { appUrl: APP_URL, error: 'Name and email are required.' });
    }
    if (!stripe) {
      return reply.view('signup.ejs', { appUrl: APP_URL, error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
    }
    if (!STRIPE_METERED_PRICE_ID) {
      return reply.view('signup.ejs', { appUrl: APP_URL, error: 'Missing STRIPE_METERED_PRICE_ID. See README for setup.' });
    }

    const customer = await stripe.customers.create({
      email,
      name,
      metadata: { company: company || '' }
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [
        { price: STRIPE_METERED_PRICE_ID, quantity: 1 }
      ],
      subscription_data: {
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        metadata: {
          buyer_name: name,
          buyer_email: email,
          buyer_company: company || ''
        }
      },
      success_url: `${APP_URL}/buyers/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/buyers/signup?canceled=1`,
      allow_promotion_codes: false
    });

    return reply.redirect(303, session.url);
  } catch (err) {
    app.log.error(err);
    return reply.view('signup.ejs', { appUrl: APP_URL, error: 'Error creating checkout session. Try again.' });
  }
});

app.get('/buyers/thanks', async (req, reply) => {
  try {
    if (!stripe) return reply.redirect('/buyers/signup');
    const sessionId = req.query.session_id;
    if (!sessionId) return reply.redirect('/buyers/signup');

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;

    if (!subscriptionId || !customerId) {
      return reply.redirect('/buyers/signup');
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const subscriptionItemId = subscription.items.data[0]?.id;

    // Create buyer in DB if not exists
    const db = getDb();
    const existing = db.prepare('SELECT id FROM buyers WHERE stripe_customer_id = ?').get(customerId);
    let apiKey;
    let buyerId;
    if (!existing) {
      apiKey = `lk_${nanoid(24)}`;
      buyerId = `buyer_${nanoid(12)}`;
      const customer = await stripe.customers.retrieve(customerId);
      const name = typeof customer?.name === 'string' ? customer.name : '';
      const email = typeof customer?.email === 'string' ? customer.email : '';
      const company = (customer?.metadata && typeof customer.metadata.company === 'string') ? customer.metadata.company : '';

      db.prepare(`INSERT INTO buyers (id, name, email, company, api_key, stripe_customer_id, stripe_subscription_item_id, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
        buyerId, name, email, company, apiKey, customerId, subscriptionItemId
      );
    } else {
      const row = db.prepare('SELECT id, api_key FROM buyers WHERE stripe_customer_id = ?').get(customerId);
      buyerId = row.id;
      apiKey = row.api_key;
    }

    return reply.view('thanks.ejs', { appUrl: APP_URL, apiKey });
  } catch (err) {
    app.log.error(err);
    return reply.redirect('/buyers/signup');
  }
});

app.get('/buyers/dashboard', async (req, reply) => {
  const key = req.query.key;
  if (!key) return reply.redirect('/buyers/signup');
  const db = getDb();
  const buyer = db.prepare('SELECT * FROM buyers WHERE api_key = ?').get(key);
  if (!buyer) return reply.redirect('/buyers/signup');

  const stats = db.prepare(`SELECT COUNT(*) as count FROM leads WHERE buyer_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`).get(buyer.id);
  return reply.view('dashboard.ejs', {
    appUrl: APP_URL,
    buyer,
    monthLeadCount: stats.count,
    pricePerLead: 60
  });
});

// Lead intake endpoint
app.post('/api/leads', async (req, reply) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || typeof apiKey !== 'string') {
      return reply.code(401).send({ error: 'Missing x-api-key header' });
    }
    const db = getDb();
    const buyer = db.prepare('SELECT * FROM buyers WHERE api_key = ?').get(apiKey);
    if (!buyer) return reply.code(403).send({ error: 'Invalid API key' });

    const { name, email, phone, meta } = req.body || {};
    if (!name && !email && !phone) {
      return reply.code(400).send({ error: 'Provide at least one of name, email, or phone' });
    }

    const leadId = `lead_${nanoid(12)}`;
    db.prepare(`INSERT INTO leads (id, buyer_id, name, email, phone, meta, created_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      leadId, buyer.id, name || '', email || '', phone || '', meta ? JSON.stringify(meta) : null
    );

    // Record metered usage in Stripe
    if (stripe && buyer.stripe_subscription_item_id) {
      try {
        await stripe.subscriptionItems.createUsageRecord(
          buyer.stripe_subscription_item_id,
          { action: 'increment', quantity: 1, timestamp: Math.floor(Date.now() / 1000) }
        );
      } catch (err) {
        app.log.error({ err }, 'Failed to record Stripe usage');
      }
    }

    return reply.send({ ok: true, leadId });
  } catch (err) {
    app.log.error(err);
    return reply.code(500).send({ error: 'Server error' });
  }
});

// Stripe webhook (optional placeholder)
app.post('/webhooks/stripe', async (req, reply) => {
  if (!STRIPE_WEBHOOK_SECRET || !stripe) return reply.code(200).send({ ok: true });
  try {
    const sig = req.headers['stripe-signature'];
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    app.log.info({ type: event.type }, 'Stripe webhook received');
  } catch (err) {
    app.log.error(err);
  }
  return reply.code(200).send({ ok: true });
});

// Start server
const start = async () => {
  // Initialize DB tables
  const db = getDb();
  db.prepare(`CREATE TABLE IF NOT EXISTS buyers (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    company TEXT,
    api_key TEXT UNIQUE,
    stripe_customer_id TEXT,
    stripe_subscription_item_id TEXT,
    created_at TEXT
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    buyer_id TEXT,
    name TEXT,
    email TEXT,
    phone TEXT,
    meta TEXT,
    created_at TEXT
  )`).run();

  try {
    await app.listen({ port: APP_PORT, host: '0.0.0.0' });
    app.log.info(`Server running at ${APP_URL}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();