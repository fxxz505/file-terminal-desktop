import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import './styles.css';

type RuntimeStatus = { modelInstalled: boolean; runtimeInstalled: boolean; modelPath: string; activeModelName: string };
type CloudPolicy = 'local_only' | 'cloud_allowed' | 'ask_each_time' | 'inherit';
type Result = { id: string; itemType: string; name: string; path: string; displayPath: string; note: string; tags: string[]; cloudPolicy: CloudPolicy; score: number; contentStatus: string; contentReasonCode?: string; extractedChars: number; contentIndexedAt?: string };
type SearchDocumentsResult = { items: Result[]; total: number; page: number; pageSize: number; searchMode: 'fts' | 'semantic' | 'embedding_fallback_fts' };
type EmbeddingModel = { id: string; displayName: string; path: string; active: boolean; dimensions?: number };
type EmbeddingIndexProgress = { completed: number; total: number; failed: number };
type FolderRef = { id: string; name: string; path: string; displayPath: string; note: string; tags: string[]; cloudPolicy: CloudPolicy; itemCount: number; sourceStatus: 'available' | 'missing' };
type FolderEntry = { id: string; name: string; path: string; displayPath: string; itemType: 'folder' | 'file'; note: string; tags: string[]; cloudPolicy: CloudPolicy };
type MetadataTarget = { targetType: 'folder' | 'item'; targetId: string; name: string; note: string; tags: string[]; cloudPolicy: CloudPolicy };
type AiOutputTarget = { workspaceId: string; path: string; displayPath: string; isAppWorkspace: boolean };
type DownloadProgress = { kind: 'model' | 'runtime'; source?: string; completed: number; total?: number };
type UpdateCheckState = 'idle' | 'checking' | 'success' | 'error';
type FilePreview = { kind: 'image' | 'text' | 'pdf' | 'folder' | 'unsupported'; name: string; path: string; displayPath: string; mimeType: string; content: string; message: string; truncated: boolean };
type Thumbnail = { itemId: string; sourceSignature: string; mimeType: string; content: string; cached: boolean };
type MediaTask = { id: string; itemId: string; name: string; kind: 'ocr' | 'transcription'; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; error?: string; createdAt: string; updatedAt: string };
type MediaSettings = { whisperModelPath: string; ocrLanguage: string };
type LocalToolStatus = { pdfText: boolean; ffmpeg: boolean; ocr: boolean; transcription: boolean; officeConverter: boolean };
type CloudProviderConfig = { providerId: string; displayName: string; baseUrl: string; model: string; autoCollaboration: boolean; reviewEachRequest: boolean; configured: boolean };
type CloudDraft = { providerId: string; previousProviderId?: string; displayName: string; baseUrl: string; model: string; apiKey: string; autoCollaboration: boolean; reviewEachRequest: boolean };
type CloudModel = { id: string };
type CloudConnectionProbeResult = { endpoint: string; latencyMs: number };
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
type IndexDiagnosticItem = { id: string; folderId: string; name: string; path: string; displayPath: string; itemType: string; sourceSize?: number; sourceModifiedMs?: number; contentStatus: string; contentReasonCode?: string; extractedChars: number; contentIndexedAt?: string; mediaStatus?: string; embeddingStatus: string; thumbnailStatus: string };
type BackgroundTask = { id: string; taskType: string; target: string; status: string; progress: string; startedAt: string; error?: string; supportsPause: boolean; supportsCancel: boolean; supportsRetry: boolean };
type FolderWatchStatus = { folderId: string; mode: 'watching' | 'fallback_scan'; detail: string; lastCheckedAt: string };
type ManagedDownloadResource = { id: string; label: string; resourceType: 'whisper_model' | 'ocr_language'; status: 'installed' | 'not_installed'; path: string; bytes: number; source: string; canDelete: boolean };
type DownloadTask = { id: string; resourceId: string; label: string; status: string; completed: number; total?: number; error?: string; createdAt: string; updatedAt: string };
type FolderChangeDetected = { folderId: string; changedAt: string };
type AgentPreferences = { autoApplyLowRisk: boolean };
type PrivacyStatus = { databaseEncrypted: boolean; message: string; recommendation: string };
type RuntimeSettings = { executionMode: 'auto' | 'cpu' | 'gpu'; threads: number; contextSize: number };
type AcceptanceCheck = { id: string; label: string; status: 'passed' | 'failed' | 'manual' | 'skipped'; detail: string };
type AgentEvidenceReport = { runId: string; status: string; finalEvidence: string[]; restrictedBindings: number };
type EncryptedBackup = { path: string; displayPath: string; createdAt: string; databaseBytes: number };
type SensitiveFinding = { itemId: string; name: string; displayPath: string; category: string; matchCount: number };
type MetadataAuditEntry = { id: string; targetType: string; targetId: string; action: string; oldPolicy?: string; newPolicy?: string; createdAt: string };
type StartupMode = { recoveryRequired: boolean; message?: string; dataDirectory: string; recoveryDirectory: string };
type DataDirectoryStatus = { path: string; source: 'portable' | 'fresh_database'; portableAvailable: boolean; restartRequired: boolean };
type View = 'workspace' | 'search' | 'assistant' | 'diagnostics' | 'settings' | 'about';

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
let updateCheckState: UpdateCheckState = 'idle';
let updateStatus = '尚未检查更新';
let pendingUpdate: Update | null = null;
// GitHub release assets may be served through a proxy with an invalid compressed
// response. Asking for an identity response keeps reqwest from failing while
// decoding the body; the updater still verifies the downloaded signature.
const updaterRequestOptions = {
  timeout: 30000,
  headers: {
    Accept: 'application/json, application/octet-stream',
    'Accept-Encoding': 'identity',
  },
};
let contextTarget: MetadataTarget | null = null;
let contextPosition = { x: 0, y: 0 };
let metadataEditor: MetadataTarget | null = null;
let metadataEditorAction: 'note' | 'tags' | null = null;
let aiOutputFolder: string | null = null;
let aiOutputTarget: AiOutputTarget | null = null;
let cloudConfig: CloudProviderConfig | null = null;
let cloudProviders: CloudProviderConfig[] = [];
let cloudModels: CloudModel[] = [];
let cloudDraft: CloudDraft = { providerId: '', displayName: '', baseUrl: '', model: '', apiKey: '', autoCollaboration: false, reviewEachRequest: false };
let cloudOriginalProviderId: string | null = null;
let cloudApiKeyVisible = false;
let cloudConnectionStatus = '';
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
let diagnostics: IndexDiagnosticItem[] = [];
let diagnosticStatus = '';
let backgroundTasks: BackgroundTask[] = [];
let folderWatchStatuses: FolderWatchStatus[] = [];
let managedDownloadResources: ManagedDownloadResource[] = [];
let downloadTasks: DownloadTask[] = [];
let formWarning: { target: 'cloud' | 'media' | 'rules'; message: string } | null = null;
let startupMode: StartupMode | null = null;
let dataDirectoryStatus: DataDirectoryStatus | null = null;
const folderRefreshTimers = new Map<string, number>();
let embeddingUpdateTimer: number | null = null;
let fontScale = Number(localStorage.getItem('file-terminal.font-scale') ?? '100');

const icon = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${name}"/></svg>`;
const icons = {
  mark: icon('M5 3.75h9.25A2.75 2.75 0 0 1 17 6.5v11.75A2.75 2.75 0 0 1 14.25 21H5a2 2 0 0 1-2-2V5.75a2 2 0 0 1 2-2Zm1.5 4.5h7m-7 4h7m-7 4h4'),
  folder: icon('M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3l1.5 1.75h7.25A2.5 2.5 0 0 1 20.25 8.75v7.5a2.5 2.5 0 0 1-2.5 2.5H6a2.25 2.25 0 0 1-2.25-2.25v-9.75Z'),
  search: icon('m20 20-4.35-4.35m1.85-4.4a6.25 6.25 0 1 1-12.5 0 6.25 6.25 0 0 1 12.5 0Z'),
  spark: icon('m12 3 1.45 5.55L19 10l-5.55 1.45L12 17l-1.45-5.55L5 10l5.55-1.45L12 3Zm6.5 12.5.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z'),
  download: icon('M12 3.5v10m0 0 3.5-3.5M12 13.5 8.5 10M5 17.5v1.25A1.75 1.75 0 0 0 6.75 20.5h10.5A1.75 1.75 0 0 0 19 18.75V17.5'),
  check: icon('m5 12.5 4.25 4.25L19.5 6.5'),
  file: icon('M6 3.5h7L18 8v12.5H6zM13 3.5V8h5'),
  settings: icon('M12 8.25A3.75 3.75 0 1 0 12 15.75 3.75 3.75 0 0 0 12 8.25Zm0-5.25 1.05 2.1 2.3.35 1.65-1.65 2.2 2.2-1.65 1.65.35 2.3L21 12l-2.1 1.05-.35 2.3 1.65 1.65-2.2 2.2-1.65-1.65-2.3.35L12 21l-1.05-2.1-2.3-.35-1.65 1.65-2.2-2.2 1.65-1.65-.35-2.3L3 12l2.1-1.05.35-2.3L3.8 7 6 4.8l1.65 1.65 2.3-.35L12 3Z'),
  upload: icon('M12 16V4m0 0L7.75 8.25M12 4l4.25 4.25M4.5 16.5v2A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5v-2'),
};

function bytes(value = 0) { return value ? `${(value / 1024 / 1024).toFixed(value > 1024 * 1024 * 1024 ? 0 : 1)} MB` : '等待下载'; }
function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]!)); }
function displayPath(value: string) { return value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, ''); }
function stateChip(ready: boolean, waiting: string, readyText: string) { return `<span class="state setup-state ${ready ? 'ready' : ''}">${ready ? readyText : waiting}</span>`; }
function cloudPolicyLabel(policy: CloudPolicy) { return ({ local_only: '云端：禁止上传', cloud_allowed: '云端：允许上传', ask_each_time: '云端：每次询问', inherit: '云端：禁止上传' } as const)[policy]; }
function metadataLine(tags: string[], policy: CloudPolicy) { return `<div class="metadata-line"><span>${tags.length ? `标签：${tags.map(escapeHtml).join('，')}` : '标签：无'}</span><b class="cloud-policy ${policy}">${cloudPolicyLabel(policy)}</b></div>`; }

function resultRows(empty: string) {
  return results.length ? `<div class="results">${results.map(result => `<button class="result preview-file metadata-target" data-target-type="item" data-target-id="${escapeHtml(result.id)}" data-note="${escapeHtml(result.note)}" data-tags="${escapeHtml(JSON.stringify(result.tags))}" data-cloud-policy="${result.cloudPolicy}" data-name="${escapeHtml(result.name)}" data-path="${escapeHtml(result.path)}"><span>${result.itemType === 'folder' ? icons.folder : icons.file}</span><b>${escapeHtml(result.name)}</b><small>${escapeHtml(result.displayPath)}</small><em>匹配 ${result.score}</em><i class="index-state ${escapeHtml(result.contentStatus)}">${escapeHtml(result.contentStatus === 'indexed' ? '已索引正文' : result.contentStatus === 'failed' ? `提取失败${result.contentReasonCode ? `：${result.contentReasonCode}` : ''}` : '只索引元数据')}</i>${metadataLine(result.tags, result.cloudPolicy)}</button>`).join('')}</div>` : `<div class="result-placeholder">${empty}</div>`;
}

function diagnosticsPage() {
  const rows = diagnostics.map(item => `<article class="diagnostic-row"><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.displayPath)}</small></div><div><span class="index-state ${escapeHtml(item.contentStatus)}">${escapeHtml(item.contentStatus)}</span><small>${item.contentReasonCode ? escapeHtml(item.contentReasonCode) : `正文 ${item.extractedChars} 字`}</small></div><div><small>OCR/转写：${escapeHtml(item.mediaStatus ?? '未排队')} · 向量：${escapeHtml(item.embeddingStatus)} · 缩略图：${escapeHtml(item.thumbnailStatus)}</small><button class="quiet retry-diagnostic" data-item-id="${escapeHtml(item.id)}" ${item.itemType === 'file' ? '' : 'disabled'}>重试</button></div></article>`).join('');
  const failures = diagnostics.filter(item => ['failed', 'skipped'].includes(item.contentStatus));
  const pending = diagnostics.filter(item => item.contentStatus === 'pending').length;
  const summary = `<div class="diagnostics-summary" aria-label="索引诊断汇总"><span>总计 ${diagnostics.length}</span><span>待处理 ${pending}</span><span class="summary-attention">需处理 ${failures.length}</span></div>`;
  const empty = `<section class="diagnostic-empty" role="status"><span class="empty-state-icon">${icons.file}</span><div><strong>还没有可诊断的资料</strong><p>接入资料夹后，这里会显示每个文件的正文、OCR、向量和缩略图处理状态。</p></div><div class="empty-actions"><button class="primary" type="button" data-view="workspace">前往资料空间</button><button class="quiet refresh-diagnostics" type="button">刷新状态</button></div></section>`;
  return `<section class="single-panel panel diagnostics-page"><header><div class="page-header-copy"><small>INDEX DIAGNOSTICS</small><h2>索引处理状态</h2><span>只显示本机索引元数据，不会读取或导出正文。</span></div><div class="page-header-actions"><button class="quiet" id="refresh-diagnostics" type="button">刷新</button><button class="quiet" id="retry-failed-diagnostics" type="button" ${failures.length ? '' : 'disabled'}>重试失败项 (${failures.length})</button></div></header>${summary}<div class="diagnostic-filters"><label>状态筛选<select id="diagnostic-status"><option value="">全部状态</option><option value="failed">提取失败</option><option value="skipped">已跳过</option><option value="indexed">已索引</option><option value="pending">等待处理</option></select></label><button class="quiet" id="export-diagnostics" type="button">导出安全摘要</button></div>${diagnosticStatus ? `<p class="form-warning">${escapeHtml(diagnosticStatus)}</p>` : ''}<div class="diagnostic-list">${rows || empty}</div></section>`;
}

function tasksPage() {
  const rows = backgroundTasks.map(task => `<article class="task-row"><div><b>${escapeHtml(task.taskType)} · ${escapeHtml(task.target)}</b><small>${escapeHtml(task.progress)} · ${escapeHtml(task.startedAt)}</small></div><span class="index-state ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span><div>${task.supportsPause && task.status !== 'paused' ? `<button class="quiet pause-task" data-task-id="${escapeHtml(task.id)}">暂停</button>` : ''}${task.supportsPause && task.status === 'paused' ? `<button class="quiet resume-task" data-task-id="${escapeHtml(task.id)}">恢复</button>` : ''}${task.supportsCancel && ['queued','running'].includes(task.status) ? `<button class="quiet ${task.taskType.startsWith('download:') ? 'cancel-download-task' : 'cancel-task'}" data-task-id="${escapeHtml(task.id)}">取消</button>` : ''}${task.supportsRetry && ['failed','cancelled'].includes(task.status) ? `<button class="quiet ${task.taskType.startsWith('download:') ? 'retry-download-task' : 'retry-task'}" data-task-id="${escapeHtml(task.id)}">重试</button>` : ''}${task.error ? `<small>${escapeHtml(task.error)}</small>` : ''}</div></article>`).join('');
  const running = backgroundTasks.filter(task => task.status === 'running').length;
  const queued = backgroundTasks.filter(task => task.status === 'queued').length;
  const attention = backgroundTasks.filter(task => ['failed', 'cancelled', 'paused'].includes(task.status)).length;
  const summary = `<div class="tasks-summary" aria-label="后台任务汇总"><span>运行中 ${running}</span><span>等待中 ${queued}</span><span class="summary-attention">需处理 ${attention}</span></div>`;
  const empty = `<section class="task-empty" role="status"><span class="empty-state-icon">${icons.settings}</span><div><strong>当前没有后台任务</strong><p>索引、OCR、转写和模型下载开始后会显示在这里；支持暂停、取消或重试的操作也会一并提供。</p></div><div class="empty-actions"><button class="primary" type="button" data-view="workspace">前往资料空间</button><button class="quiet refresh-background-tasks" type="button">刷新状态</button></div></section>`;
  return `<section class="single-panel panel tasks-page"><header><div class="page-header-copy"><small>BACKGROUND TASKS</small><h2>队列与下载状态</h2><span>仅展示真实持久化的索引、媒体和下载任务。</span></div><div class="page-header-actions"><button class="quiet" id="refresh-background-tasks" type="button">刷新</button></div></header>${summary}<div class="task-list" data-testid="task-list">${rows || empty}</div></section>`;
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
  // 本机工具管理：固定清单安装或下载，用户选择的外部文件只登记。
  const tools: Array<{ id: 'tesseract' | 'ffmpeg' | 'libreoffice'; name: string; ready: boolean; detail: string }> = [
    { id: 'tesseract', name: 'Tesseract OCR', ready: localTools.ocr, detail: '图片文字识别；语言包可在安装后自行添加。' },
    { id: 'ffmpeg', name: 'FFmpeg', ready: localTools.ffmpeg, detail: '音视频安全转码，供本地 Whisper 使用。' },
    { id: 'libreoffice', name: 'LibreOffice', ready: localTools.officeConverter, detail: 'Office 文件隔离转换为 PDF 预览。' },
  ];
  const resources = managedDownloadResources.map(resource => `<div><section><b>${escapeHtml(resource.label)}</b><small>${resource.resourceType === 'whisper_model' ? '固定清单下载的本地 Whisper 模型。' : '固定清单下载的 Tesseract 简体中文语言包。'} ${resource.status === 'installed' ? `· ${bytes(resource.bytes)}` : ''}</small></section><span class="tool-state ${resource.status === 'installed' ? 'ready' : ''}">${resource.status === 'installed' ? '已校验' : '未安装'}</span>${resource.status === 'installed' ? `<button class="quiet delete-managed-resource" data-resource-id="${escapeHtml(resource.id)}">删除应用副本</button>` : `<button class="quiet download-managed-resource" data-resource-id="${escapeHtml(resource.id)}" ${isWorking ? 'disabled' : ''}>下载并校验</button>`}</div>`).join('');
  return `<section class="tool-manager" data-testid="managed-downloads"><header><div><b>本机工具与资源</b><span>固定工具由 winget 安装；固定模型与语言包从 HTTPS 清单下载并校验；用户选择的 embedding/外部模型仅登记，不会删除源文件。</span></div></header><div class="tool-list">${tools.map(tool => `<div><section><b>${tool.name}</b><small>${tool.detail}</small></section><span class="tool-state ${tool.ready ? 'ready' : ''}">${tool.ready ? '已可用' : '未安装'}</span>${tool.ready ? '' : `<button class="quiet install-local-tool" data-tool="${tool.id}" ${isWorking ? 'disabled' : ''}>安装固定包</button>`}</div>`).join('')}${resources || '<p>正在读取可下载资源。</p>'}</div></section>`;
}

function mediaTasksPanel() {
  const candidates = results.filter(item => mediaKind(item));
  const candidateRows = candidates.map(item => `<button class="quiet enqueue-media-task" data-item-id="${escapeHtml(item.id)}" data-media-kind="${mediaKind(item)}">${mediaKind(item) === 'ocr' ? 'OCR' : '转写'}：${escapeHtml(item.name)}</button>`).join('');
  const taskRows = mediaTasks.map(task => `<div><span>${escapeHtml(task.name)} · ${task.kind} · ${task.status}${task.error ? ` · ${escapeHtml(task.error)}` : ''}</span>${['queued', 'running'].includes(task.status) ? `<button class="quiet cancel-media-task" data-task-id="${escapeHtml(task.id)}">取消</button>` : ''}</div>`).join('');
  const warning = formWarning?.target === 'media' ? `<p class="form-warning" role="alert">${escapeHtml(formWarning.message)}</p>` : '';
  return `<section class="media-tasks"><header><div><b>本地 OCR 与音视频转写</b><span>识别文本只进入本机索引；工具未安装、超时或失败时不会生成结果。</span></div><form id="media-settings">${warning}<div class="control-cluster"><input id="media-ocr-language" maxlength="80" value="${escapeHtml(mediaSettings.ocrLanguage)}" placeholder="Tesseract 语言，例如 chi_sim+eng"><input id="media-whisper-model" readonly value="${escapeHtml(mediaSettings.whisperModelPath)}" placeholder="请选择本地 Whisper 模型"><button class="quiet" type="button" id="choose-whisper-model">选择模型</button><button class="quiet" type="submit">保存设置</button></div></form></header>${toolManager()}${candidateRows ? `<div class="media-candidates">${candidateRows}</div>` : '<p>搜索结果中没有可加入 OCR 或转写的媒体文件。</p>'}<div class="media-task-list">${taskRows || '<span>当前没有媒体任务。</span>'}</div></section>`;
}

function searchPanel() {
  const previousDisabled = searchPage === 0 ? 'disabled' : '';
  const nextDisabled = results.length === 0 || (searchPage + 1) * 30 >= searchTotal ? 'disabled' : '';
  const folderOptions = folderRefs.map(folder => `<option value="${escapeHtml(folder.id)}" ${folder.id === searchFolderFilter ? 'selected' : ''}>${escapeHtml(folder.name)}</option>`).join('');
  const semanticNote = appliedSearchMode === 'semantic' ? '语义向量排序（完全本机）' : appliedSearchMode === 'embedding_fallback_fts' ? '未配置 embedding 模型，已回退 FTS' : '关键词 / FTS 搜索';
  const embeddingModel = embeddingModels.find(model => model.active);
  const progressText = embeddingProgress ? `正在建立向量索引：${embeddingProgress.completed}/${embeddingProgress.total}${embeddingProgress.failed ? `，失败 ${embeddingProgress.failed}` : ''}` : embeddingModel ? `当前 embedding：${escapeHtml(embeddingModel.displayName)}${embeddingModel.dimensions ? ` · ${embeddingModel.dimensions} 维` : ''}` : '未配置本地 embedding 模型';
  return `<section class="single-panel panel"><header><div><small>LOCAL SEARCH</small><h2>本地搜索</h2></div><span class="local-chip">${icons.check} ${semanticNote}</span></header><div class="search-page"><h1>精确查找你的资料。</h1><p>输入名称、路径、备注、标签或已提取正文；不会发送到云端。</p><form id="search-form"><div class="large-search">${icons.search}<input data-testid="search-question" id="search-question" value="${escapeHtml(searchQuery)}" placeholder="例如：游戏、Steam、项目资料"><button type="submit" ${isWorking ? 'disabled' : ''}>搜索</button></div><div class="search-filters"><label>模式 <select id="search-mode"><option value="fts" ${searchMode === 'fts' ? 'selected' : ''}>关键词（FTS）</option><option value="semantic" ${searchMode === 'semantic' ? 'selected' : ''}>语义向量</option></select></label><label>标签 <input class="search-filter" id="search-filter" value="${escapeHtml(searchFilter)}" placeholder="例如：游戏"></label><label>资料夹 <select id="search-folder-filter"><option value="">全部资料夹</option>${folderOptions}</select></label><label>类型 <select id="search-type-filter"><option value="">文件和文件夹</option><option value="file" ${searchTypeFilter === 'file' ? 'selected' : ''}>仅文件</option><option value="folder" ${searchTypeFilter === 'folder' ? 'selected' : ''}>仅文件夹</option></select></label></div></form><section class="semantic-search"><b>本地语义检索</b><span>${progressText}</span><button class="quiet" id="register-embedding-model" ${isWorking ? 'disabled' : ''}>选择 embedding GGUF</button><button class="quiet" id="build-embedding-index" ${isWorking || !embeddingModel ? 'disabled' : ''}>建立 / 更新向量索引</button><button class="quiet" id="toggle-media-gallery">${mediaGalleryOpen ? '收起图库' : '图库浏览'}</button></section>${mediaGallery()}${mediaTasksPanel()}${resultRows('输入检索词后，结果会在这里显示真实路径。')}<div class="search-paging"><button class="quiet" id="search-page-previous" ${previousDisabled}>上一页</button><span>${searchTotal ? `第 ${searchPage + 1} 页，共 ${searchTotal} 项` : '暂无搜索结果'}</span><button class="quiet" id="search-page-next" ${nextDisabled}>下一页</button></div></div></section>`;
}

function conversationPage() {
  const history = conversations.length ? conversations.map(conversation => `<div class="conversation-row"><button class="conversation-item ${conversation.id === activeConversationId ? 'active' : ''}" data-conversation-id="${escapeHtml(conversation.id)}"><b>${escapeHtml(conversation.title)}</b><small>${escapeHtml(conversation.updatedAt)}</small></button><button class="quiet danger delete-conversation" data-conversation-id="${escapeHtml(conversation.id)}" aria-label="删除对话">删除</button></div>`).join('') : '<div class="conversation-empty"><b>还没有保存的对话</b><span>开始提问后，对话会自动保存在本机。</span></div>';
  const messages = conversationMessages.length ? conversationMessages.map(message => `<article class="chat-message ${escapeHtml(message.role)}"><header><b>${message.role === 'user' ? '你' : message.source === 'cloud' ? '云端 AI' : '本地 AI'}</b><span>${escapeHtml(message.createdAt)}</span></header><p>${escapeHtml(message.parsedReply?.answer ?? message.content)}</p>${message.parsedReply?.steps.length ? `<ol>${message.parsedReply.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : ''}</article>`).join('') : '<p class="chat-empty">选择一段对话，或在“AI 助手”中开始新任务。</p>';
  return `<section class="single-panel panel"><header><div><small>LOCAL HISTORY</small><h2>AI 对话</h2></div><button class="quiet" data-view="assistant">开始新对话</button></header><div class="conversation-page"><section class="conversation-layout standalone"><aside class="conversation-history"><header><b>本机对话记录</b><small>${conversations.length} 段</small></header>${history}</aside><section class="conversation-messages"><header><div><b>对话内容</b><span>本地与云端回答均以文本保存在本机</span></div></header>${messages}</section></section></div></section>`;
}

function cloudProviderSettings() {
  const configLabel = cloudConfig?.configured ? `已启用：${escapeHtml(cloudConfig.displayName)}${cloudConfig.model ? ` / ${escapeHtml(cloudConfig.model)}` : ''}` : '填写后可先测试连接；测试不会保存密钥。';
  const providerOptions = cloudProviders.map(provider => `<option value="${escapeHtml(provider.providerId)}" ${provider.providerId === cloudConfig?.providerId ? 'selected' : ''}>${escapeHtml(provider.displayName)}${provider.configured ? '' : '（未填密钥）'}</option>`).join('');
  const cloudWarning = formWarning?.target === 'cloud' ? `<p class="form-warning" role="alert">${escapeHtml(formWarning.message)}</p>` : '';
  return `<section class="cloud-settings cloud-provider-card"><form id="cloud-provider-form">${cloudWarning}<div class="cloud-settings-heading cloud-provider-heading"><b>云端 AI 配置</b><span>${configLabel}</span><small>兼容 OpenAI 格式上游。API Key 只会写入 Windows 凭据管理器，不进入对话或数据库。</small></div><label>已保存供应商<select id="cloud-provider-select"><option value="">新建供应商</option>${providerOptions}</select></label><label>配置名称<input id="cloud-display-name" maxlength="80" value="${escapeHtml(cloudDraft.displayName)}" placeholder="例如：我的 OpenAI 兼容服务"></label><label class="cloud-base-url-field">基础地址<input id="cloud-base-url" maxlength="240" value="${escapeHtml(cloudDraft.baseUrl)}" placeholder="https://api.example.com 或 https://api.example.com/v1"><small>可直接粘贴 CCSwitch 的基础地址；末尾含 /models 或 /chat/completions 也会自动规范化。</small></label><label>模型<input id="cloud-model-input" list="cloud-model-options" maxlength="160" value="${escapeHtml(cloudDraft.model)}" placeholder="可手动填写，或点击获取模型"><datalist id="cloud-model-options">${cloudModels.map(item => `<option value="${escapeHtml(item.id)}"></option>`).join('')}</datalist><select id="cloud-model-select" aria-label="已发现模型"><option value="">选择已发现模型（可选）</option>${cloudModels.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === cloudDraft.model ? 'selected' : ''}>${escapeHtml(item.id)}</option>`).join('')}</select></label><label>API Key<input id="cloud-api-key" type="password" autocomplete="off" value="${escapeHtml(cloudDraft.apiKey)}" placeholder="输入新密钥，留空则使用已保存的 Windows 凭据"></label><div class="cloud-actions control-cluster"><button class="quiet" id="test-cloud-connection" type="button">测试连接</button><button class="quiet" id="fetch-cloud-models" type="button">获取模型</button><button class="primary" type="submit">保存并启用</button>${cloudConfig ? `<button class="quiet danger" id="delete-cloud-provider" type="button">删除供应商</button>` : ''}</div><p class="cloud-form-note">${cloudConnectionStatus ? escapeHtml(cloudConnectionStatus) : '测试连接和获取模型只使用本次输入，不会保存或清空 API Key。模型列表是辅助功能；上游不支持 /models 时，手动填写模型并测试连接即可。'}</p><label class="check-row"><input id="cloud-auto" type="checkbox" ${cloudDraft.autoCollaboration ? 'checked' : ''}> 复杂任务自动协作</label><label class="check-row"><input id="cloud-review" type="checkbox" ${cloudDraft.reviewEachRequest ? 'checked' : ''}> 每次请求先确认</label></form></section>`;
}

function cloudDraftFromConfig(config: CloudProviderConfig | null): CloudDraft {
  return {
    providerId: config?.providerId ?? crypto.randomUUID(),
    previousProviderId: config?.providerId,
    displayName: config?.displayName ?? '',
    baseUrl: config?.baseUrl ?? '',
    model: config?.model ?? '',
    apiKey: '',
    autoCollaboration: config?.autoCollaboration ?? false,
    reviewEachRequest: config?.reviewEachRequest ?? false,
  };
}

function syncCloudDraftFromDom() {
  cloudDraft = {
    providerId: cloudDraft.providerId || crypto.randomUUID(),
    displayName: document.querySelector<HTMLInputElement>('#cloud-display-name')?.value.trim() ?? cloudDraft.displayName,
    baseUrl: normalizeCloudBaseUrl(document.querySelector<HTMLInputElement>('#cloud-base-url')?.value ?? cloudDraft.baseUrl),
    model: document.querySelector<HTMLInputElement>('#cloud-model-input')?.value.trim() ?? cloudDraft.model,
    apiKey: document.querySelector<HTMLInputElement>('#cloud-api-key')?.value ?? cloudDraft.apiKey,
    autoCollaboration: document.querySelector<HTMLInputElement>('#cloud-auto')?.checked ?? cloudDraft.autoCollaboration,
    reviewEachRequest: document.querySelector<HTMLInputElement>('#cloud-review')?.checked ?? cloudDraft.reviewEachRequest,
    previousProviderId: cloudOriginalProviderId ?? undefined,
  };
}

function refreshCloudCredentialHint() {
  const hint = document.querySelector<HTMLElement>('#cloud-credential-status');
  const input = document.querySelector<HTMLInputElement>('#cloud-api-key');
  const savedForDraft = cloudConfig?.providerId === cloudDraft.providerId && cloudConfig.configured;
  if (!hint) return;
  if (input?.value) {
    hint.textContent = '本次输入尚未保存；可先测试连接或获取模型，只有“保存并启用”才会写入 Windows 凭据管理器。';
    hint.dataset.state = 'pending';
  } else if (savedForDraft) {
    hint.textContent = '已保存到 Windows 凭据管理器；留空会继续使用该密钥。';
    hint.dataset.state = 'saved';
  } else {
    hint.textContent = '尚未保存密钥。填写后可先测试连接；测试不会保存密钥。';
    hint.dataset.state = 'missing';
  }
}

function setupCloudProviderForm() {
  const cloud = document.querySelector<HTMLElement>('.cloud-settings');
  const heading = cloud?.querySelector<HTMLElement>('.cloud-settings-heading');
  cloud?.classList.add('cloud-provider-card');
  heading?.classList.add('cloud-provider-heading');
  document.querySelector('#cloud-provider-select')?.closest('label')?.classList.add('cloud-saved-provider-field');
  document.querySelector('#cloud-display-name')?.closest('label')?.classList.add('cloud-provider-name-field');
  document.querySelector('#cloud-model-input')?.closest('label')?.classList.add('cloud-model-field');
  const apiKey = document.querySelector<HTMLInputElement>('#cloud-api-key');
  const apiKeyLabel = apiKey?.closest('label');
  apiKeyLabel?.classList.add('cloud-secret-control');
  if (!apiKey || !apiKeyLabel || document.querySelector('#cloud-credential-status')) return;
  apiKey.type = cloudApiKeyVisible ? 'text' : 'password';
  const secretRow = document.createElement('div');
  secretRow.className = 'cloud-secret-meta';
  const hint = document.createElement('small');
  hint.id = 'cloud-credential-status';
  hint.setAttribute('aria-live', 'polite');
  const toggle = document.createElement('button');
  toggle.id = 'cloud-api-key-visibility';
  toggle.type = 'button';
  toggle.className = 'quiet cloud-api-key-visibility';
  toggle.setAttribute('aria-label', cloudApiKeyVisible ? '隐藏 API Key' : '显示 API Key');
  toggle.textContent = cloudApiKeyVisible ? '隐藏' : '显示';
  toggle.addEventListener('click', () => {
    cloudApiKeyVisible = !cloudApiKeyVisible;
    apiKey.type = cloudApiKeyVisible ? 'text' : 'password';
    toggle.textContent = cloudApiKeyVisible ? '隐藏' : '显示';
    toggle.setAttribute('aria-label', cloudApiKeyVisible ? '隐藏 API Key' : '显示 API Key');
  });
  secretRow.append(hint, toggle);
  apiKeyLabel.append(secretRow);
  refreshCloudCredentialHint();
}

function restoreCloudDraftToDom() {
  const fields: Array<[string, string]> = [['#cloud-display-name', cloudDraft.displayName], ['#cloud-base-url', cloudDraft.baseUrl], ['#cloud-api-key', cloudDraft.apiKey]];
  fields.forEach(([selector, value]) => { const input = document.querySelector<HTMLInputElement>(selector); if (input && value) input.value = value; });
  const model = document.querySelector<HTMLInputElement>('#cloud-model-input');
  if (model) model.value = cloudDraft.model;
  const auto = document.querySelector<HTMLInputElement>('#cloud-auto'); if (auto) auto.checked = cloudDraft.autoCollaboration;
  const review = document.querySelector<HTMLInputElement>('#cloud-review'); if (review) review.checked = cloudDraft.reviewEachRequest;
}

function normalizeCloudBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/(?:v1\/)?(?:models|chat\/completions)$/i, '').replace(/\/v1$/i, '');
}

function defaultCloudDisplayName(baseUrl: string) {
  try { return new URL(baseUrl).hostname.replace(/^www\./i, '') || '云端 AI 服务'; }
  catch { return '云端 AI 服务'; }
}

function assistantPanel() {
  const outputText = aiOutputTarget ? `本次工作区：${escapeHtml(aiOutputTarget.displayPath)}` : aiOutputFolder ? `下次写入：${escapeHtml(displayPath(aiOutputFolder))}` : '未指定时保存到软件的 AI Outputs 文件夹';
  const workspaceActions = aiOutputTarget ? `<div class="workspace-output-actions"><button class="quiet" id="open-ai-output-folder">在软件中查看输出文件夹</button><button class="quiet" id="reveal-ai-output-folder">在资源管理器中打开</button></div>` : '';
  const cloudEscalation = agentRun?.status === 'needs_cloud_assistance'
    ? agentRun.route === 'cloud_auto'
      ? `<button class="quiet" id="retry-agent-run" ${isWorking ? 'disabled' : ''}>请求云端协作</button>`
      : agentRun.route === 'cloud_needs_confirmation'
        ? `<button class="primary" id="cloud-confirm" ${isWorking ? 'disabled' : ''}>确认发送脱敏请求</button>`
        : `<button class="quiet" data-view="settings">前往云端 AI 配置</button>`
    : '';
  const taskControls = !agentRun ? '' : `<div class="agent-actions">${agentRun.status === 'awaiting_local_execution' ? `<button class="primary" id="run-local-agent-task" ${isWorking ? 'disabled' : ''}>生成本地工作区方案</button>` : ''}${cloudEscalation}${agentRun.route === 'cloud_needs_confirmation' && agentRun.status === 'awaiting_confirmation' ? `<button class="primary" id="cloud-confirm" ${isWorking ? 'disabled' : ''}>确认发送脱敏请求</button>` : ''}${agentRun.status === 'awaiting_approval' ? `<button class="primary" id="approve-agent-step" ${isWorking ? 'disabled' : ''}>批准工作区写入</button>` : ''}${agentRun.status === 'approved' ? `<button class="primary" id="apply-agent-advice" ${!aiOutputTarget || isWorking ? 'disabled' : ''}>仅新建文件</button><button class="quiet" id="apply-agent-existing-edits" ${!aiOutputTarget || isWorking ? 'disabled' : ''}>批准后修改已有文件</button>` : ''}${['files_written', 'check_failed'].includes(agentRun.status) && aiOutputTarget ? `<button class="quiet" id="run-workspace-check" ${isWorking ? 'disabled' : ''}>运行构建检查</button><select id="workspace-check-command"><option>npm run build</option><option>npm test</option><option>cargo check</option><option>cargo test</option></select>${agentRun.route === 'cloud_auto' && agentRun.status === 'check_failed' ? `<button class="quiet" id="auto-repair-agent-run" ${isWorking ? 'disabled' : ''}>自动最小修复</button>` : ''}` : ''}${['check_failed', 'cancelled'].includes(agentRun.status) ? `<button class="quiet" id="retry-agent-run" ${isWorking ? 'disabled' : ''}>重试协作</button>` : ''}${!['cancelled', 'check_complete', 'local_complete', 'repair_complete', 'needs_cloud_assistance'].includes(agentRun.status) ? `<button class="quiet danger" id="cancel-agent-run" ${isWorking ? 'disabled' : ''}>取消任务</button>` : ''}</div>`;
  const timeline = agentEvents.length ? `<ol class="agent-timeline">${agentEvents.map(event => `<li><b>${escapeHtml(event.status)}</b><span>${escapeHtml(event.message)}</span><small>${escapeHtml(event.createdAt)}</small></li>`).join('')}</ol>` : '';
  const evidence = agentEvidenceReport ? `<details class="agent-evidence-report" open><summary>最终证据报告：${escapeHtml(agentEvidenceReport.status)} · 本地受限绑定 ${agentEvidenceReport.restrictedBindings}</summary><ol>${agentEvidenceReport.finalEvidence.map(escapeHtml).map(item => `<li>${item}</li>`).join('')}</ol></details>` : '';
  const runFeedback = agentRun ? `<section class="agent-feedback"><div><b>任务路由：${escapeHtml(agentRun.route)} · ${escapeHtml(agentRun.status)}</b><span>${escapeHtml(agentRun.reason)}</span></div><dl><div><dt>允许外发</dt><dd>${agentRun.sourceCount}</dd></div><div><dt>本地受限</dt><dd>${agentRun.restrictedSourceCount}</dd></div><div><dt>已脱敏</dt><dd>${agentRun.redactionCount}</dd></div></dl><p>${escapeHtml(agentRun.feedback)}</p>${sourceCitations(agentRun.sourceCitations)}${agentRun.route === 'cloud_needs_confirmation' ? `<details><summary>查看本次内存中的脱敏请求</summary><pre>${escapeHtml(agentRun.requestPreview)}</pre></details>` : ''}${agentRun.cloudAdvice ? `<details open><summary>云端结构化建议（未执行）</summary><p>${escapeHtml(agentRun.cloudAdvice.answer)}</p><p>${agentRun.cloudAdvice.uncertainties.map(escapeHtml).join('；')}</p></details>` : ''}${timeline}<button class="quiet" id="load-agent-evidence">生成最终证据报告</button>${evidence}${taskControls}${workspaceAction ? `<pre class="workspace-action">${escapeHtml(workspaceAction.output)}${workspaceAction.writtenFiles.length ? `\n已写入：\n${workspaceAction.writtenFiles.map(escapeHtml).join('\n')}` : ''}</pre>` : ''}</section>` : '';
  const messages = conversationMessages.map(message => `<article class="chat-message ${message.role}"><header><b>${message.role === 'user' ? '你' : message.source === 'cloud' ? '云端 AI' : '本地 AI'}</b><span>${message.source === 'cloud' ? '云端' : '本地'}</span></header><p>${escapeHtml(message.parsedReply?.answer ?? message.content)}</p>${message.parsedReply?.steps.length ? `<ol>${message.parsedReply.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : ''}${message.parsedReply?.codeBlocks ? `<small>包含 ${message.parsedReply.codeBlocks} 个代码块，仅展示，不会自动执行。</small>` : ''}</article>`).join('') || '<p class="chat-empty">开始一次提问后，本地和云端的回答都会保存在这里。</p>';
  const history = conversations.map(conversation => `<div class="conversation-row"><button class="conversation-item ${conversation.id === activeConversationId ? 'active' : ''}" data-conversation-id="${escapeHtml(conversation.id)}"><b>${escapeHtml(conversation.title)}</b><small>${escapeHtml(conversation.updatedAt)}</small></button><button class="quiet delete-conversation" data-conversation-id="${escapeHtml(conversation.id)}">删除</button></div>`).join('') || '<p>暂无保存的对话。</p>';
  const ruleList = sensitiveRules.map(rule => `<div class="rule-item"><label><input class="sensitive-rule-toggle" data-rule-id="${escapeHtml(rule.id)}" type="checkbox" ${rule.enabled ? 'checked' : ''}> <b>${escapeHtml(rule.name)}</b><small>${escapeHtml(rule.pattern)}</small></label><button class="quiet delete-sensitive-rule" data-rule-id="${escapeHtml(rule.id)}">删除</button></div>`).join('') || '<p>没有自定义规则；内置密钥、电话、邮件等脱敏始终有效。</p>';
  const governance = governanceExport ? `<pre class="governance-export">${escapeHtml(JSON.stringify(governanceExport, null, 2))}</pre>` : '';
  const backup = encryptedBackup ? `<p>已创建加密备份：${escapeHtml(encryptedBackup.displayPath)}（${bytes(encryptedBackup.databaseBytes)}）。恢复需要同一 Windows 用户凭据，选择后将在重启时替换。</p>` : '';
  const sensitiveReport = sensitiveFindings.length ? `<ul class="audit-list">${sensitiveFindings.map(item => `<li><b>${escapeHtml(item.category)}</b> · ${escapeHtml(item.name)} · ${item.matchCount} 处 <small>${escapeHtml(item.displayPath)}</small></li>`).join('')}</ul>` : '<p>尚未扫描，或未在已提取正文中发现内置规则匹配项。</p>';
  const auditReport = auditEntries.length ? `<ul class="audit-list">${auditEntries.map(item => `<li><b>${escapeHtml(item.targetType)}</b> · ${escapeHtml(item.action)} · ${escapeHtml(item.createdAt)} <small>${escapeHtml(item.oldPolicy ?? '-')} → ${escapeHtml(item.newPolicy ?? '-')}</small></li>`).join('')}</ul>` : '<p>尚未加载审计记录。</p>';
  const rulesWarning = formWarning?.target === 'rules' ? `<p class="form-warning" role="alert">${escapeHtml(formWarning.message)}</p>` : '';
  const taskButtonLabel = isWorking ? '正在启动任务…' : '开始任务';
  const taskStatus = isWorking ? '<p class="task-starting" role="status"><span></span>正在创建本地任务、检索素材并准备受控工作区…</p>' : '';
  return `<section class="single-panel panel"><header><div><small>LOCAL / CLOUD COLLABORATION</small><h2>AI 协作台</h2></div><span class="local-chip">${icons.check} 本机优先</span></header><div class="assistant-page"><div class="assistant-intro"><span>${icons.spark}</span><div><h1>把任务交给 AI 协作</h1><p>本地 AI 先检索、理解和生成；能力不足时按云端权限策略协作，所有写入均在受控工作区内。</p></div></div><form id="ask-form"><label>你想完成什么？<div class="ask-row"><input id="question" maxlength="180" placeholder="例如：使用已接入图片制作可点击切换的 HTML 网页"><button ${isWorking ? 'disabled' : ''} type="submit">${icons.spark} ${taskButtonLabel}</button></div></label>${taskStatus}</form><section class="ai-output"><div><b>AI 写入位置</b><span>${outputText}</span></div><button class="quiet" id="choose-ai-output">选择 AI 写入文件夹</button><button class="quiet" id="create-ai-workspace">创建 AI 工作区</button>${workspaceActions}</section>${runFeedback}<section class="assistant-workbench"><aside class="conversation-history"><header><b>任务与 AI 对话</b><small>${conversations.length} 段</small></header>${history}</aside><section class="conversation-messages"><header><div><b>当前任务对话</b><span>本地分析、云端协作与执行状态都保存在本机</span></div></header>${messages}</section></section><section class="sensitive-rules"><header><div><b>本地敏感规则</b><span>规则仅在准备云端请求时生效；无匹配的规则会阻止外发。</span></div></header>${rulesWarning}<form id="sensitive-rule-form"><input id="sensitive-rule-name" maxlength="80" placeholder="规则名称，例如：客户编号"><input id="sensitive-rule-pattern" maxlength="500" placeholder="正则表达式，例如：CLIENT-[0-9]+"><button class="quiet" type="submit">添加规则</button></form>${ruleList}</section><section class="governance-controls"><b>本地数据治理</b><span>导出不包含 API Key、云端原始请求或原始受限资料。</span><div class="control-cluster"><button class="quiet" id="create-encrypted-backup">创建加密备份</button><button class="quiet" id="restore-encrypted-backup">选择加密备份恢复</button><button class="quiet" id="scan-sensitive-index">生成敏感扫描报告</button><button class="quiet" id="load-metadata-audit">查看元数据审计</button><button class="quiet" id="export-local-governance">导出治理摘要</button><button class="quiet danger" id="clear-local-data" data-clear-scope="conversations">清理对话</button><button class="quiet danger" id="clear-local-data" data-clear-scope="audit">清理审计</button><button class="quiet danger" id="clear-local-data" data-clear-scope="rules">清理规则</button></div>${backup}${sensitiveReport}${auditReport}${governance}</section>${resultRows('完成本地检索后会显示命中资料；受限资料绝不会外发。')}</div></section>`;
}

function folderList() {
  if (!folderRefs.length) return `<div class="empty-folder drop-target"><span>${icons.folder}</span><strong>拖入文件夹开始</strong><p>把一个文件夹拖入此窗口，或选择本机文件夹。资料会原位建立索引，保留空目录和层级。</p><button class="outline" id="choose-folder">选择本机文件夹</button></div>`;
  return `<div class="imported-folders">${folderRefs.map(folder => `<div class="folder-reference-row"><button class="folder-ref folder-ref-button metadata-target" data-folder-id="${escapeHtml(folder.id)}" data-target-type="folder" data-target-id="${escapeHtml(folder.id)}" data-note="${escapeHtml(folder.note)}" data-tags="${escapeHtml(JSON.stringify(folder.tags))}" data-cloud-policy="${folder.cloudPolicy}" data-name="${escapeHtml(folder.name)}"><span>${icons.folder}</span><div><b>${escapeHtml(folder.name)}</b><small>${escapeHtml(folder.displayPath)}</small>${folder.note ? `<p>${escapeHtml(folder.note)}</p>` : ''}${metadataLine(folder.tags, folder.cloudPolicy)}</div><em>${folder.sourceStatus === 'missing' ? '原位置不可用' : `${folder.itemCount} 项索引`}</em></button><button class="quiet danger remove-folder-reference" data-folder-id="${escapeHtml(folder.id)}">移除引用</button></div>`).join('')}</div>`;
}

function folderBrowser() {
  if (!activeFolder) return '';
  const currentPath = browserPath ?? activeFolder.path;
  return `<section class="folder-browser panel" data-testid="folder-browser"><header><div><small>INLINE BROWSER</small><h2>${escapeHtml(activeFolder.name)}</h2><span>${escapeHtml(displayPath(browserPath ?? activeFolder.displayPath))}</span></div><div><button class="quiet" id="browser-back" ${browserHistory.length ? '' : 'disabled'}>返回上级</button><button class="quiet" id="browser-reveal">在资源管理器中打开</button><button class="quiet" id="close-browser">关闭</button></div></header><div class="browser-items">${folderEntries.length ? folderEntries.map(entry => `<button class="browser-entry ${entry.itemType === 'folder' ? 'browser-folder' : 'preview-file'} metadata-target" data-target-type="item" data-target-id="${escapeHtml(entry.id)}" data-note="${escapeHtml(entry.note)}" data-tags="${escapeHtml(JSON.stringify(entry.tags))}" data-cloud-policy="${entry.cloudPolicy}" data-name="${escapeHtml(entry.name)}" data-path="${escapeHtml(entry.path)}"><span>${entry.itemType === 'folder' ? icons.folder : icons.file}</span><b>${escapeHtml(entry.name)}</b><small>${escapeHtml(entry.displayPath)}</small>${metadataLine(entry.tags, entry.cloudPolicy)}</button>`).join('') : `<p>此文件夹为空。</p>`}</div><input type="hidden" value="${escapeHtml(currentPath)}"></section>`;
}

function workspacePanel() {
  const percent = progress?.total ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;
  const modelState = stateChip(status.modelInstalled, '未安装', '已安装');
  const runtimeState = stateChip(status.runtimeInstalled, '待下载', '已就绪');
  const models = localModels.map(model => `<div class="model-row"><button class="model-item ${model.active ? 'active' : ''}" data-local-model-id="${escapeHtml(model.id)}"><b>${escapeHtml(model.displayName)}</b><small>${escapeHtml(displayPath(model.path))}</small>${model.active ? '<em>当前使用</em>' : ''}</button><button class="quiet danger delete-local-model" data-delete-local-model-id="${escapeHtml(model.id)}">移除记录</button></div>`).join('');
  const folderActions = folderRefs.length ? `<div class="folder-index-actions">${folderRefs.map(folder => `<button class="quiet" data-refresh-folder-id="${escapeHtml(folder.id)}">刷新：${escapeHtml(folder.name)}</button>`).join('')}</div>` : '';
  return `<section class="workspace-view"><div class="workspace-head"><div><p>本地资料管理</p><h1>把文件夹交给一个真正本地的助手。</h1><span>拖入或选择文件夹，添加备注和标签。AI 只根据本地索引给出可验证的结果。</span></div><div class="privacy"><b>${icons.check} 数据边界</b><span>不上传原始文件，不移动或删除资料。</span></div></div><section class="desk-grid"><section class="file-panel panel drop-target"><header><div><small>FOLDER TERMINAL</small><h2>已接入的资料</h2></div><button class="quiet" id="refresh">刷新状态</button></header><div class="drop-hint">拖入一个文件夹即可原位接入，或使用右上角“接入文件夹”。</div>${folderList()}${folderActions}</section><section class="file-upload-card panel" id="file-upload-drop" tabindex="0"><header><div><small>QUICK IMPORT</small><h2>上传文件</h2></div><span class="local-chip">${icons.check} 本机副本</span></header><div class="upload-body"><div class="upload-icon">${icons.upload}</div><strong>拖入文件到此处</strong><p>或点击按钮选择文件。软件会复制到受管理的本地资料区，原文件不会被移动或删除。</p><button class="primary" data-import-files>${icons.upload} 选择文件上传</button><small>文件夹请继续使用“接入文件夹”。</small></div></section></section><section class="setup panel"><div class="setup-heading"><div><small>AI INITIALIZATION</small><h2>应用内完成本地模型准备</h2><p>默认下载轻量模型；也可以选择你电脑中已存在的 GGUF 模型。当前模型：${escapeHtml(status.activeModelName)}。</p></div><div class="ready-summary">${status.runtimeInstalled && status.modelInstalled ? `${icons.check} 助手已可用` : '还差一步即可启用'}</div></div><div class="setup-grid"><article><div class="setup-icon">${icons.download}</div><div class="setup-copy"><b>1. 本地推理运行时</b><span>llama.cpp Windows CPU 引擎</span></div>${runtimeState}<button class="quiet setup-button" id="download-runtime" ${isWorking || status.runtimeInstalled ? 'disabled' : ''}>下载</button></article><article><div class="setup-icon">${icons.spark}</div><div class="setup-copy"><b>2. 默认中文模型</b><span>Qwen2.5 1.5B Instruct · Q4_K_M</span></div>${modelState}<button class="primary setup-button" id="download-model" ${isWorking || status.modelInstalled ? 'disabled' : ''}>下载并启用</button></article></div><section class="local-models"><header><b>本地模型</b><button class="quiet" id="register-local-model">选择本地 GGUF 模型</button></header>${models || '<p>尚未登记额外模型；默认模型下载后可直接使用。</p>'}</section>${progress ? `<div class="progress"><div><b>${progress.kind === 'model' ? `正在从 ${escapeHtml(progress.source ?? '模型源')} 下载 Qwen2.5 1.5B 模型` : '正在下载本地推理运行时'}</b><span>${percent ? `${percent}% · ${bytes(progress.completed)} / ${bytes(progress.total)}` : bytes(progress.completed)}</span></div><i><span style="width:${percent}%"></span></i></div>` : ''}</section></section>`;
}

function workspaceExtras() {
  const indexing = indexProgress ? `<div class="index-progress"><b>索引中</b><span>${indexProgress.completed} / ${indexProgress.total}</span></div>` : '';
  const watching = folderRefs.length ? `<div class="index-progress"><b>自动索引</b><span>${folderWatchStatuses.some(item => item.mode === 'fallback_scan') ? '监听不可用，已降级为定时扫描' : '正在监听已接入资料夹'}</span></div>` : '';
  const queue = indexJobs.length ? `<section class="index-jobs"><b>索引队列</b>${indexJobs.map(job => `<div><span>${escapeHtml(folderRefs.find(folder => folder.id === job.folderId)?.name ?? '资料夹')} · ${escapeHtml(job.status)} · ${job.completed}/${job.total} · 变更 ${job.changed}</span>${job.status === 'running' || job.status === 'queued' ? `<button class="quiet" data-pause-index-job="${escapeHtml(job.id)}">暂停</button>` : `<button class="quiet" data-resume-index-job="${escapeHtml(job.id)}">恢复</button>`}</div>`).join('')}</section>` : '';
  const recovery = recoveryNotice ? `<section class="privacy-status recovery-notice" role="alert"><b>数据库恢复提示</b><span>${escapeHtml(recoveryNotice)}</span><small>恢复过程只会合并缺失记录；原始数据库与恢复文件始终保留在上述目录中。</small></section>` : '';
  const privacy = privacyStatus ? `<section class="privacy-status" id="privacy-status"><b>隐私状态</b><span>${escapeHtml(privacyStatus.message)}</span><small>磁盘加密：${escapeHtml(privacyStatus.recommendation)}</small></section>` : '';
  const acceptance = acceptanceChecks.length ? `<ul class="audit-list">${acceptanceChecks.map(item => `<li><b>${escapeHtml(item.label)}</b> · ${escapeHtml(item.status)} <small>${escapeHtml(item.detail)}</small></li>`).join('')}</ul>` : '';
  return `<section class="workspace-extras workspace-extras-grid">${recovery}${privacy}<form id="runtime-settings" class="runtime-settings"><b>本地模型运行设置</b><label>模式 <select id="runtime-mode"><option value="auto" ${runtimeSettings.executionMode === 'auto' ? 'selected' : ''}>自动</option><option value="cpu" ${runtimeSettings.executionMode === 'cpu' ? 'selected' : ''}>CPU</option><option value="gpu" ${runtimeSettings.executionMode === 'gpu' ? 'selected' : ''}>GPU</option></select></label><label>线程 <input id="runtime-threads" type="number" min="1" max="64" value="${runtimeSettings.threads}"></label><label>上下文 <input id="runtime-context" type="number" min="512" max="32768" value="${runtimeSettings.contextSize}"></label><button class="quiet" type="submit">保存运行设置</button></form><button class="quiet environment-acceptance" id="run-environment-acceptance">运行环境验收</button>${acceptance}<label class="agent-preference"><input id="auto-apply-low-risk" type="checkbox" ${agentPreferences.autoApplyLowRisk ? 'checked' : ''}> 自动执行低风险工作区步骤（不覆盖、不删除、不联网、不发布）</label>${watching}${indexing}${queue}</section>`;
}

function settingsPage() {
  const source = ({ portable: '程序旁数据目录', fresh_database: '新的程序旁资料库' } as const)[dataDirectoryStatus?.source ?? 'portable'];
  const dataPath = dataDirectoryStatus?.path ?? '正在读取…';
  return `<section class="single-panel panel"><header><div><small>PREFERENCES</small><h2>设置</h2></div><span class="local-chip">${icons.check} 保存在本机</span></header><div class="settings-page"><section class="settings-section"><div><b>界面文字大小</b><span>调整资料终端的阅读密度；设置仅保存在当前 Windows 用户的本机浏览器存储中。</span></div><div class="font-scale-control"><input id="font-scale" type="range" min="90" max="125" step="5" value="${fontScale}" aria-label="界面文字大小"><output id="font-scale-value">${fontScale}%</output></div></section><section class="settings-section data-directory-setting"><div><b>应用数据目录</b><span><strong>${source}</strong><code>${escapeHtml(displayPath(dataPath))}</code><span>数据固定在 exe 同级目录。若要更换保存位置，请先关闭应用，再将整个 exe 与同级资料目录一起移动到目标文件夹。</span></span></div></section><section class="settings-section settings-note"><div><b>隐私与数据位置</b><span>文件上传副本保存在资料终端的本地应用数据目录；文件夹接入保持原位置引用。云端权限仅决定 Agent 可否按规则发送经过筛选的资料。</span></div></section><section class="settings-section cloud-provider-settings"><div><b>云端 AI</b><span>供应商、模型、自动协作与外发前确认均在此设置。AI 助手页面只保留任务、对话与执行进度。</span></div>${cloudProviderSettings()}</section></div></section>`;
}

function aboutPage() {
  // Update actions keep the stable DOM ids `check-update` and `check-update-retry` for contract tests and accessibility tooling.
  // id="check-update" id="check-update-retry" update-check-progress
  const versionText = updateVersion ? `发现可用版本 ${escapeHtml(updateVersion)}` : escapeHtml(updateStatus);
  const checkingText = updateCheckState === 'checking' ? `<section class="update-check-progress" role="status" aria-live="polite"><div><b>正在检查更新…</b><span>连接 GitHub</span></div><i><span></span></i><small>正在读取已签名的版本信息，请稍候。</small></section>` : '';
  const progressText = updateProgress ? `<section class="update-progress" role="status"><div><b>正在下载更新</b><span>${updateProgress.total ? `${Math.min(100, Math.round(updateProgress.completed / updateProgress.total * 100))}%` : '正在准备下载…'}</span></div><i><span style="width:${updateProgress.total ? Math.min(100, Math.round(updateProgress.completed / updateProgress.total * 100)) : 15}%"></span></i><small>下载完成后会自动安装并重新启动，资料库不会被清空。</small></section>` : '';
  const checking = updateCheckState === 'checking';
  const action = updateVersion
    ? `<button class="primary" id="install-update" ${isWorking ? 'disabled' : ''}>${icons.download} 立即更新</button>`
    : `<button class="quiet" id="${updateCheckState === 'error' ? 'check-update-retry' : 'check-update'}" type="button" ${checking ? 'disabled' : ''}>${checking ? '正在检查…' : updateCheckState === 'error' ? '重试检查' : '检查更新'}</button>`;
  return `<section class="single-panel panel about-page"><header><div><small>ABOUT</small><h2>关于资料终端</h2></div><span class="local-chip">${icons.check} 本机优先</span></header><div class="about-content"><section class="about-identity"><span class="about-mark">${icons.mark}</span><div><h1>资料终端</h1><p>本地优先的资料管理与 AI 助手</p></div></section><section class="about-update"><div><b>软件更新</b><span>${versionText}</span><small>更新只替换程序文件；同级资料目录、模型和本机设置会保留。</small></div><div class="settings-actions">${action}</div></section>${checkingText}${progressText}<section class="about-detail"><b>更新方式</b><span>点击“检查更新”后，发现新版即可选择“立即更新”。系统会验证发布签名，自动下载、安装并重新启动，无需手动重新下载。</span></section><section class="about-diagnostics"><div class="about-section-heading"><small>LOCAL CAPABILITIES</small><h3>本机能力与隐私</h3><p>以下检查只读取本机状态，不会上传资料。</p></div>${workspaceExtras()}</section></div></section>`;
}
function recoveryPage() {
  const message = startupMode?.message ?? '无法解锁现有本地数据库。';
  return `<main class="recovery-shell"><section class="recovery-card" role="alert"><span class="recovery-icon">${icons.settings}</span><small>SAFE RECOVERY MODE</small><h1>资料终端已安全启动</h1><p>${escapeHtml(message)}</p><div class="recovery-details"><b>旧数据没有被删除或覆盖</b><span>恢复模式不会创建新的磁盘数据库，不会启动索引、文件监听、AI、云端协作或写入操作。</span><span>如果你现在只想进入软件，可以创建一个新的空资料库；旧数据库和恢复文件会原样保留，之后仍可使用原 Windows 用户凭据或备份恢复。</span></div><dl><div><dt>应用数据目录</dt><dd>${escapeHtml(startupMode?.dataDirectory ?? '')}</dd></div><div><dt>恢复文件目录</dt><dd>${escapeHtml(startupMode?.recoveryDirectory ?? '')}</dd></div></dl><div class="recovery-actions"><button class="primary" id="start-fresh-database" ${isWorking ? 'disabled' : ''}>进入软件（新建资料库）</button><button class="quiet" id="open-recovery-directory">在资源管理器中打开恢复目录</button></div>${error ? `<p class="recovery-error">${escapeHtml(error)}</p>` : ''}<p class="recovery-footnote">新资料库会创建在 exe 同级的独立目录，旧数据库、WAL 和 SHM 文件不会被删除、移动或覆盖。</p></section></main>`;
}

function render() {
  if (startupMode?.recoveryRequired) {
    app.style.setProperty('--user-font-scale', `${fontScale / 100}`);
    app.innerHTML = recoveryPage();
    document.querySelector('#start-fresh-database')?.addEventListener('click', startFreshDatabase);
    document.querySelector('#open-recovery-directory')?.addEventListener('click', () => invoke('reveal_recovery_data_directory').catch(reason => { error = String(reason); render(); }));
    return;
  }
  const pages: Record<View, { title: string; subtitle: string; content: string }> = {
    workspace: { title: '资料空间', subtitle: '原文件留在原位置 · 索引存于本机', content: workspacePanel() },
    search: { title: '本地搜索', subtitle: '按名称、路径、备注和标签查询', content: searchPanel() },
    assistant: { title: 'AI 协作台', subtitle: '本地生成、云端协作与受控写入', content: assistantPanel() },
    diagnostics: { title: '索引诊断', subtitle: '查看正文、OCR、向量与缩略图的本机处理状态', content: diagnosticsPage() },
    settings: { title: '设置', subtitle: '界面与数据位置', content: settingsPage() },
    about: { title: '关于', subtitle: '版本、更新与应用信息', content: aboutPage() },
  };
  const page = pages[activeView];
  const menu = contextTarget ? `<div class="context-menu" style="left:${contextPosition.x}px;top:${contextPosition.y}px" role="menu"><b>${escapeHtml(contextTarget.name)}</b><button data-metadata-action="note">编辑备注</button><button data-metadata-action="tags">编辑标签</button><button data-metadata-action="local_only">云端：禁止上传</button><button data-metadata-action="cloud_allowed">云端：允许上传</button><button data-metadata-action="ask_each_time">云端：每次询问</button></div>` : '';
  const editor = metadataEditor && metadataEditorAction ? `<div class="metadata-editor-backdrop"><form class="metadata-editor" id="metadata-editor-form"><header><b>${metadataEditorAction === 'note' ? '编辑备注' : '编辑标签'}</b><button type="button" class="quiet" id="cancel-metadata-editor">取消</button></header><p>${escapeHtml(metadataEditor.name)}</p><label>${metadataEditorAction === 'note' ? '备注' : '标签（用逗号分隔）'}<input id="metadata-editor-value" autofocus maxlength="600" value="${escapeHtml(metadataEditorAction === 'note' ? metadataEditor.note : metadataEditor.tags.join(', '))}"></label><div><button type="submit" class="primary">保存</button></div></form></div>` : '';
  app.style.setProperty('--user-font-scale', `${fontScale / 100}`);
  app.innerHTML = `<aside class="sidebar"><div class="brand"><span class="brand-mark">${icons.mark}</span><span>资料终端<small>LOCAL AI WORKSPACE</small></span></div><nav><button class="nav ${activeView === 'workspace' ? 'active' : ''}" data-testid="nav-workspace" data-view="workspace">${icons.folder}<span>资料空间</span></button><button class="nav ${activeView === 'search' ? 'active' : ''}" data-testid="nav-search" data-view="search">${icons.search}<span>本地搜索</span></button><button class="nav ${activeView === 'assistant' ? 'active' : ''}" data-testid="nav-assistant" data-view="assistant">${icons.spark}<span>AI 协作台</span></button><button class="nav ${activeView === 'diagnostics' ? 'active' : ''}" data-testid="nav-diagnostics" data-view="diagnostics">${icons.file}<span>索引诊断</span></button></nav><div class="sidebar-bottom"><button class="nav ${activeView === 'settings' ? 'active' : ''}" data-testid="nav-settings" data-view="settings">${icons.settings}<span>设置</span></button><button class="nav ${activeView === 'about' ? 'active' : ''}" data-testid="nav-about" data-view="about">${icons.file}<span>关于</span></button><div class="sidebar-foot"><span class="online-dot"></span><span>仅在本机运行</span></div></div></aside><main><header class="topbar"><div><strong>${page.title}</strong><span>${page.subtitle}</span></div><button class="import" id="import-folder">${icons.folder} 接入文件夹</button></header><section class="canvas">${page.content}${folderBrowser()}${previewPanel()}${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}</section></main>${menu}${editor}`;
  restoreCloudDraftToDom();
  setupCloudProviderForm();
  bind();
}

async function refreshStatus() { [status, folderRefs, cloudConfig, cloudProviders, conversations, sensitiveRules, localModels, agentPreferences, privacyStatus, recoveryNotice, indexJobs, runtimeSettings, embeddingModels, mediaTasks, mediaSettings, localTools, managedDownloadResources, downloadTasks, folderWatchStatuses] = await Promise.all([invoke<RuntimeStatus>('get_runtime_status'), invoke<FolderRef[]>('list_folder_refs'), invoke<CloudProviderConfig | null>('get_cloud_provider_config'), invoke<CloudProviderConfig[]>('list_cloud_providers'), invoke<Conversation[]>('list_conversations'), invoke<SensitiveRule[]>('list_sensitive_rules'), invoke<LocalModel[]>('list_local_models'), invoke<AgentPreferences>('get_agent_preferences'), invoke<PrivacyStatus>('get_privacy_status'), invoke<string | null>('get_startup_recovery_notice'), invoke<IndexJob[]>('list_index_jobs'), invoke<RuntimeSettings>('get_runtime_settings'), invoke<EmbeddingModel[]>('list_embedding_models'), invoke<MediaTask[]>('list_media_tasks'), invoke<MediaSettings>('get_media_settings'), invoke<LocalToolStatus>('get_local_tool_status'), invoke<ManagedDownloadResource[]>('list_managed_download_resources'), invoke<DownloadTask[]>('list_download_tasks'), invoke<FolderWatchStatus[]>('list_folder_watch_status')]); if (!cloudDraft.providerId && !cloudDraft.displayName && !cloudDraft.baseUrl && !cloudDraft.model) { cloudDraft = cloudDraftFromConfig(cloudConfig); cloudOriginalProviderId = cloudConfig?.providerId ?? null; } render(); }
async function refreshManagedResources() { [managedDownloadResources, downloadTasks, folderWatchStatuses] = await Promise.all([invoke<ManagedDownloadResource[]>('list_managed_download_resources'), invoke<DownloadTask[]>('list_download_tasks'), invoke<FolderWatchStatus[]>('list_folder_watch_status')]); }
async function downloadManagedResource(resourceId: string) { isWorking = true; error = ''; render(); try { await invoke('download_managed_resource', { input: { resourceId } }); await refreshManagedResources(); } catch (reason) { formWarning = { target: 'media', message: String(reason) }; } finally { isWorking = false; render(); } }
async function retryDownloadTask(id: string) { await invoke('retry_download_task', { input: { id } }); await refreshBackgroundTasks(); }
async function cancelDownloadTask(id: string) { await invoke('cancel_download_task', { input: { id } }); await refreshBackgroundTasks(); }
async function deleteManagedResource(resourceId: string) { if (!window.confirm('仅删除资料终端下载并校验的副本。确定继续吗？')) return; isWorking = true; try { await invoke('delete_managed_download_resource', { input: { resourceId, confirmed: true } }); await refreshManagedResources(); } catch (reason) { formWarning = { target: 'media', message: String(reason) }; } finally { isWorking = false; render(); } }
async function refreshDiagnostics(status = '') { diagnosticStatus = status; diagnostics = await invoke<IndexDiagnosticItem[]>('list_index_diagnostics', { input: { limit: 200 } }); render(); }
async function retryDiagnostics(ids: string[]) { if (!ids.length || !window.confirm(`重试 ${ids.length} 个文件的正文提取？不会修改原文件。`)) return; isWorking = true; try { const retried = await invoke<number>('retry_index_diagnostics', { input: { itemIds: ids, confirmed: true } }); await refreshDiagnostics(`已重试 ${retried} 项。`); } catch (reason) { diagnosticStatus = String(reason); render(); } finally { isWorking = false; } }
async function refreshBackgroundTasks() { backgroundTasks = await invoke<BackgroundTask[]>('list_background_tasks'); render(); }
async function startFreshDatabase() {
  if (!window.confirm('将保留旧的加密数据库，并在 exe 同级目录创建一套新的空资料库。完成后需要重启应用。确定继续吗？')) return;
  isWorking = true; error = ''; render();
  try {
    dataDirectoryStatus = await invoke<DataDirectoryStatus>('start_fresh_database');
    await relaunch();
  } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function loadFolderRefs() { folderRefs = await invoke<FolderRef[]>('list_folder_refs'); }
async function openFolder(folderId: string, path?: string) { const folder = folderRefs.find(item => item.id === folderId); if (!folder) return; activeFolder = folder; browserPath = path ?? folder.path; folderEntries = await invoke<FolderEntry[]>('list_folder_children', { folderId, path: browserPath }); render(); }
async function navigateFolder(path: string) { if (!activeFolder) return; browserHistory.push(browserPath ?? activeFolder.path); await openFolder(activeFolder.id, path); }
async function browserBack() {
  if (!activeFolder || !browserHistory.length) return;
  const previous = browserHistory.pop();
  if (aiOutputTarget && activeFolder.id === aiOutputTarget.workspaceId) {
    browserPath = previous ?? aiOutputTarget.path;
    folderEntries = await invoke<FolderEntry[]>('list_ai_workspace_children', { input: { workspaceId: aiOutputTarget.workspaceId, path: browserPath } });
    render();
    return;
  }
  await openFolder(activeFolder.id, previous);
}
async function revealFolder() { if (!activeFolder) return; try { await invoke('reveal_in_explorer', { path: browserPath ?? activeFolder.path }); } catch (reason) { error = `无法打开资源管理器：${String(reason)}`; render(); } }
async function openAiOutputFolder() {
  if (!aiOutputTarget) return;
  try {
    activeFolder = { id: aiOutputTarget.workspaceId, name: 'AI 输出工作区', path: aiOutputTarget.path, displayPath: aiOutputTarget.displayPath, note: 'AI 输出文件', tags: ['AI 输出'], cloudPolicy: 'local_only', itemCount: 0, sourceStatus: 'available' };
    browserPath = aiOutputTarget.path;
    browserHistory = [];
    folderEntries = await invoke<FolderEntry[]>('list_ai_workspace_children', { input: { workspaceId: aiOutputTarget.workspaceId } });
  } catch (reason) { error = `无法查看 AI 输出文件夹：${String(reason)}`; }
  render();
}
async function revealAiOutputFolder() {
  if (!aiOutputTarget) return;
  try { await invoke('reveal_in_explorer', { path: aiOutputTarget.path }); }
  catch (reason) { error = `无法打开 AI 输出文件夹：${String(reason)}`; render(); }
}
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
async function importFilesToLibrary(paths: string[]) {
  if (!paths.length) return;
  isWorking = true; error = ''; render();
  try { const copied = await invoke<number>('import_files_to_library', { input: { paths } }); await loadFolderRefs(); window.alert(`已复制 ${copied} 个文件到资料终端的本地上传区，原文件未被移动或删除。`); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function chooseFilesForImport() {
  const selected = await open({ directory: false, multiple: true, title: '选择要上传到资料终端的文件' });
  if (!selected) return;
  await importFilesToLibrary(Array.isArray(selected) ? selected : [selected]);
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
    metadataEditor = target; metadataEditorAction = 'note'; render(); return;
  } else if (action === 'tags') {
    metadataEditor = target; metadataEditorAction = 'tags'; render(); return;
  } else {
    const policy = action as CloudPolicy;
    if (policy !== 'local_only' && target.cloudPolicy === 'local_only' && !window.confirm('允许云端后，AI 可能在任务需要时发送经过筛选和脱敏的资料。确定继续吗？')) { render(); return; }
    applyMetadataPolicyOptimistically(target, policy);
    return;
  }
}

function updateMetadataOptimistically(target: MetadataTarget, patch: Pick<MetadataTarget, 'note' | 'tags'>) {
  const apply = <T extends { id: string; note: string; tags: string[] }>(items: T[]) => items.map(item => item.id === target.targetId ? { ...item, ...patch } : item);
  if (target.targetType === 'folder') folderRefs = apply(folderRefs);
  else { results = apply(results); folderEntries = apply(folderEntries); }
}

async function saveMetadataEditor(event: SubmitEvent) {
  event.preventDefault();
  if (!metadataEditor || !metadataEditorAction) return;
  const target = metadataEditor;
  const original = { note: target.note, tags: target.tags };
  const value = document.querySelector<HTMLInputElement>('#metadata-editor-value')?.value ?? '';
  const patch = metadataEditorAction === 'note' ? { note: value.trim(), tags: target.tags } : { note: target.note, tags: value.split(',').map(tag => tag.trim()).filter(Boolean) };
  metadataEditor = null; metadataEditorAction = null;
  updateMetadataOptimistically(target, patch);
  render();
  try { await invoke('update_metadata', { input: { targetType: target.targetType, targetId: target.targetId, ...patch } }); }
  catch (reason) { updateMetadataOptimistically(target, original); error = `元数据未保存：${String(reason)}`; render(); }
}
function applyMetadataPolicyOptimistically(target: MetadataTarget, policy: CloudPolicy) {
  const previousPolicy = target.cloudPolicy;
  const apply = <T extends { id: string; cloudPolicy: CloudPolicy }>(items: T[]) => items.map(item => item.id === target.targetId ? { ...item, cloudPolicy: policy } : item);
  if (target.targetType === 'folder') folderRefs = apply(folderRefs);
  else { results = apply(results); folderEntries = apply(folderEntries); }
  if (activeFolder?.id === target.targetId && target.targetType === 'folder') activeFolder = { ...activeFolder, cloudPolicy: policy };
  render();
  invoke('update_metadata', { input: { targetType: target.targetType, targetId: target.targetId, cloudPolicy: policy } }).catch(reason => {
    const revert = <T extends { id: string; cloudPolicy: CloudPolicy }>(items: T[]) => items.map(item => item.id === target.targetId ? { ...item, cloudPolicy: previousPolicy } : item);
    if (target.targetType === 'folder') folderRefs = revert(folderRefs);
    else { results = revert(results); folderEntries = revert(folderEntries); }
    if (activeFolder?.id === target.targetId && target.targetType === 'folder') activeFolder = { ...activeFolder, cloudPolicy: previousPolicy };
    error = `云端权限未保存：${String(reason)}`;
    render();
  });
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
async function chooseWhisperModel() { const selected = await open({ multiple: false, directory: false, title: '选择本地 Whisper 模型', filters: [{ name: 'Whisper 模型', extensions: ['bin', 'gguf'] }] }); if (!selected || Array.isArray(selected)) return; mediaSettings = { ...mediaSettings, whisperModelPath: selected }; render(); }
async function saveAgentPreferences() { const autoApplyLowRisk = document.querySelector<HTMLInputElement>('#auto-apply-low-risk')?.checked ?? false; try { agentPreferences = await invoke<AgentPreferences>('save_agent_preferences', { input: { autoApplyLowRisk } }); } catch (reason) { error = String(reason); } render(); }
async function saveRuntimeSettings(event: SubmitEvent) { event.preventDefault(); const executionMode = document.querySelector<HTMLSelectElement>('#runtime-mode')?.value as RuntimeSettings['executionMode'] ?? 'auto'; const threads = Number(document.querySelector<HTMLInputElement>('#runtime-threads')?.value ?? 4); const contextSize = Number(document.querySelector<HTMLInputElement>('#runtime-context')?.value ?? 4096); isWorking = true; error = ''; render(); try { runtimeSettings = await invoke<RuntimeSettings>('save_runtime_settings', { input: { executionMode, threads, contextSize } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function runEnvironmentAcceptance() { isWorking = true; error = ''; render(); try { acceptanceChecks = await invoke<AcceptanceCheck[]>('run_environment_acceptance'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function loadAgentEvidenceReport() { if (!agentRun) return; isWorking = true; error = ''; render(); try { agentEvidenceReport = await invoke<AgentEvidenceReport>('get_agent_evidence_report', { input: { runId: agentRun.id } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function ask(question: string) {
  isWorking = true; error = ''; agentRun = null; render();
  try {
    [results, agentRun] = await Promise.all([invoke<Result[]>('ask_assistant', { question }), invoke<AgentRun>('prepare_agent_run', { input: { question, conversationId: activeConversationId } })]);
    activeConversationId = agentRun.conversationId ?? activeConversationId;
    if (agentRun.status === 'awaiting_local_execution') {
      await ensureAiWorkspace();
      agentRun = await invoke<AgentRun>('run_local_agent_task', { runId: agentRun.id });
    }
    if (agentRun.route === 'cloud_auto' && ['prepared', 'needs_cloud_assistance'].includes(agentRun.status)) {
      await ensureAiWorkspace();
      agentRun = await invoke<AgentRun>('run_cloud_collaboration', { runId: agentRun.id });
      await autoApplyLowRiskAdvice();
    }
    await loadConversationHistory();
    agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } });
  } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function loadConversationHistory() { conversations = await invoke<Conversation[]>('list_conversations'); if (activeConversationId) conversationMessages = await invoke<ConversationMessage[]>('list_conversation_messages', { input: { conversationId: activeConversationId } }); }
function cloudProbeInput() {
  syncCloudDraftFromDom();
  return { providerId: cloudOriginalProviderId ?? undefined, baseUrl: cloudDraft.baseUrl, model: cloudDraft.model, apiKey: cloudDraft.apiKey || undefined };
}
async function runLocalAgentTask() {
  if (!agentRun) return;
  isWorking = true; error = ''; workspaceAction = null; render();
  try {
    await ensureAiWorkspace();
    agentRun = { ...agentRun, status: 'running_local', feedback: '正在启动本地模型并分析已接入素材；不会写入文件。' };
    render();
    agentRun = await invoke<AgentRun>('run_local_agent_task', { runId: agentRun.id });
    await loadConversationHistory();
    agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } });
  } catch (reason) {
    error = `本地任务未完成：${String(reason)}。请在“设置 → 本地 AI”确认 llama.cpp 运行时和模型已完整安装。`;
    if (agentRun) agentRun = { ...agentRun, status: 'failed', feedback: error };
  }
  finally { isWorking = false; render(); }
}
async function saveCloudProvider(event: SubmitEvent) {
  event.preventDefault(); syncCloudDraftFromDom(); const draft = { ...cloudDraft, displayName: cloudDraft.displayName || defaultCloudDisplayName(cloudDraft.baseUrl) };
  cloudDraft = draft;
  if (!draft.baseUrl || !draft.model) { formWarning = { target: 'cloud', message: '请填写基础地址和模型名称。配置名称留空时会自动使用服务域名。可先获取模型，或直接填写后测试连接。' }; render(); return; }
  isWorking = true; error = ''; formWarning = null; cloudConnectionStatus = ''; render();
  try {
    cloudConfig = await invoke<CloudProviderConfig>('save_cloud_provider_config', { input: draft });
    cloudOriginalProviderId = cloudConfig.providerId;
    cloudDraft = { ...cloudDraftFromConfig(cloudConfig), apiKey: '' };
    cloudProviders = await invoke<CloudProviderConfig[]>('list_cloud_providers');
    cloudConnectionStatus = '已保存并启用。API Key 仅保存在 Windows 凭据管理器。';
  } catch (reason) { formWarning = { target: 'cloud', message: String(reason) }; }
  finally { isWorking = false; render(); }
}
async function testCloudConnection() {
  const input = cloudProbeInput();
  if (!input.baseUrl || !input.model || !input.apiKey && !input.providerId) { formWarning = { target: 'cloud', message: '请填写基础地址、模型和 API Key；已保存过的供应商可以留空 API Key。' }; render(); return; }
  isWorking = true; error = ''; formWarning = null; cloudConnectionStatus = '正在测试连接…'; render();
  try {
    const result = await invoke<CloudConnectionProbeResult>('test_cloud_connection', { input });
    cloudConnectionStatus = `连接成功 · ${result.latencyMs} ms · ${result.endpoint}`;
  } catch (reason) { formWarning = { target: 'cloud', message: String(reason) }; cloudConnectionStatus = ''; }
  finally { isWorking = false; render(); }
}
async function fetchCloudModels() {
  const input = cloudProbeInput();
  if (!input.baseUrl || !input.apiKey && !input.providerId) { formWarning = { target: 'cloud', message: '请填写基础地址和 API Key；已保存过的供应商可以留空 API Key。' }; render(); return; }
  isWorking = true; error = ''; formWarning = null; cloudConnectionStatus = '正在获取模型列表…'; render();
  try {
    cloudModels = await invoke<CloudModel[]>('discover_cloud_models', { input });
    if (!cloudDraft.model && cloudModels[0]) cloudDraft.model = cloudModels[0].id;
    cloudConnectionStatus = cloudModels.length ? `已获取 ${cloudModels.length} 个模型；选择后建议再测试连接。` : '上游返回了空模型列表；仍可手动填写模型并测试连接。';
  } catch (reason) { formWarning = { target: 'cloud', message: String(reason) }; cloudConnectionStatus = ''; }
  finally { isWorking = false; render(); }
}
async function selectCloudProvider(providerId: string) { cloudConfig = providerId ? await invoke<CloudProviderConfig>('select_cloud_provider', { input: { providerId } }) : null; cloudOriginalProviderId = cloudConfig?.providerId ?? null; cloudDraft = cloudDraftFromConfig(cloudConfig); cloudModels = []; cloudConnectionStatus = ''; formWarning = null; if (cloudConfig) cloudProviders = await invoke<CloudProviderConfig[]>('list_cloud_providers'); render(); }
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
async function installLocalTool(tool: string) { if (!window.confirm('将调用 Windows winget 安装固定官方软件包。不会上传文件。继续吗？')) return; isWorking = true; error = ''; render(); try { await invoke<string>('install_local_tool', { input: { tool, confirmed: true } }); localTools = await invoke<LocalToolStatus>('get_local_tool_status'); } catch (reason) { formWarning = { target: 'media', message: String(reason) }; } finally { isWorking = false; render(); } }
async function runWorkspaceCheck() { if (!aiOutputTarget) return; const command = document.querySelector<HTMLSelectElement>('#workspace-check-command')?.value ?? 'npm run build'; isWorking = true; error = ''; workspaceAction = null; render(); try { workspaceAction = await invoke<WorkspaceActionResult>('run_workspace_check', { input: { workspaceId: aiOutputTarget.workspaceId, command, runId: agentRun?.id } }); if (agentRun) { agentRun = { ...agentRun, status: workspaceAction.status }; agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } }); } } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function autoRepairAgentRun() { if (!agentRun || !aiOutputTarget) return; const command = document.querySelector<HTMLSelectElement>('#workspace-check-command')?.value ?? 'npm run build'; isWorking = true; error = ''; workspaceAction = null; render(); try { workspaceAction = await invoke<WorkspaceActionResult>('auto_repair_agent_run', { input: { runId: agentRun.id, workspaceId: aiOutputTarget.workspaceId, command } }); agentRun = { ...agentRun, status: workspaceAction.status, feedback: workspaceAction.status === 'repair_complete' ? '自动最小修复已通过固定检查。' : '自动最小修复后检查仍失败，已停止自动循环。' }; agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function retryAgentRun() { if (!agentRun) return; isWorking = true; error = ''; render(); try { if (agentRun.status === 'needs_cloud_assistance' && agentRun.route === 'cloud_auto') { await ensureAiWorkspace(); agentRun = await invoke<AgentRun>('run_cloud_collaboration', { runId: agentRun.id }); await autoApplyLowRiskAdvice(); } else { agentRun = await invoke<AgentRun>('retry_agent_run', { input: { runId: agentRun.id } }); if (agentRun.route === 'cloud_auto') { await ensureAiWorkspace(); agentRun = await invoke<AgentRun>('run_cloud_collaboration', { runId: agentRun.id }); await autoApplyLowRiskAdvice(); } } agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function deleteConversation(conversationId: string) { if (!window.confirm('删除该本地对话记录？此操作无法撤销。')) return; isWorking = true; error = ''; render(); try { await invoke('delete_conversation', { input: { conversationId } }); if (activeConversationId === conversationId) { activeConversationId = null; conversationMessages = []; } await loadConversationHistory(); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function deleteCloudProvider() { if (!cloudConfig || !window.confirm(`删除供应商“${cloudConfig.displayName}”及其 Windows 凭据？`)) return; isWorking = true; error = ''; render(); try { await invoke('delete_cloud_provider', { input: { providerId: cloudConfig.providerId } }); cloudConfig = null; cloudOriginalProviderId = null; cloudDraft = cloudDraftFromConfig(null); cloudModels = []; cloudProviders = await invoke<CloudProviderConfig[]>('list_cloud_providers'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
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
async function checkForUpdate(showResult = false) {
  updateCheckState = 'checking';
  updateVersion = '';
  pendingUpdate = null;
  isWorking = true;
  error = '';
  render();
  try {
    let update = null;
    let lastReason: unknown;
    for (let attempts = 0; attempts < 3; attempts += 1) {
      try {
        update = await check(updaterRequestOptions);
        break;
      } catch (reason) {
        lastReason = reason;
        if (attempts < 2) await new Promise(resolve => window.setTimeout(resolve, 800 * (attempts + 1)));
      }
    }
    if (lastReason && !update) throw lastReason;
    pendingUpdate = update;
    updateVersion = update?.version ?? '';
    updateStatus = updateVersion ? `发现可用版本 ${updateVersion}` : '当前已是最新版本';
    updateCheckState = 'success';
    if (updateVersion && !showResult && window.confirm(`发现 ${updateVersion} 新版本。现在下载并自动安装吗？`)) await installUpdate();
  } catch (reason) {
    updateCheckState = 'error';
    updateStatus = '暂时无法连接 GitHub 更新服务，请检查网络、代理或稍后重试。';
    console.warn('Update check skipped:', reason);
  } finally {
    isWorking = false;
    render();
  }
}

async function installUpdate() {
  isWorking = true;
  error = '';
  updateProgress = { kind: 'runtime', completed: 0 };
  render();
  try {
    const update = pendingUpdate ?? await check(updaterRequestOptions);
    if (!update) {
      updateVersion = '';
      updateCheckState = 'success';
      return;
    }
    let lastDownloadError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let total = 0;
      let completed = 0;
      try {
        await update.downloadAndInstall((event: DownloadEvent) => {
          if (event.event === 'Started') total = event.data.contentLength ?? 0;
          if (event.event === 'Progress') completed += event.data.chunkLength;
          updateProgress = { kind: 'runtime', completed, total: total || undefined };
        }, updaterRequestOptions);
        lastDownloadError = undefined;
        break;
      } catch (reason) {
        lastDownloadError = reason;
        if (attempt === 0) await new Promise(resolve => window.setTimeout(resolve, 1000));
      }
    }
    if (lastDownloadError) throw lastDownloadError;
    pendingUpdate = null;
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
  document.querySelector<HTMLFormElement>('#metadata-editor-form')?.addEventListener('submit', saveMetadataEditor);
  document.querySelector('#cancel-metadata-editor')?.addEventListener('click', () => { metadataEditor = null; metadataEditorAction = null; render(); });
  document.querySelectorAll<HTMLElement>('.folder-ref-button').forEach(button => button.addEventListener('click', () => openFolder(button.dataset.folderId ?? '').catch(reason => { error = `无法打开文件夹：${String(reason)}`; render(); })));
  document.querySelectorAll<HTMLElement>('.browser-folder').forEach(button => button.addEventListener('click', () => {
    const outputWorkspace = activeFolder && aiOutputTarget && activeFolder.id === aiOutputTarget.workspaceId ? aiOutputTarget : null;
    if (outputWorkspace && activeFolder) {
      browserHistory.push(browserPath ?? activeFolder.path);
      invoke<FolderEntry[]>('list_ai_workspace_children', { input: { workspaceId: outputWorkspace.workspaceId, path: button.dataset.path ?? outputWorkspace.path } })
        .then(entries => { browserPath = button.dataset.path ?? outputWorkspace.path; folderEntries = entries; render(); })
        .catch(reason => { error = `无法读取 AI 输出文件夹：${String(reason)}`; render(); });
    } else navigateFolder(button.dataset.path ?? '').catch(reason => { error = `无法读取文件夹：${String(reason)}`; render(); });
  }));
  document.querySelector('#browser-back')?.addEventListener('click', () => browserBack().catch(reason => { error = `无法返回上级：${String(reason)}`; render(); }));
  document.querySelector('#browser-reveal')?.addEventListener('click', revealFolder);
  document.querySelector('#close-browser')?.addEventListener('click', () => { activeFolder = null; browserPath = null; browserHistory = []; folderEntries = []; render(); });
  document.querySelectorAll<HTMLElement>('.preview-file').forEach(button => button.addEventListener('click', () => loadPreview(button.dataset.path ?? '')));
  document.querySelector('#close-preview')?.addEventListener('click', () => { preview = null; render(); });
  document.querySelector('#reveal-file')?.addEventListener('click', revealPreview);
  document.querySelector('#high-fidelity-office-preview')?.addEventListener('click', convertOfficePreview);
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(button => button.addEventListener('click', () => { activeView = button.dataset.view as View; if (activeView === 'diagnostics') refreshDiagnostics().catch(reason => { diagnosticStatus = String(reason); render(); }); else render(); }));
  document.querySelector('#import-folder')?.addEventListener('click', selectFolder); document.querySelector('#choose-folder')?.addEventListener('click', selectFolder); document.querySelector('#refresh')?.addEventListener('click', refreshStatus); document.querySelector('#download-runtime')?.addEventListener('click', () => provision('runtime')); document.querySelector('#download-model')?.addEventListener('click', () => provision('model'));
  document.querySelectorAll<HTMLElement>('[data-import-files]').forEach(button => button.addEventListener('click', chooseFilesForImport));
  const uploadDrop = document.querySelector<HTMLElement>('#file-upload-drop');
  uploadDrop?.addEventListener('dragover', event => { event.preventDefault(); uploadDrop.classList.add('dragging'); });
  uploadDrop?.addEventListener('dragleave', () => uploadDrop.classList.remove('dragging'));
  uploadDrop?.addEventListener('drop', event => { event.preventDefault(); uploadDrop.classList.remove('dragging'); const paths = Array.from(event.dataTransfer?.files ?? []).map(file => (file as File & { path?: string }).path).filter((path): path is string => Boolean(path)); if (paths.length) importFilesToLibrary(paths); else { error = '未能读取拖入文件路径，请点击“选择文件上传”。'; render(); } });
  document.querySelector<HTMLInputElement>('#font-scale')?.addEventListener('input', event => { fontScale = Number((event.target as HTMLInputElement).value); localStorage.setItem('file-terminal.font-scale', String(fontScale)); render(); });
  document.querySelector('#check-update')?.addEventListener('click', () => checkForUpdate(true)); document.querySelector('#check-update-retry')?.addEventListener('click', () => checkForUpdate(true));
  document.querySelector('#register-local-model')?.addEventListener('click', registerLocalModel);
  document.querySelector('#register-embedding-model')?.addEventListener('click', registerEmbeddingModel);
  document.querySelector('#build-embedding-index')?.addEventListener('click', buildEmbeddingIndex);
  document.querySelector('#toggle-media-gallery')?.addEventListener('click', () => { mediaGalleryOpen = !mediaGalleryOpen; render(); });
  document.querySelector('#build-media-thumbnails')?.addEventListener('click', buildMediaThumbnails);
  document.querySelectorAll<HTMLButtonElement>('.install-local-tool').forEach(button => button.addEventListener('click', () => installLocalTool(button.dataset.tool ?? '')));
  document.querySelectorAll<HTMLButtonElement>('.download-managed-resource').forEach(button => button.addEventListener('click', () => downloadManagedResource(button.dataset.resourceId ?? '')));
  document.querySelectorAll<HTMLButtonElement>('.delete-managed-resource').forEach(button => button.addEventListener('click', () => deleteManagedResource(button.dataset.resourceId ?? '')));
  document.querySelector('#clear-thumbnail-cache')?.addEventListener('click', clearThumbnailCache);
  document.querySelectorAll<HTMLButtonElement>('.enqueue-media-task').forEach(button => button.addEventListener('click', () => enqueueMediaTask(button.dataset.itemId ?? '', (button.dataset.mediaKind as MediaTask['kind']) ?? 'ocr')));
  document.querySelectorAll<HTMLButtonElement>('.cancel-media-task').forEach(button => button.addEventListener('click', () => cancelMediaTask(button.dataset.taskId ?? '')));
  document.querySelector('#choose-whisper-model')?.addEventListener('click', chooseWhisperModel);
  document.querySelectorAll<HTMLButtonElement>('#refresh-diagnostics, .refresh-diagnostics').forEach(button => button.addEventListener('click', () => refreshDiagnostics().catch(reason => { diagnosticStatus = String(reason); render(); })));
  document.querySelector('#retry-failed-diagnostics')?.addEventListener('click', () => retryDiagnostics(diagnostics.filter(item => ['failed', 'skipped'].includes(item.contentStatus)).map(item => item.id)));
  document.querySelectorAll<HTMLButtonElement>('.retry-diagnostic').forEach(button => button.addEventListener('click', () => retryDiagnostics([button.dataset.itemId ?? ''])));
  document.querySelector('#export-diagnostics')?.addEventListener('click', async () => { try { const report = await invoke<{ items: IndexDiagnosticItem[] }>('export_index_diagnostics', { input: { limit: 500 } }); diagnosticStatus = `已生成 ${report.items.length} 项不含正文的本机诊断摘要。`; render(); } catch (reason) { diagnosticStatus = String(reason); render(); } });
  document.querySelectorAll<HTMLButtonElement>('#refresh-background-tasks, .refresh-background-tasks').forEach(button => button.addEventListener('click', () => refreshBackgroundTasks().catch(reason => { error = String(reason); render(); })));
  document.querySelectorAll<HTMLButtonElement>('.pause-task').forEach(button => button.addEventListener('click', () => pauseIndexJob(button.dataset.taskId ?? '').then(refreshBackgroundTasks)));
  document.querySelectorAll<HTMLButtonElement>('.resume-task').forEach(button => button.addEventListener('click', () => resumeIndexJob(button.dataset.taskId ?? '').then(refreshBackgroundTasks)));
  document.querySelectorAll<HTMLButtonElement>('.cancel-task').forEach(button => button.addEventListener('click', () => cancelMediaTask(button.dataset.taskId ?? '').then(refreshBackgroundTasks)));
  document.querySelectorAll<HTMLButtonElement>('.cancel-download-task').forEach(button => button.addEventListener('click', () => cancelDownloadTask(button.dataset.taskId ?? '').catch(reason => { error = String(reason); render(); })));
  document.querySelectorAll<HTMLButtonElement>('.retry-download-task').forEach(button => button.addEventListener('click', () => retryDownloadTask(button.dataset.taskId ?? '').catch(reason => { error = String(reason); render(); })));
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
  document.querySelector('#open-ai-output-folder')?.addEventListener('click', openAiOutputFolder);
  document.querySelector('#reveal-ai-output-folder')?.addEventListener('click', revealAiOutputFolder);
  document.querySelector<HTMLFormElement>('#cloud-provider-form')?.addEventListener('submit', saveCloudProvider);
  document.querySelector('#test-cloud-connection')?.addEventListener('click', testCloudConnection);
  document.querySelector('#fetch-cloud-models')?.addEventListener('click', fetchCloudModels);
  ['#cloud-display-name', '#cloud-base-url', '#cloud-api-key', '#cloud-model-input'].forEach(selector => document.querySelector(selector)?.addEventListener('input', () => { syncCloudDraftFromDom(); cloudConnectionStatus = ''; refreshCloudCredentialHint(); }));
  document.querySelector<HTMLSelectElement>('#cloud-model-select')?.addEventListener('change', event => { const model = (event.target as HTMLSelectElement).value; const input = document.querySelector<HTMLInputElement>('#cloud-model-input'); if (input && model) input.value = model; syncCloudDraftFromDom(); });
  document.querySelector('#cloud-auto')?.addEventListener('change', syncCloudDraftFromDom);
  document.querySelector('#cloud-review')?.addEventListener('change', syncCloudDraftFromDom);
  document.querySelector<HTMLSelectElement>('#cloud-provider-select')?.addEventListener('change', event => selectCloudProvider((event.target as HTMLSelectElement).value));
  document.querySelector('#cloud-confirm')?.addEventListener('click', runCloudCollaboration);
  document.querySelector('#run-local-agent-task')?.addEventListener('click', runLocalAgentTask);
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
listen<DownloadTask>('download-task-progress', event => { downloadTasks = [event.payload, ...downloadTasks.filter(task => task.id !== event.payload.id)].slice(0, 100); refreshBackgroundTasks().catch(() => render()); }).catch(reason => { error = `无法接收下载任务状态：${String(reason)}`; render(); });
listen<IndexProgress>('index-progress', event => { indexProgress = event.payload; render(); if (event.payload.phase === 'complete') window.setTimeout(() => { indexProgress = null; render(); }, 1_500); }).catch(reason => { error = `无法接收索引进度：${String(reason)}`; render(); });
listen<IndexJob>('index-job-progress', event => { const next = event.payload; indexJobs = [...indexJobs.filter(job => job.id !== next.id && job.status !== 'completed'), next].filter(job => job.status !== 'completed'); if (next.status === 'completed') { loadFolderRefs().then(render); scheduleEmbeddingUpdate(); } render(); }).catch(reason => { error = `无法接收索引任务：${String(reason)}`; render(); });
listen<FolderChangeDetected>('folder-change-detected', event => { scheduleFolderRefresh(event.payload); }).catch(reason => { error = `无法接收文件夹变动：${String(reason)}`; render(); });
listen<EmbeddingIndexProgress>('embedding-index-progress', event => { embeddingProgress = event.payload; render(); }).catch(reason => { error = `无法接收向量索引进度：${String(reason)}`; render(); });
listen<MediaTask>('media-task-progress', event => { mediaTasks = [event.payload, ...mediaTasks.filter(task => task.id !== event.payload.id)].slice(0, 100); render(); }).catch(reason => { error = `无法接收媒体任务状态：${String(reason)}`; render(); });
getCurrentWindow().onDragDropEvent(event => {
  if (event.payload.type !== 'drop') return;
  const paths = event.payload.paths;
  const uploadDrop = document.querySelector<HTMLElement>('#file-upload-drop');
  const rect = uploadDrop?.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const dropX = event.payload.position.x / scale;
  const dropY = event.payload.position.y / scale;
  const droppedOnUpload = rect && dropX >= rect.left && dropX <= rect.right && dropY >= rect.top && dropY <= rect.bottom;
  if (droppedOnUpload) { importFilesToLibrary(paths); return; }
  if (paths.length !== 1) { error = '请一次拖入一个文件夹，或拖入文件到“上传文件”区域。'; render(); return; }
  importFolderPath(paths[0]);
}).catch(reason => { error = `无法启用文件夹拖入：${String(reason)}`; render(); });
async function bootstrap() {
  try {
    startupMode = await invoke<StartupMode>('get_startup_mode');
    if (startupMode.recoveryRequired) {
      render();
      return;
    }
    [dataDirectoryStatus] = await Promise.all([invoke<DataDirectoryStatus>('get_data_directory_status')]);
    await refreshStatus();
    checkForUpdate();
  } catch (reason) {
    error = `无法连接桌面端：${String(reason)}`;
    render();
  }
}

bootstrap();
