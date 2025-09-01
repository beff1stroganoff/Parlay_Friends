async function loginUser(username, password) {
  try {
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (response.ok) {
      // Save the username to localStorage for the dashboard
      localStorage.setItem('username', data.username); // Make sure your backend sends this
      // Save the token to localStorage
      localStorage.setItem('token', data.token);
      // Save the user ID to localStorage
      localStorage.setItem('userId', data.userId); // Make sure your backend sends this   
      // Save the league name to localStorage
      localStorage.setItem('leagueName', data.leagueName); // Make sure your backend sends this
      // Save the passkey to localStorage
      localStorage.setItem('passkey', data.passkey); // Make sure your backend sends this

      // Redirect to dashboard
      window.location.href = 'dashboard.html';
    } else {
      alert(data.error || 'Login failed');
    }
  } catch (error) {
    console.error('Error during login:', error);
    alert('Login failed. Please try again.');
  }
}
// Add event listener to the login form
document.getElementById('loginForm').addEventListener('submit', function (e) {
  e.preventDefault();
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  loginUser(username, password);
});
