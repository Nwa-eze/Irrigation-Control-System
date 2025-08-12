async function login() {
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  try {
    const resp = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    const data = await resp.json();

    if (!resp.ok) {
      // Show the error message from the server
      return alert(data.error || "Invalid login.");
    }
    console.log(data);
    // On success, store into localStorage
    localStorage.setItem("user_id",        data.userId);
    localStorage.setItem("user_name",      data.name);
    localStorage.setItem("user_location",  data.location);
    localStorage.setItem("farm_id",        data.farm_id);
    localStorage.setItem("matric_number",  data.matric_number);

    // Redirect
    window.location.href = "dashboard.html";

  } catch (err) {
    console.error("Login error:", err);
    alert("Server error during login.");
  }
}

// Attach to your login form
document.getElementById("login-form").addEventListener("submit", e => {
  e.preventDefault();
  login();
});
