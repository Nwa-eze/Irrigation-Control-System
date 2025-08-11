let lastCostSeen = 0;
let processedTimestamps = new Set();
let lastVolumeSeen = 0;
let dailyTotal     = 0;
let monthlyTotal   = 0;
const processedVolumeTimestamps = new Set();

const PAYSTACK_BASE_URL   = 'https://api.paystack.co';


// On load, check if there's an active plan that hasn't expired
const savedPlan = localStorage.getItem('active_plan');
if (savedPlan) {
  const plan = JSON.parse(savedPlan);
  const now = Date.now();
  if (now < plan.expires) {
    const plannerResult = document.getElementById('planner-result');
    if (plannerResult) {
      plannerResult.hidden = false;

      // Fill in the saved values
      document.getElementById('daily-volume').textContent = plan.dailyVolume;
      document.getElementById('total-volume').textContent = plan.totalTarget;
      document.getElementById('flat-fee').textContent    = plan.flatFee;
      document.getElementById('water-cost').textContent  =
        (parseFloat(plan.dailyVolume) * plan.durationDays * 5).toFixed(2);

      // Also add the duration line if needed
      let p = document.getElementById('plan-duration');
      if (!p) {
        p = document.createElement('p');
        p.id = 'plan-duration';
        plannerResult.insertBefore(p, plannerResult.firstChild);
      }
      p.innerHTML = `<strong>Duration:</strong> ${plan.durationDays} day(s)`;
    }
  } else {
    // Plan expired — clean up
    localStorage.removeItem('active_plan');
  }
}



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
    const response = await fetch(`/get_data?user_id=${userId}`, {
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
    const resp = await fetch("/create-checkout-session", {
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
    const resp = await fetch("/paystack/initialize", {
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
    const response = await fetch("/update_balance", {
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
    const response = await fetch("/create-postpaid-session", {
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
    const resp = await fetch("/api/paystack/initialize", {
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

// ---------------------------------------------------
// 10) ONCE HTML IS PARSED, ATTACH ALL EVENT LISTENERS
// ---------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  // (a) Top‑nav links
  document.querySelectorAll(".top-nav .nav-link").forEach(a => {
    a.addEventListener("click", evt => {
      evt.preventDefault();
      const href = a.getAttribute("href").substring(1);
      window.location.hash = href;
      showOnlySection(href);
    });
  });
  document.getElementById("logout-btn").addEventListener("click", logout);

  // (b) On first load, show either hash or default “home-section”
  const initialHash = window.location.hash.substring(1);
  if (["home-section", "analytics-section", "payments-section", "irrigation-planner"].includes(initialHash)) {
    showOnlySection(initialHash);
  } else {
    window.location.hash = "home-section";
    showOnlySection("home-section");
  }

  // (c) Attach prepaid buttons
  document.getElementById("stripe-pay-btn")?.addEventListener("click", startStripePayment);
  document.getElementById("paystack-pay-btn")?.addEventListener("click", startPaystackPayment);

  // (d) Attach postpaid buttons
  document.getElementById("add-postpaid-btn")?.addEventListener("click", handleAddPostpaid);
  document.getElementById("stripe-postpaid-btn")?.addEventListener("click", startPostpaidPayment);
  document.getElementById("paystack-postpaid-btn")?.addEventListener("click", startPostpaidPaymentPaystack);

  // (e) Initialize Home info, balance, owed
  updateHomeInfo();
  updateBalanceInfo();
  updatePostpaidOwed();
  updateLastPaymentDisplay();
  updateAnalyticsInfo();

  
  // ─── IRRIGATION PLANNER ─────────────────────────
  const plannerForm   = document.getElementById('planner-form');
  const plannerResult = document.getElementById('planner-result');
  let currentCalc     = null;

  if (plannerForm) {
    console.log("🛠️ [Planner] Listener attaching");
    plannerForm.addEventListener('submit', async e => {
      e.preventDefault();
      console.log("🛠️ [Planner] Submit event fired");

      const userId = localStorage.getItem('user_id');
      console.log("🛠️ [Planner] userId =", userId);
      const payload = {
        userId,
        crop:   plannerForm.crop.value,
        region: plannerForm.region.value,
        stage:  plannerForm.stage.value,
        area:   parseFloat(plannerForm.area.value)
      };
      console.log("📤 [Planner] Calculate payload:", payload);

      let resp, data;
      try {
        resp = await fetch('/api/plans/calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        console.log("⬅️ [Planner] HTTP status:", resp.status);
        data = await resp.json();
        console.log("⬅️ [Planner] Calculate response:", data);
      } catch (err) {
        console.error("❌ [Planner] Fetch error:", err);
        return alert("Network error during calculation. See console.");
      }

      if (!resp.ok) {
        console.warn("⚠️ [Planner] Calculation failed:", data.error);
        return alert(data.error || 'Calculation failed.');
      }

      // store for start step
      currentCalc = {
        ...payload,
        dailyVolume: data.dailyVolume,
        totalTarget: data.totalTarget,
        durationDays: data.durationDays,
        flatFee: data.flatFee
      };
      console.log("🛠️ [Planner] currentCalc set to:", currentCalc);

      // populate result panel
      document.getElementById('daily-volume').textContent = data.dailyVolume;
      document.getElementById('total-volume').textContent = data.totalTarget;
      document.getElementById('water-cost').textContent   =
        (parseFloat(data.dailyVolume) * data.durationDays * 5).toFixed(2);
      document.getElementById('flat-fee').textContent    = data.flatFee;

      // show duration
      let p = document.getElementById('plan-duration');
      if (!p) {
        p = document.createElement('p');
        p.id = 'plan-duration';
        plannerResult.insertBefore(p, plannerResult.firstChild);
      }
      p.innerHTML = `<strong>Duration:</strong> ${data.durationDays} day(s)`;

      // reveal panel & inject “Pay & Start” button
      plannerResult.hidden = false;
      let startBtn = document.getElementById('btn-start-plan');
      if (!startBtn) {
        startBtn = document.createElement('button');
        startBtn.id = 'btn-start-plan';
        startBtn.className = 'btn-primary';
        startBtn.textContent = 'Pay & Start';
        plannerResult.appendChild(startBtn);
        startBtn.addEventListener('click', startPlan);
      }
    });
  }

  // (f) “Pay & Start” handler
  async function startPlan() {
    console.log('▶️ startPlan invoked, currentCalc =', currentCalc);
    if (!currentCalc) return alert('Please calculate first.');

    const { userId, crop, region, stage, area } = currentCalc;
    console.log('▶️ startPlan payload:', { userId, crop, region, stage, area });

    let resp, data;
    try {
      resp = await fetch('/api/plans/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, crop, region, stage, area })
      });
      console.log('⬅️ startPlan status:', resp.status);
      data = await resp.json();
      console.log('⬅️ startPlan response:', data);
    } catch (err) {
      console.error('❌ startPlan fetch error:', err);
      return alert('Network error when starting plan.');
    }

    if (!resp.ok) {
      console.warn('⚠️ startPlan server error:', data.error);
      return alert(data.error || 'Could not start plan.');
    }

    // update balance
    const balanceKey = 'available_balance_' + userId;
    localStorage.setItem(balanceKey, data.newBalance);
    updateBalanceInfo();

    alert(`Plan started! Target ${data.totalTarget} L over ${data.durationDays} day(s).`);
    document.getElementById('btn-start-plan').disabled = true;
  }

  // (g) Sensor polling & payment callback
  loadSensorData();
  setInterval(loadSensorData, 5000);

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("payment") === "success") {
    const paymentType = urlParams.get("type");
    const amount = parseFloat(urlParams.get("amount")) || 0;
    const userId = localStorage.getItem("user_id");
    if (userId) {
      if (paymentType === "prepaid") {
        localStorage.setItem(
          `last_payment_${userId}`,
          JSON.stringify({ amount, date: new Date().toISOString() })
        );
        updateLastPaymentDisplay();
        const balKey = "available_balance_" + userId;
        const newBal = (parseFloat(localStorage.getItem(balKey)) || 0) + amount;
        localStorage.setItem(balKey, newBal.toFixed(2));
        updateBalanceInfo();
        updateBalanceInBackend(userId, newBal);
        alert(`Success! ₦${amount.toFixed(2)} added to your balance.`);
      } else if (paymentType === "postpaid") {
        localStorage.setItem(
          `last_payment_${userId}`,
          JSON.stringify({ amount, date: new Date().toISOString() })
        );
        updateLastPaymentDisplay();
        localStorage.setItem(`postpaid_owed_${userId}`, "0");
        updatePostpaidOwed();
        alert("Postpaid invoice settled successfully!");
      }
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }
}); // end DOMContentLoaded
