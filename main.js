const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn } = require('child_process');

app.disableHardwareAcceleration();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#14161d',
    title: 'MiniZCode · AI 编程助手',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  console.log('[MiniZCode] window ready');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

process.on('uncaughtException', (e) => console.error('[MiniZCode] uncaught:', e));
process.on('unhandledRejection', (e) => console.error('[MiniZCode] unhandled:', e));

// ---------------- 设置 ----------------
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

ipcMain.handle('settings:load', async () => {
  try {
    return JSON.parse(await fsp.readFile(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
});

ipcMain.handle('settings:save', async (_e, s) => {
  await fsp.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fsp.writeFile(settingsFile(), JSON.stringify(s, null, 2), 'utf8');
  return true;
});

ipcMain.handle('dialog:pickWorkspace', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择工作目录',
    properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// ---------------- 工具定义 ----------------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出工作目录（或其子目录）下的文件和文件夹',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的路径，默认为 "."' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作目录下某个文本文件的内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（相对工作目录或绝对路径）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建或覆盖工作目录下的一个文件（写入完整内容）。修改已有文件时，先 read_file 再整体重写。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '完整的文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在工作目录中执行一条 shell 命令并返回 stdout/stderr 输出（超时 120 秒）',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
        },
        required: ['command'],
      },
    },
  },
];

function trunc(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n) + `\n...[输出过长，已截断，共 ${s.length} 字符]`;
}

function resolveInWorkspace(ws, p) {
  if (!p || typeof p !== 'string') throw new Error('缺少 path 参数');
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(ws, p);
}

async function runTool(name, args, workspace) {
  try {
    if (name === 'list_dir') {
      const target = resolveInWorkspace(workspace, args.path || '.');
      const dirents = await fsp.readdir(target, { withFileTypes: true });
      if (!dirents.length) return `(空目录) ${target}`;
      const lines = [];
      for (const d of dirents.slice(0, 500)) {
        if (d.isDirectory()) {
          lines.push(d.name + '/');
        } else {
          let size = '';
          try {
            size = '  (' + (await fsp.stat(path.join(target, d.name))).size + ' B)';
          } catch {}
          lines.push(d.name + size);
        }
      }
      if (dirents.length > 500) lines.push(`...共 ${dirents.length} 项，仅显示前 500 项`);
      return `目录 ${target}\n` + lines.join('\n');
    }

    if (name === 'read_file') {
      const target = resolveInWorkspace(workspace, args.path);
      const st = await fsp.stat(target);
      if (st.isDirectory()) return `错误：${target} 是一个目录，请用 list_dir 浏览`;
      if (st.size > 512 * 1024) return `错误：文件过大（${st.size} 字节），请用 run_command 分段查看`;
      const content = await fsp.readFile(target, 'utf8');
      return trunc(content, 60000);
    }

    if (name === 'write_file') {
      const target = resolveInWorkspace(workspace, args.path);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, args.content ?? '', 'utf8');
      return `已写入 ${String(args.content ?? '').length} 字符 -> ${target}`;
    }

    if (name === 'run_command') {
      const command = String(args.command || '');
      return await new Promise((resolve) => {
        const child = spawn(command, { shell: true, cwd: workspace, env: process.env });
        let out = '';
        const limit = 100000;
        child.stdout.on('data', (d) => { if (out.length < limit) out += d; });
        child.stderr.on('data', (d) => { if (out.length < limit) out += d; });
        const timer = setTimeout(() => {
          try { child.kill(); } catch {}
        }, 120000);
        child.on('error', (e) => {
          clearTimeout(timer);
          resolve(`错误：无法执行命令：${e.message}`);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(trunc(`$ ${command}\n[退出码 ${code}]\n${out}`, 30000));
        });
      });
    }

    return `错误：未知工具 ${name}`;
  } catch (e) {
    return `错误：${e.message}`;
  }
}

// ---------------- Agent 主循环 ----------------
function systemPrompt(workspace) {
  return [
    '你是 MiniZCode，一个运行在用户电脑上的 AI 编程助手（类似 ZCode / Claude Code 的桌面应用）。',
    `当前工作目录：${workspace}`,
    `操作系统：${process.platform}（Windows 上命令默认通过 cmd 执行）`,
    '',
    '你可以使用工具：list_dir 浏览目录、read_file 读文件、write_file 写文件、run_command 执行命令。',
    '规则：',
    '1. 涉及项目文件的问题，先用工具查看真实文件，不要凭空猜测。',
    '2. 写代码时用 write_file 直接创建/修改文件；改已有文件前先 read_file 再整体重写。',
    '3. 需要验证时用 run_command 运行测试或脚本。',
    '4. 回答使用简体中文，简洁、结构清晰；代码用 markdown 代码块并标注语言。',
    '5. 危险操作（删除、覆盖大量文件等）前先向用户说明你要做什么。',
  ].join('\n');
}

const running = new Map(); // sender.id -> { abort, approvals, aborted }

function abortErr() {
  const e = new Error('已停止');
  e.name = 'AbortError';
  return e;
}

ipcMain.handle('agent:run', async (event, payload) => {
  const { messages, settings } = payload || {};
  const sender = event.sender;
  const state = { abort: new AbortController(), approvals: new Map(), aborted: false };
  running.set(sender.id, state);
  try {
    const result = await runAgentLoop(sender, state, Array.isArray(messages) ? messages : [], settings || {});
    return { ok: true, messages: result };
  } catch (err) {
    const aborted = state.aborted || (err && err.name === 'AbortError');
    return { ok: false, aborted, error: String((err && err.message) || err) };
  } finally {
    running.delete(sender.id);
  }
});

ipcMain.on('agent:stop', (e) => {
  const s = running.get(e.sender.id);
  if (!s) return;
  s.aborted = true;
  try { s.abort.abort(); } catch {}
  for (const r of s.approvals.values()) r(false);
  s.approvals.clear();
});

ipcMain.on('agent:approval', (e, { id, ok }) => {
  const s = running.get(e.sender.id);
  const r = s && s.approvals.get(id);
  if (r) {
    s.approvals.delete(id);
    r(!!ok);
  }
});

async function runAgentLoop(sender, state, history, settings) {
  const workspace = settings.workspace || os.homedir();
  const baseUrl = String(settings.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('未配置 API Base URL，请打开设置填写');
  const apiKey = settings.apiKey || '';
  const model = settings.model || 'glm-4.6';
  const permission = settings.permission || 'ask';

  const send = (type, data = {}) => {
    if (!sender.isDestroyed()) sender.send('agent:event', { type, ...data });
  };

  const messages = history.map((m) => m);
  const maxRounds = 30;

  let round = 0;
  for (; round < maxRounds; round++) {
    if (state.aborted) throw abortErr();

    const body = {
      model,
      messages: [{ role: 'system', content: systemPrompt(workspace) }, ...messages],
      tools: TOOLS,
      stream: true,
    };

    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: state.abort.signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`API 返回 ${res.status}：${trunc(t, 500)}`);
    }

    // 解析 SSE 流
    let content = '';
    let finish = '';
    const toolCalls = new Map();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        const choice = j.choices && j.choices[0];
        const delta = choice && choice.delta;
        if (!delta) continue;
        const dText = typeof delta.content === 'string'
          ? delta.content
          : Array.isArray(delta.content) ? delta.content.map((p) => p.text || '').join('') : '';
        if (dText) {
          content += dText;
          send('text-delta', { text: dText });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const cur = toolCalls.get(tc.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) cur.id = tc.id;
            if (tc.function) {
              if (tc.function.name) cur.function.name += tc.function.name;
              if (tc.function.arguments) cur.function.arguments += tc.function.arguments;
            }
            toolCalls.set(tc.index, cur);
          }
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }

    if (state.aborted) throw abortErr();

    if (!content && toolCalls.size === 0) {
      if (finish) break;
      throw new Error('模型未返回任何内容');
    }

    if (toolCalls.size === 0) {
      // 最终回答
      messages.push({ role: 'assistant', content });
      break;
    }

    // 有工具调用：执行它们
    const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    const assistantMsg = { role: 'assistant', content: content || null, tool_calls: calls };
    messages.push(assistantMsg);
    send('assistant-message', { message: assistantMsg });

    for (const call of calls) {
      if (state.aborted) throw abortErr();
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}

      const needsApproval =
        permission !== 'auto' && (call.function.name === 'run_command' || call.function.name === 'write_file');

      let denied = false;
      if (needsApproval) {
        const approvalId = 'ap_' + Math.random().toString(36).slice(2, 10);
        send('approval-request', { id: approvalId, tool: call.function.name, args });
        denied = !(await new Promise((resolve) => state.approvals.set(approvalId, resolve)));
        if (state.aborted) throw abortErr();
      }

      let result;
      if (denied) {
        result = '用户拒绝了该操作。请询问用户或尝试其他方案。';
      } else {
        result = await runTool(call.function.name, args, workspace);
      }

      const ok = !denied && !String(result).startsWith('错误：');
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      send('tool-result', { toolCallId: call.id, ok, denied, result: trunc(result, 20000) });
    }
    // 继续下一轮，让模型根据工具结果继续
  }

  if (round >= maxRounds) {
    messages.push({ role: 'assistant', content: '（已达到单次任务的最大工具调用轮数，本次到此为止。可以继续对话让接着做。）' });
  }

  return messages;
}
