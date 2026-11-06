import { sb, esc } from './app.js';
import { openModal } from './transactions.js';

export function initNotifications() {
  const btn = document.getElementById('bell'), badge = document.getElementById('bellCount');
  
  async function count() {
    const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
    badge.hidden = !count; badge.textContent = count || '';
  }

  btn.onclick = async () => {
    const b = openModal('Notifications');
    b.innerHTML = '<p>Loading...</p>';
    
    const { data, error } = await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(30);
    
    if (error) {
      b.innerHTML = '<p class="msg err">Could not load notifications.</p><button class="btn" data-close>Close</button>';
      return;
    }

    if (!data.length) {
      b.innerHTML = '<p>You are all caught up.</p><button class="btn" data-close>Close</button>';
      return;
    }

    b.innerHTML = `
      <ul class="list" style="margin-bottom:1rem;">
        ${data.map(n => `
          <li style="align-items: flex-start; padding-bottom: 1rem; border-bottom: 1px solid var(--border); ${n.read_at ? 'opacity: 0.6;' : ''}">
            <span>
              <b>${esc(n.title)}</b>
              ${n.read_at ? '' : ' <span class="badge active" style="font-size:0.7rem;">New</span>'}
              <br>
              <small class="sim" style="display:block; margin-top:0.3rem;">${esc(n.body)}</small>
              <small class="sim" style="font-size:0.7rem;">${new Date(n.created_at).toLocaleString()}</small>
            </span>
          </li>
        `).join('')}
      </ul>
      <button class="btn" data-close>Close</button>
    `;

    // Mark all as read when the modal is opened
    if (data.some(n => !n.read_at)) { 
      await sb.rpc('mark_notifications_read'); 
      count(); 
    }
  };

  count(); 
  setInterval(count, 60000); 
}