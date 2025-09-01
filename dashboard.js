document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('token');
  const username = localStorage.getItem('username');

  if (!token || !username) {
    alert("Please log in first.");
    window.location.href = 'login.html';
    return;
  }

  document.getElementById('username').textContent = username;

  // Handle logout
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.clear();
      window.location.href = 'index.html';
    });
  }

  fetchLiveLines();
  fetchUserLeagues();

  async function fetchUserLeagues() {
    const username = localStorage.getItem('username');
    const token = localStorage.getItem('token');
    const list = document.getElementById('leagueList');
    list.innerHTML = '';
  
    try {
      const res = await fetch(`/api/user-leagues?username=${username}`, {
        headers: {
          'Authorization': 'Bearer ' + token
        }
      });
  
      const leagues = await res.json();
  
      if (!Array.isArray(leagues)) {
        console.error('Expected array of leagues, got:', leagues);
        return;
      }
  
      leagues.forEach(league => {
        const li = document.createElement('li');
        li.innerHTML = `<a href="league_home.html?leagueId=${league._id}">${league.name}</a>`;
        list.appendChild(li);
      });
    } catch (err) {
      console.error('Error fetching user leagues:', err);
    }
  }
  
});


const sports = ['baseball_mlb', 'basketball_nba', 'icehockey_nhl', 'americanfootball_nfl'];

async function fetchLiveLines() {
  try {
    const allOdds = [];

    for (const sport of sports) {
      const res = await fetch(`/api/odds?sport=${sport}`);
      const data = await res.json();
    
      if (res.ok && Array.isArray(data)) {
        allOdds.push(...data);
      } else {
        console.warn(`No odds returned for ${sport}`, data);
      }
    }

    const oddsContainer = document.getElementById('odds-container');
    oddsContainer.innerHTML = ''; // clear old content
    
    allOdds.forEach(game => {
      const div = document.createElement('div');
      div.className = 'line-item';
      div.innerHTML = `
        <strong>${game.home_team} vs ${game.away_team}</strong><br>
        <em>${game.sport_key.replace(/_/g, ' ').toUpperCase()}</em><br>
        <span>Commence: ${new Date(game.commence_time).toLocaleString()}</span><br>
        <hr>
      `;
      oddsContainer.appendChild(div);
    });

  } catch (err) {
    console.error('Error fetching live lines:', err);
  }
}
