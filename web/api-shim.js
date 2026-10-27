/* MiniZCode Web 演示版 —— 浏览器端 api 实现（无文件/命令工具，仅对话） */
(function () {
  const listeners = [];
  let controller = null;

  function emit(type, data) {
    for (const cb of listeners) cb({ type, ...data });
  }

  async function loadSettings() {
    try { return JSON.parse(localStorage.getItem('mz_web_settings') || '{}'); } catch { return {}; }
  }

  async function saveSettings(s) {
    localStorage.setItem('mz_web_settings', JSON.stringify(s));
    return true;
  }

  async function pickWorkspace() { return null; }
  function respondApproval() {}
  function stopAgent() { if (controller) controller.abort(); }
  function onAgentEvent(cb) { listeners.push(cb); }

  async function runAgent({ messages, settings }) {
    controller = new AbortController();
    const baseUrl = String((settings && settings.baseUrl) || '').replace(/\/+$/, '');
    const apiKey = (settings && settings.apiKey) || '';
    const model = (settings && settings.model) || 'glm-4.6';
    if (!baseUrl) return { ok: false, error: '未配置 API Base URL，请打开设置填写' };

    const sys =
      '你是 MiniZCode Web 演示版，一个 AI 编程助手。当前运行在浏览器中：' +
      '无法访问本地文件系统和命令行，不能读写文件或执行命令，请据此如实回答。' +
      '用简体中文，简洁清晰，代码用 markdown 代码块并标注语言。';

    try {
      const res = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: sys }, ...messages],
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return { ok: false, error: `API 返回 ${res.status}：${t.slice(0, 300)}` };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let content = '';

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
          const delta = j.choices && j.choices[0] && j.choices[0].delta;
          if (delta && typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            emit('text-delta', { text: delta.content });
          }
        }
      }

      return { ok: true, messages: [...messages, { role: 'assistant', content }] };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, aborted: true, error: '已停止' };
      return { ok: false, error: String((e && e.message) || e) + '（提示：浏览器直连 API 需要该接口支持 CORS）' };
    }
  }

  window.api = { loadSettings, saveSettings, pickWorkspace, runAgent, stopAgent, respondApproval, onAgentEvent };
})();
