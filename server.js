const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const serviceAccount = require('./serviceAccount.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
app.post('/create-link-token', async (req, res) => {
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

app.post('/exchange-token', async (req, res) => {
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
    console.log('Exchange response:', JSON.stringify(data));
    res.json({
      access_token: data.access_token,
      item_id: data.item_id,
    });
  } catch (e) {
    console.log('Exchange error:', e);
    res.status(500).json({ error: e.message });
  }
});
app.post('/get-transactions', async (req, res) => {
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
const stripe = require('stripe')(STRIPE_SECRET_KEY);

app.post('/create-subscription', async (req, res) => {
  try {
    const { email } = req.body;

    // Create or get customer
    const customers = await stripe.customers.list({ email, limit: 1 });
    let customer;
    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({ email });
    }

    // Create subscription with payment
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

app.get('/check-subscription', async (req, res) => {
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
app.post('/plaid-webhook', async (req, res) => {
  try {
    console.log('Webhook received:', JSON.stringify(req.body));
    const { webhook_type, webhook_code, item_id } = req.body;
    console.log('Type:', webhook_type, 'Code:', webhook_code, 'Item ID:', item_id);

    if (webhook_type === 'TRANSACTIONS' && webhook_code === 'DEFAULT_UPDATE') {
      console.log('Looking for user with item_id:', item_id);
      
      const usersRef = db.collection('users');
      const snapshot = await usersRef.get();
      
      console.log('Total users found:', snapshot.size);
      snapshot.forEach(doc => {
        console.log('User data keys:', Object.keys(doc.data()));
        console.log('User plaidItemId:', doc.data().plaidItemId);
      });

      const matchSnapshot = await usersRef.where('plaidItemId', '==', item_id).get();
      console.log('Matching users:', matchSnapshot.size);

      if (!matchSnapshot.empty) {
        const userDoc = matchSnapshot.docs[0];
        const userData = userDoc.data();
        console.log('Found user, isPro:', userData.isPro);

        if (userData.isPro && userData.plaidAccessToken) {
          const now = new Date();
          const start = new Date();
          start.setDate(now.getDate() - 1);

          const transResponse = await fetch('https://sandbox.plaid.com/transactions/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: PLAID_CLIENT_ID,
              secret: PLAID_SECRET,
              access_token: userData.plaidAccessToken,
              start_date: start.toISOString().split('T')[0],
              end_date: now.toISOString().split('T')[0],
            }),
          });

          const transData = await transResponse.json();
          console.log('Transactions found:', transData.transactions?.length);

          if (transData.transactions && transData.transactions.length > 0) {
            const newAmount = transData.transactions.reduce(
              (sum, t) => sum + t.amount, 0
            );

            const date = new Date().toLocaleDateString();
            const newTransfer = { amount: parseFloat(newAmount.toFixed(2)), date, auto: true };
            console.log('Saving auto transfer:', newTransfer);

            await userDoc.ref.update({
              spent: 0,
              transfers: admin.firestore.FieldValue.arrayUnion(newTransfer),
              lastAutoTransfer: date,
            });
            console.log('Auto transfer saved successfully!');
          }
        }
      } else {
        console.log('No matching user found for item_id:', item_id);
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.log('Webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.listen(3001, () => console.log('✅ Backend running on http://localhost:3001'));