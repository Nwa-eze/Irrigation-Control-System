const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2/promise'); // Promise-based MySQL client
const path = require('path');
require('dotenv').config();   // ← this loads .env into process.env
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Stripe dependency
const axios = require("axios");
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL   = "https://api.paystack.co";


const app = express();
app.use(cors({
  origin: 'http://10.218.220.142:3005', // Your frontend URL
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
  // 1) Log the raw incoming payload
  console.log("📥 [receive_data] raw body:", JSON.stringify(req.body));

  // 2) Destructure by key
  const { user1, user2, user3 } = req.body || {};

  // 3) Validate presence of all three
  if (!user1 || !user2 || !user3) {
    console.warn("⚠️ [receive_data] missing user1/user2/user3:", req.body);
    return res.status(400).send("❌ Invalid data format");
  }

  // 4) Parse each field and log
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

  // 5) Insert all three in one go
  try {
    await pool.execute(
      `INSERT INTO sensor_data (user_id, flow, volume, cost) VALUES
         (1, ?, ?, ?),
         (2, ?, ?, ?),
         (3, ?, ?, ?)`,
      [
        flow1,   volume1,   cost1,
        flow2,   volume2,   cost2,
        flow3,   volume3,   cost3
      ]
    );
    console.log("✅ [receive_data] sensor_data inserted for users 1,2,3");
    return res.send("✅ Data received and stored");
  } catch (err) {
    console.error("❌ [receive_data] DB insert error:", err);
    return res.status(500).send("❌ Error inserting sensor data");
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
      success_url: `http://10.218.220.142:3005/dashboard.html?payment=success&type=postpaid&amount=${amount}&userId=${userId}`,
      cancel_url: 'http://10.218.220.142:3005/dashboard.html?payment=cancel',
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
        amount: Math.round(amount),                // in kobo
        metadata: { userId, type },
        callback_url: `http://10.218.220.142:3005/api/paystack/callback`
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
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
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
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
      cancel_url: 'http://10.218.220.142:3005/cancel.html',
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
        callback_url: `http://10.218.220.142:3005/paystack/callback`,
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
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
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
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

// server.js — replace existing /valve_states route with this
app.get('/valve_states', async (req, res) => {
  try {
    // CONFIG: policy - 'safety-first' will make plan/balance override manual override.
    // Change to 'manual-first' if you want manual override to always win.
    const POLICY = 'safety-first'; // 'safety-first' | 'manual-first'

    // Users to check (adjust as needed)
    const userIds = [1,2,3];

    // Fetch balances + manual flags
    const [rows] = await pool.query(
      `SELECT u.id AS user_id,
              COALESCE(u.available_balance, 0) AS available_balance,
              COALESCE(v.is_open, 0)       AS manual_is_open
         FROM users u
         LEFT JOIN valve_state v ON v.user_id = u.id
        WHERE u.id IN (?,?,?)
        ORDER BY u.id`,
      userIds
    );

    console.log('[/valve_states] fetched rows:', rows);

    // Helper: check active plan and decide whether plan allows open.
    // - handles meter rollover by resyncing plan.start_volume
    // - marks plan completed when limit or duration reached
    async function planAllowsOpen(userId) {
      const [[plan]] = await pool.execute(
        `SELECT id, start_volume, per_day_target, total_target_liters, duration_days, start_datetime, last_reset_date
           FROM user_plans
          WHERE user_id=? AND status='active'
          ORDER BY id DESC
          LIMIT 1`,
        [userId]
      );
      if (!plan) return { allowsOpen: false, reason: 'no_plan' };

      // latest sensor row
      const [[meterRow]] = await pool.execute(
        `SELECT volume, timestamp FROM sensor_data WHERE user_id=? ORDER BY timestamp DESC LIMIT 1`,
        [userId]
      );
      const currVol = parseFloat(meterRow?.volume || 0);

      // Use recorded start_volume if exists; otherwise treat startVol == currVol to avoid counting prior flow
      let startVol = (plan.start_volume !== null && typeof plan.start_volume !== 'undefined')
                       ? parseFloat(plan.start_volume || 0)
                       : currVol;

      // If meter rolled over (currVol < startVol), treat consumedToday = currVol and resync DB
      let consumedToday;
      if (currVol >= startVol) {
        consumedToday = currVol - startVol;
      } else {
        // Rollover detected
        consumedToday = currVol;
        try {
          await pool.execute(
            `UPDATE user_plans SET start_volume = ? WHERE id = ?`,
            [currVol, plan.id]
          );
          startVol = currVol;
          console.log(`[planAllowsOpen] resynced start_volume for plan ${plan.id} user ${userId} -> ${currVol}`);
        } catch (updErr) {
          console.error('[planAllowsOpen] failed to resync start_volume:', updErr);
        }
      }

      const perDay = parseFloat(plan.per_day_target || 0);
      const duration = parseInt(plan.duration_days || 0);
      const startMs = plan.start_datetime ? new Date(plan.start_datetime).getTime() : Date.now();
      const daysElapsed = Math.floor((Date.now() - startMs) / (1000*60*60*24));
      const hitToday = perDay > 0 && consumedToday >= perDay;
      const exceedDays = duration > 0 && daysElapsed >= duration;

      console.log(`[planAllowsOpen] user=${userId} planId=${plan.id} currVol=${currVol} startVol=${startVol} consumedToday=${consumedToday} perDay=${perDay} daysElapsed=${daysElapsed} duration=${duration}`);

      // If finished by days or daily limit, mark completed
      if (exceedDays || hitToday) {
        const reason = exceedDays ? 'duration_complete' : 'daily_limit';
        try {
          await pool.execute(
            `UPDATE user_plans
                SET status = 'completed',
                    completed_at = NOW()
              WHERE id = ? AND status = 'active'`,
            [plan.id]
          );
          console.log(`[planAllowsOpen] plan ${plan.id} marked completed for user ${userId} due to ${reason}`);
        } catch (updErr) {
          console.error('[planAllowsOpen] failed to mark plan completed:', updErr);
        }
        return { allowsOpen: false, reason, consumedToday, perDay, daysElapsed, duration };
      }

      return { allowsOpen: true, reason: 'plan_ok', consumedToday, perDay, daysElapsed, duration };
    }

    // Compute policy for each user
    const result = {};
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const uid = r.user_id;
      const balance = parseFloat(r.available_balance || 0);
      const manualOpen = !!r.manual_is_open;

      // planInfo may also mark plan completed as side effect
      let planInfo;
      try {
        planInfo = await planAllowsOpen(uid);
      } catch (e) {
        console.error(`[valve_states] planAllowsOpen failed for user ${uid}:`, e);
        planInfo = { allowsOpen: false, reason: 'plan_check_error' };
      }

      // Decide final open boolean using chosen policy — safety-first by default
      let open = false;
      let reason = 'idle';

      // Safety-first: balance and plan completion override manual opens
      if (balance <= 0) {
        open = false; reason = 'no_balance';
      } else if (planInfo && !planInfo.allowsOpen) {
        // a plan exists but disallows open (daily limit or duration) -> close
        open = false; reason = planInfo.reason || 'plan_block';
      } else if (manualOpen && POLICY === 'manual-first') {
        // manual-first policy: manual override can force open
        open = true; reason = 'manual_override';
      } else if (planInfo && planInfo.allowsOpen) {
        // plan allows open and balance > 0 -> open
        open = true; reason = planInfo.reason || 'plan_ok';
      } else if (manualOpen && POLICY === 'safety-first') {
        // safety-first: manual only opens if there is no plan-block and balance > 0
        open = true; reason = 'manual_override';
      } else {
        open = false; reason = 'no_plan';
      }

      result[`user${uid}_state`]        = !!open;
      result[`user${uid}_reason`]       = reason;
      result[`user${uid}_consumedToday`]= planInfo?.consumedToday ?? null;
      result[`user${uid}_perDayTarget`] = planInfo?.perDay ?? null;
      result[`user${uid}_daysElapsed`]  = planInfo?.daysElapsed ?? null;
      result[`user${uid}_duration`]     = planInfo?.duration ?? null;
    }

    console.log('[/valve_states] result:', result);
    return res.json(result);
  } catch (err) {
    console.error('Error in /valve_states:', err);
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
      `INSERT INTO valve_state (user_id, is_open)
         VALUES (?, TRUE)
       ON DUPLICATE KEY UPDATE is_open = TRUE`,
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
      `INSERT INTO valve_state (user_id, is_open)
         VALUES (?, FALSE)
       ON DUPLICATE KEY UPDATE is_open = FALSE`,
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
      `SELECT water_l_per_m2_per_day AS rate,
              days AS duration
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

      // fetch fresh balance (outside transaction or using conn)
      const [[{ available_balance }]] = await pool.execute(
        `SELECT available_balance FROM users WHERE id = ?`,
        [userId]
      );

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

app.get('/api/device/state', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    // 1) fetch active plan
    const [[plan]] = await pool.execute(
      `SELECT id, start_volume, per_day_target, total_target_liters,
              duration_days, start_datetime, last_reset_date
         FROM user_plans
        WHERE user_id=? AND status='active'
        ORDER BY id DESC
        LIMIT 1`,
      [userId]
    );

    // No active plan -- return valve state and balance
    if (!plan) {
      const [[vsRow]] = await pool.execute(
        `SELECT is_open FROM valve_state WHERE user_id=? LIMIT 1`,
        [userId]
      );
      const [[{ available_balance = 0 }]] = await pool.execute(
        `SELECT available_balance FROM users WHERE id = ?`,
        [userId]
      );
      const avail = parseFloat(available_balance) || 0;
      const manualOverride = !!vsRow?.is_open;
      const valveOpen = manualOverride && avail > 0;

      return res.json({
        plan: null,
        valveOpen: !!valveOpen,
        valveReason: valveOpen ? 'manual_override' : (avail <= 0 ? 'no_balance' : 'idle'),
        manualOverride,
        availableBalance: Number(avail.toFixed(2))
      });
    }

    // 2) latest meter reading
    const [[{ volume: currVolRaw = 0 }]] = await pool.execute(
      `SELECT volume FROM sensor_data WHERE user_id=? ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );
    const currVol = parseFloat(currVolRaw) || 0;

    // 3) manual override flag (make mutable)
    const [[vsRow2]] = await pool.execute(
      `SELECT is_open FROM valve_state WHERE user_id=? LIMIT 1`,
      [userId]
    );
    let manualOverride = !!vsRow2?.is_open;

    // 4) available balance
    const [[{ available_balance = 0 }]] = await pool.execute(
      `SELECT available_balance FROM users WHERE id = ?`,
      [userId]
    );
    const availBal = parseFloat(available_balance) || 0;

    // 5) DB-driven daily reset (safe update: only runs when last_reset_date is older than today)
    const today = todayString();
    const [resetResult] = await pool.execute(
      `UPDATE user_plans
          SET last_reset_date = CURDATE(), start_volume = ?
        WHERE id = ? AND (last_reset_date IS NULL OR last_reset_date < CURDATE())`,
      [currVol, plan.id]
    );
    if (resetResult && resetResult.affectedRows > 0) {
      plan.start_volume = currVol;
      plan.last_reset_date = today;
    }

    // 6) compute consumption and times
    // If start_volume is null/undefined, treat it as 0? (we prefer treating as currVol so pre-plan flow doesn't count)
    const startVol = (plan.start_volume !== null && typeof plan.start_volume !== 'undefined')
                       ? parseFloat(plan.start_volume || 0)
                       : currVol;

    let consumedToday = currVol - startVol;
    if (consumedToday < 0) consumedToday = 0; // guard against rollovers

    const perDayTarget = Number(parseFloat(plan.per_day_target) || 0);
    const remainingToday = Math.max(0, perDayTarget - consumedToday);

    // days elapsed & left
    const nowMs   = Date.now();
    const startMs = plan.start_datetime ? new Date(plan.start_datetime).getTime() : nowMs;
    const daysElapsed = Math.max(0, Math.floor((nowMs - startMs) / (1000 * 60 * 60 * 24)));
    const durationDays = parseInt(plan.duration_days, 10) || 0;
    const daysLeft = Math.max(0, durationDays - daysElapsed);

    // end date
    const startDate = plan.start_datetime ? new Date(plan.start_datetime) : new Date();
    const endDate = new Date(startDate.getTime() + durationDays * 24 * 60 * 60 * 1000);
    const endDateStr = endDate.toISOString().slice(0,10);

    // 7) decide valve open + reason
    const hitTodayLimit = perDayTarget > 0 && consumedToday >= perDayTarget;
    const exceedDays    = durationDays > 0 && daysElapsed >= durationDays;

    let valveOpen = false;
    let valveReason = 'ok';

    if (availBal <= 0) {
      valveOpen = false;
      valveReason = 'no_balance';
    } else if (manualOverride) {
      // manual override always allows open (user requested)
      valveOpen = true;
      valveReason = 'manual_override';
    } else if (exceedDays) {
      valveOpen = false;
      valveReason = 'duration_complete';
    } else if (hitTodayLimit) {
      valveOpen = false;
      valveReason = 'daily_limit';
    } else {
      valveOpen = true;
      valveReason = 'ok';
    }

    // 7b) If the system closed the valve (not manual) and there is a manual flag set in DB,
    // clear it so the UI won't incorrectly keep showing "manual".
    if (!valveOpen && manualOverride) {
      try {
        await pool.execute(
          `UPDATE valve_state SET is_open = FALSE WHERE user_id = ?`,
          [userId]
        );
        manualOverride = false; // reflect cleared flag in the response
        console.log(`[device/state] cleared manual override for user ${userId} because system closed valve`);
      } catch (clearErr) {
        console.error('[device/state] failed to clear manual override flag:', clearErr);
        // don't fail the whole request for this
      }
    }

    // 8) auto-complete if fully done:
    // - mark completed when duration completes OR when daily target is met (if not manually overridden)
    if (exceedDays || (hitTodayLimit && !manualOverride)) {
      try {
        await pool.execute(
          `UPDATE user_plans SET status='completed', completed_at = NOW() WHERE id = ? AND status = 'active'`,
          [plan.id]
        );
        console.log(`[device/state] marked plan ${plan.id} completed for user ${userId} (exceedDays=${exceedDays}, hitTodayLimit=${hitTodayLimit}, manualOverride=${manualOverride})`);
      } catch (updErr) {
        console.error('[device/state] failed to mark plan completed:', updErr);
      }
    }

    // 9) respond with numeric values and helpful metadata
    return res.json({
      plan: {
        planId:        plan.id,
        perDayTarget:  Number(perDayTarget),
        totalTarget:   Number(parseFloat(plan.total_target_liters) || 0),
        durationDays:  durationDays,
        daysElapsed,
        daysLeft,
        endDate:       endDateStr,
        consumedToday: Number(Number(consumedToday).toFixed(2)),
        remainingToday:Number(Number(remainingToday).toFixed(2)),
        startVolume:   Number(parseFloat(plan.start_volume) || 0),
        startDatetime: plan.start_datetime
      },
      valveOpen:        !!valveOpen,
      valveReason,
      manualOverride:   !!manualOverride,
      availableBalance: Number(availBal.toFixed(2))
    });

  } catch (err) {
    console.error('Device state error:', err);
    res.status(500).json({ error: 'Could not fetch device state.' });
  }
});


// Cancel plan route
app.post("/plans/cancel", async (req, res) => {
    const { planId } = req.body;

    try {
        // Update DB so that the plan status becomes cancelled
        await pool.query(
            "UPDATE plans SET status = 'cancelled', end_time = NOW() WHERE id = ?",
            [planId]
        );

        res.json({ success: true, message: "Plan cancelled successfully." });
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
  console.log(`🚀 Server running at http://10.218.220.142:${PORT}`);
});
