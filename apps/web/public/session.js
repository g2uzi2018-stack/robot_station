(async () => {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (!response.ok) { location.replace('/'); return; }
  const payload = await response.json();
  const user = payload.data.user;
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;z-index:50;top:12px;right:16px;display:flex;gap:8px;align-items:center;padding:7px 9px 7px 12px;border:1px solid #dfe7f0;border-radius:10px;background:#ffffffed;box-shadow:0 5px 20px #244b7618;font:12px system-ui,sans-serif;color:#536479';
  const label = document.createElement('span'); label.textContent = `${user.displayName} · ${user.role}`; bar.append(label);
  if (user.role === 'admin') { const admin = document.createElement('a'); admin.href = '/admin'; admin.textContent = '人员管理'; admin.style.color = '#356fd4'; bar.append(admin); }
  const logout = document.createElement('button'); logout.type='button'; logout.textContent='退出'; logout.style.cssText='border:0;border-radius:7px;padding:5px 8px;background:#75849a;color:white;cursor:pointer';
  logout.addEventListener('click', async () => { await fetch('/api/auth/logout', { method:'POST', credentials:'same-origin' }); location.replace('/'); });
  bar.append(logout); document.body.append(bar);
})();