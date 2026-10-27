/* global marked, api */
const $ = (s) => document.querySelector(s);

const chatList = $('#chatList');
const welcome = $('#welcome');
const chatScroll = $('#chatScroll');
const inputEl = $('#input');
const sendBtn = $('#sendBtn');
const stopBtn = $('#stopBtn');

let settings = { baseUrl: '', apiKey: '', model: '', permission: 'ask', workspace: '' };
let sessions = [];
let currentId = null;
let busy = false;
let streaming = null; // { el, buffer }
let streamTimer = null;
let streamedText = '';
const toolCards = new Map();      // tool_call_id -> { statusEl, bodyEl, preEl, toggleEl }
const pendingApprovals = new Map(); // approvalId -> { tool, args }

function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function saveSessions() { try { localStorage.setItem('mz_sessions', JSON.stringify(sessions)); } catch {} }
function currentSession() { return sessions.find((s) => s.id === currentId) || null; }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeParse(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
function mdToHtml(text) {
  if (window.marked && marked.parse) {
    try { return marked.parse(text, { breaks: true }); } catch {}
  }
  return '<pre class="plain">' + escapeHtml(text) + '</pre>';
}
function scrollBottom(force) {
  if (force || chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 260) {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }
}
function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

function toolSummary(name, args) {
  if (name === 'run_command') return args.command || '';
  if (name === 'read_file' || name === 'write_file' || name === 'list_dir') return args.path || '.';
  return JSON.stringify(args).slice(0, 120);
}

// ---------------- 渲染会话 ----------------
function renderSessions() {
  const box = $('#sessionList');
  box.innerHTML = '';
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === currentId ? ' active' : '');
    const t = document.createElement('span');
    t.className = 's-title';
    t.textContent = s.title || '新会话';
    const del = document.createElement('button');
    del.className = 's-del';
    del.textContent = '✕';
    del.title = '删除会话';
    del.onclick = (e) => {
      e.stopPropagation();
      if (busy) return;
      sessions = sessions.filter((x) => x.id !== s.id);
      if (currentId === s.id) {
        if (sessions.length) currentId = sessions[0].id;
        else { newSession(); return; }
      }
      saveSessions();
      renderSessions();
      renderConversation();
    };
    item.appendChild(t);
    item.appendChild(del);
    item.onclick = () => {
      if (busy || s.id === currentId) return;
      currentId = s.id;
      renderSessions();
      renderConversation();
    };
    box.appendChild(item);
  }
}

function addUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  div.appendChild(b);
  chatList.appendChild(div);
}

function addAssistantMsg(mdText) {
  const div = document.createElement('div');
  div.className = 'msg assistant';
  const md = document.createElement('div');
  md.className = 'md';
  md.innerHTML = mdToHtml(mdText);
  enhanceCodeBlocks(md);
  div.appendChild(md);
  chatList.appendChild(div);
  return md;
}

function addErrorBubble(text) {
  const div = document.createElement('div');
  div.className = 'msg error';
  div.textContent = text;
  chatList.appendChild(div);
}

function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '复制';
    btn.onclick = async () => {
      const codeEl = pre.querySelector('code');
      const code = codeEl ? codeEl.textContent : pre.textContent;
      try { await navigator.clipboard.writeText(code); } catch {
        const ta = document.createElement('textarea');
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    };
    pre.appendChild(btn);
  });
}

function addToolCard(tc, info) {
  const args = safeParse(tc.function && tc.function.arguments);
  const name = (tc.function && tc.function.name) || 'tool';
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML =
    '<div class="tool-head">' +
      '<span class="tool-status run">◔</span>' +
      '<span class="tool-name">' + escapeHtml(name) + '</span>' +
      '<span class="tool-arg">' + escapeHtml(toolSummary(name, args)) + '</span>' +
      '<span class="tool-toggle">▾</span>' +
    '</div>' +
    '<div class="tool-body hidden"><pre></pre></div>';
  const body = card.querySelector('.tool-body');
  const statusEl = card.querySelector('.tool-status');
  const toggleEl = card.querySelector('.tool-toggle');
  card.querySelector('.tool-head').addEventListener('click', () => {
    body.classList.toggle('hidden');
    toggleEl.textContent = body.classList.contains('hidden') ? '▾' : '▴';
  });
  const preEl = card.querySelector('pre');
  preEl.textContent = '运行中…';
  chatList.appendChild(card);
  toolCards.set(tc.id, { statusEl, bodyEl: body, preEl, toggleEl });
  if (info) fillToolCard(tc.id, info);
  scrollBottom();
}

function fillToolCard(id, info) {
  const c = toolCards.get(id);
  if (!c) return;
  if (info.denied) {
    c.statusEl.textContent = '⊘';
    c.statusEl.className = 'tool-status warn';
  } else if (info.ok) {
    c.statusEl.textContent = '✓';
    c.statusEl.className = 'tool-status ok';
  } else {
    c.statusEl.textContent = '✕';
    c.statusEl.className = 'tool-status bad';
  }
  c.preEl.textContent = info.result || '(无输出)';
  if (!info.ok || info.denied) {
    c.bodyEl.classList.remove('hidden');
    c.toggleEl.textContent = '▴';
  }
}

function addApprovalCard({ id, tool, args }) {
  pendingApprovals.set(id, { tool, args });
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.innerHTML =
    '<div class="ap-title">⚠️ 请求确认：<b>' + escapeHtml(tool) + '</b></div>' +
    '<pre class="ap-detail">' + escapeHtml(toolSummary(tool, args || {})) + '</pre>' +
    '<div class="ap-actions">' +
      '<button class="btn primary ap-ok">批准</button>' +
      '<button class="btn danger ap-no">拒绝</button>' +
    '</div>';
  const actions = card.querySelector('.ap-actions');
  const decide = (ok) => {
    api.respondApproval(id, ok);
    actions.innerHTML = ok ? '<span class="ap-decided">✓ 已批准，正在执行…</span>' : '<span class="ap-decided no">✕ 已拒绝</span>';
    pendingApprovals.delete(id);
  };
  card.querySelector('.ap-ok').onclick = () => decide(true);
  card.querySelector('.ap-no').onclick = () => decide(false);
  chatList.appendChild(card);
  scrollBottom();
}

function renderConversation() {
  chatList.innerHTML = '';
  toolCards.clear();
  const s = currentSession();
  const hasMsgs = s && s.messages.length > 0;
  welcome.style.display = hasMsgs ? 'none' : 'flex';
  if (!hasMsgs) return;

  const results = new Map();
  for (const m of s.messages) if (m.role === 'tool') results.set(m.tool_call_id, m);

  for (const m of s.messages) {
    if (m.role === 'user') {
      addUserMsg(m.content);
    } else if (m.role === 'assistant') {
      if (m.content) addAssistantMsg(m.content);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          const r = results.get(tc.id);
          addToolCard(tc, r
            ? { ok: !r.content.startsWith('错误：'), denied: r.content.includes('用户拒绝了'), result: r.content }
            : { ok: false, denied: false, result: '(无结果)' });
        }
      }
    }
  }
  for (const [id, ap] of pendingApprovals) addApprovalCard({ id, ...ap });
  scrollBottom(true);
}

// ---------------- 流式输出 ----------------
function ensureStreamingEl() {
  if (!streaming || !streaming.el.isConnected) {
    const div = document.createElement('div');
    div.className = 'msg assistant';
    const md = document.createElement('div');
    md.className = 'md streaming';
    div.appendChild(md);
    chatList.appendChild(div);
    streaming = { el: md, buffer: '' };
  }
}

function scheduleStreamRender() {
  if (streamTimer) return;
  streamTimer = setTimeout(() => {
    streamTimer = null;
    if (streaming && streaming.el.isConnected) {
      streaming.el.innerHTML = mdToHtml(streaming.buffer);
      scrollBottom();
    }
  }, 60);
}

api.onAgentEvent((ev) => {
  if (!busy) return;
  if (ev.type === 'text-delta') {
    ensureStreamingEl();
    streaming.buffer += ev.text;
    streamedText = streaming.buffer;
    scheduleStreamRender();
  } else if (ev.type === 'assistant-message') {
    if (streaming && streaming.el.isConnected) {
      streaming.el.classList.remove('streaming');
      streaming.el.innerHTML = mdToHtml(streaming.buffer);
      enhanceCodeBlocks(streaming.el);
    }
    streaming = null;
    for (const tc of (ev.message.tool_calls || [])) addToolCard(tc, null);
  } else if (ev.type === 'tool-result') {
    fillToolCard(ev.toolCallId, ev);
  } else if (ev.type === 'approval-request') {
    addApprovalCard(ev);
  }
});

// ---------------- 会话操作 ----------------
function newSession() {
  const s = { id: uid(), title: '新会话', createdAt: Date.now(), messages: [] };
  sessions.unshift(s);
  currentId = s.id;
  saveSessions();
  renderSessions();
  renderConversation();
}

// ---------------- 发送 ----------------
function setBusy(b) {
  busy = b;
  sendBtn.disabled = b;
  stopBtn.classList.toggle('hidden', !b);
}

async function send() {
  if (busy) return;
  const text = inputEl.value.trim();
  if (!text) return;
  if (!settings.baseUrl) {
    addErrorBubble('请先在「设置」中配置 API Base URL 与 API Key，再开始对话。');
    openSettings();
    return;
  }
  if (!currentSession()) newSession();
  const s = currentSession();
  setBusy(true);

  s.messages.push({ role: 'user', content: text });
  if (!s.title || s.title === '新会话') {
    s.title = text.replace(/\s+/g, ' ').slice(0, 22);
    renderSessions();
  }
  saveSessions();
  inputEl.value = '';
  autoResize();
  renderConversation();

  streamedText = '';
  const res = await api.runAgent({
    messages: s.messages.map((m) => m),
    settings: {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      permission: settings.permission,
      workspace: settings.workspace,
    },
  });

  if (res && res.ok) {
    s.messages = res.messages || s.messages;
  } else {
    if (streamedText) s.messages.push({ role: 'assistant', content: streamedText });
    addErrorBubble(res && res.aborted ? '⏹ 已停止本次任务。' : '❌ 请求失败：' + ((res && res.error) || '未知错误'));
  }

  streamedText = '';
  streaming = null;
  saveSessions();
  renderConversation();
  setBusy(false);
}

// ---------------- 设置 ----------------
function openSettings() {
  $('#setBaseUrl').value = settings.baseUrl || '';
  $('#setApiKey').value = settings.apiKey || '';
  $('#setModel').value = settings.model || '';
  $('#setPermission').value = settings.permission || 'ask';
  $('#setWorkspace').value = settings.workspace || '';
  $('#settingsMask').classList.remove('hidden');
}
function closeSettings() { $('#settingsMask').classList.add('hidden'); }

function updateTopbar() {
  $('#workspacePath').textContent = settings.workspace || '未选择工作目录（工具将使用主目录）';
  const badge = $('#modelBadge');
  badge.textContent = settings.model || '未配置模型';
  badge.className = 'badge ' + (settings.model ? 'ok' : 'none');
}

// ---------------- 事件绑定 ----------------
sendBtn.addEventListener('click', send);
stopBtn.addEventListener('click', () => api.stopAgent());
$('#newChatBtn').addEventListener('click', () => { if (!busy) newSession(); });
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsCancel').addEventListener('click', closeSettings);
$('#settingsSave').addEventListener('click', async () => {
  settings.baseUrl = $('#setBaseUrl').value.trim();
  settings.apiKey = $('#setApiKey').value.trim();
  settings.model = $('#setModel').value.trim();
  settings.permission = $('#setPermission').value;
  settings.workspace = $('#setWorkspace').value.trim();
  await api.saveSettings(settings);
  updateTopbar();
  closeSettings();
});
$('#pickWsBtn').addEventListener('click', async () => {
  const p = await api.pickWorkspace();
  if (p) $('#setWorkspace').value = p;
});
$('#workspaceBox').addEventListener('click', async () => {
  const p = await api.pickWorkspace();
  if (p) {
    settings.workspace = p;
    await api.saveSettings(settings);
    updateTopbar();
  }
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener('input', autoResize);

welcome.querySelectorAll('.w-step').forEach((el) => {
  el.addEventListener('click', async () => {
    const act = el.dataset.act;
    if (act === 'workspace') {
      const p = await api.pickWorkspace();
      if (p) {
        settings.workspace = p;
        await api.saveSettings(settings);
        updateTopbar();
      }
    } else if (act === 'settings') {
      openSettings();
    } else {
      inputEl.focus();
    }
  });
});
welcome.querySelectorAll('.chip').forEach((el) => {
  el.addEventListener('click', () => {
    inputEl.value = el.dataset.prompt;
    autoResize();
    inputEl.focus();
  });
});

// ---------------- 初始化 ----------------
(async function init() {
  const saved = await api.loadSettings();
  settings = { ...settings, ...saved };
  try { sessions = JSON.parse(localStorage.getItem('mz_sessions') || '[]'); } catch { sessions = []; }
  if (!Array.isArray(sessions)) sessions = [];
  if (sessions.length) currentId = sessions[0].id;
  else newSession();
  renderSessions();
  updateTopbar();
  renderConversation();
  if (!settings.baseUrl) openSettings();
})();
