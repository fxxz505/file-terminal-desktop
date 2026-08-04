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
type ExecutionPreference = 'automatic' | 'local' | 'cloud';
type View = 'workspace' | 'search' | 'assistant' | 'diagnostics' | 'settings' | 'about';

const app = document.querySelector<HTMLDivElement>('#app')!;
let status: RuntimeStatus = { modelInstalled: false, runtimeInstalled: false, modelPath: '', activeModelName: '????' };
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
let updateStatus = '??????';
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
let executionPreference: ExecutionPreference = (localStorage.getItem('file-terminal.execution-preference') as ExecutionPreference) || 'automatic';

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

function bytes(value = 0) { return value ? `${(value / 1024 / 1024).toFixed(value > 1024 * 1024 * 1024 ? 0 : 1)} MB` : '????'; }
function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]!)); }
function displayPath(value: string) { return value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, ''); }
function stateChip(ready: boolean, waiting: string, readyText: string) { return `<span class="state setup-state ${ready ? 'ready' : ''}">${ready ? readyText : waiting}</span>`; }
function cloudPolicyLabel(policy: CloudPolicy) { return ({ local_only: '???????', cloud_allowed: '???????', ask_each_time: '???????', inherit: '???????' } as const)[policy]; }
function metadataLine(tags: string[], policy: CloudPolicy) { return `<div class="metadata-line"><span>${tags.length ? `???${tags.map(escapeHtml).join('?')}` : '????'}</span><b class="cloud-policy ${policy}">${cloudPolicyLabel(policy)}</b></div>`; }

function resultRows(empty: string) {
  return results.length ? `<div class="results">${results.map(result => `<button class="result preview-file metadata-target" data-target-type="item" data-target-id="${escapeHtml(result.id)}" data-note="${escapeHtml(result.note)}" data-tags="${escapeHtml(JSON.stringify(result.tags))}" data-cloud-policy="${result.cloudPolicy}" data-name="${escapeHtml(result.name)}" data-path="${escapeHtml(result.path)}"><span>${result.itemType === 'folder' ? icons.folder : icons.file}</span><b>${escapeHtml(result.name)}</b><small>${escapeHtml(result.displayPath)}</small><em>?? ${result.score}</em><i class="index-state ${escapeHtml(result.contentStatus)}">${escapeHtml(result.contentStatus === 'indexed' ? '?????' : result.contentStatus === 'failed' ? `????${result.contentReasonCode ? `?${result.contentReasonCode}` : ''}` : '??????')}</i>${metadataLine(result.tags, result.cloudPolicy)}</button>`).join('')}</div>` : `<div class="result-placeholder">${empty}</div>`;
}

function diagnosticsPage() {
  const rows = diagnostics.map(item => `<article class="diagnostic-row"><div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.displayPath)}</small></div><div><span class="index-state ${escapeHtml(item.contentStatus)}">${escapeHtml(item.contentStatus)}</span><small>${item.contentReasonCode ? escapeHtml(item.contentReasonCode) : `?? ${item.extractedChars} ?`}</small></div><div><small>OCR/???${escapeHtml(item.mediaStatus ?? '???')} ? ???${escapeHtml(item.embeddingStatus)} ? ????${escapeHtml(item.thumbnailStatus)}</small><button class="quiet retry-diagnostic" data-item-id="${escapeHtml(item.id)}" ${item.itemType === 'file' ? '' : 'disabled'}>??</button></div></article>`).join('');
  const failures = diagnostics.filter(item => ['failed', 'skipped'].includes(item.contentStatus));
  const pending = diagnostics.filter(item => item.contentStatus === 'pending').length;
  const summary = `<div class="diagnostics-summary" aria-label="??????"><span>?? ${diagnostics.length}</span><span>??? ${pending}</span><span class="summary-attention">??? ${failures.length}</span></div>`;
  const empty = `<section class="diagnostic-empty" role="status"><span class="empty-state-icon">${icons.file}</span><div><strong>?????????</strong><p>????????????????????OCR????????????</p></div><div class="empty-actions"><button class="primary" type="button" data-view="workspace">??????</button><button class="quiet refresh-diagnostics" type="button">????</button></div></section>`;
  return `<section class="single-panel panel diagnostics-page"><header><div class="page-header-copy"><small>INDEX DIAGNOSTICS</small><h2>??????</h2><span>?????????????????????</span></div><div class="page-header-actions"><button class="quiet" id="refresh-diagnostics" type="button">??</button><button class="quiet" id="retry-failed-diagnostics" type="button" ${failures.length ? '' : 'disabled'}>????? (${failures.length})</button></div></header>${summary}<div class="diagnostic-filters"><label>????<select id="diagnostic-status"><option value="">????</option><option value="failed">????</option><option value="skipped">???</option><option value="indexed">???</option><option value="pending">????</option></select></label><button class="quiet" id="export-diagnostics" type="button">??????</button></div>${diagnosticStatus ? `<p class="form-warning">${escapeHtml(diagnosticStatus)}</p>` : ''}<div class="diagnostic-list">${rows || empty}</div></section>`;
}

function tasksPage() {
  const rows = backgroundTasks.map(task => `<article class="task-row"><div><b>${escapeHtml(task.taskType)} ? ${escapeHtml(task.target)}</b><small>${escapeHtml(task.progress)} ? ${escapeHtml(task.startedAt)}</small></div><span class="index-state ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span><div>${task.supportsPause && task.status !== 'paused' ? `<button class="quiet pause-task" data-task-id="${escapeHtml(task.id)}">??</button>` : ''}${task.supportsPause && task.status === 'paused' ? `<button class="quiet resume-task" data-task-id="${escapeHtml(task.id)}">??</button>` : ''}${task.supportsCancel && ['queued','running'].includes(task.status) ? `<button class="quiet ${task.taskType.startsWith('download:') ? 'cancel-download-task' : 'cancel-task'}" data-task-id="${escapeHtml(task.id)}">??</button>` : ''}${task.supportsRetry && ['failed','cancelled'].includes(task.status) ? `<button class="quiet ${task.taskType.startsWith('download:') ? 'retry-download-task' : 'retry-task'}" data-task-id="${escapeHtml(task.id)}">??</button>` : ''}${task.error ? `<small>${escapeHtml(task.error)}</small>` : ''}</div></article>`).join('');
  const running = backgroundTasks.filter(task => task.status === 'running').length;
  const queued = backgroundTasks.filter(task => task.status === 'queued').length;
  const attention = backgroundTasks.filter(task => ['failed', 'cancelled', 'paused'].includes(task.status)).length;
  const summary = `<div class="tasks-summary" aria-label="??????"><span>??? ${running}</span><span>??? ${queued}</span><span class="summary-attention">??? ${attention}</span></div>`;
  const empty = `<section class="task-empty" role="status"><span class="empty-state-icon">${icons.settings}</span><div><strong>????????</strong><p>???OCR??????????????????????????????????????</p></div><div class="empty-actions"><button class="primary" type="button" data-view="workspace">??????</button><button class="quiet refresh-background-tasks" type="button">????</button></div></section>`;
  return `<section class="single-panel panel tasks-page"><header><div class="page-header-copy"><small>BACKGROUND TASKS</small><h2>???????</h2><span>????????????????????</span></div><div class="page-header-actions"><button class="quiet" id="refresh-background-tasks" type="button">??</button></div></header>${summary}<div class="task-list" data-testid="task-list">${rows || empty}</div></section>`;
}

function sourceCitations(citations: SourceCitation[]) {
  return citations.length ? `<div class="source-citations"><b>????</b>${citations.map(citation => `<button class="preview-file" data-path="${escapeHtml(citation.path)}">${escapeHtml(citation.name)} ? ${escapeHtml(citation.reason)}</button>`).join('')}</div>` : '<p>?????????????????</p>';
}

function citations(citationList: SourceCitation[]) {
  return citationList.length ? `<div class="source-citations"><b>????</b>${citationList.map(citation => `<button class="preview-file" data-path="${escapeHtml(citation.path)}">${escapeHtml(citation.name)} ? ${escapeHtml(citation.reason)}</button>`).join('')}</div>` : '<p class="evidence-empty">?????????????????</p>';
}

function previewPanel() {
  if (!preview) return '';
  const body = preview.kind === 'image' ? `<img src="data:${preview.mimeType};base64,${preview.content}" alt="${escapeHtml(preview.name)}">`
    : preview.kind === 'pdf' ? `<iframe title="${escapeHtml(preview.name)}" src="data:application/pdf;base64,${preview.content}"></iframe>`
      : preview.kind === 'text' ? `<pre>${escapeHtml(preview.content)}</pre>` : `<p>${escapeHtml(preview.message)}</p>`;
  const office = /\.(docx?|pptx?|xlsx?|od[stp])$/i.test(preview.name);
  return `<section class="file-preview"><header><div><small>LOCAL PREVIEW</small><h2>${escapeHtml(preview.name)}</h2><span>${escapeHtml(preview.displayPath)}</span></div><div>${office ? '<button class="quiet" id="high-fidelity-office-preview">?????</button>' : ''}<button class="quiet" id="reveal-file">?????????</button><button class="quiet" id="close-preview">??</button></div></header><div class="preview-body">${body}</div></section>`;
}

function isGalleryImage(item: Result) { return item.itemType === 'file' && /\.(png|jpe?g|gif|webp|bmp|pdf)$/i.test(item.name); }
function mediaKind(item: Result): MediaTask['kind'] | null { if (/\.(png|jpe?g|bmp|tiff?|webp)$/i.test(item.name)) return 'ocr'; if (/\.(wav|mp3|m4a|flac|ogg|mp4|mkv|mov|webm|avi)$/i.test(item.name)) return 'transcription'; return null; }
function mediaGallery() {
  if (!mediaGalleryOpen) return '';
  const images = results.filter(isGalleryImage);
  const cards = images.map(item => {
    const thumbnail = mediaThumbnails.get(item.id);
    const image = thumbnail ? `<img src="data:${thumbnail.mimeType};base64,${thumbnail.content}" alt="${escapeHtml(item.name)}">` : '<span class="gallery-placeholder">???</span>';
    return `<button class="media-card preview-file" data-path="${escapeHtml(item.path)}">${image}<b>${escapeHtml(item.name)}</b><small>${thumbnail?.cached ? '??????' : '?????'}</small></button>`;
  }).join('');
  return `<section class="media-gallery"><header><div><b>????</b><span>?????????????????????PDF ????????? pdftoppm ????</span></div><div><button class="quiet" id="build-media-thumbnails" ${isWorking || !images.length ? 'disabled' : ''}>???????</button><button class="quiet" id="clear-thumbnail-cache" ${isWorking ? 'disabled' : ''}>????</button></div></header>${images.length ? `<div class="media-grid">${cards}</div>` : '<p>??????????????? PDF?</p>'}</section>`;
}

function toolManager() {
  // ??????????????????????????????
  const tools: Array<{ id: 'tesseract' | 'ffmpeg' | 'libreoffice'; name: string; ready: boolean; detail: string }> = [
    { id: 'tesseract', name: 'Tesseract OCR', ready: localTools.ocr, detail: '????????????????????' },
    { id: 'ffmpeg', name: 'FFmpeg', ready: localTools.ffmpeg, detail: '??????????? Whisper ???' },
    { id: 'libreoffice', name: 'LibreOffice', ready: localTools.officeConverter, detail: 'Office ??????? PDF ???' },
  ];
  const resources = managedDownloadResources.map(resource => `<div><section><b>${escapeHtml(resource.label)}</b><small>${resource.resourceType === 'whisper_model' ? '????????? Whisper ???' : '??????? Tesseract ????????'} ${resource.status === 'installed' ? `? ${bytes(resource.bytes)}` : ''}</small></section><span class="tool-state ${resource.status === 'installed' ? 'ready' : ''}">${resource.status === 'installed' ? '???' : '???'}</span>${resource.status === 'installed' ? `<button class="quiet delete-managed-resource" data-resource-id="${escapeHtml(resource.id)}">??????</button>` : `<button class="quiet download-managed-resource" data-resource-id="${escapeHtml(resource.id)}" ${isWorking ? 'disabled' : ''}>?????</button>`}</div>`).join('');
  return `<section class="tool-manager" data-testid="managed-downloads"><header><div><b>???????</b><span>????? winget ???????????? HTTPS ????????????? embedding/????????????????</span></div></header><div class="tool-list">${tools.map(tool => `<div><section><b>${tool.name}</b><small>${tool.detail}</small></section><span class="tool-state ${tool.ready ? 'ready' : ''}">${tool.ready ? '???' : '???'}</span>${tool.ready ? '' : `<button class="quiet install-local-tool" data-tool="${tool.id}" ${isWorking ? 'disabled' : ''}>?????</button>`}</div>`).join('')}${resources || '<p>??????????</p>'}</div></section>`;
}

function mediaTasksPanel() {
  const candidates = results.filter(item => mediaKind(item));
  const candidateRows = candidates.map(item => `<button class="quiet enqueue-media-task" data-item-id="${escapeHtml(item.id)}" data-media-kind="${mediaKind(item)}">${mediaKind(item) === 'ocr' ? 'OCR' : '??'}?${escapeHtml(item.name)}</button>`).join('');
  const taskRows = mediaTasks.map(task => `<div><span>${escapeHtml(task.name)} ? ${task.kind} ? ${task.status}${task.error ? ` ? ${escapeHtml(task.error)}` : ''}</span>${['queued', 'running'].includes(task.status) ? `<button class="quiet cancel-media-task" data-task-id="${escapeHtml(task.id)}">??</button>` : ''}</div>`).join('');
  const warning = formWarning?.target === 'media' ? `<p class="form-warning" role="alert">${escapeHtml(formWarning.message)}</p>` : '';
  return `<section class="media-tasks"><header><div><b>?? OCR ??????</b><span>???????????????????????????????</span></div><form id="media-settings">${warning}<div class="control-cluster"><input id="media-ocr-language" maxlength="80" value="${escapeHtml(mediaSettings.ocrLanguage)}" placeholder="Tesseract ????? chi_sim+eng"><input id="media-whisper-model" readonly value="${escapeHtml(mediaSettings.whisperModelPath)}" placeholder="????? Whisper ??"><button class="quiet" type="button" id="choose-whisper-model">????</button><button class="quiet" type="submit">????</button></div></form></header>${toolManager()}${candidateRows ? `<div class="media-candidates">${candidateRows}</div>` : '<p>?????????? OCR ?????????</p>'}<div class="media-task-list">${taskRows || '<span>?????????</span>'}</div></section>`;
}

function searchPanel() {
  const previousDisabled = searchPage === 0 ? 'disabled' : '';
  const nextDisabled = results.length === 0 || (searchPage + 1) * 30 >= searchTotal ? 'disabled' : '';
  const folderOptions = folderRefs.map(folder => `<option value="${escapeHtml(folder.id)}" ${folder.id === searchFolderFilter ? 'selected' : ''}>${escapeHtml(folder.name)}</option>`).join('');
  const semanticNote = appliedSearchMode === 'semantic' ? '????????????' : appliedSearchMode === 'embedding_fallback_fts' ? '??? embedding ?????? FTS' : '??? / FTS ??';
  const embeddingModel = embeddingModels.find(model => model.active);
  const progressText = embeddingProgress ? `?????????${embeddingProgress.completed}/${embeddingProgress.total}${embeddingProgress.failed ? `??? ${embeddingProgress.failed}` : ''}` : embeddingModel ? `?? embedding?${escapeHtml(embeddingModel.displayName)}${embeddingModel.dimensions ? ` ? ${embeddingModel.dimensions} ?` : ''}` : '????? embedding ??';
  return `<section class="single-panel panel"><header><div><small>LOCAL SEARCH</small><h2>????</h2></div><span class="local-chip">${icons.check} ${semanticNote}</span></header><div class="search-page"><h1>?????????</h1><p>????????????????????????????</p><form id="search-form"><div class="large-search">${icons.search}<input data-testid="search-question" id="search-question" value="${escapeHtml(searchQuery)}" placeholder="??????Steam?????"><button type="submit" ${isWorking ? 'disabled' : ''}>??</button></div><div class="search-filters"><label>?? <select id="search-mode"><option value="fts" ${searchMode === 'fts' ? 'selected' : ''}>????FTS?</option><option value="semantic" ${searchMode === 'semantic' ? 'selected' : ''}>????</option></select></label><label>?? <input class="search-filter" id="search-filter" value="${escapeHtml(searchFilter)}" placeholder="?????"></label><label>??? <select id="search-folder-filter"><option value="">?????</option>${folderOptions}</select></label><label>?? <select id="search-type-filter"><option value="">??????</option><option value="file" ${searchTypeFilter === 'file' ? 'selected' : ''}>???</option><option value="folder" ${searchTypeFilter === 'folder' ? 'selected' : ''}>????</option></select></label></div></form><section class="semantic-search"><b>??????</b><span>${progressText}</span><button class="quiet" id="register-embedding-model" ${isWorking ? 'disabled' : ''}>?? embedding GGUF</button><button class="quiet" id="build-embedding-index" ${isWorking || !embeddingModel ? 'disabled' : ''}>?? / ??????</button><button class="quiet" id="toggle-media-gallery">${mediaGalleryOpen ? '????' : '????'}</button></section>${mediaGallery()}${mediaTasksPanel()}${resultRows('????????????????????')}<div class="search-paging"><button class="quiet" id="search-page-previous" ${previousDisabled}>???</button><span>${searchTotal ? `? ${searchPage + 1} ??? ${searchTotal} ?` : '??????'}</span><button class="quiet" id="search-page-next" ${nextDisabled}>???</button></div></div></section>`;
}

function conversationPage() {
  const history = conversations.length ? conversations.map(conversation => `<div class="conversation-row"><button class="conversation-item ${conversation.id === activeConversationId ? 'active' : ''}" data-conversation-id="${escapeHtml(conversation.id)}"><b>${escapeHtml(conversation.title)}</b><small>${escapeHtml(conversation.updatedAt)}</small></button><button class="quiet danger delete-conversation" data-conversation-id="${escapeHtml(conversation.id)}" aria-label="????">??</button></div>`).join('') : '<div class="conversation-empty"><b>????????</b><span>?????????????????</span></div>';
  const messages = conversationMessages.length ? conversationMessages.map(message => `<article class="chat-message ${escapeHtml(message.role)}"><header><b>${message.role === 'user' ? '?' : message.source === 'cloud' ? '?? AI' : '?? AI'}</b><span>${escapeHtml(message.createdAt)}</span></header><p>${escapeHtml(message.parsedReply?.answer ?? message.content)}</p>${message.parsedReply?.steps.length ? `<ol>${message.parsedReply.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : ''}</article>`).join('') : '<p class="chat-empty">??????????AI ??????????</p>';
  return `<section class="single-panel panel"><header><div><small>LOCAL HISTORY</small><h2>AI ??</h2></div><button class="quiet" data-view="assistant">?????</button></header><div class="conversation-page"><section class="conversation-layout standalone"><aside class="conversation-history"><header><b>??????</b><small>${conversations.length} ?</small></header>${history}</aside><section class="conversation-messages"><header><div><b>????</b><span>????????????????</span></div></header>${messages}</section></section></div></section>`;
}

function cloudProviderSettings() {
  const configLabel = cloudConfig?.configured ? `????${escapeHtml(cloudConfig.displayName)}${cloudConfig.model ? ` / ${escapeHtml(cloudConfig.model)}` : ''}` : '???????????????????';
  const providerOptions = cloudProviders.map(provider => `<option value="${escapeHtml(provider.providerId)}" ${provider.providerId === cloudConfig?.providerId ? 'selected' : ''}>${escapeHtml(provider.displayName)}${provider.configured ? '' : '??????'}</option>`).join('');
  const cloudWarning = formWarning?.target === 'cloud' ? `<p class="form-warning" role="alert">${escapeHtml(formWarning.message)}</p>` : '';
  return `<section class="cloud-settings cloud-provider-card"><form id="cloud-provider-form">${cloudWarning}<div class="cloud-settings-heading cloud-provider-heading"><b>?? AI ??</b><span>${configLabel}</span><small>?? OpenAI ?????API Key ???? Windows ????????????????</small></div><label>??????<select id="cloud-provider-select"><option value="">?????</option>${providerOptions}</select></label><label>????<input id="cloud-display-name" maxlength="80" value="${escapeHtml(cloudDraft.displayName)}" placeholder="????? OpenAI ????"></label><label class="cloud-base-url-field">????<input id="cloud-base-url" maxlength="240" value="${escapeHtml(cloudDraft.baseUrl)}" placeholder="https://api.example.com ? https://api.example.com/v1"><small>????? CCSwitch ????????? /models ? /chat/completions ????????</small></label><label>??<input id="cloud-model-input" list="cloud-model-options" maxlength="160" value="${escapeHtml(cloudDraft.model)}" placeholder="?????????????"><datalist id="cloud-model-options">${cloudModels.map(item => `<option value="${escapeHtml(item.id)}"></option>`).join('')}</datalist><select id="cloud-model-select" aria-label="?????"><option value="">???????????</option>${cloudModels.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === cloudDraft.model ? 'selected' : ''}>${escapeHtml(item.id)}</option>`).join('')}</select></label><label>API Key<input id="cloud-api-key" type="password" autocomplete="off" value="${escapeHtml(cloudDraft.apiKey)}" placeholder="??????????????? Windows ??"></label><div class="cloud-actions control-cluster"><button class="quiet" id="test-cloud-connection" type="button">????</button><button class="quiet" id="fetch-cloud-models" type="button">????</button><button class="primary" type="submit">?????</button>${cloudConfig ? `<button class="quiet danger" id="delete-cloud-provider" type="button">?????</button>` : ''}</div><p class="cloud-form-note">${cloudConnectionStatus ? escapeHtml(cloudConnectionStatus) : '???????????????????????? API Key???????????????? /models ????????????????'}</p><label class="check-row"><input id="cloud-auto" type="checkbox" ${cloudDraft.autoCollaboration ? 'checked' : ''}> ????????</label><label class="check-row"><input id="cloud-review" type="checkbox" ${cloudDraft.reviewEachRequest ? 'checked' : ''}> ???????</label></form></section>`;
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
    hint.textContent = '?????????????????????????????????? Windows ??????';
    hint.dataset.state = 'pending';
  } else if (savedForDraft) {
    hint.textContent = '???? Windows ?????????????????';
    hint.dataset.state = 'saved';
  } else {
    hint.textContent = '??????????????????????????';
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
  toggle.setAttribute('aria-label', cloudApiKeyVisible ? '?? API Key' : '?? API Key');
  toggle.textContent = cloudApiKeyVisible ? '??' : '??';
  toggle.addEventListener('click', () => {
    cloudApiKeyVisible = !cloudApiKeyVisible;
    apiKey.type = cloudApiKeyVisible ? 'text' : 'password';
    toggle.textContent = cloudApiKeyVisible ? '??' : '??';
    toggle.setAttribute('aria-label', cloudApiKeyVisible ? '?? API Key' : '?? API Key');
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
  try { return new URL(baseUrl).hostname.replace(/^www\./i, '') || '?? AI ??'; }
  catch { return '?? AI ??'; }
}

function assistantPanel() {
  const outputText = aiOutputTarget ? `??????${escapeHtml(aiOutputTarget.displayPath)}` : aiOutputFolder ? `?????${escapeHtml(displayPath(aiOutputFolder))}` : '?????????? AI Outputs ???';
  const workspaceActions = aiOutputTarget ? `<div class="workspace-output-actions"><button class="quiet" id="open-ai-output-folder">???????????</button><button class="quiet" id="reveal-ai-output-folder">?????????</button></div>` : '';
  const cloudEscalation = agentRun?.status === 'needs_cloud_assistance'
    ? agentRun.route === 'cloud_auto'
      ? `<button class="quiet" id="retry-agent-run" ${isWorking ? 'disabled' : ''}>??????</button>`
      : agentRun.route === 'cloud_needs_confirmation'
        ? `<button class="primary" id="cloud-confirm" ${isWorking ? 'disabled' : ''}>????????</button>`
        : `<button class="quiet" data-view="settings">???? AI ??</button>`
    : '';
  const taskControls = !agentRun ? '' : `<div class="agent-actions">${agentRun.status === 'awaiting_local_execution' ? `<button class="primary" id="run-local-agent-task" ${isWorking ? 'disabled' : ''}>?????????</button>` : ''}${cloudEscalation}${agentRun.route === 'cloud_needs_confirmation' && agentRun.status === 'awaiting_confirmation' ? `<button class="primary" id="cloud-confirm" ${isWorking ? 'disabled' : ''}>????????</button>` : ''}${agentRun.status === 'awaiting_approval' ? `<button class="primary" id="approve-agent-step" ${isWorking ? 'disabled' : ''}>???????</button>` : ''}${agentRun.status === 'approved' ? `<button class="primary" id="apply-agent-advice" ${!aiOutputTarget || isWorking ? 'disabled' : ''}>?????</button><button class="quiet" id="apply-agent-existing-edits" ${!aiOutputTarget || isWorking ? 'disabled' : ''}>?????????</button>` : ''}${['files_written', 'check_failed'].includes(agentRun.status) && aiOutputTarget ? `<button class="quiet" id="run-workspace-check" ${isWorking ? 'disabled' : ''}>??????</button><select id="workspace-check-command"><option>npm run build</option><option>npm test</option><option>cargo check</option><option>cargo test</option></select>${agentRun.route === 'cloud_auto' && agentRun.status === 'check_failed' ? `<button class="quiet" id="auto-repair-agent-run" ${isWorking ? 'disabled' : ''}>??????</button>` : ''}` : ''}${['check_failed', 'cancelled'].includes(agentRun.status) ? `<button class="quiet" id="retry-agent-run" ${isWorking ? 'disabled' : ''}>????</button>` : ''}${!['cancelled', 'check_complete', 'local_complete', 'repair_complete', 'needs_cloud_assistance'].includes(agentRun.status) ? `<button class="quiet danger" id="cancel-agent-run" ${isWorking ? 'disabled' : ''}>????</button>` : ''}</div>`;
  const timeline = agentEvents.length ? `<ol class="agent-timeline">${agentEvents.map(event => `<li><b>${escapeHtml(event.status)}</b><span>${escapeHtml(event.message)}</span><small>${escapeHtml(event.createdAt)}</small></li>`).join('')}</ol>` : '';
  const evidence = agentEvidenceReport ? `<details class="agent-evidence-report" open><summary>???????${escapeHtml(agentEvidenceReport.status)} ? ?????? ${agentEvidenceReport.restrictedBindings}</summary><ol>${agentEvidenceReport.finalEvidence.map(escapeHtml).map(item => `<li>${item}</li>`).join('')}</ol></details>` : '';
  const runFeedback = agentRun ? `<section class="agent-feedback"><div><b>?????${escapeHtml(agentRun.route)} ? ${escapeHtml(agentRun.status)}</b><span>${escapeHtml(agentRun.reason)}</span></div><dl><div><dt>????</dt><dd>${agentRun.sourceCount}</dd></div><div><dt>????</dt><dd>${agentRun.restrictedSourceCount}</dd></div><div><dt>???</dt><dd>${agentRun.redactionCount}</dd></div></dl><p>${escapeHtml(agentRun.feedback)}</p>${sourceCitations(agentRun.sourceCitations)}${agentRun.route === 'cloud_needs_confirmation' ? `<details><summary>????????????</summary><pre>${escapeHtml(agentRun.requestPreview)}</pre></details>` : ''}${agentRun.cloudAdvice ? `<details open><summary>????????????</summary><p>${escapeHtml(agentRun.cloudAdvice.answer)}</p><p>${agentRun.cloudAdvice.uncertainties.map(escapeHtml).join('?')}</p></details>` : ''}${timeline}<button class="quiet" id="load-agent-evidence">????????</button>${evidence}${taskControls}${workspaceAction ? `<pre class="workspace-action">${escapeHtml(workspaceAction.output)}${workspaceAction.writtenFiles.length ? `\n????\n${workspaceAction.writtenFiles.map(escapeHtml).join('\n')}` : ''}</pre>` : ''}</section>` : '';
  const messages = conversationMessages.map(message => `<article class="chat-message ${message.role}"><header><b>${message.role === 'user' ? '?' : message.source === 'cloud' ? '?? AI' : '?? AI'}</b><span>${message.source === 'cloud' ? '??' : '??'}</span></header><p>${escapeHtml(message.parsedReply?.answer ?? message.content)}</p>${message.parsedReply?.steps.length ? `<ol>${message.parsedReply.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : ''}${message.parsedReply?.codeBlocks ? `<small>?? ${message.parsedReply.codeBlocks} ????????????????</small>` : ''}</article>`).join('') || '<p class="chat-empty">????????????????????????</p>';
  const history = conversations.map(conversation => `<div class="conversation-row"><button class="conversation-item ${conversation.id === activeConversationId ? 'active' : ''}" data-conversation-id="${escapeHtml(conversation.id)}"><b>${escapeHtml(conversation.title)}</b><small>${escapeHtml(conversation.updatedAt)}</small></button><button class="quiet delete-conversation" data-conversation-id="${escapeHtml(conversation.id)}">??</button></div>`).join('') || '<p>????????</p>';
  const assistantHistory = `<div class="assistant-history-brand"><span>${icons.spark}</span><div><b>AI ??</b><small>LOCAL / CLOUD</small></div></div><button class="assistant-history-new" data-new-conversation="true">${icons.spark}<span>????</span></button><div class="assistant-history-section"><small>??</small><span>${conversations.length} ?</span></div><div class="assistant-history-list">${history}</div><div class="assistant-history-foot"><span class="online-dot"></span><span>????????</span></div>`;
  const ruleList = sensitiveRules.map(rule => `<div class="rule-item"><label><input class="sensitive-rule-toggle" data-rule-id="${escapeHtml(rule.id)}" type="checkbox" ${rule.enabled ? 'checked' : ''}> <b>${escapeHtml(rule.name)}</b><small>${escapeHtml(rule.pattern)}</small></label><button class="quiet delete-sensitive-rule" data-rule-id="${escapeHtml(rule.id)}">??</button></div>`).join('') || '<p>??????????????????????????</p>';
  const governance = governanceExport ? `<pre class="governance-export">${escapeHtml(JSON.stringify(governanceExport, null, 2))}</pre>` : '';
  const backup = encryptedBackup ? `<p>????????${escapeHtml(encryptedBackup.displayPath)}?${bytes(encryptedBackup.databaseBytes)}???????? Windows ????????????????</p>` : '';
  const sensitiveReport = sensitiveFindings.length ? `<ul class="audit-list">${sensitiveFindings.map(item => `<li><b>${escapeHtml(item.category)}</b> ? ${escapeHtml(item.name)} ? ${item.matchCount} ? <small>${escapeHtml(item.displayPath)}</small></li>`).join('')}</ul>` : '<p>????????????????????????</p>';
  const auditReport = auditEntries.length ? `<ul class="audit-list">${auditEntries.map(item => `<li><b>${escapeHtml(item.targetType)}</b> ? ${escapeHtml(item.action)} ? ${escapeHtml(item.createdAt)} <small>${escapeHtml(item.oldPolicy ?? '-')} ? ${escapeHtml(item.newPolicy ?? '-')}</small></li>`).join('')}</ul>` : '<p>?????????</p>';
  const rulesWarning = formWarning?.target === 'rules' ? `<p class="form-warning" role="alert">${escapeHtml(formWarning.message)}</p>` : '';
  const taskButtonLabel = isWorking ? '???????' : '????';
  const taskStatus = isWorking ? '<p class="task-starting" role="status"><span></span>??????????????????????</p>' : '';
  return `<section class="assistant-shell"><aside class="conversation-history assistant-history" aria-label="????">${assistantHistory}</aside><section class="assistant-main"><header class="assistant-toolbar"><div><small>LOCAL / CLOUD COLLABORATION</small><h2>AI ??</h2></div><span class="local-chip">${icons.check} ????</span></header><section class="conversation-messages assistant-messages"><header><div><b>????</b><span>????????????????????</span></div></header>${messages}</section>${runFeedback}<section class="ai-output ai-output-primary"><div><b>AI ????</b><span>${outputText}</span></div><button class="quiet" id="choose-ai-output">?????</button><button class="quiet" id="create-ai-workspace">?????</button>${workspaceActions}</section><form id="ask-form" class="composer"><div class="composer-top">${assistantModelChoice()}<span>?????????????????????</span></div><label for="question">???????</label><div class="ask-row"><textarea id="question" rows="3" maxlength="2000" placeholder="?????????????????? HTML ??"></textarea><button ${isWorking ? 'disabled' : ''} type="submit" aria-label="${taskButtonLabel}">${icons.spark}<span>${taskButtonLabel}</span></button></div>${taskStatus}</form></section><section class="assistant-details"><details><summary>???????????</summary><section class="sensitive-rules"><header><div><b>??????</b><span>??????????????????????????</span></div></header>${rulesWarning}<form id="sensitive-rule-form"><input id="sensitive-rule-name" maxlength="80" placeholder="????????????"><input id="sensitive-rule-pattern" maxlength="500" placeholder="?????????CLIENT-[0-9]+"><button class="quiet" type="submit">????</button></form>${ruleList}</section><section class="governance-controls"><b>??????</b><span>????? API Key???????????????</span><div class="control-cluster"><button class="quiet" id="create-encrypted-backup">??????</button><button class="quiet" id="restore-encrypted-backup">????????</button><button class="quiet" id="scan-sensitive-index">????????</button><button class="quiet" id="load-metadata-audit">???????</button><button class="quiet" id="export-local-governance">??????</button><button class="quiet danger" id="clear-local-data" data-clear-scope="conversations">????</button><button class="quiet danger" id="clear-local-data" data-clear-scope="audit">????</button><button class="quiet danger" id="clear-local-data" data-clear-scope="rules">????</button></div>${backup}${sensitiveReport}${auditReport}${governance}</section></details></section>${resultRows('?????????????????????????')}</section>`;
}

function folderList() {
  if (!folderRefs.length) return `<div class="empty-folder drop-target"><span>${icons.folder}</span><strong>???????</strong><p>????????????????????????????????????????</p><button class="outline" id="choose-folder">???????</button></div>`;
  return `<div class="imported-folders">${folderRefs.map(folder => `<div class="folder-reference-row"><button class="folder-ref folder-ref-button metadata-target" data-folder-id="${escapeHtml(folder.id)}" data-target-type="folder" data-target-id="${escapeHtml(folder.id)}" data-note="${escapeHtml(folder.note)}" data-tags="${escapeHtml(JSON.stringify(folder.tags))}" data-cloud-policy="${folder.cloudPolicy}" data-name="${escapeHtml(folder.name)}"><span>${icons.folder}</span><div><b>${escapeHtml(folder.name)}</b><small>${escapeHtml(folder.displayPath)}</small>${folder.note ? `<p>${escapeHtml(folder.note)}</p>` : ''}${metadataLine(folder.tags, folder.cloudPolicy)}</div><em>${folder.sourceStatus === 'missing' ? '??????' : `${folder.itemCount} ???`}</em></button><button class="quiet danger remove-folder-reference" data-folder-id="${escapeHtml(folder.id)}">????</button></div>`).join('')}</div>`;
}

function folderBrowser() {
  if (!activeFolder) return '';
  const currentPath = browserPath ?? activeFolder.path;
  return `<section class="folder-browser panel" data-testid="folder-browser"><header><div><small>INLINE BROWSER</small><h2>${escapeHtml(activeFolder.name)}</h2><span>${escapeHtml(displayPath(browserPath ?? activeFolder.displayPath))}</span></div><div><button class="quiet" id="browser-back" ${browserHistory.length ? '' : 'disabled'}>????</button><button class="quiet" id="browser-reveal">?????????</button><button class="quiet" id="close-browser">??</button></div></header><div class="browser-items">${folderEntries.length ? folderEntries.map(entry => `<button class="browser-entry ${entry.itemType === 'folder' ? 'browser-folder' : 'preview-file'} metadata-target" data-target-type="item" data-target-id="${escapeHtml(entry.id)}" data-note="${escapeHtml(entry.note)}" data-tags="${escapeHtml(JSON.stringify(entry.tags))}" data-cloud-policy="${entry.cloudPolicy}" data-name="${escapeHtml(entry.name)}" data-path="${escapeHtml(entry.path)}"><span>${entry.itemType === 'folder' ? icons.folder : icons.file}</span><b>${escapeHtml(entry.name)}</b><small>${escapeHtml(entry.displayPath)}</small>${metadataLine(entry.tags, entry.cloudPolicy)}</button>`).join('') : `<p>???????</p>`}</div><input type="hidden" value="${escapeHtml(currentPath)}"></section>`;
}

function workspacePanel() {
  const percent = progress?.total ? Math.min(100, Math.round((progress.completed / progress.total) * 100)) : 0;
  const modelState = stateChip(status.modelInstalled, '???', '???');
  const runtimeState = stateChip(status.runtimeInstalled, '???', '???');
  const models = localModels.map(model => `<div class="model-row"><button class="model-item ${model.active ? 'active' : ''}" data-local-model-id="${escapeHtml(model.id)}"><b>${escapeHtml(model.displayName)}</b><small>${escapeHtml(displayPath(model.path))}</small>${model.active ? '<em>????</em>' : ''}</button><button class="quiet danger delete-local-model" data-delete-local-model-id="${escapeHtml(model.id)}">????</button></div>`).join('');
  const folderActions = folderRefs.length ? `<div class="folder-index-actions">${folderRefs.map(folder => `<button class="quiet" data-refresh-folder-id="${escapeHtml(folder.id)}">???${escapeHtml(folder.name)}</button>`).join('')}</div>` : '';
  return `<section class="workspace-view"><div class="workspace-head"><div><p>??????</p><h1>????????????????</h1><span>?????????????????AI ????????????????</span></div><div class="privacy"><b>${icons.check} ????</b><span>?????????????????</span></div></div><section class="desk-grid"><section class="file-panel panel drop-target"><header><div><small>FOLDER TERMINAL</small><h2>??????</h2></div><button class="quiet" id="refresh">????</button></header><div class="drop-hint">????????????????????????????</div>${folderList()}${folderActions}</section><section class="file-upload-card panel" id="file-upload-drop" tabindex="0"><header><div><small>QUICK IMPORT</small><h2>????</h2></div><span class="local-chip">${icons.check} ????</span></header><div class="upload-body"><div class="upload-icon">${icons.upload}</div><strong>???????</strong><p>??????????????????????????????????????</p><button class="primary" data-import-files>${icons.upload} ??????</button><small>????????????????</small></div></section></section><section class="setup panel"><div class="setup-heading"><div><small>AI INITIALIZATION</small><h2>???????????</h2><p>?????????????????????? GGUF ????????${escapeHtml(status.activeModelName)}?</p></div><div class="ready-summary">${status.runtimeInstalled && status.modelInstalled ? `${icons.check} ?????` : '????????'}</div></div><div class="setup-grid"><article><div class="setup-icon">${icons.download}</div><div class="setup-copy"><b>1. ???????</b><span>llama.cpp Windows CPU ??</span></div>${runtimeState}<button class="quiet setup-button" id="download-runtime" ${isWorking || status.runtimeInstalled ? 'disabled' : ''}>??</button></article><article><div class="setup-icon">${icons.spark}</div><div class="setup-copy"><b>2. ??????</b><span>Qwen2.5 1.5B Instruct ? Q4_K_M</span></div>${modelState}<button class="primary setup-button" id="download-model" ${isWorking || status.modelInstalled ? 'disabled' : ''}>?????</button></article></div><section class="local-models"><header><b>????</b><button class="quiet" id="register-local-model">???? GGUF ??</button></header>${models || '<p>??????????????????????</p>'}</section>${progress ? `<div class="progress"><div><b>${progress.kind === 'model' ? `??? ${escapeHtml(progress.source ?? '???')} ?? Qwen2.5 1.5B ??` : '???????????'}</b><span>${percent ? `${percent}% ? ${bytes(progress.completed)} / ${bytes(progress.total)}` : bytes(progress.completed)}</span></div><i><span style="width:${percent}%"></span></i></div>` : ''}</section></section>`;
}

function workspaceExtras() {
  const indexing = indexProgress ? `<div class="index-progress"><b>???</b><span>${indexProgress.completed} / ${indexProgress.total}</span></div>` : '';
  const watching = folderRefs.length ? `<div class="index-progress"><b>????</b><span>${folderWatchStatuses.some(item => item.mode === 'fallback_scan') ? '??????????????' : '??????????'}</span></div>` : '';
  const queue = indexJobs.length ? `<section class="index-jobs"><b>????</b>${indexJobs.map(job => `<div><span>${escapeHtml(folderRefs.find(folder => folder.id === job.folderId)?.name ?? '???')} ? ${escapeHtml(job.status)} ? ${job.completed}/${job.total} ? ?? ${job.changed}</span>${job.status === 'running' || job.status === 'queued' ? `<button class="quiet" data-pause-index-job="${escapeHtml(job.id)}">??</button>` : `<button class="quiet" data-resume-index-job="${escapeHtml(job.id)}">??</button>`}</div>`).join('')}</section>` : '';
  const recovery = recoveryNotice ? `<section class="privacy-status recovery-notice" role="alert"><b>???????</b><span>${escapeHtml(recoveryNotice)}</span><small>??????????????????????????????????</small></section>` : '';
  const privacy = privacyStatus ? `<section class="privacy-status" id="privacy-status"><b>????</b><span>${escapeHtml(privacyStatus.message)}</span><small>?????${escapeHtml(privacyStatus.recommendation)}</small></section>` : '';
  const acceptance = acceptanceChecks.length ? `<ul class="audit-list">${acceptanceChecks.map(item => `<li><b>${escapeHtml(item.label)}</b> ? ${escapeHtml(item.status)} <small>${escapeHtml(item.detail)}</small></li>`).join('')}</ul>` : '';
  return `<section class="workspace-extras workspace-extras-grid">${recovery}${privacy}<form id="runtime-settings" class="runtime-settings"><b>????????</b><label>?? <select id="runtime-mode"><option value="auto" ${runtimeSettings.executionMode === 'auto' ? 'selected' : ''}>??</option><option value="cpu" ${runtimeSettings.executionMode === 'cpu' ? 'selected' : ''}>CPU</option><option value="gpu" ${runtimeSettings.executionMode === 'gpu' ? 'selected' : ''}>GPU</option></select></label><label>?? <input id="runtime-threads" type="number" min="1" max="64" value="${runtimeSettings.threads}"></label><label>??? <input id="runtime-context" type="number" min="512" max="32768" value="${runtimeSettings.contextSize}"></label><button class="quiet" type="submit">??????</button></form><button class="quiet environment-acceptance" id="run-environment-acceptance">??????</button>${acceptance}<label class="agent-preference"><input id="auto-apply-low-risk" type="checkbox" ${agentPreferences.autoApplyLowRisk ? 'checked' : ''}> ?????????????????????????????</label>${watching}${indexing}${queue}</section>`;
}

function settingsPage() {
  const source = ({ portable: '???????', fresh_database: '????????' } as const)[dataDirectoryStatus?.source ?? 'portable'];
  const dataPath = dataDirectoryStatus?.path ?? '?????';
  return `<section class="single-panel panel"><header><div><small>PREFERENCES</small><h2>??</h2></div><span class="local-chip">${icons.check} ?????</span></header><div class="settings-page"><section class="settings-section"><div><b>??????</b><span>???????????????????? Windows ????????????</span></div><div class="font-scale-control"><input id="font-scale" type="range" min="90" max="125" step="5" value="${fontScale}" aria-label="??????"><output id="font-scale-value">${fontScale}%</output></div></section><section class="settings-section data-directory-setting"><div><b>??????</b><span><strong>${source}</strong><code>${escapeHtml(displayPath(dataPath))}</code><span>????? exe ????????????????????????? exe ??????????????????</span></span></div></section><section class="settings-section settings-note"><div><b>???????</b><span>??????????????????????????????????????????? Agent ???????????????</span></div></section><section class="settings-section cloud-provider-settings"><div><b>?? AI</b><span>???????????????????????AI ??????????????????</span></div>${cloudProviderSettings()}</section></div></section>`;
}

function aboutPage() {
  // Update actions keep the stable DOM ids `check-update` and `check-update-retry` for contract tests and accessibility tooling.
  // id="check-update" id="check-update-retry" update-check-progress
  const versionText = updateVersion ? `?????? ${escapeHtml(updateVersion)}` : escapeHtml(updateStatus);
  const checkingText = updateCheckState === 'checking' ? `<section class="update-check-progress" role="status" aria-live="polite"><div><b>???????</b><span>?? GitHub</span></div><i><span></span></i><small>?????????????????</small></section>` : '';
  const progressText = updateProgress ? `<section class="update-progress" role="status"><div><b>??????</b><span>${updateProgress.total ? `${Math.min(100, Math.round(updateProgress.completed / updateProgress.total * 100))}%` : '???????'}</span></div><i><span style="width:${updateProgress.total ? Math.min(100, Math.round(updateProgress.completed / updateProgress.total * 100)) : 15}%"></span></i><small>?????????????????????????</small></section>` : '';
  const checking = updateCheckState === 'checking';
  const action = updateVersion
    ? `<button class="primary" id="install-update" ${isWorking ? 'disabled' : ''}>${icons.download} ????</button>`
    : `<button class="quiet" id="${updateCheckState === 'error' ? 'check-update-retry' : 'check-update'}" type="button" ${checking ? 'disabled' : ''}>${checking ? '?????' : updateCheckState === 'error' ? '????' : '????'}</button>`;
  return `<section class="single-panel panel about-page"><header><div><small>ABOUT</small><h2>??????</h2></div><span class="local-chip">${icons.check} ????</span></header><div class="about-content"><section class="about-identity"><span class="about-mark">${icons.mark}</span><div><h1>????</h1><p>?????????? AI ??</p></div></section><section class="about-update"><div><b>????</b><span>${versionText}</span><small>????????????????????????????</small></div><div class="settings-actions">${action}</div></section>${checkingText}${progressText}<section class="about-detail"><b>????</b><span>?????????????????????????????????????????????????????????</span></section><section class="about-diagnostics"><div class="about-section-heading"><small>LOCAL CAPABILITIES</small><h3>???????</h3><p>???????????????????</p></div>${workspaceExtras()}</section></div></section>`;
}
function recoveryPage() {
  const message = startupMode?.message ?? '????????????';
  return `<main class="recovery-shell"><section class="recovery-card" role="alert"><span class="recovery-icon">${icons.settings}</span><small>SAFE RECOVERY MODE</small><h1>?????????</h1><p>${escapeHtml(message)}</p><div class="recovery-details"><b>???????????</b><span>????????????????????????????AI???????????</span><span>??????????????????????????????????????????????? Windows ??????????</span></div><dl><div><dt>??????</dt><dd>${escapeHtml(startupMode?.dataDirectory ?? '')}</dd></div><div><dt>??????</dt><dd>${escapeHtml(startupMode?.recoveryDirectory ?? '')}</dd></div></dl><div class="recovery-actions"><button class="primary" id="start-fresh-database" ${isWorking ? 'disabled' : ''}>???????????</button><button class="quiet" id="open-recovery-directory">?????????????</button></div>${error ? `<p class="recovery-error">${escapeHtml(error)}</p>` : ''}<p class="recovery-footnote">???????? exe ?????????????WAL ? SHM ??????????????</p></section></main>`;
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
    workspace: { title: '????', subtitle: '???????? ? ??????', content: workspacePanel() },
    search: { title: '????', subtitle: '??????????????', content: searchPanel() },
    assistant: { title: 'AI ???', subtitle: '??????????????', content: assistantPanel() },
    diagnostics: { title: '????', subtitle: '?????OCR??????????????', content: diagnosticsPage() },
    settings: { title: '??', subtitle: '???????', content: settingsPage() },
    about: { title: '??', subtitle: '??????????', content: aboutPage() },
  };
  const page = pages[activeView];
  const menu = contextTarget ? `<div class="context-menu" style="left:${contextPosition.x}px;top:${contextPosition.y}px" role="menu"><b>${escapeHtml(contextTarget.name)}</b><button data-metadata-action="note">????</button><button data-metadata-action="tags">????</button><button data-metadata-action="local_only">???????</button><button data-metadata-action="cloud_allowed">???????</button><button data-metadata-action="ask_each_time">???????</button></div>` : '';
  const editor = metadataEditor && metadataEditorAction ? `<div class="metadata-editor-backdrop"><form class="metadata-editor" id="metadata-editor-form"><header><b>${metadataEditorAction === 'note' ? '????' : '????'}</b><button type="button" class="quiet" id="cancel-metadata-editor">??</button></header><p>${escapeHtml(metadataEditor.name)}</p><label>${metadataEditorAction === 'note' ? '??' : '?????????'}<input id="metadata-editor-value" autofocus maxlength="600" value="${escapeHtml(metadataEditorAction === 'note' ? metadataEditor.note : metadataEditor.tags.join(', '))}"></label><div><button type="submit" class="primary">??</button></div></form></div>` : '';
  app.style.setProperty('--user-font-scale', `${fontScale / 100}`);
  const inspectorOpen = Boolean(activeFolder || preview);
  app.classList.toggle('inspector-open', inspectorOpen);
  app.classList.toggle('assistant-workbench', activeView === 'assistant');
  app.innerHTML = `<aside class="sidebar"><div class="brand"><span class="brand-mark">${icons.mark}</span><span>????<small>LOCAL AI WORKSPACE</small></span></div><nav><button class="nav ${activeView === 'workspace' ? 'active' : ''}" data-testid="nav-workspace" data-view="workspace">${icons.folder}<span>????</span></button><button class="nav ${activeView === 'search' ? 'active' : ''}" data-testid="nav-search" data-view="search">${icons.search}<span>????</span></button><button class="nav ${activeView === 'assistant' ? 'active' : ''}" data-testid="nav-assistant" data-view="assistant">${icons.spark}<span>AI ???</span></button><button class="nav ${activeView === 'diagnostics' ? 'active' : ''}" data-testid="nav-diagnostics" data-view="diagnostics">${icons.file}<span>????</span></button></nav><div class="sidebar-bottom"><button class="nav ${activeView === 'settings' ? 'active' : ''}" data-testid="nav-settings" data-view="settings">${icons.settings}<span>??</span></button><button class="nav ${activeView === 'about' ? 'active' : ''}" data-testid="nav-about" data-view="about">${icons.file}<span>??</span></button><div class="sidebar-foot"><span class="online-dot"></span><span>??????</span></div></div></aside><main><header class="topbar"><div><strong>${page.title}</strong><span>${page.subtitle}</span></div><button class="import" id="import-folder">${icons.folder} ?????</button></header><section class="canvas">${page.content}${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}</section></main>${rightInspector()}${menu}${editor}`;
  restoreCloudDraftToDom();
  setupCloudProviderForm();
  bind();
}

async function refreshStatus() { [status, folderRefs, cloudConfig, cloudProviders, conversations, sensitiveRules, localModels, agentPreferences, privacyStatus, recoveryNotice, indexJobs, runtimeSettings, embeddingModels, mediaTasks, mediaSettings, localTools, managedDownloadResources, downloadTasks, folderWatchStatuses] = await Promise.all([invoke<RuntimeStatus>('get_runtime_status'), invoke<FolderRef[]>('list_folder_refs'), invoke<CloudProviderConfig | null>('get_cloud_provider_config'), invoke<CloudProviderConfig[]>('list_cloud_providers'), invoke<Conversation[]>('list_conversations'), invoke<SensitiveRule[]>('list_sensitive_rules'), invoke<LocalModel[]>('list_local_models'), invoke<AgentPreferences>('get_agent_preferences'), invoke<PrivacyStatus>('get_privacy_status'), invoke<string | null>('get_startup_recovery_notice'), invoke<IndexJob[]>('list_index_jobs'), invoke<RuntimeSettings>('get_runtime_settings'), invoke<EmbeddingModel[]>('list_embedding_models'), invoke<MediaTask[]>('list_media_tasks'), invoke<MediaSettings>('get_media_settings'), invoke<LocalToolStatus>('get_local_tool_status'), invoke<ManagedDownloadResource[]>('list_managed_download_resources'), invoke<DownloadTask[]>('list_download_tasks'), invoke<FolderWatchStatus[]>('list_folder_watch_status')]); if (!cloudDraft.providerId && !cloudDraft.displayName && !cloudDraft.baseUrl && !cloudDraft.model) { cloudDraft = cloudDraftFromConfig(cloudConfig); cloudOriginalProviderId = cloudConfig?.providerId ?? null; } render(); }
async function refreshManagedResources() { [managedDownloadResources, downloadTasks, folderWatchStatuses] = await Promise.all([invoke<ManagedDownloadResource[]>('list_managed_download_resources'), invoke<DownloadTask[]>('list_download_tasks'), invoke<FolderWatchStatus[]>('list_folder_watch_status')]); }
async function downloadManagedResource(resourceId: string) { isWorking = true; error = ''; render(); try { await invoke('download_managed_resource', { input: { resourceId } }); await refreshManagedResources(); } catch (reason) { formWarning = { target: 'media', message: String(reason) }; } finally { isWorking = false; render(); } }
async function retryDownloadTask(id: string) { await invoke('retry_download_task', { input: { id } }); await refreshBackgroundTasks(); }
async function cancelDownloadTask(id: string) { await invoke('cancel_download_task', { input: { id } }); await refreshBackgroundTasks(); }
async function deleteManagedResource(resourceId: string) { if (!window.confirm('??????????????????????')) return; isWorking = true; try { await invoke('delete_managed_download_resource', { input: { resourceId, confirmed: true } }); await refreshManagedResources(); } catch (reason) { formWarning = { target: 'media', message: String(reason) }; } finally { isWorking = false; render(); } }
async function refreshDiagnostics(status = '') { diagnosticStatus = status; diagnostics = await invoke<IndexDiagnosticItem[]>('list_index_diagnostics', { input: { limit: 200 } }); render(); }
async function retryDiagnostics(ids: string[]) { if (!ids.length || !window.confirm(`?? ${ids.length} ?????????????????`)) return; isWorking = true; try { const retried = await invoke<number>('retry_index_diagnostics', { input: { itemIds: ids, confirmed: true } }); await refreshDiagnostics(`??? ${retried} ??`); } catch (reason) { diagnosticStatus = String(reason); render(); } finally { isWorking = false; } }
async function refreshBackgroundTasks() { backgroundTasks = await invoke<BackgroundTask[]>('list_background_tasks'); render(); }
async function startFreshDatabase() {
  if (!window.confirm('????????????? exe ???????????????????????????????')) return;
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

function rightInspector() {
  const hasFolder = Boolean(activeFolder);
  const inspectorTitle = preview ? preview.name : activeFolder?.name ?? '?????';
  const inspectorSubtitle = preview ? preview.displayPath : activeFolder ? displayPath(browserPath ?? activeFolder.displayPath) : '??????????? AI ?????????????';
  const folderContent = !hasFolder ? `<section class="inspector-empty"><span>${icons.folder}</span><b>??????</b><p>??????????????????????????????</p></section>` : `<section class="inspector-browser"><header><div><small>FILES</small><b>${escapeHtml(activeFolder!.name)}</b></div><div><button class="quiet" id="browser-back" ${browserHistory.length ? '' : 'disabled'}>??</button><button class="quiet" id="browser-reveal">??</button></div></header><div class="inspector-path" title="${escapeHtml(displayPath(browserPath ?? activeFolder!.displayPath))}">${escapeHtml(displayPath(browserPath ?? activeFolder!.displayPath))}</div><div class="browser-items">${folderEntries.length ? folderEntries.map(entry => `<button class="browser-entry ${entry.itemType === 'folder' ? 'browser-folder' : 'preview-file'} metadata-target" data-target-type="item" data-target-id="${escapeHtml(entry.id)}" data-note="${escapeHtml(entry.note)}" data-tags="${escapeHtml(JSON.stringify(entry.tags))}" data-cloud-policy="${entry.cloudPolicy}" data-name="${escapeHtml(entry.name)}" data-path="${escapeHtml(entry.path)}"><span>${entry.itemType === 'folder' ? icons.folder : icons.file}</span><div><b>${escapeHtml(entry.name)}</b><small>${entry.itemType === 'folder' ? '???' : escapeHtml(entry.displayPath)}</small>${metadataLine(entry.tags, entry.cloudPolicy)}</div></button>`).join('') : '<p>???????</p>'}</div></section>`;
  const previewContent = preview ? `<section class="inspector-preview"><header><div><small>PREVIEW</small><b>${escapeHtml(preview.name)}</b></div><div><button class="quiet" id="reveal-file">??</button><button class="quiet" id="close-preview">????</button></div></header><div class="preview-body">${preview.kind === 'image' ? `<img src="data:${preview.mimeType};base64,${preview.content}" alt="${escapeHtml(preview.name)}">` : preview.kind === 'pdf' ? `<iframe title="${escapeHtml(preview.name)}" src="data:application/pdf;base64,${preview.content}"></iframe>` : preview.kind === 'text' ? `<pre>${escapeHtml(preview.content)}</pre>` : `<p>${escapeHtml(preview.message)}</p>`}</div></section>` : '';
  return `<aside class="right-inspector ${hasFolder || preview ? 'is-open' : ''}" aria-label="???????"><header class="inspector-heading"><div><small>CONTEXT</small><h2>${escapeHtml(inspectorTitle)}</h2><span>${escapeHtml(inspectorSubtitle)}</span></div><button class="quiet" id="close-inspector" ${hasFolder || preview ? '' : 'disabled'}>??</button></header>${folderContent}${previewContent}</aside>`;
}

function assistantModelChoice() {
  const activeLocal = localModels.find(model => model.active);
  const selected = executionPreference === 'local'
    ? `local:${activeLocal?.id ?? 'default'}`
    : executionPreference === 'cloud' && cloudConfig?.configured
      ? `cloud:${cloudConfig.providerId}`
      : 'automatic';
  const defaultLocal = status.modelInstalled ? `?????? ? ${escapeHtml(status.activeModelName)}` : '?????? ? ???';
  const localOptions = [`<option value="local:default" ${selected === 'local:default' ? 'selected' : ''} ${status.modelInstalled ? '' : 'disabled'}>${defaultLocal}</option>`, ...localModels.map(model => `<option value="local:${escapeHtml(model.id)}" ${selected === `local:${model.id}` ? 'selected' : ''}>${escapeHtml(model.displayName)}${model.active ? ' ? ??' : ''}</option>`)].join('');
  const cloudOptions = cloudProviders.filter(provider => provider.configured).map(provider => `<option value="cloud:${escapeHtml(provider.providerId)}" ${selected === `cloud:${provider.providerId}` ? 'selected' : ''}>${escapeHtml(provider.displayName)}${provider.model ? ` ? ${escapeHtml(provider.model)}` : ''}</option>`).join('') || '<option value="" disabled>????????????</option>';
  return `<label class="assistant-model-picker">?????<select id="assistant-model-choice" aria-label="?????????"><option value="automatic" ${selected === 'automatic' ? 'selected' : ''}>???? ? ????</option><optgroup label="????">${localOptions}</optgroup><optgroup label="????">${cloudOptions}</optgroup></select></label>`;
}
async function revealFolder() { if (!activeFolder) return; try { await invoke('reveal_in_explorer', { path: browserPath ?? activeFolder.path }); } catch (reason) { error = `??????????${String(reason)}`; render(); } }
async function openAiOutputFolder() {
  if (!aiOutputTarget) return;
  try {
    activeFolder = { id: aiOutputTarget.workspaceId, name: 'AI ?????', path: aiOutputTarget.path, displayPath: aiOutputTarget.displayPath, note: 'AI ????', tags: ['AI ??'], cloudPolicy: 'local_only', itemCount: 0, sourceStatus: 'available' };
    browserPath = aiOutputTarget.path;
    browserHistory = [];
    folderEntries = await invoke<FolderEntry[]>('list_ai_workspace_children', { input: { workspaceId: aiOutputTarget.workspaceId } });
  } catch (reason) { error = `???? AI ??????${String(reason)}`; }
  render();
}
async function revealAiOutputFolder() {
  if (!aiOutputTarget) return;
  try { await invoke('reveal_in_explorer', { path: aiOutputTarget.path }); }
  catch (reason) { error = `???? AI ??????${String(reason)}`; render(); }
}
async function importFolderPath(path: string) {
  isWorking = true; error = ''; render();
  try { const indexed = await invoke<number>('import_folder', { input: { path, note: '', tags: [] } }); await loadFolderRefs(); window.alert(`?????????????? ${indexed} ??????`); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function selectFolder() {
  const selected = await open({ directory: true, multiple: false, title: '?????????' });
  if (!selected || Array.isArray(selected)) return;
  const note = window.prompt('????????????????') ?? '';
  const tagText = window.prompt('????????????????') ?? '';
  isWorking = true; error = ''; render();
  try { const indexed = await invoke<number>('import_folder', { input: { path: selected, note, tags: tagText.split(',').map(tag => tag.trim()).filter(Boolean) } }); await loadFolderRefs(); window.alert(`?????????????? ${indexed} ??????`); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function importFilesToLibrary(paths: string[]) {
  if (!paths.length) return;
  isWorking = true; error = ''; render();
  try { const copied = await invoke<number>('import_files_to_library', { input: { paths } }); await loadFolderRefs(); window.alert(`??? ${copied} ??????????????????????????`); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function chooseFilesForImport() {
  const selected = await open({ directory: false, multiple: true, title: '?????????????' });
  if (!selected) return;
  await importFilesToLibrary(Array.isArray(selected) ? selected : [selected]);
}
function metadataTarget(element: HTMLElement): MetadataTarget | null {
  const targetType = element.dataset.targetType;
  const targetId = element.dataset.targetId;
  if ((targetType !== 'folder' && targetType !== 'item') || !targetId) return null;
  try {
    return { targetType, targetId, name: element.dataset.name ?? '??', note: element.dataset.note ?? '', tags: JSON.parse(element.dataset.tags ?? '[]'), cloudPolicy: (element.dataset.cloudPolicy as CloudPolicy) ?? 'local_only' };
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
    if (policy !== 'local_only' && target.cloudPolicy === 'local_only' && !window.confirm('??????AI ???????????????????????????')) { render(); return; }
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
  catch (reason) { updateMetadataOptimistically(target, original); error = `???????${String(reason)}`; render(); }
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
    error = `????????${String(reason)}`;
    render();
  });
}
async function chooseAiOutputFolder() {
  const selected = await open({ directory: true, multiple: false, title: '?? AI ?????' });
  if (!selected || Array.isArray(selected)) return;
  aiOutputFolder = selected; aiOutputTarget = null; render();
}
async function createAiWorkspace() {
  const projectName = window.prompt('???? AI ????????', 'AI Project');
  if (projectName === null) return;
  isWorking = true; error = ''; render();
  try { aiOutputTarget = await invoke<AiOutputTarget>('prepare_ai_output', { input: { outputFolder: aiOutputFolder, projectName } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); }
}
async function ensureAiWorkspace() {
  if (aiOutputTarget) return aiOutputTarget;
  const projectName = agentRun ? `??-${agentRun.id.slice(0, 8)}` : 'AI Project';
  aiOutputTarget = await invoke<AiOutputTarget>('prepare_ai_output', { input: { outputFolder: aiOutputFolder, projectName } });
  return aiOutputTarget;
}
async function provision(kind: 'runtime' | 'model') { isWorking = true; error = ''; progress = { kind, completed: 0 }; render(); try { status = await invoke<RuntimeStatus>(kind === 'runtime' ? 'download_runtime' : 'download_model'); } catch (reason) { error = String(reason); } finally { isWorking = false; progress = null; render(); } }
async function registerLocalModel() { const selected = await open({ multiple: false, directory: false, filters: [{ name: 'GGUF ??', extensions: ['gguf'] }], title: '???? GGUF ??' }); if (!selected || Array.isArray(selected)) return; isWorking = true; error = ''; render(); try { await invoke<LocalModel>('register_local_model', { input: { path: selected } }); [status, localModels] = await Promise.all([invoke<RuntimeStatus>('get_runtime_status'), invoke<LocalModel[]>('list_local_models')]); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function selectLocalModel(id: string) { isWorking = true; error = ''; render(); try { await invoke('select_local_model', { input: { id } }); [status, localModels] = await Promise.all([invoke<RuntimeStatus>('get_runtime_status'), invoke<LocalModel[]>('list_local_models')]); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function deleteLocalModel(id: string) { if (!window.confirm('???????????????? GGUF ?????')) return; isWorking = true; error = ''; render(); try { await invoke('delete_local_model', { input: { id } }); [status, localModels] = await Promise.all([invoke<RuntimeStatus>('get_runtime_status'), invoke<LocalModel[]>('list_local_models')]); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function refreshFolderIndex(folderId: string) { try { await invoke('enqueue_index_job', { input: { folderId } }); indexJobs = await invoke<IndexJob[]>('list_index_jobs'); render(); } catch (reason) { error = String(reason); render(); } }
async function pauseIndexJob(id: string) { await invoke('pause_index_job', { input: { id } }); indexJobs = await invoke<IndexJob[]>('list_index_jobs'); render(); }
async function resumeIndexJob(id: string) { await invoke('resume_index_job', { input: { id } }); indexJobs = await invoke<IndexJob[]>('list_index_jobs'); render(); }
function scheduleFolderRefresh(change: FolderChangeDetected) {
  const existing = folderRefreshTimers.get(change.folderId);
  if (existing) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    folderRefreshTimers.delete(change.folderId);
    refreshFolderIndex(change.folderId).catch(reason => { error = `???????${String(reason)}`; render(); });
  }, 1_500);
  folderRefreshTimers.set(change.folderId, timer);
}
function scheduleEmbeddingUpdate() {
  if (!embeddingModels.some(model => model.active)) return;
  if (embeddingUpdateTimer) window.clearTimeout(embeddingUpdateTimer);
  embeddingUpdateTimer = window.setTimeout(() => {
    buildEmbeddingIndex().catch(reason => { error = `???????????${String(reason)}`; render(); });
  }, 1_200);
}
async function removeFolderReference(folderId: string) { if (!window.confirm('???????????????????????????????')) return; isWorking = true; error = ''; render(); try { await invoke('remove_folder_reference', { input: { folderId } }); if (activeFolder?.id === folderId) activeFolder = null; await loadFolderRefs(); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function searchDocuments(page = 0) { if (!searchQuery) return; isWorking = true; error = ''; render(); try { const result = await invoke<SearchDocumentsResult>(searchMode === 'semantic' ? 'semantic_search' : 'search_documents', { input: { query: searchQuery, tag: searchFilter || undefined, folderId: searchFolderFilter || undefined, itemType: searchTypeFilter || undefined, page } }); results = result.items; searchTotal = result.total; searchPage = result.page; appliedSearchMode = result.searchMode; } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function registerEmbeddingModel() { const selected = await open({ multiple: false, directory: false, filters: [{ name: 'Embedding GGUF ??', extensions: ['gguf'] }], title: '???? embedding GGUF ??' }); if (!selected || Array.isArray(selected)) return; isWorking = true; error = ''; render(); try { await invoke<EmbeddingModel>('register_embedding_model', { input: { path: selected } }); embeddingModels = await invoke<EmbeddingModel[]>('list_embedding_models'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
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
async function chooseWhisperModel() { const selected = await open({ multiple: false, directory: false, title: '???? Whisper ??', filters: [{ name: 'Whisper ??', extensions: ['bin', 'gguf'] }] }); if (!selected || Array.isArray(selected)) return; mediaSettings = { ...mediaSettings, whisperModelPath: selected }; render(); }
async function saveAgentPreferences() { const autoApplyLowRisk = document.querySelector<HTMLInputElement>('#auto-apply-low-risk')?.checked ?? false; try { agentPreferences = await invoke<AgentPreferences>('save_agent_preferences', { input: { autoApplyLowRisk } }); } catch (reason) { error = String(reason); } render(); }
async function saveRuntimeSettings(event: SubmitEvent) { event.preventDefault(); const executionMode = document.querySelector<HTMLSelectElement>('#runtime-mode')?.value as RuntimeSettings['executionMode'] ?? 'auto'; const threads = Number(document.querySelector<HTMLInputElement>('#runtime-threads')?.value ?? 4); const contextSize = Number(document.querySelector<HTMLInputElement>('#runtime-context')?.value ?? 4096); isWorking = true; error = ''; render(); try { runtimeSettings = await invoke<RuntimeSettings>('save_runtime_settings', { input: { executionMode, threads, contextSize } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function runEnvironmentAcceptance() { isWorking = true; error = ''; render(); try { acceptanceChecks = await invoke<AcceptanceCheck[]>('run_environment_acceptance'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function loadAgentEvidenceReport() { if (!agentRun) return; isWorking = true; error = ''; render(); try { agentEvidenceReport = await invoke<AgentEvidenceReport>('get_agent_evidence_report', { input: { runId: agentRun.id } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function ask(question: string) {
  isWorking = true; error = ''; agentRun = null; render();
  try {
    [results, agentRun] = await Promise.all([invoke<Result[]>('ask_assistant', { question }), invoke<AgentRun>('prepare_agent_run', { input: { question, conversationId: activeConversationId, executionPreference } })]);
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
    agentRun = { ...agentRun, status: 'running_local', feedback: '????????????????????????' };
    render();
    agentRun = await invoke<AgentRun>('run_local_agent_task', { runId: agentRun.id });
    await loadConversationHistory();
    agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } });
  } catch (reason) {
    error = `????????${String(reason)}?????? ? ?? AI??? llama.cpp ????????????`;
    if (agentRun) agentRun = { ...agentRun, status: 'failed', feedback: error };
  }
  finally { isWorking = false; render(); }
}
async function selectAssistantModel(value: string) {
  if (value === 'automatic') {
    executionPreference = 'automatic';
  } else if (value.startsWith('local:')) {
    const localId = value.slice('local:'.length);
    if (localId !== 'default') await invoke('select_local_model', { input: { id: localId } });
    executionPreference = 'local';
  } else if (value.startsWith('cloud:')) {
    const providerId = value.slice('cloud:'.length);
    cloudConfig = await invoke<CloudProviderConfig>('select_cloud_provider', { input: { providerId } });
    cloudOriginalProviderId = cloudConfig.providerId;
    cloudDraft = cloudDraftFromConfig(cloudConfig);
    executionPreference = 'cloud';
  }
  localStorage.setItem('file-terminal.execution-preference', executionPreference);
  await refreshStatus();
}
async function saveCloudProvider(event: SubmitEvent) {
  event.preventDefault(); syncCloudDraftFromDom(); const draft = { ...cloudDraft, displayName: cloudDraft.displayName || defaultCloudDisplayName(cloudDraft.baseUrl) };
  cloudDraft = draft;
  if (!draft.baseUrl || !draft.model) { formWarning = { target: 'cloud', message: '????????????????????????????????????????????????' }; render(); return; }
  isWorking = true; error = ''; formWarning = null; cloudConnectionStatus = ''; render();
  try {
    cloudConfig = await invoke<CloudProviderConfig>('save_cloud_provider_config', { input: draft });
    cloudOriginalProviderId = cloudConfig.providerId;
    cloudDraft = { ...cloudDraftFromConfig(cloudConfig), apiKey: '' };
    cloudProviders = await invoke<CloudProviderConfig[]>('list_cloud_providers');
    cloudConnectionStatus = '???????API Key ???? Windows ??????';
  } catch (reason) { formWarning = { target: 'cloud', message: String(reason) }; }
  finally { isWorking = false; render(); }
}
async function testCloudConnection() {
  const input = cloudProbeInput();
  if (!input.baseUrl || !input.model || !input.apiKey && !input.providerId) { formWarning = { target: 'cloud', message: '??????????? API Key????????????? API Key?' }; render(); return; }
  isWorking = true; error = ''; formWarning = null; cloudConnectionStatus = '???????'; render();
  try {
    const result = await invoke<CloudConnectionProbeResult>('test_cloud_connection', { input });
    cloudConnectionStatus = `???? ? ${result.latencyMs} ms ? ${result.endpoint}`;
  } catch (reason) { formWarning = { target: 'cloud', message: String(reason) }; cloudConnectionStatus = ''; }
  finally { isWorking = false; render(); }
}
async function fetchCloudModels() {
  const input = cloudProbeInput();
  if (!input.baseUrl || !input.apiKey && !input.providerId) { formWarning = { target: 'cloud', message: '???????? API Key????????????? API Key?' }; render(); return; }
  isWorking = true; error = ''; formWarning = null; cloudConnectionStatus = '?????????'; render();
  try {
    cloudModels = await invoke<CloudModel[]>('discover_cloud_models', { input });
    if (!cloudDraft.model && cloudModels[0]) cloudDraft.model = cloudModels[0].id;
    cloudConnectionStatus = cloudModels.length ? `??? ${cloudModels.length} ???????????????` : '?????????????????????????';
  } catch (reason) { formWarning = { target: 'cloud', message: String(reason) }; cloudConnectionStatus = ''; }
  finally { isWorking = false; render(); }
}
async function selectCloudProvider(providerId: string) { cloudConfig = providerId ? await invoke<CloudProviderConfig>('select_cloud_provider', { input: { providerId } }) : null; cloudOriginalProviderId = cloudConfig?.providerId ?? null; cloudDraft = cloudDraftFromConfig(cloudConfig); cloudModels = []; cloudConnectionStatus = ''; formWarning = null; if (cloudConfig) cloudProviders = await invoke<CloudProviderConfig[]>('list_cloud_providers'); render(); }
async function openConversation(conversationId: string) { activeConversationId = conversationId; conversationMessages = await invoke<ConversationMessage[]>('list_conversation_messages', { input: { conversationId } }); render(); }
async function autoApplyLowRiskAdvice() {
  if (!agentRun || !aiOutputTarget || !agentPreferences.autoApplyLowRisk || agentRun.status !== 'awaiting_approval') return;
  try {
    workspaceAction = await invoke<WorkspaceActionResult>('auto_apply_low_risk_agent_advice', { input: { runId: agentRun.id, workspaceId: aiOutputTarget.workspaceId } });
    agentRun = { ...agentRun, status: workspaceAction.status, feedback: '??????????????????????????????????' };
  } catch (reason) {
    // Unsafe or incomplete advice falls back to the existing explicit approval flow.
    error = `??????${String(reason)}`;
  }
}
async function runCloudCollaboration() { if (!agentRun) return; isWorking = true; error = ''; render(); try { await ensureAiWorkspace(); agentRun = await invoke<AgentRun>('run_cloud_collaboration', { runId: agentRun.id }); await autoApplyLowRiskAdvice(); await loadConversationHistory(); agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function approveAgentStep() { if (!agentRun) return; isWorking = true; error = ''; render(); try { await invoke('approve_agent_step', { input: { runId: agentRun.id } }); agentRun = { ...agentRun, status: 'approved', feedback: '????????????????????????????' }; } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function cancelAgentRun() { if (!agentRun || !window.confirm('???????????????????????')) return; isWorking = true; error = ''; render(); try { await invoke('cancel_agent_run', { input: { runId: agentRun.id } }); agentRun = { ...agentRun, status: 'cancelled', feedback: '?????????????????????' }; } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function applyAgentAdvice() { if (!agentRun || !aiOutputTarget) { error = '???? AI ??????????????'; render(); return; } isWorking = true; error = ''; workspaceAction = null; render(); try { workspaceAction = await invoke<WorkspaceActionResult>('apply_agent_advice', { input: { runId: agentRun.id, workspaceId: aiOutputTarget.workspaceId } }); agentRun = { ...agentRun, status: workspaceAction.status, feedback: '?????????????????' }; } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function applyAgentExistingEdits() { if (!agentRun || !aiOutputTarget) return; if (!window.confirm('?????? AI ????????????????????????? 2 MB??????????????????????')) return; isWorking = true; error = ''; workspaceAction = null; render(); try { workspaceAction = await invoke<WorkspaceActionResult>('apply_agent_advice', { input: { runId: agentRun.id, workspaceId: aiOutputTarget.workspaceId, allowExistingEdits: true } }); agentRun = { ...agentRun, status: workspaceAction.status, feedback: '??????????????????' }; } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function installLocalTool(tool: string) { if (!window.confirm('??? Windows winget ?????????????????????')) return; isWorking = true; error = ''; render(); try { await invoke<string>('install_local_tool', { input: { tool, confirmed: true } }); localTools = await invoke<LocalToolStatus>('get_local_tool_status'); } catch (reason) { formWarning = { target: 'media', message: String(reason) }; } finally { isWorking = false; render(); } }
async function runWorkspaceCheck() { if (!aiOutputTarget) return; const command = document.querySelector<HTMLSelectElement>('#workspace-check-command')?.value ?? 'npm run build'; isWorking = true; error = ''; workspaceAction = null; render(); try { workspaceAction = await invoke<WorkspaceActionResult>('run_workspace_check', { input: { workspaceId: aiOutputTarget.workspaceId, command, runId: agentRun?.id } }); if (agentRun) { agentRun = { ...agentRun, status: workspaceAction.status }; agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } }); } } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function autoRepairAgentRun() { if (!agentRun || !aiOutputTarget) return; const command = document.querySelector<HTMLSelectElement>('#workspace-check-command')?.value ?? 'npm run build'; isWorking = true; error = ''; workspaceAction = null; render(); try { workspaceAction = await invoke<WorkspaceActionResult>('auto_repair_agent_run', { input: { runId: agentRun.id, workspaceId: aiOutputTarget.workspaceId, command } }); agentRun = { ...agentRun, status: workspaceAction.status, feedback: workspaceAction.status === 'repair_complete' ? '??????????????' : '?????????????????????' }; agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function retryAgentRun() { if (!agentRun) return; isWorking = true; error = ''; render(); try { if (agentRun.status === 'needs_cloud_assistance' && agentRun.route === 'cloud_auto') { await ensureAiWorkspace(); agentRun = await invoke<AgentRun>('run_cloud_collaboration', { runId: agentRun.id }); await autoApplyLowRiskAdvice(); } else { agentRun = await invoke<AgentRun>('retry_agent_run', { input: { runId: agentRun.id } }); if (agentRun.route === 'cloud_auto') { await ensureAiWorkspace(); agentRun = await invoke<AgentRun>('run_cloud_collaboration', { runId: agentRun.id }); await autoApplyLowRiskAdvice(); } } agentEvents = await invoke<AgentEvent[]>('list_agent_events', { input: { runId: agentRun.id } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function deleteConversation(conversationId: string) { if (!window.confirm('??????????????????')) return; isWorking = true; error = ''; render(); try { await invoke('delete_conversation', { input: { conversationId } }); if (activeConversationId === conversationId) { activeConversationId = null; conversationMessages = []; } await loadConversationHistory(); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function deleteCloudProvider() { if (!cloudConfig || !window.confirm(`??????${cloudConfig.displayName}??? Windows ???`)) return; isWorking = true; error = ''; render(); try { await invoke('delete_cloud_provider', { input: { providerId: cloudConfig.providerId } }); cloudConfig = null; cloudOriginalProviderId = null; cloudDraft = cloudDraftFromConfig(null); cloudModels = []; cloudProviders = await invoke<CloudProviderConfig[]>('list_cloud_providers'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function saveSensitiveRule(event: SubmitEvent) { event.preventDefault(); const name = document.querySelector<HTMLInputElement>('#sensitive-rule-name')?.value.trim() ?? ''; const pattern = document.querySelector<HTMLInputElement>('#sensitive-rule-pattern')?.value.trim() ?? ''; isWorking = true; error = ''; formWarning = null; render(); try { await invoke<SensitiveRule>('save_sensitive_rule', { input: { name, pattern, enabled: true } }); sensitiveRules = await invoke<SensitiveRule[]>('list_sensitive_rules'); } catch (reason) { formWarning = { target: 'rules', message: String(reason) }; } finally { isWorking = false; render(); } }
async function updateSensitiveRule(rule: SensitiveRule, enabled: boolean) { isWorking = true; error = ''; render(); try { await invoke<SensitiveRule>('save_sensitive_rule', { input: { id: rule.id, name: rule.name, pattern: rule.pattern, enabled } }); sensitiveRules = await invoke<SensitiveRule[]>('list_sensitive_rules'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function deleteSensitiveRule(id: string) { if (!window.confirm('???????????')) return; isWorking = true; error = ''; render(); try { await invoke('delete_sensitive_rule', { input: { id } }); sensitiveRules = await invoke<SensitiveRule[]>('list_sensitive_rules'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function exportLocalGovernance() { isWorking = true; error = ''; render(); try { governanceExport = await invoke<GovernanceExport>('export_local_governance'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function createEncryptedBackup() { isWorking = true; error = ''; render(); try { encryptedBackup = await invoke<EncryptedBackup>('create_encrypted_backup'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function restoreEncryptedBackup() { const selected = await open({ multiple: false, directory: false, filters: [{ name: '????????', extensions: ['ftbackup'] }], title: '??????' }); if (!selected || Array.isArray(selected)) return; isWorking = true; error = ''; render(); try { const result = await invoke<{ message: string }>('stage_encrypted_restore', { input: { path: selected } }); window.alert(result.message); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function scanSensitiveIndex() { isWorking = true; error = ''; render(); try { sensitiveFindings = await invoke<SensitiveFinding[]>('scan_sensitive_index'); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function loadMetadataAudit() { isWorking = true; error = ''; render(); try { auditEntries = await invoke<MetadataAuditEntry[]>('list_metadata_audit', { input: { limit: 100 } }); } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function clearLocalData(scope: string) { if (!window.confirm('?????????????????????????')) return; isWorking = true; error = ''; render(); try { await invoke('clear_local_data', { input: { scope } }); await refreshStatus(); governanceExport = null; if (scope === 'conversations') { activeConversationId = null; conversationMessages = []; } } catch (reason) { error = String(reason); } finally { isWorking = false; render(); } }
async function loadPreview(path: string) { if (!path) return; isWorking = true; error = ''; render(); try { preview = await invoke<FilePreview>('preview_file', { path }); } catch (reason) { error = `???????${String(reason)}`; } finally { isWorking = false; render(); } }
async function convertOfficePreview() { if (!preview) return; isWorking = true; error = ''; render(); try { preview = await invoke<FilePreview>('convert_office_preview', { path: preview.path }); } catch (reason) { error = `??????????${String(reason)}`; } finally { isWorking = false; render(); } }
async function revealPreview() { if (!preview) return; try { await invoke('reveal_in_explorer', { path: preview.path }); } catch (reason) { error = `??????????${String(reason)}`; render(); } }
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
    updateStatus = updateVersion ? `?????? ${updateVersion}` : '????????';
    updateCheckState = 'success';
    if (updateVersion && !showResult && window.confirm(`?? ${updateVersion} ???????????????`)) await installUpdate();
  } catch (reason) {
    updateCheckState = 'error';
    updateStatus = '?????? GitHub ???????????????????';
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
  document.querySelectorAll<HTMLElement>('.folder-ref-button').forEach(button => button.addEventListener('click', () => openFolder(button.dataset.folderId ?? '').catch(reason => { error = `????????${String(reason)}`; render(); })));
  document.querySelectorAll<HTMLElement>('.browser-folder').forEach(button => button.addEventListener('click', () => {
    const outputWorkspace = activeFolder && aiOutputTarget && activeFolder.id === aiOutputTarget.workspaceId ? aiOutputTarget : null;
    if (outputWorkspace && activeFolder) {
      browserHistory.push(browserPath ?? activeFolder.path);
      invoke<FolderEntry[]>('list_ai_workspace_children', { input: { workspaceId: outputWorkspace.workspaceId, path: button.dataset.path ?? outputWorkspace.path } })
        .then(entries => { browserPath = button.dataset.path ?? outputWorkspace.path; folderEntries = entries; render(); })
        .catch(reason => { error = `???? AI ??????${String(reason)}`; render(); });
    } else navigateFolder(button.dataset.path ?? '').catch(reason => { error = `????????${String(reason)}`; render(); });
  }));
  document.querySelector('#browser-back')?.addEventListener('click', () => browserBack().catch(reason => { error = `???????${String(reason)}`; render(); }));
  document.querySelector('#browser-reveal')?.addEventListener('click', revealFolder);
  document.querySelector('#close-browser')?.addEventListener('click', () => { activeFolder = null; browserPath = null; browserHistory = []; folderEntries = []; render(); });
  document.querySelector('#close-inspector')?.addEventListener('click', () => { activeFolder = null; browserPath = null; browserHistory = []; folderEntries = []; preview = null; render(); });
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
  uploadDrop?.addEventListener('drop', event => { event.preventDefault(); uploadDrop.classList.remove('dragging'); const paths = Array.from(event.dataTransfer?.files ?? []).map(file => (file as File & { path?: string }).path).filter((path): path is string => Boolean(path)); if (paths.length) importFilesToLibrary(paths); else { error = '???????????????????????'; render(); } });
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
  document.querySelector('#export-diagnostics')?.addEventListener('click', async () => { try { const report = await invoke<{ items: IndexDiagnosticItem[] }>('export_index_diagnostics', { input: { limit: 500 } }); diagnosticStatus = `??? ${report.items.length} ?????????????`; render(); } catch (reason) { diagnosticStatus = String(reason); render(); } });
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
  document.querySelector<HTMLSelectElement>('#assistant-model-choice')?.addEventListener('change', event => selectAssistantModel((event.target as HTMLSelectElement).value).catch(reason => { error = `???????${String(reason)}`; render(); }));
  document.querySelector('[data-new-conversation]')?.addEventListener('click', () => { activeConversationId = null; conversationMessages = []; agentRun = null; agentEvents = []; workspaceAction = null; render(); });
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

listen<DownloadProgress>('download-progress', event => { progress = event.payload; render(); }).catch(reason => { error = `?????????${String(reason)}`; render(); });
listen<DownloadTask>('download-task-progress', event => { downloadTasks = [event.payload, ...downloadTasks.filter(task => task.id !== event.payload.id)].slice(0, 100); refreshBackgroundTasks().catch(() => render()); }).catch(reason => { error = `???????????${String(reason)}`; render(); });
listen<IndexProgress>('index-progress', event => { indexProgress = event.payload; render(); if (event.payload.phase === 'complete') window.setTimeout(() => { indexProgress = null; render(); }, 1_500); }).catch(reason => { error = `?????????${String(reason)}`; render(); });
listen<IndexJob>('index-job-progress', event => { const next = event.payload; indexJobs = [...indexJobs.filter(job => job.id !== next.id && job.status !== 'completed'), next].filter(job => job.status !== 'completed'); if (next.status === 'completed') { loadFolderRefs().then(render); scheduleEmbeddingUpdate(); } render(); }).catch(reason => { error = `?????????${String(reason)}`; render(); });
listen<FolderChangeDetected>('folder-change-detected', event => { scheduleFolderRefresh(event.payload); }).catch(reason => { error = `??????????${String(reason)}`; render(); });
listen<EmbeddingIndexProgress>('embedding-index-progress', event => { embeddingProgress = event.payload; render(); }).catch(reason => { error = `???????????${String(reason)}`; render(); });
listen<MediaTask>('media-task-progress', event => { mediaTasks = [event.payload, ...mediaTasks.filter(task => task.id !== event.payload.id)].slice(0, 100); render(); }).catch(reason => { error = `???????????${String(reason)}`; render(); });
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
  if (paths.length !== 1) { error = '??????????????????????????'; render(); return; }
  importFolderPath(paths[0]);
}).catch(reason => { error = `??????????${String(reason)}`; render(); });
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
    error = `????????${String(reason)}`;
    render();
  }
}

bootstrap();
