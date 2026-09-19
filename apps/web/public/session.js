(async () => {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (!response.ok) { location.replace('/'); return; }
  const payload = await response.json();
  const user = payload.data.user;
  const slot = document.querySelector('.account-slot');
  const style = document.createElement('style');
  style.textContent = `
    .account-slot { position: relative; min-width: 38px; min-height: 38px; }
    .account-menu { position: relative; font: 12px system-ui, -apple-system, sans-serif; color: #536479; }
    .account-menu.account-floating { position: fixed; top: 16px; right: 24px; z-index: 220; }
    .account-trigger { height: 36px; min-width: 36px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 2px 5px 2px 2px; border: 1px solid rgba(255,255,255,.95); border-radius: 20px; background: rgba(255,255,255,.86); box-shadow: 0 4px 16px rgba(48,67,97,.10); color: #68788d; }
    .account-trigger:hover, .account-menu.open .account-trigger { background: #fff; color: #356fd4; }
    .account-avatar { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; background: linear-gradient(145deg,#dbeaff,#a9cdf9); color: #2d69ac; font-size: 13px; font-weight: 700; }
    .account-chevron { font-size: 14px; line-height: 1; margin-top: -3px; }
    .account-dropdown { position: absolute; top: calc(100% + 9px); right: 0; width: 218px; padding: 8px; border: 1px solid #e2e9f2; border-radius: 14px; background: rgba(255,255,255,.98); box-shadow: 0 16px 38px rgba(48,67,97,.16); }
    .account-dropdown[hidden] { display: none; }
    .account-summary { padding: 7px 9px 9px; display: flex; flex-direction: column; gap: 4px; overflow: hidden; }
    .account-summary strong { color: #35445a; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .account-summary span { color: #8a98aa; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .account-menu-divider { height: 1px; margin: 1px 3px 5px; background: #edf1f6; }
    .account-dropdown a, .account-dropdown button { box-sizing: border-box; width: 100%; display: block; padding: 9px 10px; border: 0; border-radius: 8px; background: transparent; color: #536479; text-align: left; text-decoration: none; font: inherit; cursor: pointer; }
    .account-dropdown a:hover, .account-dropdown button:hover { background: #f1f6fd; color: #356fd4; }
    @media (max-width: 680px) { .account-menu.account-floating { top: 12px; right: 14px; } .account-chevron { display: none; } }
  `;
  document.head.append(style);
  const root = document.createElement('div');
  root.className = 'account-menu';
  root.innerHTML = `
    <button class="account-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="打开账户菜单">
      <span class="account-avatar" aria-hidden="true"></span>
      <span class="account-chevron" aria-hidden="true">⌄</span>
    </button>
    <div class="account-dropdown" role="menu" hidden>
      <div class="account-summary"><strong></strong><span></span></div>
      <div class="account-menu-divider"></div>
      ${user.role === 'admin' ? '<a href="/admin" role="menuitem">人员管理</a>' : ''}
      <button type="button" role="menuitem" data-logout>退出登录</button>
    </div>`;
  const trigger = root.querySelector('.account-trigger');
  const dropdown = root.querySelector('.account-dropdown');
  const avatar = root.querySelector('.account-avatar');
  const summaryName = root.querySelector('.account-summary strong');
  const summaryRole = root.querySelector('.account-summary span');
  const roleName = { admin: '管理员', operator: '操作员', viewer: '只读' };
  const initials = String(user.displayName || user.email || '?').trim().slice(0, 1).toUpperCase();
  avatar.textContent = initials;
  summaryName.textContent = user.displayName || user.email;
  summaryRole.textContent = `${roleName[user.role] || user.role} · ${user.email}`;
  function setOpen(open) {
    dropdown.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    root.classList.toggle('open', open);
  }
  trigger.addEventListener('click', () => setOpen(dropdown.hidden));
  document.addEventListener('click', event => { if (!root.contains(event.target)) setOpen(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') setOpen(false); });
  root.querySelector('[data-logout]').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.replace('/');
  });
  if (slot) {
    slot.replaceChildren(root);
  } else {
    root.classList.add('account-floating');
    document.body.append(root);
  }
})();
