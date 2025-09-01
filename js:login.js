document.getElementById('loginForm').addEventListener('submit', async function (e) {
  e.preventDefault();

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (!res.ok) {
      alert(`❌ ${data.error || 'Login failed'}`);
      return;
    }

    // Save token and redirect
    localStorage.setItem('token', data.token);
    localStorage.setItem('username', username); // Save username for dashboard
    window.location.href = 'dashboard.html';

  } catch (err) {
    alert('❌ Something went wrong logging in.');
    console.error(err);
  }
});

