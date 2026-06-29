import { getSessionDEK } from '/crypto/session-dek.js';
import { loadAndSelectChats } from '/lib/chat/chat-login-loader.js';
import { callLLM } from '/lib/llm.js';
import { loadChatPromptV1 } from '/lib/prompts-loader.js';
import { createRespondedChat, listChats } from '/lib/chat/chat-records.js';

// One opener call per chat per session. The list render NEVER calls the LLM.
const openerCache = new Map(); // hubMemoId -> opener text

// In-session model, rebuilt on mount. Keeps the list consistent after a reply
// without a reload: a hub that gains a responded chat leaves the proposed pool.
let model = { candidates: [], memosById: {}, responded: [] };

export async function mountChat(container) {
  container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'chat-surface';
  container.appendChild(root);

  try {
    const dek = await getSessionDEK();
    if (!dek) throw new Error('no-dek');
    const feed = await loadAndSelectChats({ dek });       // { candidates, memosById }
    const responded = await listChats();                  // persisted responded chats
    const respondedHubs = new Set(responded.map((c) => c.hubMemoId));
    const candidates = (feed && feed.candidates ? feed.candidates : []).filter((c) => !respondedHubs.has(c.hubMemoId)); // Model-E dedupe
    model = { candidates, memosById: (feed && feed.memosById) || {}, responded };
  } catch (err) {
    renderError(root, "Couldn't load chats. Refresh and try again.");
    return;
  }
  renderList(root);
}

function renderList(root) {
  root.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'chat-list';
  const { candidates, responded, memosById } = model;

  if (!candidates.length && !responded.length) {
    const empty = document.createElement('p');
    empty.className = 'small';
    empty.textContent = 'No conversations right now.';
    list.appendChild(empty);
    root.appendChild(list);
    return;
  }

  for (const c of responded) {
    const memo = memosById[c.hubMemoId];
    const label = memo
      ? ((memo.title && memo.title.trim()) || snippet(memo.body) || c.hubMemoId)
      : (titleFromTranscript(c.transcript) || c.hubMemoId);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'chat-row responded';
    row.appendChild(span('chat-row-label', label));
    row.appendChild(span('chat-row-reason', 'responded'));
    row.addEventListener('click', () => openResponded(root, c));
    list.appendChild(row);
  }

  for (const c of candidates) {
    const memo = memosById[c.hubMemoId];
    const label = memo ? ((memo.title && memo.title.trim()) || snippet(memo.body) || c.hubMemoId) : c.hubMemoId;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'chat-row';
    row.appendChild(span('chat-row-label', label));
    if (c.reason) row.appendChild(span('chat-row-reason', c.reason));
    row.addEventListener('click', () => openChat(root, c));
    list.appendChild(row);
  }

  root.appendChild(list);
}

// PROPOSED open path — the ONLY place callLLM is invoked.
async function openChat(root, candidate) {
  const memo = model.memosById[candidate.hubMemoId];
  const memoText = memo ? (memo.body || '') : '';
  renderConversation(root, { opener: '…', reply: null, candidate, loading: true });

  let opener = openerCache.get(candidate.hubMemoId);
  if (opener == null) {
    try {
      const { system } = await loadChatPromptV1();
      opener = await callLLM({ messages: [{ role: 'user', content: memoText }], system });
      openerCache.set(candidate.hubMemoId, opener); // exactly one call per chat
    } catch (err) {
      renderConversation(root, { opener: "Couldn't start this conversation. Go back and try again.", reply: null, candidate, isError: true });
      return;
    }
  }
  renderConversation(root, { opener, reply: null, candidate });
}

// RESPONDED open path — NO callLLM; renders the stored transcript read-only.
function openResponded(root, chat) {
  const t = chat.transcript || {};
  const opener = messageContent(t, 'assistant') || '';
  const reply = messageContent(t, 'user') || '';
  renderConversation(root, { opener, reply, readOnly: true });
}

// opts: { opener, reply, candidate?, loading?, isError?, readOnly? }
function renderConversation(root, opts) {
  const { opener, reply, candidate, loading, isError, readOnly } = opts;
  root.innerHTML = '';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'chat-back';
  back.textContent = '← Back';
  back.addEventListener('click', () => renderList(root));
  root.appendChild(back);

  const view = document.createElement('div');
  view.className = 'chat-conversation';

  const openerBubble = document.createElement('div');
  openerBubble.className = isError ? 'chat-bubble err' : 'chat-bubble billy';
  openerBubble.textContent = opener;
  view.appendChild(openerBubble);

  if (reply != null && reply !== '') {
    const replyBubble = document.createElement('div');
    replyBubble.className = 'chat-bubble user';
    replyBubble.textContent = reply;
    view.appendChild(replyBubble);
  }
  root.appendChild(view);

  // Reply affordance ONLY for a live proposed chat.
  if (candidate && !loading && !isError && !readOnly) {
    const form = document.createElement('div');
    form.className = 'chat-reply';
    const ta = document.createElement('textarea');
    ta.className = 'chat-reply-input';
    ta.rows = 2;
    ta.placeholder = 'Reply…';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'chat-send';
    send.textContent = 'Send';

    let inFlight = false;
    send.addEventListener('click', async () => {
      if (inFlight) return;
      const text = (ta.value || '').trim();
      if (!text) return;
      inFlight = true;
      send.disabled = true; // synchronous: closes the double-submit race
      ta.disabled = true;
      const transcript = { messages: [{ role: 'assistant', content: opener }, { role: 'user', content: text }] };
      try {
        const saved = await createRespondedChat({ hubMemoId: candidate.hubMemoId, transcript });
        model.candidates = model.candidates.filter((c) => c.hubMemoId !== candidate.hubMemoId);
        model.responded = model.responded.concat([{ id: saved.id, hubMemoId: candidate.hubMemoId, state: 'responded', transcript, createdAt: saved.createdAt }]);
        renderConversation(root, { opener, reply: text, readOnly: true });
      } catch (err) {
        inFlight = false;
        send.disabled = false;
        ta.disabled = false;
        const e = document.createElement('p');
        e.className = 'err';
        e.textContent = "Couldn't save your reply. Try again.";
        form.appendChild(e);
      }
    });

    form.appendChild(ta);
    form.appendChild(send);
    root.appendChild(form);
  }
}

function titleFromTranscript(t) {
  const a = messageContent(t || {}, 'assistant');
  return a ? snippet(a) : null;
}
function messageContent(transcript, role) {
  const msgs = transcript && Array.isArray(transcript.messages) ? transcript.messages : [];
  const m = msgs.find((x) => x && x.role === role);
  return m ? m.content : null;
}
function snippet(s, n = 90) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function span(cls, txt) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = txt;
  return el;
}
function renderError(root, msg) {
  root.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'err';
  p.textContent = msg;
  root.appendChild(p);
}
