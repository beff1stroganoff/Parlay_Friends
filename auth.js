// Register User
async function registerUser(username, password) {
    try {
      const response = await fetch('/register', {
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
      const response = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      
      // Save JWT token in localStorage
      localStorage.setItem('token', data.token);
      alert('Login successful!');
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }
  
  // Logout User
  function logoutUser() {
    localStorage.removeItem('token');
    alert('You have been logged out.');
    window.location.href = 'login.html'; // Redirect to login page
  }
  
  // Check if User is Logged In (using JWT token)
  function isLoggedIn() {
    return !!localStorage.getItem('token');
  }

