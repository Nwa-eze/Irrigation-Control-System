require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2/promise'); // Promise-based MySQL client
const path = require('path');
const csv = require('csv-express');
require('dotenv').config();   // ← this loads .env into process.env
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL   = "https://api.paystack.co";
const crypto = require('crypto');
const BASE_URL = process.env.BASE_URL;


const app = express();
app.use(cors({
  origin: 'http://172.19.151.142:3005', // Your frontend URL
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(bodyParser.json());

app.get('/', (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'test.html'));
});

app.use(express.static(path.join(__dirname, 'public')));


// Create a MySQL connection pool (adjust with your credentials)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});


function todayString() {
  return new Date().toISOString().slice(0, 10);
}

// getOrCreatePlanDay(planId, dayDate)
async function getOrCreatePlanDay(planId, dayDate) {
  const [rows] = await pool.execute(
    `SELECT id, consumed_liters FROM user_plan_days WHERE plan_id = ? AND day_date = ? LIMIT 1`,
    [planId, dayDate]
  );
  if (rows.length) return rows[0];

  const [ins] = await pool.execute(
    `INSERT INTO user_plan_days (plan_id, day_date, consumed_liters, created_at, updated_at) VALUES (?, ?, 0, NOW(), NOW())`,
    [planId, dayDate]
  );
  const [newRow] = await pool.execute(
    `SELECT id, consumed_liters FROM user_plan_days WHERE id = ? LIMIT 1`,
    [ins.insertId]
  );
  return newRow[0];
}

// addConsumptionToPlanDay(planId, dayDate, deltaLiters)
async function addConsumptionToPlanDay(planId, dayDate, deltaLiters) {
  const delta = Number(deltaLiters) || 0;
  if (delta <= 0) return;

  await pool.execute(
    `INSERT INTO user_plan_days (plan_id, day_date, consumed_liters, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE consumed_liters = consumed_liters + VALUES(consumed_liters), updated_at = NOW()`,
    [planId, dayDate, delta]
  );

  try {
    await pool.execute(
      `UPDATE user_plans SET consumed_total = COALESCE(consumed_total,0) + ? WHERE id = ?`,
      [delta, planId]
    );
  } catch (e) {
    console.error('[addConsumptionToPlanDay] failed to update consumed_total:', e);
  }
}

// getConsumedTodayForPlan(planId, dayDate)
async function getConsumedTodayForPlan(planId, dayDate) {
  const [rows] = await pool.execute(
    `SELECT consumed_liters FROM user_plan_days WHERE plan_id = ? AND day_date = ? LIMIT 1`,
    [planId, dayDate]
  );
  if (!rows.length) return 0;
  return Number(rows[0].consumed_liters) || 0;
}



// --------------------
// Registration Endpoint (optional, for new users)
// --------------------
// Example server-side code snippet for /register endpoint
app.post('/register', async (req, res) => {
  const { user, profile, address } = req.body;

  // Helper function to replace undefined with null in objects
  const replaceUndefinedWithNull = (obj) => {
    const newObj = {};
    for (const key in obj) {
      newObj[key] = obj[key] === undefined ? null : obj[key];
    }
    return newObj;
  };

  // Clean the payloads
  const cleanedUser = replaceUndefinedWithNull(user);
  const cleanedProfile = replaceUndefinedWithNull(profile);
  const cleanedAddress = replaceUndefinedWithNull(address);

  let connection;
  try {
    connection = await pool.getConnection(); // Assuming you're using a connection pool
    await connection.beginTransaction();

    // Insert into users (example query - adjust to your exact columns)
    const userQuery = `
      INSERT INTO users (username, password, location, farm_id, matric_number, name)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const userParams = [
      cleanedUser.username,
      cleanedUser.password, // Assume hashed on server
      cleanedUser.location,
      cleanedUser.farm_id,
      cleanedUser.matric_number,
      cleanedUser.name // This sets the 'name' column to full name
    ];
    const [userResult] = await connection.execute(userQuery, userParams);
    const userId = userResult.insertId;

    // Insert into user_profiles
    const profileQuery = `
      INSERT INTO user_profiles (user_id, email, phone, full_name, date_of_birth, gender)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const profileParams = [
      userId,
      cleanedProfile.email,
      cleanedProfile.phone,
      cleanedProfile.full_name,
      cleanedProfile.date_of_birth,
      cleanedProfile.gender
    ];
    await connection.execute(profileQuery, profileParams);

    // Insert into user_addresses
    const addressQuery = `
      INSERT INTO user_addresses (user_id, address_line1, address_line2, city, state_province, country, postal_code, is_primary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const addressParams = [
      userId,
      cleanedAddress.address_line1,
      cleanedAddress.address_line2,
      cleanedAddress.city,
      cleanedAddress.state_province,
      cleanedAddress.country,
      cleanedAddress.postal_code,
      cleanedAddress.is_primary
    ];
    await connection.execute(addressQuery, addressParams);

    await connection.commit();
    res.status(201).json({ message: 'Registration successful' });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    if (connection) connection.release();
  }
});


// --------------------
// Login Endpoint (using plain authentication)
// --------------------

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  console.log("Login attempt for user:", username);
  console.log("Password:", password);

  try {
    // Pull id, name, location, farm_id, matric_number
    const [rows] = await pool.execute(
      `SELECT id, username, location, farm_id, name
         FROM users
        WHERE username = ? AND password = ?
        LIMIT 1`,
      [username, password]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const user = rows[0];
    console.log(user);
    // On success, send back JSON (status defaults to 200)
    res.json({
      userId:        user.id,
      username:      user.username,
      location:      user.location,
      farm_id:       user.farm_id,
      name:          user.name,
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Server error during login." });
  }
});


// ================= ADMIN ROUTES =====================
// GET /api/admin/users  -> returns small user list for dropdown
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin123') {
    res.json({ token: 'admin-token' }); // Hardcoded token
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Middleware to check admin token
const checkAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader === 'Bearer admin-token') {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

app.get('/admin/users', checkAdmin, async (req, res) => {
  try {
    const [users] = await pool.query('SELECT id, username, name FROM users');
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/admin/user/:id', checkAdmin, async (req, res) => {
  const userId = req.params.id;
  try {
    const [userRows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    const user = userRows[0];

    const [profileRows] = await pool.query('SELECT * FROM user_profiles WHERE user_id = ?', [userId]);
    const profile = profileRows[0];

    const [addressRows] = await pool.query('SELECT * FROM user_addresses WHERE user_id = ?', [userId]);
    const address = addressRows[0];

    const [valveRows] = await pool.query('SELECT * FROM valve_state WHERE user_id = ?', [userId]);
    const valve = valveRows[0] || { is_open: 0, updated_at: null };

    const [plans] = await pool.query(`
      SELECT up.*, cwr.crop_name 
      FROM user_plans up 
      LEFT JOIN crop_water_requirements cwr ON up.crop_id = cwr.id 
      WHERE up.user_id = ?
    `, [userId]);

    const [planDays] = await pool.query('SELECT * FROM user_plan_days WHERE plan_id IN (SELECT id FROM user_plans WHERE user_id = ?)', [userId]);

    const [sensorData] = await pool.query('SELECT * FROM sensor_data WHERE user_id = ? ORDER BY timestamp DESC LIMIT 100', [userId]);

    res.json({
      user,
      profile,
      address,
      valve,
      plans,
      plan_days: planDays,
      sensor_data: sensorData
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/admin/sensor-csv/:userId', checkAdmin, async (req, res) => {
  const userId = req.params.userId;
  try {
    const [sensorData] = await pool.query('SELECT * FROM sensor_data WHERE user_id = ? ORDER BY timestamp DESC', [userId]); // Full for export
    res.csv(sensorData, true); // Using csv-express
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});



// --------------------
// GET Endpoint to fetch sensor data filtered by user_id
// --------------------
app.get("/get_data", async (req, res) => {
  const userId = req.query.user_id; // Expecting ?user_id=...
  if (!userId) {
    return res.status(400).json({ error: "User ID not provided" });
  }
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM sensor_data WHERE user_id = ? ORDER BY timestamp DESC LIMIT 50",
      [userId]
    );
    res.json(rows);
  } catch (error) {
    console.error("Error fetching sensor data:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------
// POST Endpoint for Sensor Data (Manual User Split)
// --------------------
// Expects a JSON payload with keys "user1", "user2", and "user3"
// and inserts data for user IDs 1, 2, and 3 respectively.
// POST /receive_data - store sensor_data and persist per-plan daily deltas
app.post('/receive_data', async (req, res) => {
  console.log("📥 [receive_data] raw body:", JSON.stringify(req.body));
  const { user1, user2, user3 } = req.body || {};

  if (!user1 || !user2 || !user3) {
    console.warn("⚠️ [receive_data] missing user1/user2/user3:", req.body);
    return res.status(400).send("❌ Invalid data format");
  }

  const flow1   = parseFloat(user1.flow   || 0);
  const volume1 = parseFloat(user1.volume || 0);
  const cost1   = parseFloat(user1.cost   || 0);
  console.log(`▶️ Parsed user1 → flow:${flow1}, volume:${volume1}, cost:${cost1}`);

  const flow2   = parseFloat(user2.flow   || 0);
  const volume2 = parseFloat(user2.volume || 0);
  const cost2   = parseFloat(user2.cost   || 0);
  console.log(`▶️ Parsed user2 → flow:${flow2}, volume:${volume2}, cost:${cost2}`);

  const flow3   = parseFloat(user3.flow   || 0);
  const volume3 = parseFloat(user3.volume || 0);
  const cost3   = parseFloat(user3.cost   || 0);
  console.log(`▶️ Parsed user3 → flow:${flow3}, volume:${volume3}, cost:${cost3}`);

  try {
    // Insert sensor_data for all three users (one query)
    await pool.execute(
      `INSERT INTO sensor_data (user_id, flow, volume, cost) VALUES
         (1, ?, ?, ?),
         (2, ?, ?, ?),
         (3, ?, ?, ?)`,
      [
        flow1, volume1, cost1,
        flow2, volume2, cost2,
        flow3, volume3, cost3
      ]
    );
    console.log("✅ [receive_data] sensor_data inserted for users 1,2,3");

    // For each user: compute delta (last two readings) and persist to user_plan_days
    const users = [
      { id: 1 },
      { id: 2 },
      { id: 3 }
    ];

    for (const u of users) {
      try {
        // fetch last two sensor_data rows for this user (most recent first)
        const [rows] = await pool.execute(
          `SELECT volume, timestamp FROM sensor_data WHERE user_id = ? ORDER BY timestamp DESC LIMIT 2`,
          [u.id]
        );
        if (!rows || rows.length === 0) continue;

        const currVol = parseFloat(rows[0].volume || 0);
        const prevVol = rows[1] ? parseFloat(rows[1].volume || 0) : null;

        // compute delta: if we have a previous reading and curr >= prev => delta = curr - prev
        // if curr < prev => simple rollover handling: treat delta = curr (you can adjust if you know meter rollover offset)
        let delta = 0;
        if (prevVol === null) {
          // no previous reading — cannot compute delta reliably; skip
          delta = 0;
        } else if (currVol >= prevVol) {
          delta = currVol - prevVol;
        } else {
          // rollover case
          delta = currVol;
          console.log(`[receive_data] rollover detected for user ${u.id}: prev=${prevVol} curr=${currVol} => delta=${delta}`);
        }

        if (delta > 0) {
          // find active plan for this user (most recent active)
          const [[plan]] = await pool.execute(
            `SELECT id FROM user_plans WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
            [u.id]
          );
          if (plan && plan.id) {
            const today = new Date().toISOString().slice(0,10);
            await addConsumptionToPlanDay(plan.id, today, delta);
            // optional: update consumed_total for plan
            try {
              await pool.execute(`UPDATE user_plans SET consumed_total = COALESCE(consumed_total,0) + ? WHERE id = ?`, [delta, plan.id]);
            } catch (e) {
              console.error('[receive_data] failed to update consumed_total', e);
            }
            console.log(`[receive_data] added delta=${delta} L to plan ${plan.id} for user ${u.id} (date ${today})`);
          } else {
            // no active plan - nothing to persist for planner
            // (we keep sensor_data in DB though)
          }
        }
      } catch (innerErr) {
        console.error(`[receive_data] per-user ledger update failed for user ${u.id}:`, innerErr);
        // don't fail whole endpoint on a per-user ledger write error
      }
    }

    return res.send("✅ Data received and stored");
  } catch (err) {
    console.error("❌ [receive_data] DB insert error:", err);
    return res.status(500).send("❌ Error inserting sensor data");
  }
});


app.post("/create-postpaid-session", async (req, res) => {
  const { amount, userId } = req.body;
  try {
    if (!amount || !userId) {
      return res.status(400).json({ error: 'Missing required fields: amount or userId' });
    }
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Postpaid Water Invoice Payment',
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${BASE_URL}/dashboard.html?payment=success&type=postpaid&amount=${encodeURIComponent(amount)}&userId=${encodeURIComponent(userId)}`,
      cancel_url: `${BASE_URL}/dashboard.html?payment=cancel`,
      metadata: {
        payment_type: 'postpaid',
        user_id: userId,
      },
    });
    res.json({ id: session.id });
  } catch (error) {
    console.error("Error creating postpaid session:", error);
    res.status(500).json({ error: error.message });
  }
});

// Initialize a Paystack transaction
app.post('/api/paystack/initialize', async (req, res) => {
  const { amount, userId, type } = req.body;
  try {
    const [profileRows] = await pool.execute(
      `SELECT email FROM user_profiles WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    const email = profileRows[0]?.email || 'system@domain.com';

    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        email,    
        amount: Math.round(amount), 
        metadata: { userId, type },
        callback_url: `${BASE_URL}/api/paystack/callback`
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    console.log('Paystack postpaid init response:', response.data);
    res.json(response.data.data);
  } catch (err) {
    console.error('Paystack postpaid init error', err.response?.data || err);
    res.status(500).json({ error: 'Paystack initialize failed' });
  }
});

// Paystack postpaid callback verification
app.get('/api/paystack/callback', async (req, res) => {
  const reference = req.query.reference;
  if (!reference) {
    console.error('Paystack postpaid callback error: Missing reference');
    return res.redirect(`${BASE_URL}/dashboard.html?payment=failed`);
  }
  try {
    const response = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const { status, amount, metadata } = response.data.data;
    console.log('Paystack postpaid callback:', { status, amount, metadata });
    if (status === 'success') {
      res.redirect(
        `${BASE_URL}/dashboard.html?payment=success&type=${metadata.type}&amount=${amount / 100}&userId=${metadata.userId}`
      );
    } else {
      res.redirect(`${BASE_URL}/dashboard.html?payment=failed`);
    }
  } catch (err) {
    console.error('Paystack postpaid verify error', err.response?.data || err);
    res.redirect(`${BASE_URL}/dashboard.html?payment=failed`);
  }
});

// --------------------
// Stripe Checkout Session Endpoint
// --------------------
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { amount, userId, type } = req.body; // Include userId and type for consistency
    if (!amount || !userId || !type) {
      return res.status(400).json({ error: 'Missing required fields: amount, userId, or type' });
    }
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd', // or 'ngn' if using NGN
            product_data: {
              name: 'Prepaid Water Payment',
            },
            unit_amount: Math.round(amount * 100), // Ensure cents/kobo
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${BASE_URL}/dashboard.html?payment=success&type=prepaid&amount=${encodeURIComponent(amount)}&userId=${encodeURIComponent(userId)}`,
      cancel_url: `${BASE_URL}/cancel.html`,
      metadata: { user_id: userId, payment_type: type },
    });
    res.json({ id: session.id });
  } catch (error) {
    console.error("Stripe Checkout Session Error:", error);
    res.status(500).json({ error: error.message });
  }
});


// Initialize a Paystack transaction
app.post("/paystack/initialize", async (req, res) => {
  const { amount, userId, type } = req.body;
  try {
    const [profileRows] = await pool.execute(
      `SELECT email FROM user_profiles WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    const email = profileRows[0]?.email || 'system@domain.com';

    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        email,
        amount: Math.round(amount), 
        metadata: { userId, type },
        callback_url: `${BASE_URL}/paystack/callback`,
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    );
    console.log('Paystack prepaid init response:', response.data);
    res.json({
      authorization_url: response.data.data.authorization_url,
    });
  } catch (err) {
    console.error("Paystack prepaid init error:", err.response?.data || err);
    res.status(500).json({ error: "Paystack initialization failed" });
  }
});

app.get("/paystack/callback", async (req, res) => {
  const reference = req.query.reference;
  if (!reference) {
    console.error("Paystack prepaid callback error: Missing reference");
    return res.redirect(`${BASE_URL}/dashboard.html?payment=failed`);
  }
  try {
    const verification = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        },
      }
    );
    const { status, amount, metadata } = verification.data.data;
    console.log('Paystack prepaid callback:', { status, amount, metadata });
    if (status === "success") {
      res.redirect(
        `${BASE_URL}/dashboard.html?payment=success&type=${metadata.type}&amount=${amount / 100}&userId=${metadata.userId}`
      );
    } else {
      res.redirect(`${BASE_URL}/dashboard.html?payment=failed`);
    }
  } catch (err) {
    console.error("Paystack prepaid verify error:", err.response?.data || err);
    res.redirect(`${BASE_URL}/dashboard.html?payment=failed`);
  }
});

app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { user_id, payment_type } = session.metadata;
    const amount = session.amount_total / 100; // Convert cents to dollars

    // Update your database or perform actions (e.g., mark payment as complete)
    console.log(`Payment successful for user ${user_id}, type: ${payment_type}, amount: ${amount}`);
    // Example: Update user balance or record transaction
  }

  res.json({ received: true });
});



app.post("/update_balance", async (req, res) => {
  const { userId, available_balance } = req.body;
  try {
    // Example SQL: update the available balance in a table (assume you have a table for user balances)
    await pool.execute(
      "UPDATE users SET available_balance = ? WHERE id = ?",
      [available_balance, userId]
    );
    res.json({ message: "Balance updated successfully." });
  } catch (error) {
    console.error("Error updating balance:", error);
    res.status(500).json({ message: "Error updating balance." });
  }
});


async function planAllowsOpen(userId, balance) {
  const [[plan]] = await pool.execute(
    `SELECT id, start_volume, per_day_target, total_target_liters, duration_days, start_datetime, last_reset_date
       FROM user_plans
      WHERE user_id=? AND status='active'
      ORDER BY id DESC
      LIMIT 1`,
    [userId]
  );

  if (!plan) return { hasPlan: false, allowsOpen: false, reason: 'no_plan' };

  const today = new Date().toISOString().slice(0,10);
  let consumedToday = 0;
  try {
    consumedToday = await getConsumedTodayForPlan(plan.id, today);
  } catch (e) {
    // fallback to meter diff if ledger not available
    const [[meterRow]] = await pool.execute(
      `SELECT volume FROM sensor_data WHERE user_id=? ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );
    const currVol = parseFloat(meterRow?.volume || 0);
    const startVol = (plan.start_volume !== null && plan.start_volume !== undefined)
                       ? parseFloat(plan.start_volume || 0)
                       : currVol;
    consumedToday = Math.max(0, currVol - startVol);
  }

  const perDay = parseFloat(plan.per_day_target || 0);
  const duration = parseInt(plan.duration_days || 0);
  const startMs = plan.start_datetime ? new Date(plan.start_datetime).getTime() : Date.now();
  const daysElapsed = Math.floor((Date.now() - startMs) / (1000*60*60*24));
  const hitToday = perDay > 0 && consumedToday >= perDay;
  const exceedDays = duration > 0 && daysElapsed >= duration;

  // Balance priority
  if ((balance === null ? 0 : Number(balance)) <= 0) {
    return { hasPlan: true, allowsOpen: false, reason: 'no_balance', consumedToday, perDay, daysElapsed, duration, planId: plan.id };
  }

  // Duration exhausted -> mark completed and lock the valve permanently (plan_locked)
  if (exceedDays) {
    try {
      await pool.execute(`UPDATE user_plans SET status='completed', completed_at = NOW() WHERE id = ? AND status = 'active'`, [plan.id]);
      await pool.execute(
        `INSERT INTO valve_state (user_id, is_open, source, reason, last_changed_at)
           VALUES (?, 0, 'planner', 'plan_locked', NOW())
         ON DUPLICATE KEY UPDATE
           is_open = VALUES(is_open),
           source  = VALUES(source),
           reason  = VALUES(reason),
           last_changed_at = VALUES(last_changed_at)`,
        [userId]
      );
      console.log(`[planAllowsOpen] plan ${plan.id} completed -> locked valve for user ${userId}`);
    } catch (e) {
      console.error('[planAllowsOpen] failed to persist plan lock', e);
    }
    return { hasPlan: true, allowsOpen: false, reason: 'duration_complete', consumedToday, perDay, daysElapsed, duration, planId: plan.id };
  }

  // Daily limit hit -> close for the rest of the day but DO NOT complete the plan
  if (hitToday) {
    try {
      await pool.execute(
        `INSERT INTO valve_state (user_id, is_open, source, reason, last_changed_at)
           VALUES (?, 0, 'planner', 'daily_limit', NOW())
         ON DUPLICATE KEY UPDATE
           is_open = VALUES(is_open),
           source  = VALUES(source),
           reason  = VALUES(reason),
           last_changed_at = VALUES(last_changed_at)`,
        [userId]
      );
      console.log(`[planAllowsOpen] plan ${plan.id}: daily target hit -> closed for the day for user ${userId}`);
    } catch (e) {
      console.error('[planAllowsOpen] failed to persist daily_limit', e);
    }
    return { hasPlan: true, allowsOpen: false, reason: 'daily_limit', consumedToday, perDay, daysElapsed, duration, planId: plan.id };
  }

  // Plan exists and allows open
  return { hasPlan: true, allowsOpen: true, reason: 'plan_ok', consumedToday, perDay, daysElapsed, duration, planId: plan.id };
}



// GET /valve_states - planner has priority; manual close persists, balance auto-open only if is_open IS NULL (auto)
app.get('/valve_states', async (req, res) => {
  try {
    const userIds = [1,2,3]; // adjust as needed or derive dynamically

    // fetch balances for users
    const [rows] = await pool.query(
      `SELECT u.id AS user_id, COALESCE(u.available_balance, 0) AS available_balance
       FROM users u
       WHERE u.id IN (?,?,?)
       ORDER BY u.id`,
      userIds
    );

    const result = {};
    for (const r of rows) {
      const uid = r.user_id;
      const balance = parseFloat(r.available_balance || 0);

      // current valve state
      const [[vrow]] = await pool.execute(`SELECT is_open, reason, source, last_changed_at FROM valve_state WHERE user_id = ? LIMIT 1`, [uid]);
      const isOpenFlag = (vrow && typeof vrow.is_open !== 'undefined') ? vrow.is_open : null;
      const vReason = vrow?.reason || null;
      const vSource = vrow?.source || null;

      // check plan with balance priority
      let planInfo;
      try {
        planInfo = await planAllowsOpen(uid, balance);
      } catch (e) {
        console.error('[valve_states] planAllowsOpen error for user', uid, e);
        planInfo = { hasPlan: false, allowsOpen: false, reason: 'plan_check_error' };
      }

      let state = false;
      let reason = 'unknown';

      if (planInfo.hasPlan) {
        // Plan exists: planAllowsOpen already respected balance and wrote valve_state for daily_limit/duration
        if (!planInfo.allowsOpen) {
          state = false;
          reason = planInfo.reason || 'plan_blocked';
        } else {
          // Planner wants it open
          state = true;
          reason = 'plan_ok';
          try {
            await pool.execute(
              `INSERT INTO valve_state (user_id, is_open, source, reason, last_changed_at)
                 VALUES (?, 1, 'planner', NULL, NOW())
               ON DUPLICATE KEY UPDATE
                 is_open = VALUES(is_open),
                 source  = VALUES(source),
                 reason  = VALUES(reason),
                 last_changed_at = VALUES(last_changed_at)`,
              [uid]
            );
          } catch (e) { console.error('[valve_states] failed persist planner open', e); }
        }

        // expose plan fields
        result[`user${uid}_consumedToday`] = planInfo.consumedToday ?? null;
        result[`user${uid}_perDayTarget`] = planInfo.perDay ?? null;
        result[`user${uid}_daysElapsed`] = planInfo.daysElapsed ?? null;
        result[`user${uid}_duration`] = planInfo.duration ?? null;

      } else {
        // No plan: manual or balance/system logic. Manual overrides persist.
        if (vSource === 'manual' && isOpenFlag === 1) {
          state = true; reason = 'manual_override';
        } else if (vSource === 'manual' && isOpenFlag === 0) {
          state = false; reason = 'manual_close';
        } else {
          // Not manual: check if plan_locked exists (must stay closed until manual)
          if (vReason === 'plan_locked') {
            state = false; reason = 'plan_locked';
          } else {
            // Normal balance/system behaviour
            if (isOpenFlag === 1 && vSource !== 'manual') {
              if (balance <= 0) {
                // persist system close
                try {
                  await pool.execute(
                    `INSERT INTO valve_state (user_id, is_open, source, reason, last_changed_at)
                       VALUES (?, 0, 'system', 'no_balance', NOW())
                     ON DUPLICATE KEY UPDATE
                       is_open = VALUES(is_open),
                       source  = VALUES(source),
                       reason  = VALUES(reason),
                       last_changed_at = VALUES(last_changed_at)`,
                    [uid]
                  );
                } catch (e) { console.error('[valve_states] failed persist close on zero-balance', e); }
                state = false; reason = 'no_balance';
              } else {
                state = true; reason = 'balance_ok';
              }
            } else if (isOpenFlag === 0 && vSource !== 'manual') {
              // previously system-closed or planner daily_limit: re-open on top-up if not plan_locked
              if (balance > 0) {
                try {
                  await pool.execute(
                    `INSERT INTO valve_state (user_id, is_open, source, reason, last_changed_at)
                       VALUES (?, 1, 'system', NULL, NOW())
                     ON DUPLICATE KEY UPDATE
                       is_open = VALUES(is_open),
                       source  = VALUES(source),
                       reason  = VALUES(reason),
                       last_changed_at = VALUES(last_changed_at)`,
                    [uid]
                  );
                } catch (e) { console.error('[valve_states] failed to re-open on top-up', e); }
                state = true; reason = 'balance_ok';
              } else {
                state = false; reason = 'no_balance';
              }
            } else {
              // auto (is_open IS NULL) or no row
              if (balance > 0) {
                try {
                  await pool.execute(
                    `INSERT INTO valve_state (user_id, is_open, source, reason, last_changed_at)
                       VALUES (?, 1, 'system', NULL, NOW())
                     ON DUPLICATE KEY UPDATE
                       is_open = VALUES(is_open),
                       source  = VALUES(source),
                       reason  = VALUES(reason),
                       last_changed_at = VALUES(last_changed_at)`,
                    [uid]
                  );
                } catch (e) { console.error('[valve_states] failed persist balance open', e); }
                state = true; reason = 'balance_ok';
              } else {
                state = false; reason = 'no_balance';
              }
            }
          }
        }

        // no-plan fields
        result[`user${uid}_consumedToday`] = null;
        result[`user${uid}_perDayTarget`] = null;
        result[`user${uid}_daysElapsed`] = null;
        result[`user${uid}_duration`] = null;
      }

      result[`user${uid}_state`] = state;
      result[`user${uid}_reason`] = reason;
    }

    return res.json(result);
  } catch (err) {
    console.error('Error in /valve_states route:', err);
    return res.status(500).json({ error: 'DB error' });
  }
});




// Manual open (web button) -> sets valve_state.is_open = TRUE
app.post('/api/valve/open', async (req, res) => {
  const userId = req.body.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    console.log(`[API] /api/valve/open called for user ${userId}`);
    await pool.execute(
      `INSERT INTO valve_state (user_id, is_open, source, reason, last_changed_at)
         VALUES (?, 1, 'manual', NULL, NOW())
       ON DUPLICATE KEY UPDATE
         is_open = VALUES(is_open),
         source  = VALUES(source),
         reason  = VALUES(reason),
         last_changed_at = VALUES(last_changed_at)`,
      [userId]
    );
    return res.sendStatus(204);
  } catch (err) {
    console.error('/api/valve/open error:', err);
    return res.status(500).json({ error: 'Could not set valve open' });
  }
});

// Manual close (web button) -> sets valve_state.is_open = FALSE
app.post('/api/valve/close', async (req, res) => {
  const userId = req.body.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    console.log(`[API] /api/valve/close called for user ${userId}`);
    await pool.execute(
      `INSERT INTO valve_state (user_id, is_open, source, reason, last_changed_at)
         VALUES (?, 0, 'manual', NULL, NOW())
       ON DUPLICATE KEY UPDATE
         is_open = VALUES(is_open),
         source  = VALUES(source),
         reason  = VALUES(reason),
         last_changed_at = VALUES(last_changed_at)`,
      [userId]
    );
    return res.sendStatus(204);
  } catch (err) {
    console.error('/api/valve/close error:', err);
    return res.status(500).json({ error: 'Could not set valve closed' });
  }
});



// ─── PLANNER / VALVE CONTROL ROUTES ────────────────────────────────────

// 1) Start a new plan (deduct flat fee & record target liters)
app.post('/api/plans/calculate', async (req, res) => {
  const { crop, region, stage, area } = req.body;
  console.log('▶️ calculate payload:', req.body);

  try {
    const [[row]] = await pool.execute(
      `SELECT water_l_per_m2_per_day AS rate, days AS duration
         FROM crop_water_requirements
        WHERE crop_name    = ?
          AND region       = ?
          AND growth_stage = ?
        LIMIT 1`,
      [crop, region, stage]
    );
    console.log('🛠️ fetched row:', row);

    if (!row || row.duration == null) {
      return res.status(404).json({
        error: 'Crop data not found or duration is null.',
        debug: row
      });
    }

    const ratePerM2   = parseFloat(row.rate);
    const duration    = parseInt(row.duration, 10);
    const dailyVolume = ratePerM2 * parseFloat(area);
    const totalTarget = dailyVolume * duration;
    const flatFee     = 10;

    return res.json({
      dailyVolume:  dailyVolume.toFixed(2),
      totalTarget:  totalTarget.toFixed(2),
      durationDays: duration,
      flatFee:      flatFee.toFixed(2)
    });
  } catch (err) {
    console.error('Calculation error:', err);
    return res.status(500).json({ error: 'Calculation failed.' });
  }
});

// --------------------------- /api/plans/start (transactional + validation) ---------------------------
app.post('/api/plans/start', async (req, res) => {
  const { userId, crop, region, stage, area } = req.body;
  if ([userId, crop, region, stage, area].some(v => v == null)) {
    return res.status(400).json({ error: 'Missing plan parameters.', received: req.body });
  }

  // Basic validations
  const fieldArea = parseFloat(area);
  if (!Number.isFinite(fieldArea) || fieldArea <= 0) {
    return res.status(400).json({ error: 'Invalid area. Must be a positive number.' });
  }

  try {
    // 1) fetch crop row (use alias duration)
    const [[cw]] = await pool.execute(
      `SELECT id, water_l_per_m2_per_day AS rate, days AS duration
         FROM crop_water_requirements
        WHERE crop_name = ? AND region = ? AND growth_stage = ?
        LIMIT 1`,
      [crop, region, stage]
    );
    if (!cw) return res.status(404).json({ error: 'Crop data not found.' });

    const cropId    = cw.id;
    const ratePerM2 = parseFloat(cw.rate) || 0;
    const duration  = parseInt(cw.duration, 10) || 0;
    if (duration <= 0) return res.status(400).json({ error: 'Invalid crop duration.' });

    const perDayTarget = ratePerM2 * fieldArea; // liters per day
    const totalTarget  = perDayTarget * duration;
    const flatFee      = 10;

    // 2) Use a DB transaction so fee deduction + plan insertion are atomic
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Deduct flat fee from user balance
      await conn.execute(
        `UPDATE users
           SET available_balance = GREATEST(0, available_balance - ?)
         WHERE id = ?`,
        [flatFee, userId]
      );

      // Grab latest meter reading (use the same connection for consistency)
      const [[{ volume: startVol = 0 }]] = await conn.execute(
        `SELECT volume FROM sensor_data WHERE user_id=? ORDER BY timestamp DESC LIMIT 1`,
        [userId]
      );

      // Insert plan
      // NOTE: Keep per_day_target column in DB or remove from this INSERT
      const [insPlan] = await conn.execute(
        `INSERT INTO user_plans
           (user_id, crop_id, growth_stage, field_area_m2,
            start_volume, total_target_liters,
            duration_days, per_day_target,
            start_datetime, last_reset_date,
            flat_fee, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), CURDATE(), ?, 'active')`,
        [
          userId,
          cropId,
          stage,
          fieldArea,
          startVol,
          totalTarget,
          duration,
          perDayTarget,   // ensure DB has this column (see note below)
          flatFee
        ]
      );

      if (!insPlan || !insPlan.insertId) {
        throw new Error('Failed to create plan in DB.');
      }

      // commit transaction
      await conn.commit();

      const planId = insPlan.insertId;

      // fetch fresh balance (outside transaction or using conn)
      const [[{ available_balance }]] = await pool.execute(
        `SELECT available_balance FROM users WHERE id = ?`,
        [userId]
      );
      
      try {
        const todayDateString = new Date().toISOString().slice(0,10);
        // ensure the plan-day row exists (0 consumed so far) — uses consumed_liters column
        await pool.execute(
         `INSERT INTO user_plan_days (plan_id, day_date, consumed_liters)
            VALUES (?, ?, 0)
          ON DUPLICATE KEY UPDATE consumed_liters = consumed_liters`,
          [planId, todayDateString]
        );

      } catch (errInsertDay) {
        console.error('Warning: could not create initial user_plan_days row:', errInsertDay);
        // non-fatal: plan has been created, continue
      }

      res.json({
        planId:       insPlan.insertId,
        dailyVolume:  Number(perDayTarget.toFixed(2)),
        totalTarget:  Number(totalTarget.toFixed(2)),
        durationDays: duration,
        flatFee:      Number(flatFee.toFixed(2)),
        newBalance:   Number(parseFloat(available_balance).toFixed(2))
      });
    } catch (errTx) {
      await conn.rollback();
      console.error('Transaction error (plans/start):', errTx);
      return res.status(500).json({ error: 'Could not start plan (transaction failed).' });
    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('Plan start error:', err);
    return res.status(500).json({ error: 'Could not start plan.' });
  }
});



// --------------------------- /api/device/state (improved response + DB-reset safe) ---------------------------
function todayString() {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/device/state - returns single-user plan & valve decision (defensive)
app.get('/api/device/state', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    // fetch the active plan (if any)
    const [[plan]] = await pool.execute(
      `SELECT id, start_volume, per_day_target, total_target_liters,
              duration_days, start_datetime, last_reset_date
         FROM user_plans
        WHERE user_id=? AND status='active'
        ORDER BY id DESC
        LIMIT 1`,
      [userId]
    );

    // read valve_state
    const [[vsRow]] = await pool.execute(
      `SELECT is_open, reason, source, last_changed_at FROM valve_state WHERE user_id=? LIMIT 1`,
      [userId]
    );
    const isOpenFlag = (vsRow && typeof vsRow.is_open !== 'undefined') ? vsRow.is_open : null;
    const vSource = vsRow?.source || null;
    const vReason = vsRow?.reason || null;

    // balance
    const [[{ available_balance = 0 }]] = await pool.execute(
      `SELECT COALESCE(available_balance,0) AS available_balance FROM users WHERE id = ?`,
      [userId]
    );
    const availBal = parseFloat(available_balance) || 0;
    const today = todayString();

    // NO PLAN branch
    if (!plan) {
      // Manual overrides
      if (isOpenFlag === 1 && vSource === 'manual') {
        return res.json({ plan: null, valveOpen: true, valveReason: 'manual_override', manualOverride: true, availableBalance: Number(availBal.toFixed(2)) });
      }
      if (isOpenFlag === 0 && vSource === 'manual') {
        return res.json({ plan: null, valveOpen: false, valveReason: 'manual_close', manualOverride: false, availableBalance: Number(availBal.toFixed(2)) });
      }

      // If plan_locked present, keep locked until manual intervention
      if (vReason === 'plan_locked') {
        return res.json({ plan: null, valveOpen: false, valveReason: 'plan_locked', manualOverride: false, availableBalance: Number(availBal.toFixed(2)) });
      }

      // If system-open but balance dropped -> persist close
      if (isOpenFlag === 1 && vSource !== 'manual') {
        if (availBal <= 0) {
          try {
            await pool.execute(
              `INSERT INTO valve_state (user_id, is_open, source, reason, last_changed_at)
                 VALUES (?, 0, 'system', 'no_balance', NOW())
               ON DUPLICATE KEY UPDATE
                 is_open = VALUES(is_open),
                 source  = VALUES(source),
                 reason  = VALUES(reason),
                 last_changed_at = VALUES(last_changed_at)`,
              [userId]
            );
            console.log(`[device/state] balance<=0: closing previously system-open valve for user ${userId}`);
          } catch (e) {
            console.error('[device/state] failed to persist close on zero-balance', e);
          }
          return res.json({ plan: null, valveOpen: false, valveReason: 'no_balance', manualOverride: false, availableBalance: Number(availBal.toFixed(2)) });
        }
        return res.json({ plan: null, valveOpen: true, valveReason: 'balance_ok', manualOverride: false, availableBalance: Number(availBal.toFixed(2)) });
      }

      // If previously system-closed (not manual) -> allow reopen on top-up
      if (isOpenFlag === 0 && vSource !== 'manual') {
        if (availBal > 0) {
          try {
            await pool.execute(
              `INSERT INTO valve_state (user_id, is_open, source, reason, last_changed_at)
                 VALUES (?, 1, 'system', NULL, NOW())
               ON DUPLICATE KEY UPDATE
                 is_open = VALUES(is_open),
                 source  = VALUES(source),
                 reason  = VALUES(reason),
                 last_changed_at = VALUES(last_changed_at)`,
              [userId]
            );
          } catch (e) {
            console.error('[device/state] failed to re-open on top-up', e);
          }
          return res.json({ plan: null, valveOpen: true, valveReason: 'balance_ok', manualOverride: false, availableBalance: Number(availBal.toFixed(2)) });
        } else {
          return res.json({ plan: null, valveOpen: false, valveReason: 'no_balance', manualOverride: false, availableBalance: Number(availBal.toFixed(2)) });
        }
      }

      // Auto mode or missing valve_state row
      if (isOpenFlag === null) {
        if (availBal > 0) {
          try {
            await pool.execute(
              `INSERT INTO valve_state (user_id, is_open, source, reason, last_changed_at)
                 VALUES (?, 1, 'system', NULL, NOW())
               ON DUPLICATE KEY UPDATE
                 is_open = VALUES(is_open),
                 source  = VALUES(source),
                 reason  = VALUES(reason),
                 last_changed_at = VALUES(last_changed_at)`,
              [userId]
            );
          } catch (e) { console.error('[device/state] failed to persist balance-open', e); }
          return res.json({ plan: null, valveOpen: true, valveReason: 'balance_ok', manualOverride: false, availableBalance: Number(availBal.toFixed(2)) });
        } else {
          return res.json({ plan: null, valveOpen: false, valveReason: 'no_balance', manualOverride: false, availableBalance: Number(availBal.toFixed(2)) });
        }
      }

      // fallback respect persisted flag
      if (isOpenFlag === 1) {
        return res.json({ plan: null, valveOpen: true, valveReason: (vSource === 'manual') ? 'manual_override' : 'balance_ok', manualOverride: vSource === 'manual', availableBalance: Number(availBal.toFixed(2)) });
      } else {
        return res.json({ plan: null, valveOpen: false, valveReason: (vSource === 'manual') ? 'manual_close' : 'no_balance', manualOverride: vSource === 'manual', availableBalance: Number(availBal.toFixed(2)) });
      }
    } // end no-plan

    // ---------- PLAN exists (active) ----------
    // Use planAllowsOpen with balance as used in valve_states
    let planInfo;
    try {
      planInfo = await planAllowsOpen(plan.user_id || plan.id /* not used for planAllowsOpen but fine */, availBal);
      // Note: planAllowsOpen uses userId, we already passed correct info earlier in valve_states.
    } catch (e) {
      console.error('[device/state] planAllowsOpen error', e);
      planInfo = { hasPlan: true, allowsOpen: false, reason: 'plan_check_error' };
    }

    // Read latest meter
    const [[meterRow]] = await pool.execute(`SELECT volume FROM sensor_data WHERE user_id=? ORDER BY timestamp DESC LIMIT 1`, [userId]);
    const currVol = parseFloat(meterRow?.volume || 0);

    // Reset start_volume once per day (if needed)
    try {
      const [resetResult] = await pool.execute(
        `UPDATE user_plans
            SET last_reset_date = CURDATE(), start_volume = ?
          WHERE id = ? AND (last_reset_date IS NULL OR last_reset_date < CURDATE())`,
        [currVol, plan.id]
      );
      if (resetResult && resetResult.affectedRows > 0) {
        plan.start_volume = currVol;
      }
    } catch (e) {
      console.error('[device/state] reset update failed', e);
    }

    // consumedToday via ledger preferred
    let consumedToday = 0;
    try {
      consumedToday = await getConsumedTodayForPlan(plan.id, today);
      if (!Number.isFinite(consumedToday)) consumedToday = 0;
    } catch (e) {
      const startVol = (plan.start_volume !== null && typeof plan.start_volume !== 'undefined')
                         ? parseFloat(plan.start_volume || 0)
                         : currVol;
      consumedToday = Math.max(0, currVol - startVol);
    }

    const perDayTarget = Number(parseFloat(plan.per_day_target || 0));
    const durationDays = parseInt(plan.duration_days || 0, 10) || 0;
    const startMs = plan.start_datetime ? new Date(plan.start_datetime).getTime() : Date.now();
    const daysElapsed = Math.max(0, Math.floor((Date.now() - startMs) / (1000 * 60 * 60 * 24)));
    const daysLeft = (durationDays > 0) ? Math.max(0, durationDays - daysElapsed) : null;
    const remainingToday = Math.max(0, perDayTarget - consumedToday);

    // If plan just finished due to duration -> planAllowsOpen already marked plan_completed & persisted plan_locked
    // If daily limit hit -> planAllowsOpen already persisted 'daily_limit' and we should return valveOpen false for now
    // Determine final valveOpen/valveReason respecting plan_locked (cannot be re-opened by system) and balance
    // Re-read valve_state
    const [[vsAfter]] = await pool.execute(`SELECT is_open, reason, source FROM valve_state WHERE user_id=? LIMIT 1`, [userId]);
    const isOpenAfter = vsAfter ? vsAfter.is_open : null;
    const vReasonAfter = vsAfter?.reason || null;
    const manualOverride = !!(isOpenAfter === 1 && vsAfter?.source === 'manual');

    let valveOpen = false;
    let valveReason = 'ok';

    if (vReasonAfter === 'plan_locked') {
      valveOpen = false;
      valveReason = 'plan_locked';
    } else if (vReasonAfter === 'daily_limit') {
      valveOpen = false;
      valveReason = 'daily_limit';
    } else {
      // if planAllowsOpen allowed open and balance>0 => open; else closed
      if (planInfo && planInfo.allowsOpen && availBal > 0) {
        valveOpen = true;
        valveReason = 'plan_ok';
      } else if (planInfo && planInfo.reason === 'no_balance') {
        valveOpen = false;
        valveReason = 'no_balance';
      } else {
        valveOpen = false;
        valveReason = 'plan_blocked';
      }
    }

    // plan object to return
    const planObj = {
      planId: plan.id,
      id: plan.id,
      perDayTarget: Number(perDayTarget),
      totalTarget: Number(parseFloat(plan.total_target_liters || 0)),
      durationDays: durationDays,
      daysElapsed: Number(daysElapsed),
      daysLeft: daysLeft === null ? null : Number(daysLeft),
      endDate: (plan.start_datetime && durationDays>0) ? new Date(new Date(plan.start_datetime).getTime() + durationDays*86400000).toISOString().slice(0,10) : '-',
      consumedToday: Number(consumedToday.toFixed(2)),
      remainingToday: Number(remainingToday.toFixed(2)),
      startVolume: Number(plan.start_volume ?? 0),
      startDatetime: plan.start_datetime ?? null,
      status: planInfo && planInfo.reason === 'duration_complete' ? 'completed' : 'active'
    };

    return res.json({
      plan: planObj,
      valveOpen: !!valveOpen,
      valveReason,
      manualOverride,
      availableBalance: Number(availBal.toFixed(2))
    });

  } catch (err) {
    console.error('Device state error:', err);
    res.status(500).json({ error: 'Could not fetch device state.' });
  }
});



// Cancel plan route
app.post("/api/plans/cancel", async (req, res) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: 'Missing planId' });

  try {
    // Fetch user_id from plan (for valve update)
    const [[plan]] = await pool.execute(
      `SELECT user_id FROM user_plans WHERE id = ?`,
      [planId]
    );
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    // Transaction: delete days, delete plan, close valve
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('DELETE FROM user_plan_days WHERE plan_id = ?', [planId]);
      await conn.execute('DELETE FROM user_plans WHERE id = ?', [planId]);
      await conn.execute('UPDATE valve_state SET is_open = 0 WHERE user_id = ?', [plan.user_id]);
      await conn.commit();
      res.json({ success: true, message: "Plan totally removed." });
    } catch (errorTx) {
      await conn.rollback();
      console.error("Error cancelling plan (tx):", errorTx);
      res.status(500).json({ success: false, message: "Error cancelling plan." });
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Error cancelling plan:", error);
    res.status(500).json({ success: false, message: "Error cancelling plan." });
  }
});


// GET /api/plans/active (improved: returns latest plan even if not active)
app.get('/api/plans/active', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    // Fetch the most recent plan (any status)
    const [[plan]] = await pool.execute(
      `SELECT id, status, per_day_target, total_target_liters,
              duration_days, start_datetime, last_reset_date, start_volume
         FROM user_plans
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 1`,
      [userId]
    );

    if (!plan) return res.json({ active: false, plan: null });

    // Get latest meter reading to compute consumedToday
    const [[meterRow]] = await pool.execute(
      `SELECT volume FROM sensor_data WHERE user_id=? ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );
    const currVol = parseFloat(meterRow?.volume || 0);

    // If start_volume exists use it, otherwise treat startVol as currVol so previous usage doesn't count
    const startVol = (plan.start_volume !== null && typeof plan.start_volume !== 'undefined')
                      ? parseFloat(plan.start_volume || 0)
                      : currVol;

    const perDay = Number(parseFloat(plan.per_day_target || 0));
    let consumedToday = Math.max(0, currVol - startVol);
    if (!Number.isFinite(consumedToday)) consumedToday = 0;
    const remainingToday = Math.max(0, perDay - consumedToday);

    // days elapsed & left
    const startMs = plan.start_datetime ? new Date(plan.start_datetime).getTime() : Date.now();
    const daysElapsed = Math.max(0, Math.floor((Date.now() - startMs) / (1000 * 60 * 60 * 24)));
    const durationDays = parseInt(plan.duration_days || 0, 10) || 0;
    const daysLeft = Math.max(0, durationDays - daysElapsed);

    // build plan object for frontend
    const planObj = {
      id: plan.id,
      status: plan.status,                       // 'active' | 'completed' | 'cancelled' ...
      perDayTarget: Number(perDay),
      totalTarget: Number(parseFloat(plan.total_target_liters || 0)),
      durationDays,
      daysElapsed,
      daysLeft,
      consumedToday: Number(consumedToday.toFixed(2)),
      remainingToday: Number(remainingToday.toFixed(2)),
      startVolume: Number(parseFloat(plan.start_volume || 0)),
      startDatetime: plan.start_datetime,
      lastResetDate: plan.last_reset_date ?? null
    };

    return res.json({
      active: (plan.status === 'active'),
      plan: planObj
    });
  } catch (err) {
    console.error('Error fetching active/last plan:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/api/plans/latest', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    // fetch the latest plan (regardless of status)
    const [[plan]] = await pool.execute(
      `SELECT id, per_day_target, total_target_liters, duration_days,
              start_datetime, start_volume, status
         FROM user_plans
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 1`,
      [userId]
    );

    if (!plan) return res.json({ plan: null });

    // latest meter reading (may be undefined)
    const [[meterRow]] = await pool.execute(
      `SELECT volume, timestamp FROM sensor_data WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );
    const currVol = parseFloat(meterRow?.volume || 0);

    // Use recorded start_volume when present; otherwise treat current reading as startVolume
    const startVol = (plan.start_volume !== null && typeof plan.start_volume !== 'undefined')
                     ? parseFloat(plan.start_volume || 0)
                     : currVol;

    const perDayTarget = Number(parseFloat(plan.per_day_target || 0));
    let consumedToday = Math.max(0, currVol - startVol);
    // guard NaN
    if (!Number.isFinite(consumedToday)) consumedToday = 0;
    const remainingToday = Math.max(0, perDayTarget - consumedToday);

    // compute days elapsed/left
    const startMs = plan.start_datetime ? new Date(plan.start_datetime).getTime() : Date.now();
    const durationDays = parseInt(plan.duration_days || 0, 10) || 0;
    const daysElapsed = Math.max(0, Math.floor((Date.now() - startMs) / (1000 * 60 * 60 * 24)));
    const daysLeft = Math.max(0, durationDays - daysElapsed);

    // compute end date string
    const startDateObj = plan.start_datetime ? new Date(plan.start_datetime) : new Date();
    const endDate = new Date(startDateObj.getTime() + durationDays * 24 * 60 * 60 * 1000);
    const endDateStr = endDate.toISOString().slice(0, 10);

    // respond with mapped fields the frontend expects
    res.json({
      plan: {
        id: plan.id,
        planId: plan.id,
        perDayTarget: perDayTarget,
        totalTarget: Number(parseFloat(plan.total_target_liters || 0)),
        durationDays: durationDays,
        daysElapsed,
        daysLeft,
        endDate: endDateStr,
        consumedToday: Number(consumedToday.toFixed(2)),
        remainingToday: Number(remainingToday.toFixed(2)),
        startVolume: Number(parseFloat(plan.start_volume || startVol || 0)),
        startDatetime: plan.start_datetime,
        status: plan.status || 'unknown'
      }
    });
  } catch (err) {
    console.error('/api/plans/latest error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});




// Crop Regions
app.get('/api/plans/regions', async (req, res) => {
  const crop = req.query.crop;
  if (!crop) return res.status(400).json({ error: 'Missing crop' });

  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT region
         FROM crop_water_requirements
        WHERE crop_name = ?
        ORDER BY region`,
      [crop]
    );
    res.json(rows.map(r => r.region));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch regions' });
  }
});

// Stages with Regions
app.get('/api/plans/stages', async (req, res) => {
  const { crop, region } = req.query;
  if (!crop || !region) return res.status(400).json({ error: 'Missing crop or region' });

  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT growth_stage
         FROM crop_water_requirements
        WHERE crop_name = ? AND region = ?
        ORDER BY growth_stage`,
      [crop, region]
    );
    res.json(rows.map(r => r.growth_stage));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch stages' });
  }
});

// --------------------
// Start the Server
// --------------------
const PORT = 3005;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});