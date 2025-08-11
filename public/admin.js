const BASE_URL = 'http://10.32.164.142:3005';

// Handle admin login
document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('admin-username').value.trim();
  const password = document.getElementById('admin-password').value;

  try {
    const resp = await fetch(`${BASE_URL}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (resp.ok) {
      const { token } = await resp.json();
      localStorage.setItem('adminToken', token);
      document.getElementById('login-container').style.display = 'none';
      document.getElementById('admin-content').style.display = 'block';
      loadUsers();
    } else {
      showError('Invalid credentials');
    }
  } catch (err) {
    console.error('Login error:', err);
    showError('Server error');
  }
});

// Handle logout
document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('adminToken');
  document.getElementById('admin-content').style.display = 'none';
  document.getElementById('user-details').innerHTML = '';
  document.getElementById('user-select').innerHTML = '<option value="">Select a User</option>';
  document.getElementById('login-container').style.display = 'block';
});

// Load users for dropdown
async function loadUsers() {
  try {
    const token = localStorage.getItem('adminToken');
    const resp = await fetch(`${BASE_URL}/admin/users`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (resp.ok) {
      const users = await resp.json();
      const select = document.getElementById('user-select');
      users.forEach(user => {
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = `${user.name} (${user.username})`;
        select.appendChild(option);
      });
      select.addEventListener('change', loadUserDetails);
    } else {
      showError('Failed to load users');
    }
  } catch (err) {
    console.error('Load users error:', err);
  }
}

// Load selected user details
async function loadUserDetails(e) {
  const userId = e.target.value;
  if (!userId) return;

  try {
    const token = localStorage.getItem('adminToken');
    const resp = await fetch(`${BASE_URL}/admin/user/${userId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (resp.ok) {
      const data = await resp.json();
      displayUserData(data);
    } else {
      showError('Failed to load user details');
    }
  } catch (err) {
    console.error('Load details error:', err);
  }
}

// Display data in sections/tables/charts
function displayUserData(data) {
  const detailsDiv = document.getElementById('user-details');
  detailsDiv.innerHTML = '';

  // User Info
  const userCard = createCard('User Info');
  userCard.innerHTML += `<p><strong>Name:</strong> ${data.user.name}</p>`;
  userCard.innerHTML += `<p><strong>Username:</strong> ${data.user.username}</p>`;
  userCard.innerHTML += `<p><strong>Location:</strong> ${data.user.location}</p>`;
  userCard.innerHTML += `<p><strong>Farm ID:</strong> ${data.user.farm_id}</p>`;
  userCard.innerHTML += `<p><strong>Matric Number:</strong> ${data.user.matric_number || 'N/A'}</p>`;
  userCard.innerHTML += `<p><strong>Available Balance:</strong> ${data.user.available_balance}</p>`;
  detailsDiv.appendChild(userCard);

  // Profile
  const profileCard = createCard('Profile');
  profileCard.innerHTML += `<p><strong>Email:</strong> ${data.profile.email}</p>`;
  profileCard.innerHTML += `<p><strong>Phone:</strong> ${data.profile.phone || 'N/A'}</p>`;
  profileCard.innerHTML += `<p><strong>Full Name:</strong> ${data.profile.full_name}</p>`;
  profileCard.innerHTML += `<p><strong>Date of Birth:</strong> ${data.profile.date_of_birth || 'N/A'}</p>`;
  profileCard.innerHTML += `<p><strong>Gender:</strong> ${data.profile.gender || 'N/A'}</p>`;
  detailsDiv.appendChild(profileCard);

  // Address
  const addressCard = createCard('Address');
  addressCard.innerHTML += `<p><strong>Address Line 1:</strong> ${data.address.address_line1}</p>`;
  addressCard.innerHTML += `<p><strong>Address Line 2:</strong> ${data.address.address_line2 || 'N/A'}</p>`;
  addressCard.innerHTML += `<p><strong>City:</strong> ${data.address.city}</p>`;
  addressCard.innerHTML += `<p><strong>State/Province:</strong> ${data.address.state_province}</p>`;
  addressCard.innerHTML += `<p><strong>Country:</strong> ${data.address.country}</p>`;
  addressCard.innerHTML += `<p><strong>Postal Code:</strong> ${data.address.postal_code || 'N/A'}</p>`;
  detailsDiv.appendChild(addressCard);

  // Valve State
  const valveCard = createCard('Valve State');
  valveCard.innerHTML += `<p><strong>Is Open:</strong> ${data.valve.is_open ? 'Yes' : 'No'}</p>`;
  valveCard.innerHTML += `<p><strong>Updated At:</strong> ${data.valve.updated_at}</p>`;
  detailsDiv.appendChild(valveCard);

  // Plans Table
  const plansTable = createTable(['ID', 'Crop Name', 'Growth Stage', 'Field Area (m2)', 'Total Target Liters', 'Flat Fee', 'Duration Days', 'Status', 'Per Day Target', 'Start Datetime', 'Last Reset Date', 'Completed At', 'Consumed Total']);
  data.plans.forEach(plan => {
    const row = plansTable.insertRow();
    row.insertCell().textContent = plan.id;
    row.insertCell().textContent = plan.crop_name;
    row.insertCell().textContent = plan.growth_stage;
    row.insertCell().textContent = plan.field_area_m2;
    row.insertCell().textContent = plan.total_target_liters;
    row.insertCell().textContent = plan.flat_fee;
    row.insertCell().textContent = plan.duration_days;
    row.insertCell().textContent = plan.status;
    row.insertCell().textContent = plan.per_day_target;
    row.insertCell().textContent = plan.start_datetime;
    row.insertCell().textContent = plan.last_reset_date || 'N/A';
    row.insertCell().textContent = plan.completed_at || 'N/A';
    row.insertCell().textContent = plan.consumed_total;
  });
  const plansSection = createCard('User Plans');
  plansSection.appendChild(plansTable);
  plansSection.classList.add('full-width-card');

  detailsDiv.appendChild(plansSection);

  // Plan Days Table
  const planDaysTable = createTable(['ID', 'Plan ID', 'Day Date', 'Consumed Liters', 'Notes', 'Created At', 'Updated At']);
  data.plan_days.forEach(day => {
    const row = planDaysTable.insertRow();
    row.insertCell().textContent = day.id;
    row.insertCell().textContent = day.plan_id;
    row.insertCell().textContent = day.day_date;
    row.insertCell().textContent = day.consumed_liters;
    row.insertCell().textContent = day.notes || 'N/A';
    row.insertCell().textContent = day.created_at;
    row.insertCell().textContent = day.updated_at;
  });
  const planDaysSection = createCard('Plan Days');
  planDaysSection.appendChild(planDaysTable);
  detailsDiv.appendChild(planDaysSection);
  planDaysSection.classList.add('full-width-card');

  detailsDiv.appendChild(planDaysSection);


  // Sensor Data Table and Chart
  const sensorTable = createTable(['ID', 'Timestamp', 'Flow', 'Volume', 'Cost']);
  data.sensor_data.forEach(sensor => {
    const row = sensorTable.insertRow();
    row.insertCell().textContent = sensor.id;
    row.insertCell().textContent = sensor.timestamp;
    row.insertCell().textContent = sensor.flow;
    row.insertCell().textContent = sensor.volume;
    row.insertCell().textContent = sensor.cost;
  });
  const sensorSection = createCard('Sensor Data (Last 100 Entries)');

  const tableWrapper = document.createElement('div');
  tableWrapper.className = 'table-wrapper';
  tableWrapper.appendChild(sensorTable); // put table inside wrapper
  sensorSection.appendChild(tableWrapper); // append wrapper to section

  // CSV Export Button
  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn-export';
  exportBtn.textContent = 'Export Sensor Data as CSV';
  exportBtn.addEventListener('click', () => exportToCSV(data.sensor_data, data.user.id));
  sensorSection.appendChild(exportBtn);

  // Sensor Chart
  const chartCanvas = document.createElement('canvas');
  chartCanvas.id = 'sensor-chart';
  sensorSection.appendChild(chartCanvas);
  const ctx = chartCanvas.getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.sensor_data.map(s => s.timestamp),
      datasets: [{
        label: 'Volume',
        data: data.sensor_data.map(s => s.volume),
        borderColor: '#0072ff',
        fill: false
      }]
    },
    options: {
      responsive: true,
      scales: {
        x: { title: { display: true, text: 'Timestamp' } },
        y: { title: { display: true, text: 'Volume' } }
      }
    }
  });

  sensorSection.classList.add('full-width-card');

  detailsDiv.appendChild(sensorSection);
}

// Helper to create card
function createCard(title) {
  const card = document.createElement('div');
  card.className = 'card';
  const h3 = document.createElement('h3');
  h3.textContent = title;
  card.appendChild(h3);
  return card;
}

// Helper to create table
function createTable(headers) {
  const table = document.createElement('table');
  const thead = table.createTHead();
  const row = thead.insertRow();
  headers.forEach(header => {
    const th = document.createElement('th');
    th.textContent = header;
    row.appendChild(th);
  });
  table.createTBody();
  return table;
}

// CSV Export
function exportToCSV(sensorData, userId) {
  const csvContent = 'data:text/csv;charset=utf-8,'
    + 'ID,Timestamp,Flow,Volume,Cost\n'
    + sensorData.map(s => `${s.id},${s.timestamp},${s.flow},${s.volume},${s.cost}`).join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `sensor_data_user_${userId}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Show error
function showError(msg) {
  const p = document.getElementById('login-error');
  p.textContent = msg;
  p.hidden = false;
}