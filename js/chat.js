// Customer live-chat widget (floating button + panel).
import { sb, setMsg } from './app.js';
import { mountChat } from './chatview.js';

export function initChat() {
  const fab = document.createElement('button');
  fab.className = 'btn chatfab';
  fab.innerHTML = '<i class="fa-solid fa-comments"></i> Chat with support';

  const panel = document.createElement('section');
  panel.className = 'chatpanel card';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Live chat with AmBank support');
  panel.innerHTML = '<div class="chathead"><b>Live chat</b><span><button class="link" id="chatEnd" hidden>End chat</button> <button class="link" id="chatMin" aria-label="Minimize chat">&minus;</button></span></div><div class="chatbody"></div>';

  document.body.append(fab, panel);

  const body = panel.querySelector('.chatbody'), end = panel.querySelector('#chatEnd');
  let view = null, convId = null;
  let loading = false;   // prevents fab double-click racing the initial query

  const resetFab = () => {
    fab.disabled = false;
    fab.hidden = false;
    fab.innerHTML = '<i class="fa-solid fa-comments"></i> Chat with support';
  };

  async function attach(id) {
    // Defensive: if a previous attach is still live, tear it down first.
    if (view) { try { view.destroy(); } catch {} view = null; }
    convId = id; end.hidden = false; body.innerHTML = '';
    view = await mountChat(body, id, false, () => {
      end.hidden = true; view = null;
      body.insertAdjacentHTML('beforeend', '<button class="btn" id="chatNew">Start a new chat</button>');
      body.querySelector('#chatNew').onclick = open;
    });
  }

  async function open() {
    if (loading) return;              // guard against concurrent opens
    if (view) {                       // already attached — just un-hide the panel
      panel.hidden = false; fab.hidden = true;
      return;
    }
    loading = true;
    fab.disabled = true;              // immediate feedback while loading
    fab.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Opening…';
    panel.hidden = false; fab.hidden = true;
    try {
      const { data } = await sb.from('chat_conversations').select('id').neq('status', 'closed').order('created_at', { ascending: false }).limit(1);
      if (data?.length) { await attach(data[0].id); return; }

      const { data: online } = await sb.rpc('chat_staff_online');
      body.innerHTML = online
        ? '<p>Our team is online. Start a chat and we will pick it up shortly.</p><button class="btn" id="chatStart">Start chat</button><p class="msg" role="alert"></p>'
        : '<p>Our team is offline right now. Open a support ticket and we will reply there.</p><a class="btn" href="support.html">Open a ticket</a>';

      const s = body.querySelector('#chatStart');
      if (s) {
        let starting = false;         // guard the "Start chat" click
        s.onclick = async () => {
          if (starting) return;
          starting = true; s.disabled = true; s.textContent = 'Starting…';
          const { data: id, error } = await sb.rpc('chat_start');
          if (error) {
            starting = false; s.disabled = false; s.textContent = 'Start chat';
            return setMsg(body.querySelector('.msg'), error.message);
          }
          // Do NOT re-enable — we're navigating to the attached chat.
          await attach(id);
        };
      }
    } finally {
      loading = false;
      // If we attached (or are about to), the panel is showing and the fab should stay hidden.
      // If we failed or the user is looking at the "Start chat" prompt, restore the fab.
      if (!view) resetFab();
    }
  }

  end.onclick = async () => {
    if (convId && confirm('End this chat?')) {
      await sb.rpc('chat_close', { p_conv: convId });
      view?.refresh();
    }
  };

  panel.querySelector('#chatMin').onclick = () => { panel.hidden = true; fab.hidden = false; };

  fab.onclick = open;
}