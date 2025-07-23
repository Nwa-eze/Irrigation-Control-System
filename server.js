const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2/promise'); // Promise-based MySQL client
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Stripe dependency
const axios = require("axios");
const PAYSTACK_BASE_URL   = "https://api.paystack.co";


const app = express();
app.use(cors({
  origin: 'http://10.151.85.142:3005', // Your frontend URL
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));


// Create a MySQL connection pool (adjust with your credentials)
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '', // Your MySQL password
  database: 'water distribution', // Database name with space
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// --------------------
// Registration Endpoint (optional, for new users)
// --------------------
app.post('/register', async (req, res) => {
  const {
    username,
    password,
    profile,
    address,
    farm
  } = req.body;

  // Destructure nested objects
  const {
    email,
    phone,
    full_name,
    date_of_birth,
    gender
  } = profile || {};

  const {
    address_line1,
    address_line2,
    city,
    state_province,
    country,
    postal_code
  } = address || {};

  const {
    location,
    farm_id
  } = farm || {};

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Insert into users
    const [userResult] = await conn.execute(
      `INSERT INTO users
         (username, password, location, farm_id)
       VALUES (?, ?, ?, ?)`,
      [username, password, location, farm_id]
    );
    const userId = userResult.insertId;

    // 2) Insert into user_profiles
    await conn.execute(
      `INSERT INTO user_profiles
         (user_id, email, phone, full_name, date_of_birth, gender)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, email, phone, full_name, date_of_birth, gender]
    );

    // 3) Insert into user_addresses (marking as primary)
    await conn.execute(
      `INSERT INTO user_addresses
         (user_id, address_line1, address_line2, city, state_province, country, postal_code, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [userId, address_line1, address_line2, city, state_province, country, postal_code]
    );

    await conn.commit();
    res.status(201).json({ message: 'User registered successfully.' });

  } catch (error) {
    await conn.rollback();
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Error registering user.' });

  } finally {
    conn.release();
  }
});



// --------------------
// Login Endpoint (using plain authentication)
// --------------------

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    // Pull id, name, location, farm_id, matric_number
    const [rows] = await pool.execute(
      `SELECT id, name, location, farm_id, matric_number
         FROM users
        WHERE username = ? AND password = ?
        LIMIT 1`,
      [username, password]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const user = rows[0];
    // On success, send back JSON (status defaults to 200)
    res.json({
      userId:        user.id,
      name:          user.name,
      location:      user.location,
      farm_id:       user.farm_id,
      matric_number: user.matric_number
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Server error during login." });
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
app.post('/receive_data', async (req, res) => {
  const data = req.body;
  console.log("📥 Incoming Sensor Data:", data);

  if (data && data.user1 && data.user2 && data.user3) {
    try {
      await pool.execute(
        "INSERT INTO sensor_data (user_id, flow, volume, cost) VALUES (?, ?, ?, ?)",
        [1, parseFloat(data.user1.flow || 0), parseFloat(data.user1.volume || 0), parseFloat(data.user1.cost || 0)]
      );
      await pool.execute(
        "INSERT INTO sensor_data (user_id, flow, volume, cost) VALUES (?, ?, ?, ?)",
        [2, parseFloat(data.user2.flow || 0), parseFloat(data.user2.volume || 0), parseFloat(data.user2.cost || 0)]
      );
      await pool.execute(
        "INSERT INTO sensor_data (user_id, flow, volume, cost) VALUES (?, ?, ?, ?)",
        [3, parseFloat(data.user3.flow || 0), parseFloat(data.user3.volume || 0), parseFloat(data.user3.cost || 0)]
      );
      console.log("✅ Sensor data inserted for user1, user2, and user3.");
      res.send("✅ Data received and stored");
    } catch (error) {
      console.error("Error inserting sensor data:", error);
      res.status(500).send("❌ Error inserting sensor data");
    }
  } else {
    console.log("⚠️ Invalid or empty sensor data received.");
    res.status(400).send("❌ Invalid data format");
  }
});

app.post("/create-postpaid-session", async (req, res) => {
  const { amount, userId } = req.body; 
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Postpaid Water Invoice Payment',
          },
          unit_amount: amount * 100,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `http://10.151.85.142:3005/dashboard.html?payment=success&type=postpaid&amount=${amount}&userId=${userId}`,
      cancel_url: 'http://10.151.85.142:3005/dashboard.html?payment=cancel',
      metadata: {
        payment_type: 'postpaid',
        user_id: userId
      }
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
    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        email: 'hellozed10@gmail.com',    // hardcode or pull from users table
        amount: Math.round(amount * 100),                // in kobo
        metadata: { userId, type },
        callback_url: `http://10.151.85.142:3005/api/paystack/callback`
      },
    );
    res.json(response.data.data);
  } catch (err) {
    console.error('Paystack init error', err.response?.data || err);
    res.status(500).json({ error: 'Paystack initialize failed' });
  }
});

// Paystack callback verification
app.get('/api/paystack/callback', async (req, res) => {
  const reference = req.query.reference;
  try {
    const response = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
    );
    // you can check response.data.data.status === 'success'
    res.redirect(`/dashboard.html?payment=success&type=postpaid&amount=${response.data.data.amount/100}`);
  } catch (err) {
    console.error('Paystack verify error', err.response?.data || err);
    res.redirect(`/dashboard.html?payment=failed`);
  }
});

// --------------------
// Stripe Checkout Session Endpoint
// --------------------
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { amount } = req.body; // amount in naira (or cents, depending on your front-end)
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd', // or 'ngn', whichever you prefer
            product_data: {
              name: 'Prepaid Water Payment',
            },
            unit_amount: amount * 100, // amount in cents (if USD), or *100 if NGN in kobo
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      // ←– note the addition of `type=prepaid`
      success_url:
        'http://10.151.85.142:3005/dashboard.html?payment=success&type=prepaid&amount=' +
        amount,
      cancel_url: 'http://10.151.85.142:3005/cancel.html',
    });
    res.json({ id: session.id });
  } catch (error) {
    console.error("Stripe Checkout Session Error:", error);
    res.status(500).json({ error: error.message });
  }
});


// Initialize a Paystack transaction
app.post("/paystack/initialize", async (req, res) => {
  const { email, amount, metadata } = req.body;
  try {
    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        email,
        amount,
        metadata,
        callback_url: `http://10.151.85.142:3005/paystack/callback`,
      },
      {
        headers: {
        },
      }
    );
    res.json({
      authorization_url: response.data.data.authorization_url,
    });
  } catch (err) {
    console.error("Paystack init error:", err.response?.data || err);
    res.status(500).send("Paystack initialization failed");
  }
});

app.get("/paystack/callback", async (req, res) => {
  const reference = req.query.reference;
  try {
    // verify transaction
    const verification = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
      {
        headers: {
        },
      }
    );
    const { status, amount, metadata } = verification.data.data;
    if (status === "success") {
      // → Send user back to dashboard with both `type` and `amount` in query
      res.redirect(
        `/dashboard.html?payment=success&type=${metadata.type}&amount=${amount / 100}`
      );
    } else {
      res.redirect(`/dashboard.html?payment=failed`);
    }
  } catch (err) {
    console.error("Paystack verify error:", err.response?.data || err);
    res.redirect(`/dashboard.html?payment=failed`);
  }
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

app.get('/valve_states', async (req, res) => {
  try {
    // fetch balances for users 1,2,3
    const [rows] = await pool.query(
      `SELECT id, available_balance
       FROM users
       WHERE id IN (1,2,3)
       ORDER BY id`
    );

    // build an array [bal1, bal2, bal3]
    const balances = [0, 0, 0];
    rows.forEach(r => {
      const idx = r.id - 1;             // user 1 → index 0
      balances[idx] = parseFloat(r.available_balance) || 0;
    });

    // **Tweak:** use the “_state” suffix to match your ESP parsing
    res.json({
      user1_state: balances[0],
      user2_state: balances[1],
      user3_state: balances[2]
    });
  } catch (err) {
    console.error('Error in /valve_states:', err);
    res.status(500).json({ error: 'DB error' });
  }
});



// ─── PLANNER / VALVE CONTROL ROUTES ────────────────────────────────────

// 1) Start a new plan (deduct flat fee & record target liters)
app.post('/api/plans/calculate', async (req, res) => {
  const { crop, region, stage, area } = req.body;
  try {
    const [[row]] = await pool.execute(
      `SELECT water_l_per_m2_per_day, duration_days
         FROM crop_water_requirements
        WHERE crop_name = ?
          AND region    = ?
          AND growth_stage = ?
        LIMIT 1`,
      [crop, region, stage]
    );
    if (!row) {
      return res.status(404).json({ error: 'Crop data not found.' });
    }

    const ratePerM2    = parseFloat(row.water_l_per_m2_per_day);
    const durationDays = parseInt(row.duration_days, 10);
    const dailyVolume  = ratePerM2 * parseFloat(area);
    const totalTarget  = dailyVolume * durationDays;
    const flatFee      = 10;

    // return the calculated values without touching balance or plans table
    res.json({
      dailyVolume:  dailyVolume.toFixed(2),
      totalTarget:  totalTarget.toFixed(2),
      durationDays,
      flatFee:      flatFee.toFixed(2)
    });
  } catch (err) {
    console.error('Calculation error:', err);
    res.status(500).json({ error: 'Calculation failed.' });
  }
});

// 2) Start (pay & persist)
app.post('/api/plans/start', async (req, res) => {
  console.log('▶️ /api/plans/start body:', req.body);
  const { userId, crop, region, stage, area } = req.body;

  if ([userId, crop, region, stage, area].some(v => v == null)) {
    return res.status(400).json({ 
      error: 'Missing plan parameter',
      received: req.body
    });
  }
  try {
    const [[row]] = await pool.execute(
      `SELECT water_l_per_m2_per_day, duration_days
         FROM crop_water_requirements
        WHERE crop_name=? AND region=? AND growth_stage=? LIMIT 1`,
      [crop, region, stage]
    );
    if (!row) {
      return res.status(404).json({ error: 'Crop data not found.' });
    }

    const ratePerM2    = parseFloat(row.water_l_per_m2_per_day);
    const durationDays = parseInt(row.duration_days, 10);
    const dailyVolume  = ratePerM2 * parseFloat(area);
    const totalTarget  = dailyVolume * durationDays;
    const flatFee      = 10;

    // Deduct flat fee from user balance
    await pool.execute(
    `UPDATE users
       SET available_balance = GREATEST(0, available_balance - ?)
     WHERE id = ?`,
    [flatFee, userId]
  );

    // Grab current meter volume
    const [[{ volume: startVol = 0 }]] = await pool.execute(
      `SELECT volume FROM sensor_data WHERE user_id=? ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );

    // Insert persistent plan entry
    const [resPlan] = await pool.execute(
      `INSERT INTO user_plans
         (user_id, crop_id, stage, field_area_m2,
          start_volume, total_target_liters,
          duration_days, per_day_target,
          start_datetime, last_reset_date,
          flat_fee, status)
       VALUES
         (?,
          (SELECT id FROM crop_water_requirements
             WHERE crop_name=? AND region=? AND growth_stage=?),
          ?, ?, ?, ?, ?, ?, NOW(), CURDATE(), ?, 'active')`,
      [
        userId, crop, region, stage,
        stage, area, startVol, totalTarget,
        durationDays, dailyVolume, flatFee
      ]
    );

    const planId = resPlan.insertId;
    if (!resPlan || !resPlan.insertId) {
    return res.status(500).json({ error: 'Failed to create plan in database.' });
  }


    // 6) Fetch the newly updated balance:
    const [[{ available_balance: newBalanceStr }]] = await pool.execute(
      `SELECT available_balance FROM users WHERE id = ?`,
      [userId]
    );
    const newBalance = parseFloat(newBalanceStr);

    // Return the new plan details
    res.json({
    planId,
    dailyVolume:  dailyVolume.toFixed(2),
    totalTarget:  totalTarget.toFixed(2),
    durationDays,
    flatFee:      flatFee.toFixed(2),
    newBalance:   newBalance.toFixed(2)    // <— add this
  });
  } catch (err) {
    console.error('Plan start error:', err);
    res.status(500).json({ error: 'Could not start plan.' });
  }
});

// 3) Manual Reopen Valve
app.post('/api/valve/open', async (req, res) => {
  const userId = req.body.userId;
  try {
    await pool.execute(
      `INSERT INTO valve_state (user_id, is_open)
        VALUES (?, TRUE)
      ON DUPLICATE KEY UPDATE is_open = TRUE`,
      [userId]
    );
    res.sendStatus(204);
  } catch (err) {
    console.error('Valve open error:', err);
    res.status(500).json({ error: 'Could not reopen valve.' });
  }
});

// 4) Device polling endpoint
app.get('/api/device/state', async (req, res) => {
  const userId = req.query.userId;
  try {
    const [[plan]] = await pool.execute(
      `SELECT start_volume, total_target_liters
         FROM user_plans
        WHERE user_id=? AND status='active'
        ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    const [[vs]] = await pool.execute(
      `SELECT is_open FROM valve_state WHERE user_id=?`,
      [userId]
    );
    res.json({ plan: plan || null, valveOpen: !!vs?.is_open });
  } catch (err) {
    console.error('Device state error:', err);
    res.status(500).json({ error: 'Could not fetch device state.' });
  }
});

// --------------------
// Start the Server
// --------------------
const PORT = 3005;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running at http://10.151.85.142:${PORT}`);
});
