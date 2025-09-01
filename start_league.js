document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('startLeagueForm');

  if (form) {
    // ✅ This block runs ONLY if #startLeagueForm exists
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const leagueName = document.getElementById('leagueName').value;
      const passkey = document.getElementById('passkey').value;
      const token = localStorage.getItem('token');

      if (!token) {
        alert('You must be logged in!');
        window.location.href = 'login.html';
        return;
      }

      try {
        const response = await fetch('/create-league', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ leagueName, passkey })
        });

        const data = await response.json();

        if (response.ok) {
          alert('League created successfully!');
          localStorage.setItem('leagueId', data.leagueId);
          window.location.href = `league_settings.html?leagueId=${data.leagueId}`;
        } else {
          alert(`Error: ${data.error}`);
        }
      } catch (err) {
        console.error('Error creating league:', err);
        alert('Server error. Please try again.');
      }
    });
  }

  // ✅ Handle league details if we're on League_Details.html
  if (document.getElementById('leagueNameDisplay')) {
    getLeagueDetails();
  }
});

// 🔥 This function ONLY runs if called (from above!)
async function getLeagueDetails() {
  const urlParams = new URLSearchParams(window.location.search);
  const leagueId = urlParams.get('leagueId'); // make sure you're using "leagueId" in the URL

  if (!leagueId) {
    alert('League ID is missing in the URL.');
    return;
  }

  const token = localStorage.getItem('token');

  try {
    const response = await fetch(`/league/${leagueId}`, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token
      }
    });

    if (response.ok) {
      const league = await response.json();
      document.getElementById('leagueNameDisplay').innerText = league.name;
      document.getElementById('leagueCreatorDisplay').innerText = league.creator.username;
      document.getElementById('leagueCreatedAtDisplay').innerText = new Date(league.createdAt).toLocaleDateString();
    } else {
      alert('Failed to fetch league details');
    }
  } catch (err) {
    console.error('Error fetching league details:', err);
    alert('Server error while fetching league details.');
  }
}
