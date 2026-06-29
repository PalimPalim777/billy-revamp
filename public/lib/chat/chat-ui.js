import { getSessionDEK } from '/crypto/session-dek.js';
import { loadAndSelectChats } from '/lib/chat/chat-login-loader.js';
import { callLLM } from '/lib/llm.js';
import { loadChatPromptV1 } from '/lib/prompts-loader.js';

// One opener call per chat per session. The list render NEVER calls the LLM.
const openerCache = new Map(); // hubMemoId -> opener text

export async function mountChat(container) {
  container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'chat-surface';
  container.appendChild(root);

  let feed;
  try {
    const dek = await getSessionDEK();
    if (!dek) throw new Error('no-dek');
    feed = await loadAndSelectChats({ dek }); // { candidates, memosById }
  } catch (err) {
    renderError(root, "Couldn't load chats. Refresh and try again.");
    return;
  }
  const { candidates = [], memosById = {} } = feed || {};
  renderList(root, candidates, memosById);
}

function renderList(root, candidates, memosById) {
  root.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'chat-list';
  if (!candidates.length) {
    const empty = document.createElement('p');
    empty.className = 'small';
    empty.textContent = 'No conversations right now.';
    list.appendChild(empty);
    root.appendChild(list);
    return;
  }
  for (const c of candidates) {
    const memo = memosById[c.hubMemoId];
    const label = memo ? ((memo.title && memo.title.trim()) || snippet(memo.body) || c.hubMemoId) : c.hubMemoId;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'chat-row';
    row.appendChild(span('chat-row-label', label));
    if (c.reason) row.appendChild(span('chat-row-reason', c.reason));
    row.addEventListener('click', () => openChat(root, c, memosById, candidates));
    list.appendChild(row);
  }
  root.appendChild(list);
}

async function openChat(root, candidate, memosById, candidates) {
  const memo = memosById[candidate.hubMemoId];
  const memoText = memo ? (memo.body || '') : '';
  renderConversation(root, '…', candidates, memosById, false); // loading

  let opener = openerCache.get(candidate.hubMemoId);
  if (opener == null) {
    try {
      const { system } = await loadChatPromptV1();
      opener = await callLLM({ messages: [{ role: 'user', content: memoText }], system });
      openerCache.set(candidate.hubMemoId, opener); // exactly one call per chat
    } catch (err) {
      renderConversation(root, "Couldn't start this conversation. Go back and try again.", candidates, memosById, true);
      return;
    }
  }
  renderConversation(root, opener, candidates, memosById, false);
}

function renderConversation(root, openerText, candidates, memosById, isError) {
  root.innerHTML = '';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'chat-back';
  back.textContent = '← Back';
  back.addEventListener('click', () => renderList(root, candidates, memosById));
  root.appendChild(back);

  const view = document.createElement('div');
  view.className = 'chat-conversation';
  const bubble = document.createElement('div');
  bubble.className = isError ? 'chat-bubble err' : 'chat-bubble billy';
  bubble.textContent = openerText;
  view.appendChild(bubble);
  root.appendChild(view);
  // Commit B adds the reply input + responded-persist. No reply control in Commit A.
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
