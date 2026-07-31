import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { check, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import './styles.css';

type RuntimeStatus = { modelInstalled: boolean; runtimeInstalled: boolean; modelPath: string; activeModelName: string };
type CloudPolicy = 'local_only' | 'cloud_allowed' | 'ask_each_time' | 'inherit';
type Result = { id: string; itemType: string; name: string; path: string; displayPath: string; note: string; tags: string[]; cloudPolicy: CloudPolicy; score: number };
type SearchDocumentsResult = { items: Result[]; total: number; page: number; pageSize: number; searchMode: 'fts' | 'semantic' | 'embedding_fallback_fts' };
type EmbeddingModel = { id: string; displayName: string; path: string; active: boolean; dimensions?: number };
type EmbeddingIndexProgress = { completed: number; total: number; failed: number };
type FolderRef = { id: string; name: string; path: string; displayPath: string; note: string; tags: string[]; cloudPolicy: CloudPolicy; itemCount: number; sourceStatus: 'available' | 'missing' };
type FolderEntry = { id: string; name: string; path: string; displayPath: string; itemType: 'folder' | 'file'; note: string; tags: string[]; cloudPolicy: CloudPolicy };
type MetadataTarget = { targetType: 'folder' | 'item'; targetId: string; name: string; note: string; tags: string[]; cloudPolicy: CloudPolicy };
type AiOutputTarget = { workspaceId: string; path: string; displayPath: string; isAppWorkspace: boolean };
type DownloadProgress = { kind: 'model' | 'runtime'; source?: string; completed: number; total?: number };
type FilePreview = { kind: 'image' | 'text' | 'pdf' | 'folder' | 'unsupported'; name: string; path: string; displayPath: string; mimeType: string; content: string; message: string; truncated: boolean };
type Thumbnail = { itemId: string; sourceSignature: string; mimeType: string; content: string; cached: boolean };
type MediaTask = { id: string; itemId: string; name: string; kind: 'ocr' | 'transcription'; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; error?: string; createdAt: string; updatedAt: string };
type MediaSettings = { whisperModelPath: string; ocrLanguage: string };
type LocalToolStatus = { pdfText: boolean; ffmpeg: boolean; ocr: boolean; transcription: boolean; officeConverter: boolean };
type CloudProviderConfig = { providerId: string; displayName: string; baseUrl: string; model: string; autoCollaboration: boolean; reviewEachRequest: boolean; configured: boolean };
type CloudModel = { id: string };
type ParsedReply = { answer: string; steps: string[]; codeBlocks: number };
type Conversation = { id: string; title: string; providerId?: string; updatedAt: string };
type ConversationMessage = { id: string; conversationId: string; role: 'user' | 'assistant' | 'system'; source: 'local' | 'cloud' | 'system'; content: string; parsedReply?: ParsedReply; createdAt: string };
type SourceCitation = { id: string; name: string; path: string; displayPath: string; reason: string };
type CloudAdvice = { answer: string; assumptions: string[]; files: Array<{ pathHint: string; content: string; purpose: string }>; steps: Array<{ id: string; instruction: string; requestedTool?: string; risk: string }>; uncertainties: string[] };
type AgentRun = { id: string; route: 'local' | 'cloud_auto' | 'cloud_needs_confirmation' | 'blocked'; reason: string; providerId?: string; cloudSentAutomatically: boolean; sourceCount: number; restrictedSourceCount: number; redactionCount: number; status: string; packagePreview: string; requestPreview: string; feedback: string; advice?: string; cloudAdvice?: CloudAdvice; sourceCitations: SourceCitation[]; conversationId?: string };
type WorkspaceActionResult = { status: string; writtenFiles: string[]; output: string };
type SensitiveRule = { id: string; name: string; pattern: string; enabled: boolean };
type AgentEvent = { id: string; runId: string; status: string; message: string; createdAt: string };
type GovernanceExport = { exportedAt: string; conversations: Conversation[]; sensitiveRules: SensitiveRule[]; metadataAuditCount: number; agentEventCount: number };
type LocalModel = { id: string; displayName: string; path: string; active: boolean };
type IndexProgress = { folderId: string; phase: string; completed: number; total: number };
type IndexJob = { id: string; folderId: string; status: 'queued' | 'running' | 'paused' | 'failed' | 'completed'; completed: number; total: number; changed: number; createdAt: string; updatedAt: string; error?: string };
type FolderChangeDetected = { folderId: string; changedAt: string };
type AgentPreferences = { autoApplyLowRisk: boolean };
type PrivacyStatus = { databaseEncrypted: boolean; message: string; recommendation: string };
type RuntimeSettings = { executionMode: 'auto' | 'cpu' | 'gpu'; threads: number; contextSize: number };
type AcceptanceCheck = { id: string; label: string; status: 'passed' | 'failed' | 'manual' | 'skipped'; detail: string };
type AgentEvidenceReport = { runId: string; status: string; finalEvidence: string[]; restrictedBindings: number };
type EncryptedBackup = { path: string; displayPath: string; createdAt: string; databaseBytes: number };
type SensitiveFinding = { itemId: string; name: string; displayPath: string; category: string; matchCount: number };
type MetadataAuditEntry = { id: string; targetType: string; targetId: string; action: string; oldPolicy?: string; newPolicy?: string; createdAt: string };
type View = 'workspace' | 'search' | 'assistant' | 'conversations';

const app = document.querySelector<HTMLDivElement>('#app')!;
let status: RuntimeStatus = { modelInstalled: false, runtimeInstalled: false, modelPath: '', activeModelName: '默认模型' };
let results: Result[] = [];
let folderRefs: FolderRef[] = [];
let activeFolder: FolderRef | null = null;
let browserPath: string | null = null;
let browserHistory: string[] = [];
let folderEntries: FolderEntry[] = [];
let progress: DownloadProgress | null = null;
let preview: FilePreview | null = null;
let error = '';
let isWorking = false;
let activeView: View = 'workspace';
let searchQuery = '';
let updateVersion = '';
let updateProgress: DownloadProgress | null = null;
let contextTarget: MetadataTarget | null = null;
let contextPosition = { x: 0, y: 0 };
let aiOutputFolder: string | null = null;
let aiOutputTarget: AiOutputTarget | null = null;
let cloudConfig: CloudProviderConfig | null = null;
let cloudProviders: CloudProviderConfig[] = [];
let cloudModels: CloudModel[] = [];
let agentRun: AgentRun | null = null;
let conversations: Conversation[] = [];
let activeConversationId: string | null = null;
let conversationMessages: ConversationMessage[] = [];
let sensitiveRules: SensitiveRule[] = [];
let workspaceAction: WorkspaceActionResult | null = null;
let agentEvents: AgentEvent[] = [];
let governanceExport: GovernanceExport | null = null;
let localModels: LocalModel[] = [];
let indexProgress: IndexProgress | null = null;
let indexJobs: IndexJob[] = [];
let searchPage = 0;
let searchTotal = 0;
let searchFilter = '';
let searchFolderFilter = '';
let searchTypeFilter = '';
let searchMode: 'fts' | 'semantic' = 'fts';
let appliedSearchMode: SearchDocumentsResult['searchMode'] = 'fts';
let embeddingModels: EmbeddingModel[] = [];
let embeddingProgress: EmbeddingIndexProgress | null = null;
let agentPreferences: AgentPreferences = { autoApplyLowRisk: false };
let privacyStatus: PrivacyStatus | null = null;
let recoveryNotice: string | null = null;
let encryptedBackup: EncryptedBackup | null = null;
let sensitiveFindings: SensitiveFinding[] = [];
let auditEntries: MetadataAuditEntry[] = [];
let runtimeSettings: RuntimeSettings = { executionMode: 'auto', threads: 4, contextSize: 4096 };
let acceptanceChecks: AcceptanceCheck[] = [];
let agentEvidenceReport: AgentEvidenceReport | null = null;
let mediaGalleryOpen = false;
let mediaThumbnails = new Map<string, Thumbnail>();
let mediaTasks: MediaTask[] = [];
let mediaSettings: MediaSettings = { whisperModelPath: '', ocrLanguage: 'chi_sim+eng' };
let localTools: LocalToolStatus = { pdfText: true, ffmpeg: false, ocr: false, transcription: false, officeConverter: false };
let formWarning: { target: 'cloud' | 'media' | 'rules'; message: string } | null = null;
const folderRefreshTimers = new Map<string, number>();
let embeddingUpdateTimer: number | null = null;

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
function displayPath(value: string) { return value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, ''); }
function stateChip(ready: boolean, waiting: string, readyText: string) { return `<span class="state setup-state ${ready ? 'ready' : ''}">${ready ? readyText : waiting}</span>`; }
function cloudPolicyLabel(policy: CloudPolicy) { return ({ local_only: '云端：禁止上传', cloud_allowed: '云端：允许上传', ask_each_time: '云端：每次询问', inherit: '云端：禁止上传' } as const)[policy]; }
function metadataLine(tags: string[], policy: CloudPolicy) { return `<div class="metadata-line"><span>${tags.length ? `标签：${tags.map(escapeHtml).join('，')}` : '标签：无'}</span><b class="cloud-policy ${policy}">${cloudPolicyLabel(policy)}</b></div>`; }

function resultRows(empty: string) {
  return results.length ? `<div class="results">${results.map(result => `<button class="result preview-file metadata-target" data-target-type="item" data-target-id="${escapeHtml(result.id)}" data-note="${escapeHtml(result.note)}" data-tags="${escapeHtml(JSON.stringify(result.tags))}" data-cloud-policy="${result.cloudPolicy}" data-name="${escapeHtml(result.name)}" data-path="${escapeHtml(result.path)}"><span>${result.itemType === 'folder' ? icons.folder : icons.file}</span><b>${escapeHtml(result.name)}</b><small>${escapeHtml(result.displayPath)}</small><em>匹配 ${result.score}</em>${metadataLine(result.tags, result.cloudPolicy)}</button>`).join('')}</div>` : `<div class="result-placeholder">${empty}</div>`;
}

function sourceCitations(citations: SourceCitation[]) {
  return citations.length ? `<div class="source-citations"><b>本地证据</b>${citations.map(citation => `<button class="preview-file" data-path="${escapeHtml(citation.path)}">${escapeHtml(citation.name)} · ${escapeHtml(citation.reason)}</button>`).join('')}</div>` : '<p>证据不足：未找到可引用的本地资料。</p>';
}

function citations(citationList: SourceCitation[]) {
  return citationList.length ? `<div class="source-citations"><b>本地证据</b>${citationList.map(citation => `<button class="preview-file" data-path="${escapeHtml(citation.path)}">${escapeHtml(citation.name)} · ${escapeHtml(citation.reason)}</button>`).join('')}</div>` : '<p class="evidence-empty">证据不足：未找到可引用的本地资料。</p>';
}

function previewPanel() {
  if (!preview) return '';
  const body = preview.kind === 'image' ? `<img src="data:${preview.mimeType};base64,${preview.content}" alt="${escapeHtml(preview.name)}">`
    : preview.kind === 'pdf' ? `<iframe title="${escapeHtml(preview.name)}" src="data:application/pdf;base64,${preview.content}"></iframe>`
      : preview.kind === 'text' ? `<pre>${escapeHtml(preview.content)}</pre>` : `<p>${escapeHtml(preview.message)}</p>`;
  const office = /\.(docx?|pptx?|xlsx?|od[stp])$/i.test(preview.name);
  return `<section class="file-preview"><header><div><small>LOCAL PREVIEW</small><h2>${escapeHtml(preview.name)}</h2><span>${escapeHtml(preview.displayPath)}</span></div><div>${office ? '<button class="quiet" id="high-fidelity-office-preview">高保真预览</button>' : ''}<button class="quiet" id="reveal-file">在资源管理器中打开</button><button class="quiet" id="close-preview">关闭</button></div></header><div class="preview-body">${body}</div></section>`;
}

function isGalleryImage(item: Result) { return item.itemType === 'file' && /\.(png|jpe?g|gif|webp|bmp|pdf)$/i.test(item.name); }
function mediaKind(item: Result): MediaTask['kind'] | null { if (/\.(png|jpe?g|bmp|tiff?|webp)$/i.test(item.name)) return 'ocr'; if (/\.(wav|mp3|m4a|flac|ogg|mp4|mkv|mov|webm|avi)$/i.test(item.name)) return 'transcription'; return null; }
function mediaGallery() {
  if (!mediaGalleryOpen) return '';
  const images = results.filter(isGalleryImage);
  const cards = images.map(item => {
    const thumbnail = mediaThumbnails.get(item.id);
    const image = thumbnail ? `<img src="data:${thumbnail.mimeType};base64,${thumbnail.content}" alt="${escapeHtml(item.name)}">` : '<span class="gallery-placeholder">未生成</span>';
    return `<button class="media-card preview-file" data-path="${escapeHtml(item.path)}">${image}<b>${escapeHtml(item.name)}</b><small>${thumbnail?.cached ? '来自本地缓存' : '仅本机缓存'}</small></button>`;
  }).join('');
  return `<section class="media-gallery"><header><div><b>图库浏览</b><span>缩略图仅写入应用数据目录，不会改动原文件；PDF 首页缩略图需要本机 pdftoppm 渲染器。</span></div><div><button class="quiet" id="build-media-thumbnails" ${isWorking || !images.length ? 'disabled' : ''}>生成当前缩略图</button><button class="quiet" id="clear-thumbnail-cache" ${isWorking ? 'disabled' : ''}>清理缓存</button></div></header>${images.length ? `<div class="media-grid">${cards}</div>` : '<p>当前搜索结果没有可展示的图片或 PDF。</p>'}</section>`;
}

function toolManager() {
  const tools: Array<{ id: 'tesseract' | 'ffmpeg' | 'libreoffice'; name: string; ready: boolean; detail: string }> = [
    { id: 'tesseract', name: 'Tesseract OCR', ready: localTools.ocr, detail: '图片文字识别；语言包可在安装后自行添加。' },
    { id: 'ffmpeg', name: 'FFmpeg', ready: localTools.ffmpeg, detail: '音视频安全转码，供本地 Whisper 使用。' },
    { id: 'libreoffice', name: 'LibreOffice', ready: localTools.officeConverter, detail: 'Office 文件隔离转换为 PDF 预览。' },
  ];
  return `<section class="tool-manager"><header><div><b>本机工具管理</b><span>仅通过 Windows winget 安装固定官方包；不会上传资料或执行第三方脚本。</span></div></header><div class="tool-list">${tools.map(tool => `<div><section><b>${tool.name}</b><small>${tool.detail}</small></section><span class="tool-state ${tool.ready ? 'ready' : ''}">${tool.ready ? '已可用' : '未安装'}</span>${tool.ready ? '' : `<button class="quiet install-local-tool" data-tool="${tool.id}" ${isWorking ? 'disabled' : ''}>一键安装</button>`}</div>`).join('')}</div></section>`;
}

function mediaTasksPanel() {
  const candidates = results.filter(item => mediaKind(item));
  const candidateRows = candidates.map(item => `<button class="quiet enqueue-media-task" data-item-id="${escapeHtml(item.id)}" data-media-kind="${mediaKind(item)}">${mediaKind(item) === 'ocr' ? 'OCR' : '转写'}：${escapeHtml(item.name)}</button>`).join('');
  const taskRows = mediaTasks.map(task => `<div><span>${escapeHtml(task.name)} · ${task.kind} · ${task.status}${task.error ? ` · ${escapeHtml(task.error)}` : ''}</span>${['queued', 'running'].includes(task.status) ? `<button class="quiet cancel-media-task" data-task-id="${escapeHtml(task.id)}">取消</button>` : ''}</div>`).join('');
  const warning = formWarning?.target === 'media' ? `<p class="form-warning" role="alert">${escapeHtml(formWarning.message)}</p>` : '';
  return `<section class="media-tasks"><header><div><b>本地 OCR 与音视频转写</b><span>识别文本只进入本机索引；工具未安装、超时或失败时不会生成结果。</span></div><form id="media-settings">${warning}<div class="control-cluster"><input id="media-ocr-language" maxlength="80" value="${escapeHtml(mediaSettings.ocrLanguage)}" placeholder="Tesseract 语言，例如 chi_sim+eng"><input id="media-whisper-model" maxlength="1024" value="${escapeHtml(mediaSettings.whisperModelPath)}" placeholder="本地 Whisper 模型路径"><button class="quiet" type="submit">保存设置</button></div></form></header>${toolManager()}${candidateRows ? `<div class="media-candidates">${candidateRows}</div>` : '<p>搜索结果中没有可加入 OCR 或转写的媒体文件。</p>'}<div class="media-task-list">${taskRows || '<span>当前没有媒体任务。</span>'}</div></section>`;
}

function searchPanel() {
  const previousDisabled = searchPage === 0 ? 'disabled' : '';
  const nextDisabled = results.length === 0 || (searchPage + 1) * 30 >= searchTotal ? 'disabled' : '';
  const folderOptions = folderRefs.map(folder => `<option value="${escapeHtml(folder.id)}" ${folder.id === searchFolderFilter ? 'selected' : ''}>${escapeHtml(folder.name)}</option>`).join('');
  const semanticNote = appliedSearchMode === 'semantic' ? '语义向量排序（完全本机）' : appliedSearchMode === 'embedding_fallback_fts' ? '未配置 embedding 模型，已回退 FTS' : '关键词 / FTS 搜索';
  const embeddingModel = embeddingModels.find(model => model.active);
  const progressText = embeddingProgress ? `正在建立向量索引：${embeddingProgress.completed}/${embeddingProgress.total}${embeddingProgress.failed ? `，失败 ${embeddingProgress.failed}` : ''}` : embeddingModel ? `当前 embedding：${escapeHtml(embeddingModel.displayName)}${embeddingModel.dimensions ? ` · ${embeddingModel.dimensions} 维` : ''}` : '未配置本地 embedding 模型';
  return `<section class="single-panel panel"><header><div><small>LOCAL SEARCH</small><h2>本地搜索</h2></div><span class="local-chip">${icons.check} ${semanticNote}</span></header><div class="search-page"><h1>精确查找你的资料。</h1><p>输入名称、路径、备注、标签或已提取正文；不会发送到云端。</p><form id="search-form"><div class="large-search">${icons.search}<input id="search-question" value="${escapeHtml(searchQuery)}" placeholder="例如：游戏、Steam、项目资料"><button type="submit" ${isWorking ? 'disabled' : ''}>搜索</button></div><div class="search-filters"><label>模式 <select id="search-mode"><option value="fts" ${searchMode === 'fts' ? 'selected' : ''}>关键词（FTS）</option><option value="semantic" ${searchMode === 'semantic' ? 'selected' : ''}>语义向量</option></select></label><label>标签 <input class="search-filter" id="search-filter" value="${escapeHtml(searchFilter)}" placeholder="例如：游戏"></label><label>资料夹 <select id="search-folder-filter"><option value="">全部资料夹</option>${folderOptions}</select></label><label>类型 <select id="search-type-filter"><option value="">文件和文件夹</option><option value="file" ${searchTypeFilter === 'file' ? 'selected' : ''}>仅文件</option><option value="folder" ${searchTypeFilter === 'folder' ? 'selected' : ''}>仅文件夹</option></select></label></div></form><section class="semantic-search"><b>本地语义检索</b><span>${progressText}</span><button class="quiet" id="register-embedding-model" ${isWorking ? 'disabled' : ''}>选择 embedding GGUF</button><button class="quiet" id="build-embedding-index" ${isWorking || !embeddingModel ? 'disabled' : ''}>建立 / 更新向量索引</button><button class="quiet" id="toggle-media-gallery">${mediaGalleryOpen ? '收起图库' : '图库浏览'}</button></section>${mediaGallery()}${mediaTasksPanel()}${resultRows('输入检索词后，结果会在这里显示真实路径。')}<div class="search-paging"><button class="quiet" id="search-page-previous" ${previousDisabled}>上一页</button><span>${searchTotal ? `第 ${searchPage + 1} 页，共 ${searchTotal} 项` : '暂无搜索结果'}</span><button class="quiet" id="search-page-next" ${nextDisabled}>下一页</button></div></div></section>`;
}

function conversationPage() {
  const history = conversations.length ? conversations.map(conversation => `<div class="conversation-row"><button class="conversation-item ${conversation.id === activeConversationId ? 'active' : ''}" data-conversation-id="${escapeHtml(conversation.id)}"><b>${escapeHtml(conversation.title)}</b><small>${escapeHtml(conversation.updatedAt)}</small></button><button class="quiet danger delete-conversation" data-conversation-id="${escapeHtml(conversation.id)}" aria-label="删除对话">删除</button></div>`).join('') : '<p>还没有保存的对话。开始提问后会自动记录在本机。</p>';
  const messages = conversationMessages.length ? conversationMessages.map(message => `<article class="chat-message ${escapeHtml(message.role)}"><header><b>${message.role === 'user' ? '你' : message.source === 'cloud' ? '云端 AI' : '本地 AI'}</b><span>${escapeHtml(message.createdAt)}</span></header><p>${escapeHtml(message.parsedReply?.answer ?? message.content)}</p>${message.parsedReply?.steps.length ? `<ol>${message.parsedReply.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : ''}</article>`).join('') : '<p class="chat-empty">选择一段对话，或在“AI 助手”中开始新任务。</p>';
  return `<section class="single-panel panel"><header><div><small>LOCAL HISTORY</small><h2>AI 对话</h2></div><button class="quiet" data-view="assistant">开始新对话</button></header><div class="conversation-page"><section class="conversation-layout standalone"><aside class="conversation-history"><header><b>本机对话记录</b></header>${history}</aside><section class="conversation-messages"><header><b>对话内容</b><span>本地与云端回答均以文本保存在本机</span></header>${messages}</section></section></div></section>`;
}

function assistantPanel() {
  const outputText = aiOutputTarget ? `本次工作区：${escapeHtml(aiOutputTarget.displayPath)}` : aiOutputFolder ? `下次写入：${escapeHtml(displayPath(aiOutputFolder))}` : '未指定时保存到软件的 AI Outputs 文件夹';
  const configLabel = cloudConfig?.configured ? `已配置：${escapeHtml(cloudConfig.providerId)} / ${escapeHtml(cloudConfig.model)}` : '未配置云端服务；复杂任务仍只在本地准备。';
  const taskControls = !agentRun ? '' : `<div class="agent-actions">${agentRun.route === 'cloud_needs_confirmation' && agentRun.status === 'awaiting_confirmation' ? `<button class="primary" id="cloud-confirm" ${isWorking ? 'disabled' : ''}>确认发送脱敏请求</button>` : ''}${agentRun.status === 'awaiting_approval' ? `<button class="primary" id="approve-agent-step" ${isWorking ? 'disabled' : ''}>批准工作区写入</button>` : ''}${agentRun.status === 'approved' ? `<button class="primary" id="apply-agent-advice" ${!aiOutputTarget || isWorking ? 'disabled' : ''}>仅新建文件</button><button class="quiet" id="apply-agent-existing-edits" ${!aiOutputTarget || isWorking ? 'disabled' : ''}>批准后修改已有文件</button>` : ''}${['files_written', 'check_failed'].includes(agentRun.status) && aiOutputTarget ? `<button class="quiet" id="run-workspace-check" ${isWorking ? 'disabled' : ''}>运行构建检查</button><select id="workspace-check-command"><option>npm run build</option><option>npm test</option><option>cargo check</option><option>cargo test</option></select>${agentRun.route === 'cloud_auto' && agentRun.status === 'check_failed' ? `<button class="quiet" id="auto-repair-agent-run" ${isWorking ? 'disabled' : ''}>自动最小修复</button>` : ''}` : ''}${['check_failed', 'cancelled'].includes(agentRun.status) ? `<button class="quiet" id="retry-agent-run" ${isWorking ? 'disabled' : ''}>重试协作</button>` : ''}${!['cancelled', 'check_complete', 'local_complete', 'repair_complete'].includes(agentRun.status) ? `<button class="quiet danger" id="cancel-agent-run" ${isWorking ? 'disabled' : ''}>取消任务</button>` : ''}</div>`;
  const timeline = agentEvents.length ? `<ol class="agent-timeline">${agentEvents.map(event => `<li><b>${escapeHtml(event.status)}</b><span>${escapeHtml(event.message)}</span><small>${escapeHtml(event.createdAt)}</small></li>`).join('')}</ol>` : '';
  const evidence = agentEvidenceReport ? `<details class="agent-evidence-report" open><summary>最终证据报告：${escapeHtml(agentEvidenceReport.status)} · 本地受限绑定 ${agentEvidenceReport.restrictedBindings}</summary><ol>${agentEvidenceReport.finalEvidence.map(escapeHtml).map(item => `<li>${item}</li>`).join('')}</ol></details>` : '';
  const runFeedback = agentRun ? `<section class="agent-feedback"><div><b>任务路由：${escapeHtml(agentRun.route)} · ${escapeHtml(agentRun.status)}</b><span>${escapeHtml(agentRun.reason)}</span></div><dl><div><dt>允许外发</dt><dd>${agentRun.sourceCount}</dd></div><div><dt>本地受限</dt><dd>${agentRun.restrictedSourceCount}</dd></div><div><dt>已脱敏</dt><dd>${agentRun.redactionCount}</dd></div></dl><p>${escapeHtml(agentRun.feedback)}</p>${sourceCitations(agentRun.sourceCitations)}${agentRun.route === 'cloud_needs_confirmation' ? `<details><summary>查看本次内存中的脱敏请求</summary><pre>${escapeHtml(agentRun.requestPreview)}</pre></details>` : ''}${agentRun.cloudAdvice ? `<details open><summary>云端结构化建议（未执行）</summary><p>${escapeHtml(agentRun.cloudAdvice.answer)}</p><p>${agentRun.cloudAdvice.uncertainties.map(escapeHtml).join('；')}</p></details>` : ''}${timeline}<button class="quiet" id="load-agent-evidence">生成最终证据报告</button>${evidence}${taskControls}${workspaceAction ? `<pre class="workspace-action">${escapeHtml(workspaceAction.output)}${workspaceAction.writtenFiles.length ? `\n已写入：\n${workspaceAction.writtenFiles.map(escapeHtml).join('\n')}` : ''}</pre>` : ''}</section>` : '';
  const providerOptions = cloudProviders.map(provider => `<option value="${escapeHtml(provider.providerId)}" ${provider.providerId === cloudConfig?.providerId ? 'selected' : ''}>${escapeHtml(provider.displayName)}${provider.configured ? '' : '（未填密钥）'}</option>`).join('');
  const messages = conversationMessages.map(message => `<article class="chat-message ${message.role}"><header><b>${message.role === 'user' ? '你' : message.source === 'cloud' ? '云端 AI' : '本地 AI'}</b><span>${message.source === 'cloud' ? '云端' : '本地'}</span></header><p>${escapeHtml(message.parsedReply?.answer ?? message.content)}</p>${message.parsedReply?.steps.length ? `<ol>${message.parsedReply.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : ''}${message.parsedReply?.codeBlocks ? `<small>包含 ${message.parsedReply.codeBlocks} 个代码块，仅展示，不会自动执行。</small>` : ''}</article>`).join('') || '<p class="chat-empty">开始一次提问后，本地和云端的回答都会保存在这里。</p>';
  const history = conversations.map(conversation => `<div class="conversation-row"><button class="conversation-item ${conversation.id === activeConversationId ? 'active' : ''}" data-conversation-id="${escapeHtml(conversation.id)}"><b>${escapeHtml(conversation.title)}</b><small>${escapeHtml(conversation.updatedAt)}</small></button><button class="quiet delete-conversation" data-conversation-id="${escapeHtml(conversation.id)}">删除</button></div>`).join('') || '<p>暂无保存的对话。</p>';
  const ruleList = sensitiveRules.map(rule => `<div class="rule-item"><label><input class="sensitive-rule-toggle" data-rule-id="${escapeHtml(rule.id)}" type="checkbox" ${rule.enabled ? 'checked' : ''}> <b>${escapeHtml(rule.name)}</b><small>${escapeHtml(rule.pattern)}</small></label><button class="quiet delete-sensitive-rule" data-rule-id="${escapeHtml(rule.id)}">删除</button></div>`).join('') || '<p>没有自定义规则；内置密钥、电话、邮件等脱敏始终有效。</p>';
  const governance = governanceExport ? `<pre class="governance-export">${escapeHtml(JSON.stringify(governanceExport, null, 2))}</pre>` : '';
  const backup = encryptedBackup ? `<p>已创建加密备份：${escapeHtml(encryptedBackup.displayPath)}（${bytes(encryptedBackup.databaseBytes)}）。恢复需要同一 Windows 用户凭据，选择后将在重启时替换。</p>` : '';
  const sensitiveReport = sensitiveFindings.length ? `<ul class="audit-list">${sensitiveFindings.map(item => `<li><b>${escapeHtml(item.category)}</b> · ${escapeHtml(item.name)} · ${item.matchCount} 处 <small>${escapeHtml(item.displayPath)}</small></li>`).join('')}</ul>` : '<p>尚未扫描，或未在已提取正文中发现内置规则匹配项。</p>';
  const auditReport = auditEntries.length ? `<ul class="audit-list">${auditEntries.map(item => `<li><b>${escapeHtml(item.targetType)}</b> · ${escapeHtml(item.action)} · ${escapeHtml(item.createdAt)} <small>${escapeHtml(item.oldPolicy ?? '-')} → ${escapeHtml(item.newPolicy ?? '-')}</small></li>`).join('')}</ul>` : '<p>尚未加载审计记录。</p>';
  const cloudWarning = formWarning?.target === 'cloud' ? `<p class="form-warning" role="alert">${escapeHtml(formWarning.message)}</p>` : '';
  const rulesWarning = formWarning?.target === 'rules' ? `<p class="form-warning" role="alert">${escapeHtml(formWarning.message)}</p>` : '';
  return `<section class="single-panel panel"><header><div><small>LOCAL AI</small><h2>AI 助手</h2></div><span class="local-chip">${icons.check} 本机优先</span></header><div class="assistant-page"><div class="assistant-intro"><span>${icons.spark}</span><div><h1>问资料助手</h1><p>本机检索和多轮理解优先；云端只接收经过策略筛选和脱敏的最小请求。</p></div></div><form id="ask-form"><label>你想完成什么？<div class="ask-row"><input id="question" value="现在想要玩游戏" maxlength="180" placeholder="例如：根据现有素材制作一款游戏"><button ${isWorking ? 'disabled' : ''} type="submit">${icons.spark} 开始分析</button></div></label></form><section class="cloud-settings"><form id="cloud-provider-form">${cloudWarning}<div><b>云端供应商</b><span>${configLabel}</span><small>保存后再获取模型；密钥只写入 Windows 凭据库，不保存在对话或数据库中。</small></div><label>已保存供应商<select id="cloud-provider-select"><option value="">新建供应商</option>${providerOptions}</select></label><label>名称<input id="cloud-display-name" maxlength="80" value="${escapeHtml(cloudConfig?.displayName ?? '')}" placeholder="例如：我的 OpenAI 兼容服务"></label><label>标识<input id="cloud-provider-id" maxlength="80" value="${escapeHtml(cloudConfig?.providerId ?? '')}" placeholder="例如：my-provider"></label><label>基础地址<input id="cloud-base-url" maxlength="240" value="${escapeHtml(cloudConfig?.baseUrl ?? '')}" placeholder="https://api.example.com"></label><label>模型<select id="cloud-model-select"><option value="${escapeHtml(cloudConfig?.model ?? '')}">${escapeHtml(cloudConfig?.model ?? '请先获取模型')}</option>${cloudModels.filter(item => item.id !== cloudConfig?.model).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.id)}</option>`).join('')}</select></label><label>API Key<input id="cloud-api-key" type="password" autocomplete="off" placeholder="留空以保留已保存密钥"></label><div class="cloud-actions control-cluster"><button class="quiet" id="fetch-cloud-models" type="button">获取模型</button><button class="primary" type="submit">保存供应商</button>${cloudConfig ? `<button class="quiet danger" id="delete-cloud-provider" type="button">删除供应商</button>` : ''}</div><label class="check-row"><input id="cloud-auto" type="checkbox" ${cloudConfig?.autoCollaboration ? 'checked' : ''}> 复杂任务自动协作</label><label class="check-row"><input id="cloud-review" type="checkbox" ${cloudConfig?.reviewEachRequest ? 'checked' : ''}> 每次请求先确认</label></form></section>${runFeedback}<section class="ai-output"><div><b>AI 写入位置</b><span>${outputText}</span></div><button class="quiet" id="choose-ai-output">选择 AI 写入文件夹</button><button class="quiet" id="create-ai-workspace">创建 AI 工作区</button></section><section class="sensitive-rules"><header><div><b>本地敏感规则</b><span>规则仅在准备云端请求时生效；无匹配的规则会阻止外发。</span></div></header>${rulesWarning}<form id="sensitive-rule-form"><input id="sensitive-rule-name" maxlength="80" placeholder="规则名称，例如：客户编号"><input id="sensitive-rule-pattern" maxlength="500" placeholder="正则表达式，例如：CLIENT-[0-9]+"><button class="quiet" type="submit">添加规则</button></form>${ruleList}</section><section class="governance-controls"><b>本地数据治理</b><span>导出不包含 API Key、云端原始请求或原始受限资料。</span><div class="control-cluster"><button class="quiet" id="create-encrypted-backup">创建加密备份</button><button class="quiet" id="restore-encrypted-backup">选择加密备份恢复</button><button class="quiet" id="scan-sensitive-index">生成敏感扫描报告</button><button class="quiet" id="load-metadata-audit">查看元数据审计</button><button class="quiet" id="export-local-governance">导出治理摘要</button><button class="quiet danger" id="clear-local-data" data-clear-scope="conversations">清理对话</button><button class="quiet danger" id="clear-local-data" data-clear-scope="audit">清理审计</button><button class="quiet danger" id="clear-local-data" data-clear-scope="rules">清理规则</button></div>${backup}${sensitiveReport}${auditReport}${governance}</section>${resultRows('完成本地检索后会显示命中资料；受限资料绝不会外发。')}</div></section>`;
}

function folderList() {
  if (!folderRefs.length) return `<div class="empty-folder drop-target"><span>${icons.folder}</span><strong>拖入文件夹开始</strong><p>把一个文件夹拖入此窗口，或选择本机文件夹。资料会原位建立索引，保留空目录和层级。</p><button class="outline" id="choose-folder">选择本机文件夹</button></div>`;
  return `<div class="imported-folders">${folderRefs.map(folder => `<div class="folder-reference-row"><button class="folder-ref folder-ref-button metadata-target" data-folder-id="${escapeHtml(folder.id)}" data-target-type="folder" data-target-id="${escapeHtml(folder.id)}" data-note="${escapeHtml(folder.note)}" data-tags="${escapeHtml(JSON.stringify(folder.tags))}" data-cloud-policy="${folder.cloudPolicy}" data-name="${escapeHtml(folder.name)}"><span>${icons.folder}</span><div><b>${escapeHtml(folder.name)}</b><small>${escapeHtml(folder.displayPath)}</small>${folder.note ? `<p>${escapeHtml(folder.note)}</p>` : ''}${metadataLine(folder.tags, folder.cloudPolicy)}</div><em>${folder.sourceStatus === 'missing' ? '原位置不可用' : `${folder.itemCount} 项索引`}</em></button><button class="quiet danger remove-folder-reference" data-folder-id="${escapeHtml(folder.id)}">移除引用</button></div>`).join('')}</div>`;
}

function folderBrowser() {
  if (!activeFolder) return '';
  const currentPath = browserPath ?? activeFolder.path;
  return `<section class="folder-browser panel"><header><div><small>INLINE BROWSER</small><h2>${escapeHtml(activeFolder.name)}</h2><span>${escapeHtml(displayPath(browserPath ?? activeFolder.displayPath))}</span></div><div><button class="quiet" id="browser-back" ${browserHistory.length ? '' : 'disabled'}>返回上级</button><button class="quiet" id="browser-reveal">在资源管理器中打开</button><button class="quiet" id="close-browser">关闭</button></div></header><div class="browser-items">${folderEntries.length ? folderEntries.map(entry => `<button class="browser-entry ${entry.itemType === 'folder' ? 'browser-folder' : 'preview-file'} metadata-target" data-target-type="item" data-target-id="${escapeHtml(entry.id)}" data-note="${escapeHtml(entry.note)}" data-tags="${escapeHtml(JSON.stringify(entry.tags))}" data-cloud-policy="${entry.cloudPolicy}" data-name="${escapeHtml(entry.name)}" data-path="${escapeHtml(entry.path)}"><span>${entry.itemType === 'folder' ? icons.folder : icons.file}</span><b>${escapeHtml(entry.name)}</b><small>${escapeHtml(entry.displayPath)}</small>${metadataLine(entry.tags, entry.cloudPolicy)}</button>`).join('') : `<p>此文件夹为空。</p>`}</div><input type="hidden" value="${escapeHtml(currentPath)}"></section>`;
}

function workspacePanel() {
  const percent = progress?.total ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;
  const modelState = stateChip(status.modelInstalled, '未安装', '已安装');
  const runtimeState = stateChip(status.runtimeInstalled, '待下载', '已就绪');
  const models = localModels.map(model => `<div class="model-row"><button class="model-item ${model.active ? 'active' : ''}" data-local-model-id="${escapeHtml(model.id)}"><b>${escapeHtml(model.displayName)}</b><small>${escapeHtml(displayPath(model.path))}</small>${model.active ? '<em>当前使用</em>' : ''}</button><button class="quiet danger delete-local-model" data-delete-local-model-id="${escapeHtml(model.id)}">移除记录</button></div>`).join('');
  const folderActions = folderRefs.length ? `<div class="folder-index-actions">${folderRefs.map(folder => `<button class="quiet" data-refresh-folder-id="${escapeHtml(folder.id)}">刷新：${escapeHtml(folder.name)}</button>`).join('')}</div>` : '';
  return `<section class="workspace-view"><div class="workspace-head"><div><p>本地资料管理</p><h1>把文件夹交给一个真正本地的助手。</h1><span>拖入或选择文件夹，添加备注和标签。AI 只根据本地索引给出可验证的结果。</span></div><div class="privacy"><b>${icons.check} 数据边界</b><span>不上传原始文件，不移动或删除资料。</span></div></div><section class="desk-grid"><section class="file-panel panel drop-target"><header><div><small>FOLDER TERMINAL</small><h2>已接入的资料</h2></div><button class="quiet" id="refresh">刷新状态</button></header><div class="drop-hint">拖入一个文件夹即可原位接入，或使用右上角“接入文件夹”。</div>${folderList()}${folderActions}</section><section class="assistant panel"><header><div><small>LOCAL AI</small><h2>助手快捷入口</h2></div><span class="local-chip">${icons.check} 本机</span></header><div class="assistant-body"><div class="question">现在想要玩游戏</div><p class="assistant-copy">它会检索名称、路径、备注、标签及已提取的安全文本正文，结果始终附带真实路径。</p><button class="primary" data-view="assistant">${icons.spark} 打开 AI 助手</button></div></section></section><section class="setup panel"><div class="setup-heading"><div><small>AI INITIALIZATION</small><h2>应用内完成本地模型准备</h2><p>默认下载轻量模型；也可以选择你电脑中已存在的 GGUF 模型。当前模型：${escapeHtml(status.activeModelName)}。</p></div><div class="ready-summary">${status.runtimeInstalled && status.modelInstalled ? `${icons.check} 助手已可用` : '还差一步即可启用'}</div></div><div class="setup-grid"><article><div class="setup-icon">${icons.download}</div><div class="setup-copy"><b>1. 本地推理运行时</b><span>llama.cpp Windows CPU 引擎</span></div>${runtimeState}<button class="quiet setup-button" id="download-runtime" ${isWorking || status.runtimeInstalled ? 'disabled' : ''}>下载</button></article><article><div class="setup-icon">${icons.spark}</div><div class="setup-copy"><b>2. 默认中文模型</b><span>Qwen2.5 1.5B Instruct · Q4_K_M</span></div>${modelState}<button class="primary setup-button" id="download-model" ${isWorking || status.modelInstalled ? 'disabled' : ''}>下载并启用</button></article></div><section class="local-models"><header><b>本地模型</b><button class="quiet" id="register-local-model">选择本地 GGUF 模型</button></header>${models || '<p>尚未登记额外模型；默认模型下载后可直接使用。</p>'}</section>${progress ? `<div class="progress"><div><b>${progress.kind === 'model' ? `正在从 ${escapeHtml(progress.source ?? '模型源')} 下载 Qwen2.5 1.5B 模型` : '正在下载本地推理运行时'}</b><span>${percent ? `${percent}% · ${bytes(progress.completed)} / ${bytes(progress.total)}` : bytes(progress.completed)}</span></div><i><span style="width:${percent}%"></span></i></div>` : ''}</section></section>`;
}

function workspaceExtras() {
  const indexing = indexProgress ? `<div class="index-progress"><b>索引中</b><span>${indexProgress.completed} / ${indexProgress.total}</span></div>` : '';
  const watching = folderRefs.length ? '<div class="index-progress"><b>自动索引</b><span>正在监听已接入资料夹</span></div>' : '';
  const queue = indexJobs.length ? `<section class="index-jobs"><b>索引队列</b>${indexJobs.map(job => `<div><span>${escapeHtml(folderRefs.find(folder => folder.id === job.folderId)?.name ?? '资料夹')} · ${escapeHtml(job.status)} · ${job.completed}/${job.total} · 变更 ${job.changed}</span>${job.status === 'running' || job.status === 'queued' ? `<button class="quiet" data-pause-index-job="${escapeHtml(job.id)}">暂停</button>` : `<button class="quiet" data-resume-index-job="${escapeHtml(job.id)}">恢复</button>`}</div>`).join('')}</section>` : '';
  const recovery = recoveryNotice ? `<section class="privacy-status recovery-notice" role="alert"><b>数据库恢复提示</b><span>${escapeHtml(recoveryNotice)}</span><small>恢复过程只会合并缺失记录；原始数据库与恢复文件始终保留在上述目录中。</small></section>` : '';
  const privacy = privacyStatus ? `<section class="privacy-status" id="privacy-status"><b>隐私状态</b><span>${escapeHtml(privacyStatus.message)}</span><small>磁盘加密：${escapeHtml(privacyStatus.recommendation)}</small></section>` : '';
  const acceptance = acceptanceChecks.length ? `<ul class="audit-list">${acceptanceChecks.map(item => `<li><b>${escapeHtml(item.label)}</b> · ${escapeHtml(item.status)} <small>${escapeHtml(item.detail)}</small></li>`).join('')}</ul>` : '';
  return `<section class="workspace-extras">${recovery}${privacy}<form id="runtime-settings" class="runtime-settings"><b>本地模型运行设置</b><label>模式 <select id="runtime-mode"><option value="auto" ${runtimeSettings.executionMode === 'auto' ? 'selected' : ''}>自动</option><option value="cpu" ${runtimeSettings.executionMode === 'cpu' ? 'selected' : ''}>CPU</option><option value="gpu" ${runtimeSettings.executionMode === 'gpu' ? 'selected' : ''}>GPU</option></select></label><label>线程 <input id="runtime-threads" type="number" min="1" max="64" value="${runtimeSettings.threads}"></label><label>上下文 <input id="runtime-context" type="number" min="512" max="32768" value="${runtimeSettings.contextSize}"></label><button class="quiet" type="submit">保存运行设置</button></form><button class="quiet" id="run-environment-acceptance">运行环境验收</button>${acceptance}<label class="agent-preference"><input id="auto-apply-low-risk" type="checkbox" ${agentPreferences.autoApplyLowRisk ? 'checked' : ''}> 自动执行低风险工作区步骤（不覆盖、不删除、不联网、不发布）</label>${watching}${indexing}${queue}</section>`;
}

function render() {
  const pages: Record<View, { title: string; subtitle: string; content: string }> = {
    workspace: { title: '资料空间', subtitle: '原文件留在原位置 · 索引存于本机', content: `${workspaceExtras()}${workspacePanel()}` },
    search: { title: '本地搜索', subtitle: '按名称、路径、备注和标签查询', content: searchPanel() },
    assistant: { title: 'AI 助手', subtitle: '理解问题后，以本地索引给出结果', content: assistantPanel() },
    conversations: { title: 'AI 对话', subtitle: '本机保存的问答记录与结构化步骤', content: conversationPage() },
  };
  const page = pages[activeView];
  const menu = contextTarget ? `<div class="context-menu" style="left:${contextPosition.x}px;top:${contextPosition.y}px" role="menu"><b>${escapeHtml(contextTarget.name)}</b><button data-metadata-action="note">编辑备注</button><button data-metadata-action="tags">编辑标签</button><button data-metadata-action="local_only">云端：禁止上传</button><button data-metadata-action="cloud_allowed">云端：允许上传</button><button data-metadata-action="ask_each_time">云端：每次询问</button></div>` : '';
  app.innerHTML = `<aside class="sidebar"><div class="brand"><span class="brand-mark">${icons.mark}</span><span>资料终端<small>LOCAL FILE ASSISTANT</small></span></div><nav><button class="nav ${activeView === 'workspace' ? 'active' : ''}" data-view="workspace">${icons.folder}<span>资料空间</span></button><button class="nav ${activeView === 'search' ? 'active' : ''}" data-view="search">${icons.search}<span>本地搜索</span></button><button class="nav ${activeView === 'assistant' ? 'active' : ''}" data-view="assistant">${icons.spark}<span>AI 助手</span></button><button class="nav ${activeView === 'conversations' ? 'active' : ''}" data-view="conversations">${icons.file}<span>AI 对话</span></button></nav><div class="sidebar-foot"><span class="online-dot"></span><span>仅在本机运行</span></div></aside><main><header class="topbar"><div><strong>${page.title}</strong><span>${page.subtitle}</span></div><button class="import" id="import-folder">${icons.folder} 接入文件夹</button></header><section class="canvas">${page.content}${folderBrowser()}${previewPanel()}${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}</section></main>${menu}`;
  bind();
}

async function refreshStatus() { [status, folderRefs, cloudConfig, cloudProviders, conversations, sensitiveRules, localModels, agentPreferences, privacyStatus, recoveryNotice, indexJobs, runtimeSettings, embeddingModels, mediaTasks, mediaSettings, localTools] = await Promise.all([invoke<RuntimeStatus>('get_runtime_status'), invoke<FolderRef[]>('list_folder_refs'), invoke<CloudProviderConfig | null>('get_cloud_provider_config'), invoke<CloudProviderConfig[]>('list_cloud_providers'), invoke<Conversation[]>('list_conversations'), invoke<SensitiveRule[]>('list_sensitive_rules'), invoke<LocalModel[]>('list_local_models'), invoke<AgentPreferences>('get_agent_preferences'), invoke<PrivacyStatus>('get_privacy_status'), invoke<string | null>('get_startup_recovery_notice'), invoke<IndexJob[]>('list_index_jobs'), invoke<RuntimeSettings>('get_runtime_settings'), invoke<EmbeddingModel[]>('list_embedding_models'), invoke<MediaTask[]>('list_media_tasks'), invoke<MediaSettings>('get_media_settings'), invoke<LocalToolStatus>('get_local_tool_status')]); render(); }
async function loadFolderRefs() { folderRefs = await invoke<FolderRef[]>('list_folder_refs'); }
async function openFolder(folderId: string, path?: string) { const folder = folderRefs.find(item => item.id === folderId); if (!folder) return; activeFolder = folder; browserPath = path ?? folder.path; folderEntries = await invoke<FolderEntry[]>('list_folder_children', { folderId, path: browserPath }); render(); }
async function navigateFolder(path: string) { if (!activeFolder) return; browserHistory.push(browserPath ?? activeFolder.path); await openFolder(activeFolder.id, path); }
async function browserBack() { if (!activeFolder || !browserHistory.length) return; const previous = browserHistory.pop(); await openFolder(activeFolder.id, previous); }
async function revealFolder() { if (!activeFolder) return; try { await invoke('reveal_in_explorer', { path: browserPath ?? activeFolder.path }); } catch (reason) { error = `无法打开资源管理器：${String(reason)}`; render(); } }
async function importFolderPath(path: string) {
  isWorking = true; error = ''; render();
  try { const indexed = await invoke<number>('import_folder', { input: { path, note: '', tags: [] } }); await loadFolderRefs(); window.alert(`已在原位置接入文件夹，并建立 ${indexed} 项本地索引。`); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function selectFolder() {
  const selected = await open({ directory: true, multiple: false, title: '选择要接入的文件夹' });
  if (!selected || Array.isArray(selected)) return;
  const note = window.prompt('为这个文件夹添加备注（可留空）：') ?? '';
  const tagText = window.prompt('添加标签，用逗号分隔（可留空）：') ?? '';
  isWorking = true; error = ''; render();
  try { const indexed = await invoke<number>('import_folder', { input: { path: selected, note, tags: tagText.split(',').map(tag => tag.trim()).filter(Boolean) } }); await loadFolderRefs(); window.alert(`已在原位置接入文件夹，并建立 ${indexed} 项本地索引。`); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
function metadataTarget(element: HTMLElement): MetadataTarget | null {
  const targetType = element.dataset.targetType;
  const targetId = element.dataset.targetId;
  if ((targetType !== 'folder' && targetType !== 'item') || !targetId) return null;
  try {
    return { targetType, targetId, name: element.dataset.name ?? '资料', note: element.dataset.note ?? '', tags: JSON.parse(element.dataset.tags ?? '[]'), cloudPolicy: (element.dataset.cloudPolicy as CloudPolicy) ?? 'local_only' };
  } catch { return null; }
}
async function editMetadata(action: string) {
  if (!contextTarget) return;
  const target = contextTarget;
  contextTarget = null;
  if (action === 'note') {
    const note = window.prompt(`编辑“${target.name}”的备注：`, target.note);
    if (note === null) { render(); return; }
    await invoke('update_metadata', { input: { targetType: target.targetType, targetId: target.targetId, note } });
  } else if (action === 'tags') {
    const tags = window.prompt(`编辑“${target.name}”的标签（用逗号分隔）：`, target.tags.join(', '));
    if (tags === null) { render(); return; }
    await invoke('update_metadata', { input: { targetType: target.targetType, targetId: target.targetId, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean) } });
  } else {
    const policy = action as CloudPolicy;
    if (policy !== 'local_only' && target.cloudPolicy === 'local_only' && !window.confirm('允许云端后，AI 可能在任务需要时发送经过筛选和脱敏的资料。确定继续吗？')) { render(); return; }
    await invoke('update_metadata', { input: { targetType: target.targetType, targetId: target.targetId, cloudPolicy: policy } });
  }
  await refreshStatus();
  if (activeFolder) await openFolder(activeFolder.id, browserPath ?? activeFolder.path);
}
async function chooseAiOutputFolder() {
  const selected = await open({ directory: true, multiple: false, title: '选择 AI 写入文件夹' });
  if (!selected || Array.isArray(selected)) return;
  aiOutputFolder = selected; aiOutputTarget = null; render();
}
async function createAiWorkspace() {
  const projectName = window.prompt('输入本次 AI 任务的项目名称：', 'AI Project');
  if (projectName === null) return;
  isWorking = true; error = ''; render();
  try { aiOutputTarget = await invoke<AiOutputTarget>('prepare_ai_output', { input: { outputFolder: aiOutputFolder, projectName } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function ensureAiWorkspace() {
  if (aiOutputTarget) return aiOutputTarget;
  const projectName = agentRun ? `协作-${agentRun.id.slice(0, 8)}` : 'AI Project';
  aiOutputTarget = await invoke<AiOutputTarget>('prepare_ai_output', { input: { outputFolder: aiOutputFolder, projectName } });
  return aiOutputTarget;
}
async function provision(kind: 'runtime' | 'model') { isWorking = true; error = ''; progress = { kind, completed: 0 }; render(); try { status = await invoke<RuntimeStatus>(kind === 'runtime' ? 'download_runtime' : 'download_model'); } catch (reason) { error = String(reason); } finally { isWorking = false; progress = null; render(); } }
async function registerLocalModel() { const selected = await open({ multiple: false, directory: false, filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }], title: '选择本地 GGUF 模型' }); if (!selected || Array.isArray(selected)) return; isWorking = true; error = ''; render(); try { await invoke<LocalModel>('register_local_model', { input: { path: selected } }); [status, localModels] = await Promise.all([invoke<RuntimeStatus>('get_runtime_status'), invoke<LocalModel[]>('list_local_models')]); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function selectLocalModel(id: string) { isWorking = true; error = ''; render(); try { await invoke('select_local_model', { input: { id } }); [status, localModels] = await Promise.all([invoke<RuntimeStatus>('get_runtime_status'), invoke<LocalModel[]>('list_local_models')]); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function deleteLocalModel(id: string) { if (!window.confirm('移除该模型登记？不会删除电脑中的 GGUF 模型文件。')) return; isWorking = true; error = ''; render(); try { await invoke('delete_local_model', { input: { id } }); [status, localModels] = await Promise.all([invoke<RuntimeStatus>('get_runtime_status'), invoke<LocalModel[]>('list_local_models')]); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function refreshFolderIndex(folderId: string) { try { await invoke('enqueue_index_job', { input: { folderId } }); indexJobs = await invoke<IndexJob[]>('list_index_jobs'); render(); } catch (reason) { error = String(reason); render(); } }
async function pauseIndexJob(id: string) { await invoke('pause_index_job', { input: { id } }); indexJobs = await invoke<IndexJob[]>('list_index_jobs'); render(); }
async function resumeIndexJob(id: string) { await invoke('resume_index_job', { input: { id } }); indexJobs = await invoke<IndexJob[]>('list_index_jobs'); render(); }
function scheduleFolderRefresh(change: FolderChangeDetected) {
  const existing = folderRefreshTimers.get(change.folderId);
  if (existing) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    folderRefreshTimers.delete(change.folderId);
    refreshFolderIndex(change.folderId).catch(reason => { error = `自动刷新失败：${String(reason)}`; render(); });
  }, 1_500);
  folderRefreshTimers.set(change.folderId, timer);
}
function scheduleEmbeddingUpdate() {
  if (!embeddingModels.some(model => model.active)) return;
  if (embeddingUpdateTimer) window.clearTimeout(embeddingUpdateTimer);
  embeddingUpdateTimer = window.setTimeout(() => {
    buildEmbeddingIndex().catch(reason => { error = `自动更新向量索引失败：${String(reason)}`; render(); });
  }, 1_200);
}
async function removeFolderReference(folderId: string) { if (!window.confirm('仅移除软件内索引、备注和标签；不会删除原文件夹或其中任何文件。')) return; isWorking = true; error = ''; render(); try { await invoke('remove_folder_reference', { input: { folderId } }); if (activeFolder?.id === folderId) activeFolder = null; await loadFolderRefs(); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function searchDocuments(page = 0) { if (!searchQuery) return; isWorking = true; error = ''; render(); try { const result = await invoke<SearchDocumentsResult>(searchMode === 'semantic' ? 'semantic_search' : 'search_documents', { input: { query: searchQuery, tag: searchFilter || undefined, folderId: searchFolderFilter || undefined, itemType: searchTypeFilter || undefined, page } }); results = result.items; searchTotal = result.total; searchPage = result.page; appliedSearchMode = result.searchMode; } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function registerEmbeddingModel() { const selected = await open({ multiple: false, directory: false, filters: [{ name: 'Embedding GGUF 模型', extensions: ['gguf'] }], title: '选择本地 embedding GGUF 模型' }); if (!selected || Array.isArray(selected)) return; isWorking = true; error = ''; render(); try { await invoke<EmbeddingModel>('register_embedding_model', { input: { path: selected } }); embeddingModels = await invoke<EmbeddingModel[]>('list_embedding_models'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function buildEmbeddingIndex() { isWorking = true; error = ''; render(); try { const progress = await invoke<EmbeddingIndexProgress>('build_embedding_index'); embeddingProgress = progress; embeddingModels = await invoke<EmbeddingModel[]>('list_embedding_models'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function buildMediaThumbnails() {
  isWorking = true; error = ''; render();
  try {
    const images = results.filter(isGalleryImage);
    const built = await Promise.all(images.map(async item => [item.id, await invoke<Thumbnail>('get_thumbnail', { input: { itemId: item.id, path: item.path } })] as const));
    mediaThumbnails = new Map(built);
  } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function clearThumbnailCache() {
  isWorking = true; error = ''; render();
  try { await invoke('clear_thumbnail_cache'); mediaThumbnails = new Map(); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function enqueueMediaTask(itemId: string, kind: MediaTask['kind']) { isWorking = true; error = ''; render(); try { await invoke('enqueue_media_task', { input: { itemId, kind } }); mediaTasks = await invoke<MediaTask[]>('list_media_tasks'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function cancelMediaTask(id: string) { isWorking = true; error = ''; render(); try { await invoke('cancel_media_task', { input: { id } }); mediaTasks = await invoke<MediaTask[]>('list_media_tasks'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function saveMediaSettings(event: SubmitEvent) { event.preventDefault(); const ocrLanguage = document.querySelector<HTMLInputElement>('#media-ocr-language')?.value.trim() ?? ''; const whisperModelPath = document.querySelector<HTMLInputElement>('#media-whisper-model')?.value.trim() ?? ''; isWorking = true; error = ''; formWarning = null; render(); try { mediaSettings = await invoke<MediaSettings>('save_media_settings', { input: { ocrLanguage, whisperModelPath } }); } catch (reason) { formWarning = { target: 'media', message: String(reason) }; } finally { isWorking = false; render(); } }
async function saveAgentPreferences() { const autoApplyLowRisk = document.querySelector<HTMLInputElement>('#auto-apply-low-risk')?.checked ?? false; try { agentPreferences = await invoke<AgentPreferences>('save_agent_preferences', { input: { autoApplyLowRisk } }); } catch (reason) { error = String(reason); } render(); }
async function saveRuntimeSettings(event: SubmitEvent) { event.preventDefault(); const executionMode = document.querySelector<HTMLSelectElement>('#runtime-mode')?.value as RuntimeSettings['executionMode'] ?? 'auto'; const threads = Number(document.querySelector<HTMLInputElement>('#runtime-threads')?.value ?? 4); const contextSize = Number(document.querySelector<HTMLInputElement>('#runtime-context')?.value ?? 4096); isWorking = true; error = ''; render(); try { runtimeSettings = await invoke<RuntimeSettings>('save_runtime_settings', { input: { executionMode, threads, contextSize } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function runEnvironmentAcceptance() { isWorking = true; error = ''; render(); try { acceptanceChecks = await invoke<AcceptanceCheck[]>('run_environment_acceptance'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function loadAgentEvidenceReport() { if (!agentRun) return; isWorking = true; error = ''; render(); try { agentEvidenceReport = await invoke<AgentEvidenceReport>('get_agent_evidence_report', { input: { runId: agentRun.id } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function ask(question: string) {
  isWorking = true; error = ''; agentRun = null; render();
  try {
    [results, agentRun] = await Promise.all([invoke<Result[]>('ask_assistant', { question }), invoke<AgentRun>('prepare_agent_run', { input: { question, conversationId: activeConversationId } })]);
    activeConversationId = agentRun.conversationId ?? activeConversationId;
    if (agentRun.route === 'cloud_auto') {
      await ensureAiWorkspace();
      agentRun = await invoke<AgentRun>('run_cloud_collaboration', { runId: agentRun.id });
      await autoApplyLowRiskAdvice();
    }
    await loadConversationHistory();
    agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } });
  } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function loadConversationHistory() { conversations = await invoke<Conversation[]>('list_conversations'); if (activeConversationId) conversationMessages = await invoke<ConversationMessage[]>('list_conversation_messages', { input: { conversationId: activeConversationId } }); }
async function saveCloudProvider(event: SubmitEvent) { event.preventDefault(); const providerId = document.querySelector<HTMLInputElement>('#cloud-provider-id')?.value.trim() ?? ''; const displayName = document.querySelector<HTMLInputElement>('#cloud-display-name')?.value.trim() ?? ''; const baseUrl = document.querySelector<HTMLInputElement>('#cloud-base-url')?.value.trim() ?? ''; const model = document.querySelector<HTMLSelectElement>('#cloud-model-select')?.value.trim() ?? ''; const apiKey = document.querySelector<HTMLInputElement>('#cloud-api-key')?.value ?? ''; const autoCollaboration = document.querySelector<HTMLInputElement>('#cloud-auto')?.checked ?? false; const reviewEachRequest = document.querySelector<HTMLInputElement>('#cloud-review')?.checked ?? false; isWorking = true; error = ''; formWarning = null; render(); try { cloudConfig = await invoke<CloudProviderConfig>('save_cloud_provider_config', { input: { providerId, displayName, baseUrl, model, apiKey, autoCollaboration, reviewEachRequest } }); cloudProviders = await invoke<CloudProviderConfig[]>('list_cloud_providers'); } catch (reason) { formWarning = { target: 'cloud', message: String(reason) }; } finally { isWorking = false; render(); } }
async function fetchCloudModels() { const providerId = document.querySelector<HTMLInputElement>('#cloud-provider-id')?.value.trim() ?? ''; if (!providerId) { formWarning = { target: 'cloud', message: '请先填写并保存供应商标识、地址和 API Key。' }; render(); return; } isWorking = true; error = ''; formWarning = null; render(); try { cloudModels = await invoke<CloudModel[]>('fetch_cloud_models', { input: { providerId } }); } catch (reason) { formWarning = { target: 'cloud', message: String(reason) }; } finally { isWorking = false; render(); } }
async function selectCloudProvider(providerId: string) { cloudConfig = providerId ? await invoke<CloudProviderConfig>('select_cloud_provider', { input: { providerId } }) : null; cloudModels = []; if (cloudConfig) cloudProviders = await invoke<CloudProviderConfig[]>('list_cloud_providers'); render(); }
async function openConversation(conversationId: string) { activeConversationId = conversationId; conversationMessages = await invoke<ConversationMessage[]>('list_conversation_messages', { input: { conversationId } }); render(); }
async function autoApplyLowRiskAdvice() {
  if (!agentRun || !aiOutputTarget || !agentPreferences.autoApplyLowRisk || agentRun.status !== 'awaiting_approval') return;
  try {
    workspaceAction = await invoke<WorkspaceActionResult>('auto_apply_low_risk_agent_advice', { input: { runId: agentRun.id, workspaceId: aiOutputTarget.workspaceId } });
    agentRun = { ...agentRun, status: workspaceAction.status, feedback: '已自动写入通过低风险规则校验的文件；未覆盖、不删除、不联网、不发布。' };
  } catch (reason) {
    // Unsafe or incomplete advice falls back to the existing explicit approval flow.
    error = `未自动执行：${String(reason)}`;
  }
}
async function runCloudCollaboration() { if (!agentRun) return; isWorking = true; error = ''; render(); try { await ensureAiWorkspace(); agentRun = await invoke<AgentRun>('run_cloud_collaboration', { runId: agentRun.id }); await autoApplyLowRiskAdvice(); await loadConversationHistory(); agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function approveAgentStep() { if (!agentRun) return; isWorking = true; error = ''; render(); try { await invoke('approve_agent_step', { input: { runId: agentRun.id } }); agentRun = { ...agentRun, status: 'approved', feedback: '已批准受控工作区写入；仍不会覆盖已有文件或执行外部操作。' }; } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function cancelAgentRun() { if (!agentRun || !window.confirm('取消后不会发送云端请求或写入文件。确定取消吗？')) return; isWorking = true; error = ''; render(); try { await invoke('cancel_agent_run', { input: { runId: agentRun.id } }); agentRun = { ...agentRun, status: 'cancelled', feedback: '任务已取消；未执行后续云端请求或本地写入。' }; } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function applyAgentAdvice() { if (!agentRun || !aiOutputTarget) { error = '请先创建 AI 工作区，再写入已批准的建议。'; render(); return; } isWorking = true; error = ''; workspaceAction = null; render(); try { workspaceAction = await invoke<WorkspaceActionResult>('apply_agent_advice', { input: { runId: agentRun.id, workspaceId: aiOutputTarget.workspaceId } }); agentRun = { ...agentRun, status: workspaceAction.status, feedback: '已写入受控工作区；未覆盖已有文件。' }; } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function applyAgentExistingEdits() { if (!agentRun || !aiOutputTarget) return; if (!window.confirm('将仅修改当前 AI 工作区内、建议明确列出的已有普通文件（每个文件最大 2 MB）。原文件会先复制到本机可恢复备份。继续吗？')) return; isWorking = true; error = ''; workspaceAction = null; render(); try { workspaceAction = await invoke<WorkspaceActionResult>('apply_agent_advice', { input: { runId: agentRun.id, workspaceId: aiOutputTarget.workspaceId, allowExistingEdits: true } }); agentRun = { ...agentRun, status: workspaceAction.status, feedback: '已修改已批准文件，并创建可恢复备份。' }; } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function installLocalTool(tool: string) { isWorking = true; error = ''; render(); try { await invoke<string>('install_local_tool', { input: { tool } }); localTools = await invoke<LocalToolStatus>('get_local_tool_status'); } catch (reason) { formWarning = { target: 'media', message: String(reason) }; } finally { isWorking = false; render(); } }
async function runWorkspaceCheck() { if (!aiOutputTarget) return; const command = document.querySelector<HTMLSelectElement>('#workspace-check-command')?.value ?? 'npm run build'; isWorking = true; error = ''; workspaceAction = null; render(); try { workspaceAction = await invoke<WorkspaceActionResult>('run_workspace_check', { input: { workspaceId: aiOutputTarget.workspaceId, command, runId: agentRun?.id } }); if (agentRun) { agentRun = { ...agentRun, status: workspaceAction.status }; agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } }); } } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function autoRepairAgentRun() { if (!agentRun || !aiOutputTarget) return; const command = document.querySelector<HTMLSelectElement>('#workspace-check-command')?.value ?? 'npm run build'; isWorking = true; error = ''; workspaceAction = null; render(); try { workspaceAction = await invoke<WorkspaceActionResult>('auto_repair_agent_run', { input: { runId: agentRun.id, workspaceId: aiOutputTarget.workspaceId, command } }); agentRun = { ...agentRun, status: workspaceAction.status, feedback: workspaceAction.status === 'repair_complete' ? '自动最小修复已通过固定检查。' : '自动最小修复后检查仍失败，已停止自动循环。' }; agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function retryAgentRun() { if (!agentRun) return; isWorking = true; error = ''; render(); try { agentRun = await invoke<AgentRun>('retry_agent_run', { input: { runId: agentRun.id } }); if (agentRun.route === 'cloud_auto') { await ensureAiWorkspace(); agentRun = await invoke<AgentRun>('run_cloud_collaboration', { runId: agentRun.id }); await autoApplyLowRiskAdvice(); } agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function deleteConversation(conversationId: string) { if (!window.confirm('删除该本地对话记录？此操作无法撤销。')) return; isWorking = true; error = ''; render(); try { await invoke('delete_conversation', { input: { conversationId } }); if (activeConversationId === conversationId) { activeConversationId = null; conversationMessages = []; } await loadConversationHistory(); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function deleteCloudProvider() { if (!cloudConfig || !window.confirm(`删除供应商“${cloudConfig.displayName}”及其 Windows 凭据？`)) return; isWorking = true; error = ''; render(); try { await invoke('delete_cloud_provider', { input: { providerId: cloudConfig.providerId } }); cloudConfig = null; cloudModels = []; cloudProviders = await invoke<CloudProviderConfig[]>('list_cloud_providers'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function saveSensitiveRule(event: SubmitEvent) { event.preventDefault(); const name = document.querySelector<HTMLInputElement>('#sensitive-rule-name')?.value.trim() ?? ''; const pattern = document.querySelector<HTMLInputElement>('#sensitive-rule-pattern')?.value.trim() ?? ''; isWorking = true; error = ''; formWarning = null; render(); try { await invoke<SensitiveRule>('save_sensitive_rule', { input: { name, pattern, enabled: true } }); sensitiveRules = await invoke<SensitiveRule[]>('list_sensitive_rules'); } catch (reason) { formWarning = { target: 'rules', message: String(reason) }; } finally { isWorking = false; render(); } }
async function updateSensitiveRule(rule: SensitiveRule, enabled: boolean) { isWorking = true; error = ''; render(); try { await invoke<SensitiveRule>('save_sensitive_rule', { input: { id: rule.id, name: rule.name, pattern: rule.pattern, enabled } }); sensitiveRules = await invoke<SensitiveRule[]>('list_sensitive_rules'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function deleteSensitiveRule(id: string) { if (!window.confirm('删除这条本地敏感规则？')) return; isWorking = true; error = ''; render(); try { await invoke('delete_sensitive_rule', { input: { id } }); sensitiveRules = await invoke<SensitiveRule[]>('list_sensitive_rules'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function exportLocalGovernance() { isWorking = true; error = ''; render(); try { governanceExport = await invoke<GovernanceExport>('export_local_governance'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function createEncryptedBackup() { isWorking = true; error = ''; render(); try { encryptedBackup = await invoke<EncryptedBackup>('create_encrypted_backup'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function restoreEncryptedBackup() { const selected = await open({ multiple: false, directory: false, filters: [{ name: '资料终端加密备份', extensions: ['ftbackup'] }], title: '选择加密备份' }); if (!selected || Array.isArray(selected)) return; isWorking = true; error = ''; render(); try { const result = await invoke<{ message: string }>('stage_encrypted_restore', { input: { path: selected } }); window.alert(result.message); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function scanSensitiveIndex() { isWorking = true; error = ''; render(); try { sensitiveFindings = await invoke<SensitiveFinding[]>('scan_sensitive_index'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function loadMetadataAudit() { isWorking = true; error = ''; render(); try { auditEntries = await invoke<MetadataAuditEntry[]>('list_metadata_audit', { input: { limit: 100 } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function clearLocalData(scope: string) { if (!window.confirm('此操作只清理选定的本地记录，不能撤销。确定继续吗？')) return; isWorking = true; error = ''; render(); try { await invoke('clear_local_data', { input: { scope } }); await refreshStatus(); governanceExport = null; if (scope === 'conversations') { activeConversationId = null; conversationMessages = []; } } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function loadPreview(path: string) { if (!path) return; isWorking = true; error = ''; render(); try { preview = await invoke<FilePreview>('preview_file', { path }); } catch (reason) { error = `无法预览文件：${String(reason)}`; } finally { isWorking = false; render(); } }
async function convertOfficePreview() { if (!preview) return; isWorking = true; error = ''; render(); try { preview = await invoke<FilePreview>('convert_office_preview', { path: preview.path }); } catch (reason) { error = `无法生成高保真预览：${String(reason)}`; } finally { isWorking = false; render(); } }
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
  document.querySelectorAll<HTMLElement>('.metadata-target').forEach(element => element.addEventListener('contextmenu', event => {
    const target = metadataTarget(element); if (!target) return;
    event.preventDefault(); contextTarget = target; contextPosition = { x: event.clientX, y: event.clientY }; render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-metadata-action]').forEach(button => button.addEventListener('click', () => editMetadata(button.dataset.metadataAction ?? '').catch(reason => { error = String(reason); render(); })));
  document.querySelectorAll<HTMLElement>('.folder-ref-button').forEach(button => button.addEventListener('click', () => openFolder(button.dataset.folderId ?? '').catch(reason => { error = `无法打开文件夹：${String(reason)}`; render(); })));
  document.querySelectorAll<HTMLElement>('.browser-folder').forEach(button => button.addEventListener('click', () => navigateFolder(button.dataset.path ?? '').catch(reason => { error = `无法读取文件夹：${String(reason)}`; render(); })));
  document.querySelector('#browser-back')?.addEventListener('click', () => browserBack().catch(reason => { error = `无法返回上级：${String(reason)}`; render(); }));
  document.querySelector('#browser-reveal')?.addEventListener('click', revealFolder);
  document.querySelector('#close-browser')?.addEventListener('click', () => { activeFolder = null; browserPath = null; browserHistory = []; folderEntries = []; render(); });
  document.querySelectorAll<HTMLElement>('.preview-file').forEach(button => button.addEventListener('click', () => loadPreview(button.dataset.path ?? '')));
  document.querySelector('#close-preview')?.addEventListener('click', () => { preview = null; render(); });
  document.querySelector('#reveal-file')?.addEventListener('click', revealPreview);
  document.querySelector('#high-fidelity-office-preview')?.addEventListener('click', convertOfficePreview);
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(button => button.addEventListener('click', () => { activeView = button.dataset.view as View; render(); }));
  document.querySelector('#import-folder')?.addEventListener('click', selectFolder); document.querySelector('#choose-folder')?.addEventListener('click', selectFolder); document.querySelector('#refresh')?.addEventListener('click', refreshStatus); document.querySelector('#download-runtime')?.addEventListener('click', () => provision('runtime')); document.querySelector('#download-model')?.addEventListener('click', () => provision('model'));
  document.querySelector('#register-local-model')?.addEventListener('click', registerLocalModel);
  document.querySelector('#register-embedding-model')?.addEventListener('click', registerEmbeddingModel);
  document.querySelector('#build-embedding-index')?.addEventListener('click', buildEmbeddingIndex);
  document.querySelector('#toggle-media-gallery')?.addEventListener('click', () => { mediaGalleryOpen = !mediaGalleryOpen; render(); });
  document.querySelector('#build-media-thumbnails')?.addEventListener('click', buildMediaThumbnails);
  document.querySelectorAll<HTMLButtonElement>('.install-local-tool').forEach(button => button.addEventListener('click', () => installLocalTool(button.dataset.tool ?? '')));
  document.querySelector('#clear-thumbnail-cache')?.addEventListener('click', clearThumbnailCache);
  document.querySelectorAll<HTMLButtonElement>('.enqueue-media-task').forEach(button => button.addEventListener('click', () => enqueueMediaTask(button.dataset.itemId ?? '', (button.dataset.mediaKind as MediaTask['kind']) ?? 'ocr')));
  document.querySelectorAll<HTMLButtonElement>('.cancel-media-task').forEach(button => button.addEventListener('click', () => cancelMediaTask(button.dataset.taskId ?? '')));
  document.querySelector<HTMLFormElement>('#media-settings')?.addEventListener('submit', saveMediaSettings);
  document.querySelectorAll<HTMLButtonElement>('[data-local-model-id]').forEach(button => button.addEventListener('click', () => selectLocalModel(button.dataset.localModelId ?? '')));
  document.querySelectorAll<HTMLButtonElement>('.delete-local-model').forEach(button => button.addEventListener('click', () => deleteLocalModel(button.dataset.deleteLocalModelId ?? '')));
  document.querySelectorAll<HTMLButtonElement>('[data-refresh-folder-id]').forEach(button => button.addEventListener('click', () => refreshFolderIndex(button.dataset.refreshFolderId ?? '')));
  document.querySelectorAll<HTMLButtonElement>('[data-pause-index-job]').forEach(button => button.addEventListener('click', () => pauseIndexJob(button.dataset.pauseIndexJob ?? '').catch(reason => { error = String(reason); render(); })));
  document.querySelectorAll<HTMLButtonElement>('[data-resume-index-job]').forEach(button => button.addEventListener('click', () => resumeIndexJob(button.dataset.resumeIndexJob ?? '').catch(reason => { error = String(reason); render(); })));
  document.querySelectorAll<HTMLButtonElement>('.remove-folder-reference').forEach(button => button.addEventListener('click', () => removeFolderReference(button.dataset.folderId ?? '')));
  document.querySelector('#install-update')?.addEventListener('click', installUpdate);
  document.querySelector('#choose-ai-output')?.addEventListener('click', chooseAiOutputFolder);
  document.querySelector('#create-ai-workspace')?.addEventListener('click', createAiWorkspace);
  document.querySelector<HTMLFormElement>('#cloud-provider-form')?.addEventListener('submit', saveCloudProvider);
  document.querySelector('#fetch-cloud-models')?.addEventListener('click', fetchCloudModels);
  document.querySelector<HTMLSelectElement>('#cloud-provider-select')?.addEventListener('change', event => selectCloudProvider((event.target as HTMLSelectElement).value));
  document.querySelector('#cloud-confirm')?.addEventListener('click', runCloudCollaboration);
  document.querySelector('#approve-agent-step')?.addEventListener('click', approveAgentStep);
  document.querySelector('#cancel-agent-run')?.addEventListener('click', cancelAgentRun);
  document.querySelector('#apply-agent-advice')?.addEventListener('click', applyAgentAdvice);
  document.querySelector('#apply-agent-existing-edits')?.addEventListener('click', applyAgentExistingEdits);
  document.querySelector('#run-workspace-check')?.addEventListener('click', runWorkspaceCheck);
  document.querySelector('#auto-repair-agent-run')?.addEventListener('click', autoRepairAgentRun);
  document.querySelector('#retry-agent-run')?.addEventListener('click', retryAgentRun);
  document.querySelector('#load-agent-evidence')?.addEventListener('click', loadAgentEvidenceReport);
  document.querySelector('#delete-cloud-provider')?.addEventListener('click', deleteCloudProvider);
  document.querySelector('#new-conversation')?.addEventListener('click', () => { activeConversationId = null; conversationMessages = []; render(); });
  document.querySelectorAll<HTMLButtonElement>('.conversation-item[data-conversation-id]').forEach(button => button.addEventListener('click', () => openConversation(button.dataset.conversationId ?? '').catch(reason => { error = String(reason); render(); })));
  document.querySelectorAll<HTMLButtonElement>('.delete-conversation').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); deleteConversation(button.dataset.conversationId ?? ''); }));
  document.querySelector<HTMLFormElement>('#sensitive-rule-form')?.addEventListener('submit', saveSensitiveRule);
  document.querySelectorAll<HTMLInputElement>('.sensitive-rule-toggle').forEach(input => input.addEventListener('change', () => { const rule = sensitiveRules.find(item => item.id === input.dataset.ruleId); if (rule) updateSensitiveRule(rule, input.checked); }));
  document.querySelectorAll<HTMLButtonElement>('.delete-sensitive-rule').forEach(button => button.addEventListener('click', () => deleteSensitiveRule(button.dataset.ruleId ?? '')));
  document.querySelector('#export-local-governance')?.addEventListener('click', exportLocalGovernance);
  document.querySelector('#create-encrypted-backup')?.addEventListener('click', createEncryptedBackup);
  document.querySelector('#restore-encrypted-backup')?.addEventListener('click', restoreEncryptedBackup);
  document.querySelector('#scan-sensitive-index')?.addEventListener('click', scanSensitiveIndex);
  document.querySelector('#load-metadata-audit')?.addEventListener('click', loadMetadataAudit);
  document.querySelectorAll<HTMLButtonElement>('#clear-local-data').forEach(button => button.addEventListener('click', () => clearLocalData(button.dataset.clearScope ?? '')));
  document.querySelector<HTMLFormElement>('#ask-form')?.addEventListener('submit', event => { event.preventDefault(); const question = document.querySelector<HTMLInputElement>('#question')?.value.trim() ?? ''; if (question) ask(question); });
  document.querySelector<HTMLInputElement>('#auto-apply-low-risk')?.addEventListener('change', saveAgentPreferences);
  document.querySelector<HTMLFormElement>('#runtime-settings')?.addEventListener('submit', saveRuntimeSettings);
  document.querySelector('#run-environment-acceptance')?.addEventListener('click', runEnvironmentAcceptance);
  document.querySelector<HTMLFormElement>('#search-form')?.addEventListener('submit', event => { event.preventDefault(); searchQuery = document.querySelector<HTMLInputElement>('#search-question')?.value.trim() ?? ''; searchFilter = document.querySelector<HTMLInputElement>('#search-filter')?.value.trim() ?? ''; searchFolderFilter = document.querySelector<HTMLSelectElement>('#search-folder-filter')?.value ?? ''; searchTypeFilter = document.querySelector<HTMLSelectElement>('#search-type-filter')?.value ?? ''; searchMode = (document.querySelector<HTMLSelectElement>('#search-mode')?.value ?? 'fts') as 'fts' | 'semantic'; searchDocuments(0); });
  document.querySelector('#search-page-previous')?.addEventListener('click', () => searchDocuments(Math.max(0, searchPage - 1)));
  document.querySelector('#search-page-next')?.addEventListener('click', () => searchDocuments(searchPage + 1));
}

document.addEventListener('click', () => { if (contextTarget) { contextTarget = null; render(); } });

listen<DownloadProgress>('download-progress', event => { progress = event.payload; render(); }).catch(reason => { error = `无法接收下载进度：${String(reason)}`; render(); });
listen<IndexProgress>('index-progress', event => { indexProgress = event.payload; render(); if (event.payload.phase === 'complete') window.setTimeout(() => { indexProgress = null; render(); }, 1_500); }).catch(reason => { error = `无法接收索引进度：${String(reason)}`; render(); });
listen<IndexJob>('index-job-progress', event => { const next = event.payload; indexJobs = [...indexJobs.filter(job => job.id !== next.id && job.status !== 'completed'), next].filter(job => job.status !== 'completed'); if (next.status === 'completed') { loadFolderRefs().then(render); scheduleEmbeddingUpdate(); } render(); }).catch(reason => { error = `无法接收索引任务：${String(reason)}`; render(); });
listen<FolderChangeDetected>('folder-change-detected', event => { scheduleFolderRefresh(event.payload); }).catch(reason => { error = `无法接收文件夹变动：${String(reason)}`; render(); });
listen<EmbeddingIndexProgress>('embedding-index-progress', event => { embeddingProgress = event.payload; render(); }).catch(reason => { error = `无法接收向量索引进度：${String(reason)}`; render(); });
listen<MediaTask>('media-task-progress', event => { mediaTasks = [event.payload, ...mediaTasks.filter(task => task.id !== event.payload.id)].slice(0, 100); render(); }).catch(reason => { error = `无法接收媒体任务状态：${String(reason)}`; render(); });
getCurrentWindow().onDragDropEvent(event => {
  if (event.payload.type !== 'drop') return;
  const paths = event.payload.paths;
  if (paths.length !== 1) { error = '请一次拖入一个文件夹。'; render(); return; }
  importFolderPath(paths[0]);
}).catch(reason => { error = `无法启用文件夹拖入：${String(reason)}`; render(); });
refreshStatus().catch(reason => { error = `无法连接桌面端：${String(reason)}`; render(); });

checkForUpdate();
