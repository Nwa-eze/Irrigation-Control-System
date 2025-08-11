document.getElementById('register-form').addEventListener('submit', async e => {
  e.preventDefault();
  // collect top-level user columns (users table)
  const userPayload = {
    username: document.getElementById('reg-username').value.trim(),
    password: document.getElementById('reg-password').value,
    // maps to users.name
    name: document.getElementById('reg-fullname').value.trim(),
    // maps to users.matric_number
    matric_number: document.getElementById('reg-matric').value.trim() || null,
    // maps to users.location and users.farm_id
    location: document.getElementById('reg-location').value.trim(),
    farm_id: document.getElementById('reg-farmid').value.trim()
  };

  // profile -> user_profiles (user_id will be set server-side after creating users row)
  const profile = {
    email: document.getElementById('reg-email').value.trim(),
    phone: document.getElementById('reg-phone').value.trim() || null,
    full_name: document.getElementById('reg-fullname').value.trim(),
    date_of_birth: document.getElementById('reg-dob').value || null,
    gender: document.getElementById('reg-gender').value || null
  };

  // address -> user_addresses
  const address = {
    address_line1: document.getElementById('address1').value.trim(),
    address_line2: document.getElementById('address2').value.trim() || null,
    city: document.getElementById('city').value.trim(),
    state_province: document.getElementById('state_province').value.trim(),
    country: document.getElementById('country').value.trim(),
    postal_code: document.getElementById('postal_code').value.trim() || null,
    is_primary: 1
  };

  const payload = {
    user: userPayload,
    profile,
    address
  };

  try {
    const resp = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload)
    });

    if (resp.ok) {
      alert('Registration successful — please log in.');
      window.location.href = 'login.html';
      return;
    }

    // try to parse error message
    let txt = await resp.text();
    try { txt = JSON.parse(txt).error || txt; } catch(_) {}
    showError(txt || 'Registration failed');
  } catch (err) {
    console.error('Registration error:', err);
    showError('Server error — please try again later.');
  }
});

function showError(msg) {
  const p = document.getElementById('reg-error');
  p.textContent = msg;
  p.hidden = false;
}
