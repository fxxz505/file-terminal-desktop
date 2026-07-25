import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { check, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import './styles.css';

type RuntimeStatus = { modelInstalled: boolean; runtimeInstalled: boolean; modelPath: string };
type Result = { id: string; itemType: string; name: string; path: string; note: string; tags: string[]; score: number };
type DownloadProgress = { kind: 'model' | 'runtime'; completed: number; total?: number };
type FilePreview = { kind: 'image' | 'text' | 'pdf' | 'folder' | 'unsupported'; name: string; path: string; mimeType: string; content: string; message: string; truncated: boolean };
type View = 'workspace' | 'search' | 'assistant';

const app = document.querySelector<HTMLDivElement>('#app')!;
let status: RuntimeStatus = { modelInstalled: false, runtimeInstalled: false, modelPath: '' };
let results: Result[] = [];
let progress: DownloadProgress | null = null;
let preview: FilePreview | null = null;
let error = '';
let isWorking = false;
let activeView: View = 'workspace';
let searchQuery = '';
let updateVersion = '';
let updateProgress: DownloadProgress | null = null;

const icon = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${name}"/></svg>`;
const icons = {
  mark: icon('M5 3.75h9.25A2.75 2.75 0 0 1 17 6.5v11.75A2.75 2.75 0 0 1 14.25 21H5a2 2 0 0 1-2-2V5.75a2 2 0 0 1 2-2Zm1.5 4.5h7m-7 4h7m-7 4h4'),
  folder: icon('M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3l1.5 1.75h7.25A2.5 2.5 0 0 1 20.25 8.75v7.5a2.5 2.5 0 0 1-2.5 2.5H6a2.25 2.25 0 0 1-2.25-2.25v-9.75Z'),
  search: icon('m20 20-4.35-4.35m1.85-4.4a6.25 6.25 0 1 1-12.5 0 6.25 6.25 0 0 1 12.5 0Z'),
  spark: icon('m12 3 1.45 5.55L19 10l-5.55 1.45L12 17l-1.45-5.55L5 10l5.55-1.45L12 3Zm6.5 12.5.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z'),
  download: icon('M12 3.5v10m0 0 3.5-3.5M12 13.5 8.5 10M5 17.5v1.25A1.75 1.75 0 0 0 6.75 20.5h10.5A1.75 1.75 0 0 0 19 18.75V17.5'),
  check: icon('m5 12.5 4.25 4.25L19.5 6.5'),
  file: icon('M6 3.5h7L18 8v12.5H6zM13 3.5V8h5'),
};

function bytes(value = 0) { return value ? `${(value / 1024 / 1024).toFixed(value > 1024 * 1024 * 1024 ? 0 : 1)} MB` : '等待下载'; }
function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]!)); }
function stateChip(ready: boolean, waiting: string, readyText: string) { return `<span class="state setup-state ${ready ? 'ready' : ''}">${ready ? readyText : waiting}</span>`; }

function resultRows(empty: string) {
  return results.length ? `<div class="results">${results.map(result => `<button class="result preview-file" data-path="${escapeHtml(result.path)}"><span>${result.itemType === 'folder' ? icons.folder : icons.file}</span><b>${escapeHtml(result.name)}</b><small>${escapeHtml(result.path)}</small><em>匹配 ${result.score}</em></button>`).join('')}</div>` : `<div class="result-placeholder">${empty}</div>`;
}

function previewPanel() {
  if (!preview) return '';
  const body = preview.kind === 'image' ? `<img src="data:${preview.mimeType};base64,${preview.content}" alt="${escapeHtml(preview.name)}">`
    : preview.kind === 'pdf' ? `<iframe title="${escapeHtml(preview.name)}" src="data:application/pdf;base64,${preview.content}"></iframe>`
      : preview.kind === 'text' ? `<pre>${escapeHtml(preview.content)}</pre>` : `<p>${escapeHtml(preview.message)}</p>`;
  return `<section class="file-preview"><header><div><small>LOCAL PREVIEW</small><h2>${escapeHtml(preview.name)}</h2><span>${escapeHtml(preview.path)}</span></div><div><button class="quiet" id="reveal-file">在资源管理器中打开</button><button class="quiet" id="close-preview">关闭</button></div></header><div class="preview-body">${body}</div></section>`;
}

function searchPanel() {
  return `<section class="single-panel panel"><header><div><small>LOCAL SEARCH</small><h2>本地搜索</h2></div><span class="local-chip">${icons.check} 只检索本机索引</span></header><div class="search-page"><h1>精确查找你的资料。</h1><p>输入名称、路径、备注或标签；搜索结果来自本地 SQLite 索引。</p><form id="search-form"><div class="large-search">${icons.search}<input id="search-question" value="${escapeHtml(searchQuery)}" placeholder="例如：游戏、Steam、项目资料"><button type="submit" ${isWorking ? 'disabled' : ''}>搜索</button></div></form>${resultRows('输入检索词后，结果会在这里显示真实路径。')}</div></section>`;
}

function assistantPanel() {
  return `<section class="single-panel panel"><header><div><small>LOCAL AI</small><h2>AI 助手</h2></div><span class="local-chip">${icons.check} 本机推理</span></header><div class="assistant-page"><div class="assistant-intro"><span>${icons.spark}</span><div><h1>问资料助手</h1><p>AI 只理解你的问题；资料匹配、路径和标签都来自本地索引。</p></div></div><form id="ask-form"><label>你想找什么？<div class="ask-row"><input id="question" value="现在想要玩游戏" maxlength="180" placeholder="例如：现在想要玩游戏"><button ${isWorking ? 'disabled' : ''} type="submit">${icons.spark} 查找</button></div></label></form>${resultRows('例如输入“现在想要玩游戏”，助手会找出带有游戏标签、备注或路径的资料。')}</div></section>`;
}

function workspacePanel() {
  const percent = progress?.total ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;
  const modelState = stateChip(status.modelInstalled, '未安装', '已安装');
  const runtimeState = stateChip(status.runtimeInstalled, '待下载', '已就绪');
  return `<section class="workspace-view"><div class="workspace-head"><div><p>本地资料管理</p><h1>把文件夹交给一个真正本地的助手。</h1><span>拖入或选择文件夹，添加备注和标签。AI 只根据本地索引给出可验证的结果。</span></div><div class="privacy"><b>${icons.check} 数据边界</b><span>不上传原始文件，不移动或删除资料。</span></div></div><section class="desk-grid"><section class="file-panel panel"><header><div><small>FOLDER TERMINAL</small><h2>已接入的资料</h2></div><button class="quiet" id="refresh">刷新状态</button></header><div class="empty-folder"><span>${icons.folder}</span><strong>选择一个文件夹开始</strong><p>桌面端会原位建立目录索引，保留空目录和层级，后续可持续增量扫描。</p><button class="outline" id="choose-folder">选择本机文件夹</button></div></section><section class="assistant panel"><header><div><small>LOCAL AI</small><h2>助手快捷入口</h2></div><span class="local-chip">${icons.check} 本机</span></header><div class="assistant-body"><div class="question">现在想要玩游戏</div><p class="assistant-copy">它会检索所有带有“游戏”标签或备注的资料，结果始终附带真实路径。</p><button class="primary" data-view="assistant">${icons.spark} 打开 AI 助手</button></div></section></section><section class="setup panel"><div class="setup-heading"><div><small>AI INITIALIZATION</small><h2>应用内完成本地模型准备</h2><p>无需 LM Studio、Ollama 或账号。资料终端将下载运行时与默认中文轻量模型到自己的应用数据目录。</p></div><div class="ready-summary">${status.runtimeInstalled && status.modelInstalled ? `${icons.check} 助手已可用` : '还差一步即可启用'}</div></div><div class="setup-grid"><article><div class="setup-icon">${icons.download}</div><div class="setup-copy"><b>1. 本地推理运行时</b><span>llama.cpp Windows CPU 引擎</span></div>${runtimeState}<button class="quiet setup-button" id="download-runtime" ${isWorking || status.runtimeInstalled ? 'disabled' : ''}>下载</button></article><article><div class="setup-icon">${icons.spark}</div><div class="setup-copy"><b>2. 默认中文模型</b><span>Qwen2.5 1.5B Instruct · Q4_K_M</span></div>${modelState}<button class="primary setup-button" id="download-model" ${isWorking || status.modelInstalled ? 'disabled' : ''}>下载并启用</button></article></div>${progress ? `<div class="progress"><div><b>${progress.kind === 'model' ? '正在下载 Qwen2.5 1.5B 模型' : '正在下载本地推理运行时'}</b><span>${percent ? `${percent}% · ${bytes(progress.completed)} / ${bytes(progress.total)}` : bytes(progress.completed)}</span></div><i><span style="width:${percent}%"></span></i></div>` : ''}</section></section>`;
}

function render() {
  const pages: Record<View, { title: string; subtitle: string; content: string }> = {
    workspace: { title: '资料空间', subtitle: '原文件留在原位置 · 索引存于本机', content: workspacePanel() },
    search: { title: '本地搜索', subtitle: '按名称、路径、备注和标签查询', content: searchPanel() },
    assistant: { title: 'AI 助手', subtitle: '理解问题后，以本地索引给出结果', content: assistantPanel() },
  };
  const page = pages[activeView];
  app.innerHTML = `<aside class="sidebar"><div class="brand"><span class="brand-mark">${icons.mark}</span><span>资料终端<small>LOCAL FILE ASSISTANT</small></span></div><nav><button class="nav ${activeView === 'workspace' ? 'active' : ''}" data-view="workspace">${icons.folder}<span>资料空间</span></button><button class="nav ${activeView === 'search' ? 'active' : ''}" data-view="search">${icons.search}<span>本地搜索</span></button><button class="nav ${activeView === 'assistant' ? 'active' : ''}" data-view="assistant">${icons.spark}<span>AI 助手</span></button></nav><div class="sidebar-foot"><span class="online-dot"></span><span>仅在本机运行</span></div></aside><main><header class="topbar"><div><strong>${page.title}</strong><span>${page.subtitle}</span></div><button class="import" id="import-folder">${icons.folder} 接入文件夹</button></header><section class="canvas">${page.content}${previewPanel()}${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}</section></main>`;
  bind();
}

async function refreshStatus() { status = await invoke<RuntimeStatus>('get_runtime_status'); render(); }
async function selectFolder() {
  const selected = await open({ directory: true, multiple: false, title: '选择要接入的文件夹' });
  if (!selected || Array.isArray(selected)) return;
  const note = window.prompt('为这个文件夹添加备注（可留空）：') ?? '';
  const tagText = window.prompt('添加标签，用逗号分隔（可留空）：') ?? '';
  isWorking = true; error = ''; render();
  try { const indexed = await invoke<number>('import_folder', { input: { path: selected, note, tags: tagText.split(',').map(tag => tag.trim()).filter(Boolean) } }); window.alert(`已在原位置接入文件夹，并建立 ${indexed} 项本地索引。`); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function provision(kind: 'runtime' | 'model') { isWorking = true; error = ''; progress = { kind, completed: 0 }; render(); try { status = await invoke<RuntimeStatus>(kind === 'runtime' ? 'download_runtime' : 'download_model'); } catch (reason) { error = String(reason); } finally { isWorking = false; progress = null; render(); } }
async function ask(question: string) { isWorking = true; error = ''; render(); try { results = await invoke<Result[]>('ask_assistant', { question }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function loadPreview(path: string) { if (!path) return; isWorking = true; error = ''; render(); try { preview = await invoke<FilePreview>('preview_file', { path }); } catch (reason) { error = `无法预览文件：${String(reason)}`; } finally { isWorking = false; render(); } }
async function revealPreview() { if (!preview) return; try { await invoke('reveal_in_explorer', { path: preview.path }); } catch (reason) { error = `无法打开资源管理器：${String(reason)}`; render(); } }
async function checkForUpdate() {
  try {
    const update = await check();
    updateVersion = update?.version ?? '';
    if (updateVersion && window.confirm(`发现 ${updateVersion} 新版本。现在下载并自动安装吗？`)) await installUpdate();
  } catch (reason) {
    console.warn('Update check skipped:', reason);
  }
}

async function installUpdate() {
  isWorking = true;
  error = '';
  updateProgress = { kind: 'runtime', completed: 0 };
  render();
  try {
    const update = await check();
    if (!update) {
      updateVersion = '';
      return;
    }
    let total = 0;
    let completed = 0;
    await update.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0;
      if (event.event === 'Progress') completed += event.data.chunkLength;
      updateProgress = { kind: 'runtime', completed, total: total || undefined };
    });
    await relaunch();
  } catch (reason) {
    error = `Update failed: ${String(reason)}`;
  } finally {
    isWorking = false;
    updateProgress = null;
    render();
  }
}

function bind() {
  document.querySelectorAll<HTMLElement>('.preview-file').forEach(button => button.addEventListener('click', () => loadPreview(button.dataset.path ?? '')));
  document.querySelector('#close-preview')?.addEventListener('click', () => { preview = null; render(); });
  document.querySelector('#reveal-file')?.addEventListener('click', revealPreview);
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(button => button.addEventListener('click', () => { activeView = button.dataset.view as View; render(); }));
  document.querySelector('#import-folder')?.addEventListener('click', selectFolder); document.querySelector('#choose-folder')?.addEventListener('click', selectFolder); document.querySelector('#refresh')?.addEventListener('click', refreshStatus); document.querySelector('#download-runtime')?.addEventListener('click', () => provision('runtime')); document.querySelector('#download-model')?.addEventListener('click', () => provision('model'));
  document.querySelector('#install-update')?.addEventListener('click', installUpdate);
  document.querySelector<HTMLFormElement>('#ask-form')?.addEventListener('submit', event => { event.preventDefault(); const question = document.querySelector<HTMLInputElement>('#question')?.value.trim() ?? ''; if (question) ask(question); });
  document.querySelector<HTMLFormElement>('#search-form')?.addEventListener('submit', event => { event.preventDefault(); const question = document.querySelector<HTMLInputElement>('#search-question')?.value.trim() ?? ''; searchQuery = question; if (question) ask(question); });
}

listen<DownloadProgress>('download-progress', event => { progress = event.payload; render(); }).catch(reason => { error = `无法接收下载进度：${String(reason)}`; render(); });
refreshStatus().catch(reason => { error = `无法连接桌面端：${String(reason)}`; render(); });

checkForUpdate();
