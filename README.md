# MiniZCode · 类 ZCode 的桌面 AI 编程助手

一个用 **Electron** 实现的桌面 AI 编程助手，核心能力和 ZCode 类似：给它一个任务，它会自动浏览文件、读写代码、执行命令，直到完成任务。

## 功能

- 💬 聊天界面：流式输出、Markdown 渲染、代码块复制按钮
- 🛠 Agent 工具调用：
  - `list_dir` 浏览目录
  - `read_file` 读取文件
  - `write_file` 创建/修改文件
  - `run_command` 执行 shell 命令（超时 120 秒）
- 🔐 权限模式：默认「写文件 / 执行命令前需要人工确认」，可在设置中切为自动执行
- 📁 工作目录：选择一个文件夹作为 AI 的工作区
- 🗂 多会话管理，本地自动保存
- 🔌 兼容任何 OpenAI Chat Completions 接口（智谱 GLM / DeepSeek / OpenAI / 本地 Ollama 等）

## 运行

```bash
cd mini-zcode
npm install
npm start
```

> 国内网络已配置 `.npmrc` 使用 npmmirror 镜像，Electron 二进制下载更稳。

## 配置

首次启动会弹出设置窗口：

| 配置项 | 说明 |
| --- | --- |
| API Base URL | OpenAI 兼容接口地址，如 `https://open.bigmodel.cn/api/paas/v4` |
| API Key | 对应平台的密钥 |
| 模型名称 | 如 `glm-4.6`、`deepseek-chat`、`gpt-4o` |
| 权限模式 | `需要确认`（推荐） / `自动执行` |
| 工作目录 | AI 读写文件、执行命令的根目录 |

常用接口地址：
- 智谱：`https://open.bigmodel.cn/api/paas/v4`
- DeepSeek：`https://api.deepseek.com`
- OpenAI：`https://api.openai.com/v1`
- 本地 Ollama：`http://127.0.0.1:11434/v1`（Key 随便填）

## 安全提示

- `run_command` 会在你的电脑上真实执行命令，默认权限模式下每次执行前都会弹出确认卡片。
- 请勿在「自动执行」模式下给 AI 下达来源不明的任务。

## 项目结构

```
mini-zcode/
├── main.js            # Electron 主进程：窗口、IPC、Agent 循环、工具执行
├── preload.js         # 渲染进程安全桥（contextBridge）
├── renderer/
│   ├── index.html     # 界面
│   ├── style.css      # 暗色主题样式
│   └── renderer.js    # 聊天 UI、会话管理、工具卡片、确认交互
└── package.json
```

## 后续可扩展

- 打包安装程序（`electron-builder`）
- diff 视图 / 文件树面板
- 会话导出、历史搜索
- MCP 工具接入
