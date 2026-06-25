const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const stripe = require('stripe')(STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await fetch('https://sandbox.plaid.com/link/token/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        client_name: 'CreditTracker',
        country_codes: ['US'],
        language: 'en',
        user: { client_user_id: req.body.userId || 'user' },
        products: ['transactions'],
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/exchange-token', async (req, res) => {
  try {
    const response = await fetch('https://sandbox.plaid.com/item/public_token/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        public_token: req.body.public_token,
      }),
    });
    const data = await response.json();
    res.json({ access_token: data.access_token, item_id: data.item_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/get-transactions', async (req, res) => {
  try {
    const now = new Date();
    const start = new Date();
    start.setDate(now.getDate() - 30);
    const response = await fetch('https://sandbox.plaid.com/transactions/get', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        access_token: req.body.access_token,
        start_date: start.toISOString().split('T')[0],
        end_date: now.toISOString().split('T')[0],
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/create-subscription', async (req, res) => {
  try {
    const { email } = req.body;
    const customers = await stripe.customers.list({ email, limit: 1 });
    let customer;
    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({ email });
    }
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'CreditTracker Pro — Auto Transfer' },
          unit_amount: 300,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      success_url: 'http://localhost:8081/success',
      cancel_url: 'http://localhost:8081/',
    });
    res.json({ url: session.url, customerId: customer.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/check-subscription', async (req, res) => {
  try {
    const { email } = req.query;
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) return res.json({ active: false });
    const subscriptions = await stripe.subscriptions.list({
      customer: customers.data[0].id,
      status: 'active',
      limit: 1,
    });
    res.json({ active: subscriptions.data.length > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plaid-webhook', async (req, res) => {
  res.json({ received: true });
});

module.exports = app;