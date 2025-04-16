// auth.js
const API_URL = 'http://localhost:3000'; // Update if deployed

// Register User
async function registerUser(username, password) {
  try {
    const response = await fetch(`${API_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    alert('Registration successful! Please log in.');
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// Login User
async function loginUser(username, password) {
  try {
    const response = await fetch(`${API_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    localStorage.setItem('token', data.token);
    alert('Login successful!');
    window.location.href = 'home.html'; // Or your dashboard page
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// Logout User
function logoutUser() {
  localStorage.removeItem('token');
  alert('You have been logged out.');
  window.location.href = 'login.html'; // Redirect to login
}

// Check Login Status
function isLoggedIn() {
  return !!localStorage.getItem('token');
}

// Example usage (you can connect these to button events in HTML):
// registerUser('exampleUser', 'password123');
// loginUser('exampleUser', 'password123');
// logoutUser();

