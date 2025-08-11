document.getElementById('register-form').addEventListener('submit', async e => {
  e.preventDefault();

  // Gather form values
  const payload = {
    username:      document.getElementById('reg-username').value.trim(),
    password:      document.getElementById('reg-password').value,
    profile: {
      email:         document.getElementById('reg-email').value.trim(),
      phone:         document.getElementById('reg-phone').value.trim(),
      full_name:     document.getElementById('reg-fullname').value.trim(),
      date_of_birth: document.getElementById('reg-dob').value,
      gender:        document.getElementById('reg-gender').value
    },
    address: {
      address_line1:  document.getElementById('address1').value.trim(),
      address_line2:  document.getElementById('address2').value.trim(),
      city:           document.getElementById('city').value.trim(),
      state_province: document.getElementById('state_province').value.trim(),
      country:        document.getElementById('country').value.trim(),
      postal_code:    document.getElementById('postal_code').value.trim()
    },
    farm: {
      location: document.getElementById('reg-location').value.trim(),
      farm_id:  document.getElementById('reg-farmid').value.trim()
    }
  };

  try {
    const resp = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (resp.ok) {
      alert('Registration successful! Please log in.');
      window.location.href = 'login.html';
    } else {
      const text = await resp.text();
      showError(text || 'Registration failed.');
    }
  } catch (err) {
    console.error('Registration error:', err);
    showError('Server error, please try again later.');
  }
});

function showError(msg) {
  const p = document.getElementById('reg-error');
  p.textContent = msg;
  p.hidden = false;
}
