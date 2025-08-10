let lastCostSeen = 0;
let processedTimestamps = new Set();
let lastVolumeSeen = 0;
let dailyTotal     = 0;
let monthlyTotal   = 0;
const processedVolumeTimestamps = new Set();

const PAYSTACK_BASE_URL   = 'https://api.paystack.co';


// ------------------------
// 1) SENSOR DATA / CHART
// ------------------------
async function loadSensorData() {
  const userId = localStorage.getItem("user_id");
  if (!userId) {
    console.error("No logged-in user found. Redirecting to login...");
    window.location.href = "login.html";
    return;
  }

  try {
    const response = await fetch(`http://10.218.220.142:3005/get_data?user_id=${userId}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    if (!response.ok) throw new Error("Failed to fetch sensor data");

    const data = await response.json();
    // (a) Update table
    displaySensorData(data);

    // (b) Deduct cost by chronological order
    const chronologicalData = data.slice().reverse();
    chronologicalData.forEach(row => updateBalanceIfFlow(row));

    // (c) Build chart from the last 10 entries
    const latestEntries = chronologicalData.slice(-10);
    const chartData = { labels: [], volumes: [] };
    latestEntries.forEach(entry => {
      chartData.labels.push(new Date(entry.timestamp).toLocaleTimeString());
      chartData.volumes.push(entry.volume);
    });
    createChart(chartData);

    updateWaterStats(data);
  } catch (error) {
    console.error("Error fetching sensor data:", error);
    // optional: silently fail or alert
  }
}

function updateWaterStats(data) {
  const now       = new Date();
  const Y         = now.getFullYear();
  const M         = now.getMonth();
  const D         = now.getDate();
  const monthKey  = `${Y}-${M}`;

  const todayEntries = data
    .map(r => ({ ts: new Date(r.timestamp), vol: parseFloat(r.volume) || 0 }))
    .filter(e =>
      e.ts.getFullYear() === Y &&
      e.ts.getMonth()    === M &&
      e.ts.getDate()     === D
    )
    .sort((a, b) => a.ts - b.ts);

  const todayTotal = todayEntries.length
    ? todayEntries[todayEntries.length - 1].vol
    : 0;

  // Write today’s total to the DOM
  const todayElem = document.getElementById("total-water-today");
  if (todayElem) todayElem.textContent = `${todayTotal.toFixed(2)} L`;


  let storedMonth = localStorage.getItem("baseline_month");
  let baselineVol = parseFloat(localStorage.getItem("baseline_volume"));
  // Gather this month’s readings
  const monthEntries = data
    .map(r => ({ ts: new Date(r.timestamp), vol: parseFloat(r.volume) || 0 }))
    .filter(e =>
      e.ts.getFullYear() === Y &&
      e.ts.getMonth()    === M
    )
    .sort((a, b) => a.ts - b.ts);

  let monthTotal = 0;

  if (monthEntries.length === 0) {
    // No data this month → zero out
    localStorage.removeItem("baseline_month");
    localStorage.removeItem("baseline_volume");
  } else {
    // If it’s a new month (or first-ever run), capture the first reading
    if (storedMonth !== monthKey || isNaN(baselineVol)) {
      baselineVol = monthEntries[0].vol;
      localStorage.setItem("baseline_month", monthKey);
      localStorage.setItem("baseline_volume", baselineVol.toFixed(2));
    }
    // Latest cumulative reading this month
    const latestVol = monthEntries[monthEntries.length - 1].vol;
    // Compute difference (never negative)
    monthTotal = Math.max(0, latestVol - baselineVol);
  }

  // Write month’s total to the DOM
  const monthElem = document.getElementById("total-water-month");
  if (monthElem) monthElem.textContent = `${monthTotal.toFixed(2)} L`;
}


function displaySensorData(data) {
  const tableBody = document.getElementById("data-table");
  if (!tableBody) return;

  tableBody.innerHTML = "";
  if (!Array.isArray(data) || data.length === 0) {
    tableBody.innerHTML = "<tr><td colspan='4'>No sensor data available</td></tr>";
    return;
  }

  data.forEach(row => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(row.timestamp).toLocaleString()}</td>
      <td>${parseFloat(row.flow).toFixed(2)}</td>
      <td>${parseFloat(row.volume).toFixed(2)}</td>
      <td>${parseFloat(row.cost).toFixed(2)}</td>
    `;
    tableBody.appendChild(tr);
  });
}

let chartInstance = null;

function createChart(data) {
  const ctx = document.getElementById('usageChart')?.getContext('2d');
  if (!ctx) return;

  if (chartInstance) {
    chartInstance.destroy();
  }

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.labels,
      datasets: [{
        label: 'Volume (L)',
        data: data.volumes,
        borderColor: '#36A2EB',
        backgroundColor: 'rgba(54,162,235,0.1)',
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      scales: {
        x: {
          title: {
            display: true,
            text: 'Time (hh:mm:ss)',
            font: { size: 14, weight: 'bold' }
          }
        },
        y: {
          title: {
            display: true,
            text: 'Volume (L)',
            font: { size: 14, weight: 'bold' }
          },
          beginAtZero: true
        }
      },
      plugins: {
        legend: {
          display: false    // hides the legend entirely
        },
        title: {
          display: true,
          text: 'Water Volume (Last 10 Entries)'
        }
      }
    }
  });
}


function updateAnalyticsInfo() {
  const nameSpan    = document.getElementById("analytics-name");
  const farmIdSpan  = document.getElementById("analytics-farm-id");
  const matricSpan  = document.getElementById("analytics-matric");

  if (nameSpan)   nameSpan.textContent   = localStorage.getItem("user_name")      || "--";
  if (farmIdSpan) farmIdSpan.textContent = localStorage.getItem("farm_id")        || "--";
  if (matricSpan) matricSpan.textContent = localStorage.getItem("matric_number")  || "--";
}


// -------------------------------------------------
// 2) PREPAID PAYMENT (Stripe & Paystack, NO PRE-CREDIT)
// -------------------------------------------------
async function startStripePayment() {
  const amountInput = document.getElementById("payment-amount");
  const amount = parseFloat(amountInput?.value);
  if (isNaN(amount) || amount <= 0) {
    alert("Please enter a valid amount.");
    return;
  }

  const userId = localStorage.getItem("user_id");
  if (!userId) {
    alert("Not logged in.");
    return;
  }

  try {
    const resp = await fetch("http://10.218.220.142:3005/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: amount,
        userId: userId,
        type: "prepaid"
      })
    });
    const session = await resp.json();
    if (!session.id) throw new Error("Missing session ID");

    const stripe = Stripe("pk_test_51Qo6ArP6Eq8DZLKp1Jloq3I58N1MA1slOXKB8hK7IpgpdljVj33eVuOuc8MIYxdkilkQOtkLZgnR99oIy2W6bFSt00xSCHSgrM");
    const { error } = await stripe.redirectToCheckout({ sessionId: session.id });
    if (error) throw error;

  } catch (err) {
    console.error("Stripe payment error:", err);
    alert("Error initiating Stripe payment. Please try again later.");
  }
}

async function startPaystackPayment() {
  const amount = parseFloat(document.getElementById("payment-amount")?.value);
  if (isNaN(amount) || amount <= 0) {
    alert("Please enter a valid amount.");
    return;
  }

  const userId = localStorage.getItem("user_id");
  if (!userId) {
    alert("Not logged in.");
    return;
  }

  try {
    const resp = await fetch("http://10.218.220.142:3005/paystack/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "system@domain.com",        // or grab real user email if you prefer
        amount: Math.round(amount * 100),  // kobo
        metadata: { userId, type: "prepaid" }
      })
    });
    const { authorization_url } = await resp.json();
    if (!authorization_url) throw new Error("No auth URL returned");
    window.location.href = authorization_url;
  } catch (err) {
    console.error("Paystack payment error:", err);
    alert("Could not start Paystack payment. Please try later.");
  }
}

// -------------------------------------------------
// 3) COST DEDUCTION AS USAGE HAPPENS
// -------------------------------------------------
function updateBalanceIfFlow(row) {
  const userId     = localStorage.getItem("user_id");
  const balanceKey = "available_balance_" + userId;
  const costKey    = "last_cost_seen_"    + userId;
  const tsKey      = "last_ts_seen_"      + userId;

  const ts   = row.timestamp;
  const flow = parseFloat(row.flow) || 0;
  const cost = parseFloat(row.cost) || 0;

  // 1) In-session dedupe
  if (processedTimestamps.has(ts)) return;

  // 2) Cross-session dedupe: has this timestamp already been applied?
  const lastTsSeen = localStorage.getItem(tsKey);
  if (lastTsSeen && ts <= lastTsSeen) {
    processedTimestamps.add(ts);
    return;
  }

  // 3) Pull last cost & balance from storage
  let lastCostSeen = parseFloat(localStorage.getItem(costKey)) || 0;
  let balance      = parseFloat(localStorage.getItem(balanceKey)) || 0;

  // 4) Reset logic if the meter cost ever drops to zero or below
  if (cost <= 0) {
    lastCostSeen = 0;
    // Mark this ts as seen so we don't loop here again
    processedTimestamps.add(ts);
    localStorage.setItem(costKey, lastCostSeen.toFixed(2));
    localStorage.setItem(tsKey, ts);
    // Still update UI/chart so any reset shows immediately
    updateBalanceInfo();
    return;
  }

  // 5) If there's flow and a previous cost, compute delta
  if (flow > 0 && lastCostSeen > 0) {
    const delta = cost - lastCostSeen;
    if (delta > 0) {
      balance = Math.max(0, balance - delta);
      showDeductionAlert(delta);
    }
    // else delta ≤ 0 = no new charge
  }
  // 6) Else first real reading after reset: nothing to deduct

  // 7) Persist updated state
  lastCostSeen = cost;
  processedTimestamps.add(ts);
  localStorage.setItem(balanceKey, balance.toFixed(2));
  localStorage.setItem(costKey,   lastCostSeen.toFixed(2));
  localStorage.setItem(tsKey,     ts);

  // 8) Reflect in UI (balance display, chart, etc.)
  updateBalanceInfo();
}

function showDeductionAlert(amount) {
  let toast = document.getElementById("deduction-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "deduction-toast";
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      backgroundColor: "#333",
      color: "#fff",
      padding: "15px",
      borderRadius: "5px",
      boxShadow: "0 0 10px rgba(0,0,0,0.5)",
      opacity: "0",
      transition: "opacity 0.5s ease-in-out"
    });
    document.body.appendChild(toast);
  }
  toast.textContent = `₦${amount.toFixed(2)} was deducted from your balance.`;
  toast.style.opacity = "1";
  setTimeout(() => { toast.style.opacity = "0"; }, 3000);
}
// ------------------------
// 4) UPDATE “HOME” INFO
// ------------------------
function updateHomeInfo() {
  const userNameSpan     = document.getElementById("user-name");
  const userLocationSpan = document.getElementById("user-location");
  const farmIdSpan       = document.getElementById("farm-id");
  if (!userNameSpan || !userLocationSpan || !farmIdSpan) return;

  const name     = localStorage.getItem("user_name")     || "Unknown";
  const location = localStorage.getItem("user_location") || "Unknown";
  const farmId   = localStorage.getItem("farm_id")       || "000";
  userNameSpan.textContent     = name;
  userLocationSpan.textContent = location;
  farmIdSpan.textContent       = farmId;
}

// -----------------------------
// 5) UPDATE AVAILABLE BALANCE
// -----------------------------
function updateBalanceInfo() {
  const userId = localStorage.getItem("user_id");
  const balanceElem = document.getElementById("balance-info");
  if (!userId || !balanceElem) return;

  const balanceKey = "available_balance_" + userId;
  const balance = parseFloat(localStorage.getItem(balanceKey)) || 0;
  // We assume your HTML is something like “₦<span id='balance-info'>...</span>”
  balanceElem.textContent = `₦${balance.toFixed(2)}`;

  // Fire an update to backend
  updateBalanceInBackend(userId, balance);
}

async function updateBalanceInBackend(userId, balance) {
  try {
    const response = await fetch("http://10.218.220.142:3005/update_balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, available_balance: balance })
    });
    if (!response.ok) console.error("Failed to update backend balance");
  } catch (err) {
    console.error("Error updating balance in backend:", err);
  }
}

// -----------------------------
// 6) UPDATE POSTPAID DEBT
// -----------------------------
function updatePostpaidOwed() {
  const userId = localStorage.getItem("user_id");
  const owedKey = "postpaid_owed_" + userId;
  const owed = parseFloat(localStorage.getItem(owedKey)) || 0;

  // (a) In “Home” section, a span with id="home-owed-amount"
  const homeDebtSpan = document.getElementById("home-owed-amount");
  if (homeDebtSpan) homeDebtSpan.textContent = `₦${owed.toFixed(2)}`;

  // (b) In “Payments” section, a span with id="owed-amount"
  const paymentDebtSpan = document.getElementById("owed-amount");
  if (paymentDebtSpan) paymentDebtSpan.textContent = owed.toFixed(2);
}

// -----------------------------
// 7) HANDLE ADD CREDIT (Postpaid)
// -----------------------------
function handleAddPostpaid() {
  const select = document.getElementById("postpaid-select");
  const amount = parseFloat(select?.value);
  if (!amount || amount <= 0) {
    alert("Please select a valid amount");
    return;
  }

  const userId = localStorage.getItem("user_id");
  if (!userId) return;

  // (1) Increase available balance
  const balanceKey = "available_balance_" + userId;
  const currentBalance = parseFloat(localStorage.getItem(balanceKey)) || 0;
  const newBalance = currentBalance + amount;
  localStorage.setItem(balanceKey, newBalance.toFixed(2));

  // (2) Increase postpaid debt
  const owedKey = "postpaid_owed_" + userId;
  const currentOwed = parseFloat(localStorage.getItem(owedKey)) || 0;
  const newOwed = currentOwed + amount;
  if (newOwed > 1000) {
    alert("You have reached your ₦1,000 credit limit. Please settle first.");
    return;
  }
  localStorage.setItem(owedKey, newOwed.toFixed(2));

  // (3) Refresh UI
  updateHomeInfo();
  updateBalanceInfo();
  updatePostpaidOwed();
  alert(`✓ ₦${amount.toFixed(2)} credited to your balance and added to debt.`);
}

// -----------------------------
// 8) POSTPAID PAYMENT (Stripe & Paystack)
// -----------------------------
async function startPostpaidPayment() {
  const userId = localStorage.getItem("user_id");
  const owedKey = "postpaid_owed_" + userId;
  const owedAmount = parseFloat(localStorage.getItem(owedKey)) || 0;
  if (owedAmount <= 0) {
    alert("No outstanding balance to pay.");
    return;
  }

  try {
    const response = await fetch("http://10.218.220.142:3005/create-postpaid-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: owedAmount, userId, type: "postpaid" })
    });
    if (!response.ok) throw new Error("Failed to create postpaid session");

    const session = await response.json();
    const stripe = Stripe("pk_test_51Qo6ArP6Eq8DZLKp1Jloq3I58N1MA1slOXKB8hK7IpgpdljVj33eVuOuc8MIYxdkilkQOtkLZgnR99oIy2W6bFSt00xSCHSgrM");
    const { error } = await stripe.redirectToCheckout({ sessionId: session.id });
    if (error) throw error;

  } catch (err) {
    console.error("Stripe postpaid error:", err);
    alert("Error initiating Stripe postpaid. Please try again.");
  }
}

async function startPostpaidPaymentPaystack() {
  const userId = localStorage.getItem("user_id");
  const owedKey = "postpaid_owed_" + userId;
  const owedAmount = parseFloat(localStorage.getItem(owedKey)) || 0;
  if (owedAmount <= 0) {
    alert("No outstanding balance to pay.");
    return;
  }

  try {
    const resp = await fetch("http://10.218.220.142:3005/api/paystack/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Math.round(owedAmount * 100),
        userId,
        type: "postpaid",
        email: localStorage.getItem("user_email") || "system@domain.com"
      })
    });
    const data = await resp.json();
    if (!data.authorization_url) throw new Error("No Paystack URL");
    window.location.href = data.authorization_url;
  } catch (err) {
    console.error("Paystack postpaid error:", err);
    alert("Could not start Paystack payment.");
  }
}

function updateLastPaymentDisplay() {
  const userId = localStorage.getItem("user_id");
  if (!userId) return;

  const raw = localStorage.getItem(`last_payment_${userId}`);
  const lastElem = document.getElementById("last-payment");
  if (!lastElem) return;

  if (raw) {
    try {
      const obj = JSON.parse(raw);
      // Format: “₦100.00 on May 17, 2023, 14:23”
      const paidAmt = parseFloat(obj.amount).toFixed(2);
      const paidDate = new Date(obj.date);
      const formattedDate = paidDate.toLocaleString(undefined, {
        year:   "numeric",
        month:  "short",
        day:    "2-digit",
        hour:   "2-digit",
        minute: "2-digit"
      });
      lastElem.textContent = `₦${paidAmt} on ${formattedDate}`;
    } catch {
      lastElem.textContent = "--";
    }
  } else {
    lastElem.textContent = "--";
  }
}


function logout() {
  
  localStorage.removeItem("user_id");
  localStorage.removeItem("user_name");
  localStorage.removeItem("user_location");
  localStorage.removeItem("farm_id");
  
  window.location.href = "login.html";
}


// -----------------------------
// 9) NAVIGATION (Home / Analytics / Payments)
// -----------------------------
function showOnlySection(targetId) {
  ["home-section", "analytics-section", "payments-section", "irrigation-planner"]
    .forEach(id => {
      const sec = document.getElementById(id);
      if (sec) sec.style.display = (id === targetId) ? "block" : "none";
    });
}
// (2) Highlight & tab-switcher logic
document.querySelectorAll('.top-nav .nav-link').forEach(link => {
  const targetId = link.dataset.target;

  link.addEventListener('click', e => {
    e.preventDefault();
    showOnlySection(targetId);
    document.querySelectorAll('.top-nav .nav-link').forEach(l => l.classList.remove('active'));
    link.classList.add('active');
  });

  if (window.location.hash === `#${targetId}`) {
    link.classList.add('active');
    showOnlySection(targetId);
  }
});

if (!window.location.hash) {
  const first = document.querySelector('.top-nav .nav-link');
  first.classList.add('active');
  showOnlySection(first.dataset.target);
}


// ---------------------------------------------------
// 10) ONCE HTML IS PARSED, ATTACH ALL EVENT LISTENERS
// ---------------------------------------------------
// ------------------- Page init (replace existing DOMContentLoaded block) -------------------
document.addEventListener('DOMContentLoaded', async () => {
  // read userId once
  const userId = localStorage.getItem('user_id');
  console.log('🟢 DOMContentLoaded — user_id:', userId);

  // ---------- Safe helpers ----------
  const safe = {
    el: id => document.getElementById(id),
    on: (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); },
    logFetch: async (label, p) => {
      try {
        const resp = await p;
        console.log(`${label} → status:`, resp.status);
        const json = await resp.json().catch(()=>null);
        console.log(`${label} → body:`, json);
        return { resp, json };
      } catch (err) {
        console.error(`${label} → error:`, err);
        return { resp: null, json: null, err };
      }
    }
  };

  // ---------- Top nav ----------
  document.querySelectorAll(".top-nav .nav-link").forEach(a => {
    a.addEventListener("click", evt => {
      evt.preventDefault();
      const href = a.getAttribute("href").substring(1);
      window.location.hash = href;
      showOnlySection(href);
    });
  });
  safe.on('logout-btn','click', logout);

  // ---------- Default section ----------
  const initialHash = window.location.hash.substring(1);
  if (["home-section","analytics-section","payments-section","irrigation-planner"].includes(initialHash)) {
    showOnlySection(initialHash);
  } else {
    window.location.hash = "home-section";
    showOnlySection("home-section");
  }

  // ---------- Attach payment & postpaid buttons (if present) ----------
  safe.on('stripe-pay-btn','click', startStripePayment);
  safe.on('paystack-pay-btn','click', startPaystackPayment);
  safe.on('add-postpaid-btn','click', handleAddPostpaid);
  safe.on('stripe-postpaid-btn','click', startPostpaidPayment);
  safe.on('paystack-postpaid-btn','click', startPostpaidPaymentPaystack);

  // ---------- Call site-wide updaters but don't crash if they don't exist ----------
  try { if (typeof updateHomeInfo === 'function') await updateHomeInfo(userId); } catch (e) { console.warn('updateHomeInfo failed', e); }
  try { if (typeof updateBalanceInfo === 'function') await updateBalanceInfo(userId); } catch (e) { console.warn('updateBalanceInfo failed', e); }
  try { if (typeof updatePostpaidOwed === 'function') await updatePostpaidOwed(userId); } catch (e) { console.warn('updatePostpaidOwed failed', e); }
  try { if (typeof updateLastPaymentDisplay === 'function') await updateLastPaymentDisplay(userId); } catch (e) { console.warn('updateLastPaymentDisplay failed', e); }
  try { if (typeof updateAnalyticsInfo === 'function') await updateAnalyticsInfo(userId); } catch (e) { console.warn('updateAnalyticsInfo failed', e); }

  // ---------- Planner UI refs ----------
  const cropSelect   = safe.el('crop');
  const regionSelect = safe.el('region');
  const stageSelect  = safe.el('stage');
  const plannerForm  = safe.el('planner-form');
  const plannerResult = safe.el('planner-result');
  let currentCalc = null;

  // helper: safe-reset dropdown
  function reset(selectEl, placeholder) {
    if (!selectEl) return;
    selectEl.innerHTML = `<option value="">${placeholder}</option>`;
  }

  // dynamic regions when crop changes (guard against missing elements)
  if (cropSelect && regionSelect && stageSelect) {
    cropSelect.addEventListener('change', async () => {
      const crop = cropSelect.value;
      reset(regionSelect, 'Select region…');
      reset(stageSelect,  'Select stage…');
      if (!crop) return;
      regionSelect.innerHTML += `<option>Loading…</option>`;
      try {
        const r = await fetch(`/api/plans/regions?crop=${encodeURIComponent(crop)}`, { cache: 'no-store' });
        const regions = await r.json();
        reset(regionSelect, 'Select region…');
        (regions || []).forEach(x => {
          const o = document.createElement('option'); o.value = x; o.textContent = x; regionSelect.appendChild(o);
        });
      } catch (err) {
        console.error('Failed to load regions', err);
        reset(regionSelect, 'Error loading');
      }
    });

    regionSelect.addEventListener('change', async () => {
      const crop = cropSelect.value;
      const region = regionSelect.value;
      reset(stageSelect, 'Select stage…');
      if (!crop || !region) return;
      stageSelect.innerHTML += `<option>Loading…</option>`;
      try {
        const r = await fetch(`/api/plans/stages?crop=${encodeURIComponent(crop)}&region=${encodeURIComponent(region)}`, { cache: 'no-store' });
        const stages = await r.json();
        reset(stageSelect, 'Select stage…');
        (stages || []).forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; stageSelect.appendChild(o); });
      } catch (err) {
        console.error('Failed to load stages', err);
        reset(stageSelect, 'Error loading');
      }
    });
  } else {
    console.warn('Planner selects missing: crop/region/stage', { cropSelect, regionSelect, stageSelect });
  }

  // planner form submit
  if (plannerForm) {
    plannerForm.addEventListener('submit', async e => {
      e.preventDefault();
      const uid = localStorage.getItem('user_id');
      const payload = {
        userId: uid,
        crop:   plannerForm.crop?.value || '',
        region: plannerForm.region?.value || '',
        stage:  plannerForm.stage?.value || '',
        area:   parseFloat(plannerForm.area?.value || 0)
      };
      console.log('📤 [Planner] Calculate payload:', payload);
      try {
        const resp = await fetch('/api/plans/calculate', {
          method: 'POST',
          headers: { 'Content-Type':'application/json' },
          body: JSON.stringify(payload),
          cache: 'no-store'
        });
        const data = await resp.json();
        console.log('⬅️ [Planner] calculate response:', resp.status, data);
        if (!resp.ok) return alert(data.error || 'Calculation failed.');
        currentCalc = { ...payload, ...data };

        safe.el('daily-volume') && (safe.el('daily-volume').textContent = data.dailyVolume);
        safe.el('total-volume') && (safe.el('total-volume').textContent = data.totalTarget);
        if (safe.el('water-cost')) safe.el('water-cost').textContent = ((parseFloat(data.totalTarget)||0) * 5).toFixed(2);
        safe.el('flat-fee') && (safe.el('flat-fee').textContent = data.flatFee);

        let p = safe.el('plan-duration');
        if (!p && plannerResult) {
          p = document.createElement('p'); p.id = 'plan-duration'; plannerResult.insertBefore(p, plannerResult.firstChild);
        }
        if (p) p.innerHTML = `<strong>Duration:</strong> ${data.durationDays} day(s)`;

        if (plannerResult) plannerResult.hidden = false;
        if (!safe.el('btn-start-plan')) {
          const btn = document.createElement('button');
          btn.id = 'btn-start-plan'; btn.className = 'btn-primary'; btn.textContent = 'Pay & Start';
          btn.addEventListener('click', startPlan);
          plannerResult.appendChild(btn);
        }
      } catch (err) {
        console.error('[Planner] Calculate error', err);
        alert('Network or server error during calculation.');
      }
    });
  } else {
    console.warn('planner-form element not found');
  }

  // ---------- Planner + Plan lifecycle (updated) ----------
/* Assumes:
   - safe.el(id) -> document.getElementById(id) helper exists
   - API endpoints:
     POST /api/plans/start   (body { userId, crop, region, stage, area })
     GET  /api/plans/active  (?userId=...)
     POST /api/valve/open    (body { userId })
     POST /api/plans/cancel  (body { userId })  <-- see note below
*/


  // --- START PLAN ---
  async function startPlan() {
    console.log('▶️ startPlan invoked, currentCalc =', currentCalc);
    if (!currentCalc) return alert('Please calculate first.');

    const { crop, region, stage, area } = currentCalc;
    if (!userId) return alert('User not logged in.');

    try {
      const resp = await fetch('/api/plans/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, crop, region, stage, area }),
        cache: 'no-store'
      });

      // defensive parse
      const data = await resp.json().catch(() => null);
      console.log('⬅️ startPlan response:', resp.status, data);

      if (!resp.ok) return alert(data?.error || 'Could not start plan.');

      if (typeof data.newBalance !== 'undefined') {
        // store as string — preserve decimals if backend returned them
        localStorage.setItem('available_balance_' + userId, String(data.newBalance));
        if (typeof updateBalanceInfo === 'function') updateBalanceInfo(userId);
      }

      showPlanSummary({
        planId: data.planId,
        dailyTarget: Number(data.dailyVolume || data.dailyTarget || 0),
        totalTarget: Number(data.totalTarget || 0),
        duration: parseInt(data.durationDays || data.duration || 0, 10)
      });

      const startBtn = safe.el('btn-start-plan');
      if (startBtn) { startBtn.disabled = true; startBtn.style.display = 'none'; }

      alert(`Plan started! Target ${data.totalTarget} L over ${data.durationDays} day(s).`);

      // start polling
      startPollingDeviceState(userId, 10000);
    } catch (err) {
      console.error('startPlan error', err);
      alert('Network error when starting plan.');
    }
  }

  // --- SHOW PLAN SUMMARY (UI) ---
  function showPlanSummary({ planId, dailyTarget, totalTarget, duration }) {
    function set(id, value, digits = 2) {
      const el = safe.el(id); if (!el) return;
      if (typeof value === 'number') el.textContent = value.toFixed(digits);
      else el.textContent = (value ?? '—');
    }
    set('ps-daily-target', Number(dailyTarget || 0));
    set('ps-total-target', Number(totalTarget || 0));
    const elPsDuration = safe.el('ps-duration'); if (elPsDuration) elPsDuration.textContent = (duration ?? 0);
    const elDur = safe.el('plan-duration-days'); if (elDur) elDur.textContent = (duration ?? '—');

    safe.el('plan-summary') && (safe.el('plan-summary').hidden = false);
    safe.el('planner-result') && (safe.el('planner-result').hidden = true);
  }  

  // --- plan status badge helper ---
  function setPlanStatusText(status) {
    const el = safe.el('plan-status');
    if (!el) return;
    const st = (status === 'active') ? 'Active'
             : (status === 'completed') ? 'Completed'
             : (status === 'cancelled') ? 'Cancelled'
             : (status ?? 'Unknown');
    el.textContent = st;
    el.classList.toggle('active', status === 'active');
    el.classList.toggle('completed', status === 'completed');
    el.classList.toggle('cancelled', status === 'cancelled');
  }

  // --- MANUAL OPEN (web button) ---
  async function handleManualOpen() {
    if (!userId) return alert('User not identified.');
    try {
      const resp = await fetch('/api/valve/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      if (resp.ok) {
        alert('Valve reopened (manual).');
        safe.el('valve-status') && (safe.el('valve-status').textContent = 'OPEN (manual)');
        await updatePlanUI(userId);
      } else {
        const err = await resp.json().catch(()=>({}));
        console.error('Manual open failed', err);
        alert('Could not reopen valve.');
      }
    } catch (err) {
      console.error('Manual open net error', err);
      alert('Network error when trying to reopen valve.');
    }
  }

  async function handleManualClose() {
    const uid = localStorage.getItem('user_id');
    if (!uid) return alert('User not identified.');
    try {
      const resp = await fetch('/api/valve/close', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ userId: uid })
      });
      if (resp.ok) {
        safe.el('valve-status') && (safe.el('valve-status').textContent = 'CLOSED (manual)');
        alert('Valve closed (manual).');
        await updatePlanUI(uid);
      } else {
        alert('Could not close valve.');
      }
    } catch (err) {
      console.error('Manual close error', err);
      alert('Network error when trying to close valve.');
    }
  }

  // --- CANCEL PLAN (web button) ---
  async function handleCancelPlan() {
    if (!userId) return alert('User not identified.');
    if (!confirm('Are you sure you want to cancel the current plan?')) return;

    try {
      const resp = await fetch('/api/plans/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
       });

      const data = await resp.json().catch(()=>null);
      console.log('⬅️ Cancel plan response:', resp.status, data);
  
      if (!resp.ok) return alert(data?.error || 'Could not cancel plan.');

      alert('Plan cancelled.');
      stopPollingDeviceState();
      safe.el('plan-summary') && (safe.el('plan-summary').hidden = true);
      safe.el('planner-result') && (safe.el('planner-result').hidden = true);
      safe.el('valve-status') && (safe.el('valve-status').textContent = 'CLOSED');
    } catch (err) {
      console.error('Cancel plan error', err);
      alert('Network error when cancelling plan.');
    }
  }

  // bind click listeners
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'btn-manual-open') handleManualOpen();
    if (e.target && e.target.id === 'btn-manual-close') handleManualClose();
    if (e.target && e.target.id === 'cancelPlanBtn') handleCancelPlan();
  });

  // ---------- Polling & plan persistence helpers (DROP-IN REPLACEMENT) ----------

  let deviceStatePollTimer = null;
  let lastPlan = null; // persist last-known plan so UI can show summary after completion

  async function fetchDeviceState(uid) {
    if (!uid) return null;
    try {
      const resp = await fetch(`/api/device/state?userId=${encodeURIComponent(uid)}`, { cache: 'no-store' });
      if (!resp.ok) { console.warn('device/state fetch failed', resp.status); return null; }
      return await resp.json().catch(()=>null);
    } catch (err) {
      console.error('fetchDeviceState error', err);
      return null;
    }
  }

  // helper: fetch the most recent plan (active or completed)
  // server must implement GET /api/plans/latest?userId=...
  async function fetchLatestPlan(uid) {
    if (!uid) return null;
    try {
      const resp = await fetch(`/api/plans/latest?userId=${encodeURIComponent(uid)}`, { cache: 'no-store' });
      if (!resp.ok) return null;
      const obj = await resp.json().catch(()=>null);
      return obj?.plan ?? null;
    } catch (err) {
      console.warn('fetchLatestPlan failed', err);
      return null;
    }
  }

  // updatePlanUI: show plan summary (persisted) and always prefer device state for valve pill
  async function updatePlanUI(uid) {
    try {
      if (!uid) return;
      const device = await fetchDeviceState(uid);        // may include plan if active
      let planObj = device?.plan ?? null;

      if (!planObj) {
        // no active plan in device/state — try latest plan from DB
        planObj = await fetchLatestPlan(uid);
      }  

      // If we have a plan (active or completed), map fields and persist to lastPlan
      if (planObj) {
        // map different naming schemes into a consistent shape
        const p = {
          id: planObj.planId ?? planObj.id ?? planObj.plan_id ?? null,
          perDayTarget: Number(planObj.perDayTarget ?? planObj.per_day_target ?? planObj.dailyTarget ?? 0),
          totalTarget: Number(planObj.totalTarget ?? planObj.total_target_liters ?? 0),
          durationDays: Number(planObj.durationDays ?? planObj.duration_days ?? planObj.duration ?? 0),
          daysElapsed: Number(planObj.daysElapsed ?? planObj.days_elapsed ?? 0),
          daysLeft: Number(planObj.daysLeft ?? planObj.days_left ?? 0),
          consumedToday: Number(planObj.consumedToday ?? planObj.consumed_today ?? 0),
          remainingToday: Number(planObj.remainingToday ?? planObj.remaining_today ?? 0),
          endDate: planObj.endDate ?? planObj.end_date ?? '-',
          status: planObj.status ?? (planObj.daysLeft === 0 ? 'completed' : 'active')
        };

        lastPlan = p; // persist on client

        // write UI fields safely
        safe.el('ps-daily-target') && (safe.el('ps-daily-target').textContent = p.perDayTarget.toFixed(2));
        safe.el('ps-total-target') && (safe.el('ps-total-target').textContent = p.totalTarget.toFixed(2));
        safe.el('ps-duration') && (safe.el('ps-duration').textContent = p.durationDays);
        safe.el('plan-duration-days') && (safe.el('plan-duration-days').textContent = p.durationDays);
        safe.el('plan-days-elapsed') && (safe.el('plan-days-elapsed').textContent = (p.daysElapsed ?? '—'));
        safe.el('plan-days-left') && (safe.el('plan-days-left').textContent = (p.daysLeft ?? '—'));
        safe.el('plan-consumed-today') && (safe.el('plan-consumed-today').textContent = (p.consumedToday ?? '0.00'));
        safe.el('plan-remaining-today') && (safe.el('plan-remaining-today').textContent = (p.remainingToday ?? '0.00'));
        safe.el('plan-end-date') && (safe.el('plan-end-date').textContent = (p.endDate ?? '-'));
        if (safe.el('plan-status')) safe.el('plan-status').textContent = p.status;

        // always show plan summary (persist it even if completed) and hide calculator
        safe.el('plan-summary') && (safe.el('plan-summary').hidden = false);
        safe.el('planner-result') && (safe.el('planner-result').hidden = true);
      } else {
        // truly no plan found anywhere — hide summary and show calculator
        safe.el('plan-summary') && (safe.el('plan-summary').hidden = true);
        safe.el('planner-result') && (safe.el('planner-result').hidden = false);
      }

      // ---- Valve pill logic: prefer device flags so it reflects current relay state ----
      const vsEl = safe.el('valve-status');
      if (vsEl && device) {
        // normalize classes
        vsEl.classList.remove('open','closed','manual');

        const manual = !!device.manualOverride || device.valveReason === 'manual_override';
        // if device.valveOpen explicitly provided use it; otherwise try to infer from reason/availableBalance
        const hasOpenFlag = (typeof device.valveOpen === 'boolean');
        const open = hasOpenFlag ? device.valveOpen : (device.availableBalance > 0 && device.valveReason !== 'no_balance');

        if (manual) {
          vsEl.textContent = open ? 'OPEN (manual)' : 'CLOSED (manual)';
          vsEl.classList.add('manual');
        } else {
          vsEl.textContent = open ? 'OPEN' : 'CLOSED';
          vsEl.classList.add(open ? 'open' : 'closed');
        }
      }
 
      // Do NOT stop polling here — keep polling so user can reopen the valve after completion
      if (lastPlan && lastPlan.status === 'completed') {
        console.log('Plan completed: UI persisted but polling continues so manual actions are available.');
      }
    } catch (err) {
      console.error('updatePlanUI error:', err);
    }
  }

  function startPollingDeviceState(uid, intervalMs = 10000) {
    if (!uid) return;
    if (deviceStatePollTimer) clearInterval(deviceStatePollTimer);
    // first immediate call
    updatePlanUI(uid);
    deviceStatePollTimer = setInterval(() => updatePlanUI(uid), intervalMs);
  }

  function stopPollingDeviceState() {
    if (deviceStatePollTimer) {
      clearInterval(deviceStatePollTimer);
      deviceStatePollTimer = null;
    }
  }

  // ON LOAD: seed the UI with latest plan (active or completed), then start polling
  (async function checkActivePlanOnLoad() {
    try {
      if (!userId) {
        safe.el('plan-summary') && (safe.el('plan-summary').hidden = true);
        safe.el('planner-result') && (safe.el('planner-result').hidden = true);
        return;
      }

      console.log('📡 Checking active plan for user:', userId);
      // First try the active endpoint (fast path)
      const resp = await fetch(`/api/plans/active?userId=${encodeURIComponent(userId)}`, { cache: 'no-store' });
      const data = await resp.json().catch(()=>null);
      console.log('⬅️ Active plan check:', data);

      if (data && data.active && data.plan) {
        // Active — render and start polling
        lastPlan = {
          id: data.plan.id,
          perDayTarget: Number(data.plan.perDayTarget ?? data.plan.per_day_target ?? 0),
          totalTarget: Number(data.plan.totalTarget ?? 0),
          durationDays: Number(data.plan.durationDays ?? data.plan.duration ?? 0),
          daysElapsed: Number(data.plan.daysElapsed ?? 0),
          daysLeft: Number(data.plan.daysLeft ?? 0),
          consumedToday: Number(data.plan.consumedToday ?? 0),
          remainingToday: Number(data.plan.remainingToday ?? 0),
          endDate: data.plan.endDate ?? '-',
          status: 'active'
        };

        // render via updatePlanUI (which prefers device flags for valve)
        startPollingDeviceState(userId, 10000);
        return;
      }

      // No active plan — try latest plan (completed or last)
      const last = await fetchLatestPlan(userId);
      if (last) {
        // map and persist
        lastPlan = {
          id: last.id ?? last.planId,
          perDayTarget: Number(last.perDayTarget ?? last.per_day_target ?? 0),
          totalTarget: Number(last.totalTarget ?? last.total_target_liters ?? 0),
          durationDays: Number(last.durationDays ?? last.duration_days ?? 0),
          daysElapsed: Number(last.daysElapsed ?? 0),
          daysLeft: Number(last.daysLeft ?? 0),
          consumedToday: Number(last.consumedToday ?? 0),
          remainingToday: Number(last.remainingToday ?? 0),
          endDate: last.endDate ?? last.end_date ?? '-',
          status: last.status ?? 'completed'
        };

        // render persisted summary and still start polling to update valve pill
        // show summary (updatePlanUI will also be called immediately by startPollingDeviceState)
        safe.el('plan-summary') && (safe.el('plan-summary').hidden = false);
        safe.el('planner-result') && (safe.el('planner-result').hidden = true);
        safe.el('ps-daily-target') && (safe.el('ps-daily-target').textContent = (lastPlan.perDayTarget || 0).toFixed(2));
        safe.el('ps-total-target') && (safe.el('ps-total-target').textContent = (lastPlan.totalTarget || 0).toFixed(2));
        safe.el('plan-status') && (safe.el('plan-status').textContent = lastPlan.status);

        startPollingDeviceState(userId, 10000);
        return;
      }

      // fallback: no plan at all
      safe.el('plan-summary') && (safe.el('plan-summary').hidden = true);
      safe.el('planner-result') && (safe.el('planner-result').hidden = true);
    } catch (err) {
      console.error('Active plan check failed:', err);
    }
  })();




  // ---------- sensor polling & payment callback (unchanged) ----------
  try { if (typeof loadSensorData === 'function') { loadSensorData(); setInterval(loadSensorData, 5000); } } catch (e) { console.warn('loadSensorData not available', e); }

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("payment") === "success") {
    const paymentType = urlParams.get("type");
    const amount = parseFloat(urlParams.get("amount")) || 0;
    const uid = localStorage.getItem("user_id");
    if (uid) {
      if (paymentType === "prepaid") {
        localStorage.setItem(`last_payment_${uid}`, JSON.stringify({ amount, date: new Date().toISOString() }));
        updateLastPaymentDisplay?.();
        const balKey = "available_balance_" + uid;
        const newBal = (parseFloat(localStorage.getItem(balKey)) || 0) + amount;
        localStorage.setItem(balKey, newBal.toFixed(2));
        updateBalanceInfo?.(uid);
        updateBalanceInBackend?.(uid, newBal);
        alert(`Success! ₦${amount.toFixed(2)} added to your balance.`);
      } else if (paymentType === "postpaid") {
        localStorage.setItem(`last_payment_${uid}`, JSON.stringify({ amount, date: new Date().toISOString() }));
        updateLastPaymentDisplay?.();
        localStorage.setItem(`postpaid_owed_${uid}`, "0");
        updatePostpaidOwed?.(uid);
        alert("Postpaid invoice settled successfully!");
      }
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }
}); // end DOMContentLoaded
