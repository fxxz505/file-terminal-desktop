#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use file_terminal_desktop::assistant::{extract_search_terms, matches_terms, parse_model_terms};
use futures_util::StreamExt;
use keyring::Entry;
use lopdf::Document;
use notify::{Config as NotifyConfig, RecommendedWatcher, RecursiveMode, Watcher};
use regex::Regex;
use rand::RngCore;
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Cursor, Read, Write},
    net::IpAddr,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use walkdir::WalkDir;

const APP_FOLDER: &str = "资料终端";
struct RuntimeManifest {
    id: &'static str,
    url: &'static str,
    archive_sha256: &'static str,
    executable: &'static str,
    gpu: bool,
}

const RUNTIME_MANIFEST: &[RuntimeManifest] = &[
    RuntimeManifest {
        id: "cpu-x64-b10107",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-win-cpu-x64.zip",
        archive_sha256: "52133a0a5a8f6035b1bdd2f89c3425ea8b742413d9bdb9a2dee30e3a1681b18c",
        executable: "llama-cli.exe",
        gpu: false,
    },
    RuntimeManifest {
        id: "cuda-12.4-x64-b10107",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-win-cuda-12.4-x64.zip",
        archive_sha256: "1e43bbec9691cd0bc636603c366769148fa6265fd261c5f7c67050b450bbc237",
        executable: "llama-cli.exe",
        gpu: true,
    },
];
const MODEL_URLS: &[(&str, &str)] = &[
    ("官方 Hugging Face", "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"),
    ("HF 镜像", "https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"),
];
const MODEL_SHA256: &str = "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e";
const MODEL_FILE: &str = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
const MAX_PREVIEW_BYTES: u64 = 1_048_576;
const MAX_THUMBNAIL_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: usize = 256 * 1024;
const MAX_MEDIA_OUTPUT_CHARS: usize = 120_000;
const MAX_MEDIA_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MEDIA_TASK_TIMEOUT: Duration = Duration::from_secs(120);
const OFFICE_PREVIEW_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_OFFICE_PREVIEW_SOURCE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_AGENT_REPAIR_ATTEMPTS: usize = 2;
const MAX_CLOUD_REQUEST_BYTES: usize = 48 * 1024;
const CLOUD_KEYRING_SERVICE: &str = "file-terminal-desktop.cloud-provider";
const BACKUP_KEYRING_SERVICE: &str = "file-terminal-desktop.encrypted-backup";
const DATABASE_KEYRING_SERVICE: &str = "file-terminal-desktop.sqlcipher";
const DATABASE_KEY_BACKUP_FILE: &str = "database-key.dpapi";
const BACKUP_MAGIC: &[u8] = b"FTBK1";
const MAX_GENERATED_FILES: usize = 40;
const MAX_GENERATED_FILE_BYTES: usize = 256 * 1024;
const ALLOWED_WORKSPACE_CHECKS: &[&str] =
    &["npm run build", "npm test", "cargo test", "cargo check"];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CloudPolicy {
    LocalOnly,
    CloudAllowed,
    AskEachTime,
    Inherit,
}

impl CloudPolicy {
    fn from_database(value: &str) -> Self {
        match value {
            "cloud_allowed" => Self::CloudAllowed,
            "ask_each_time" => Self::AskEachTime,
            "inherit" => Self::Inherit,
            _ => Self::LocalOnly,
        }
    }

    fn as_database(self) -> &'static str {
        match self {
            Self::LocalOnly => "local_only",
            Self::CloudAllowed => "cloud_allowed",
            Self::AskEachTime => "ask_each_time",
            Self::Inherit => "inherit",
        }
    }
}

fn effective_cloud_policy(folder: CloudPolicy, item: CloudPolicy) -> CloudPolicy {
    let item = if item == CloudPolicy::Inherit {
        folder
    } else {
        item
    };
    let rank = |policy| match policy {
        CloudPolicy::LocalOnly => 0,
        CloudPolicy::AskEachTime => 1,
        CloudPolicy::CloudAllowed => 2,
        CloudPolicy::Inherit => 0,
    };
    if rank(folder) <= rank(item) {
        folder
    } else {
        item
    }
}

struct AppState {
    database: Mutex<Connection>,
    data_dir: PathBuf,
    startup_recovery_notice: Option<String>,
    prepared_runs: Mutex<HashMap<String, PreparedCloudRun>>,
    cancelled_runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexItem {
    id: String,
    item_type: String,
    name: String,
    path: String,
    note: String,
    tags: Vec<String>,
    cloud_policy: CloudPolicy,
    score: usize,
    display_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderRef {
    id: String,
    name: String,
    path: String,
    note: String,
    tags: Vec<String>,
    cloud_policy: CloudPolicy,
    item_count: usize,
    display_path: String,
    source_status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderEntry {
    id: String,
    name: String,
    path: String,
    display_path: String,
    item_type: String,
    note: String,
    tags: Vec<String>,
    cloud_policy: CloudPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderImport {
    path: String,
    note: String,
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileImport {
    paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchDocumentsInput {
    query: String,
    folder_id: Option<String>,
    item_type: Option<String>,
    tag: Option<String>,
    page: Option<usize>,
    page_size: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchDocumentsResult {
    items: Vec<IndexItem>,
    total: usize,
    page: usize,
    page_size: usize,
    search_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingModelInput {
    path: String,
    display_name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingModel {
    id: String,
    display_name: String,
    path: String,
    active: bool,
    dimensions: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingIndexProgress {
    completed: usize,
    total: usize,
    failed: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceCitation {
    id: String,
    name: String,
    path: String,
    display_path: String,
    reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexProgress {
    folder_id: String,
    phase: String,
    completed: usize,
    total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexJob {
    id: String,
    folder_id: String,
    status: String,
    completed: usize,
    total: usize,
    changed: usize,
    created_at: String,
    updated_at: String,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexJobInput {
    folder_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderChangeDetected {
    folder_id: String,
    changed_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivacyStatus {
    database_encrypted: bool,
    message: String,
    recommendation: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedBackup {
    path: String,
    display_path: String,
    created_at: String,
    database_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupPathInput {
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreStage {
    pending: bool,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SensitiveFinding {
    item_id: String,
    name: String,
    display_path: String,
    category: String,
    match_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditFilterInput {
    target_type: Option<String>,
    limit: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataAuditEntry {
    id: String,
    target_type: String,
    target_id: String,
    action: String,
    old_policy: Option<String>,
    new_policy: Option<String>,
    created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalToolStatus {
    pdf_text: bool,
    ffmpeg: bool,
    ocr: bool,
    transcription: bool,
    office_converter: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ManagedTool {
    Tesseract,
    Ffmpeg,
    Libreoffice,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedToolInput {
    tool: ManagedTool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAdvice {
    answer: String,
    assumptions: Vec<String>,
    files: Vec<CloudAdviceFile>,
    steps: Vec<CloudAdviceStep>,
    uncertainties: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAdviceFile {
    path_hint: String,
    content: String,
    purpose: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAdviceStep {
    id: String,
    instruction: String,
    requested_tool: Option<String>,
    risk: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentPreferences {
    auto_apply_low_risk: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataUpdate {
    target_type: String,
    target_id: String,
    note: Option<String>,
    tags: Option<Vec<String>>,
    cloud_policy: Option<CloudPolicy>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiOutputRequest {
    output_folder: Option<String>,
    project_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiFileWrite {
    workspace_id: String,
    relative_path: String,
    content: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiOutputTarget {
    workspace_id: String,
    path: String,
    display_path: String,
    is_app_workspace: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    kind: String,
    source: String,
    completed: u64,
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    model_installed: bool,
    runtime_installed: bool,
    model_path: String,
    active_model_name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSettings {
    execution_mode: String,
    threads: usize,
    context_size: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptanceCheck {
    id: String,
    label: String,
    status: String,
    detail: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilePreview {
    kind: String,
    name: String,
    path: String,
    mime_type: String,
    content: String,
    message: String,
    truncated: bool,
    display_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudProviderConfig {
    provider_id: String,
    display_name: String,
    base_url: String,
    model: String,
    auto_collaboration: bool,
    review_each_request: bool,
    configured: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudProviderConfigInput {
    provider_id: String,
    display_name: String,
    base_url: String,
    model: String,
    auto_collaboration: bool,
    review_each_request: bool,
    api_key: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudModel {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderIdInput {
    provider_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Conversation {
    id: String,
    title: String,
    provider_id: Option<String>,
    updated_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationMessage {
    id: String,
    conversation_id: String,
    role: String,
    source: String,
    content: String,
    parsed_reply: Option<ParsedReply>,
    created_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedReply {
    answer: String,
    steps: Vec<String>,
    code_blocks: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationMessageInput {
    conversation_id: Option<String>,
    title: Option<String>,
    provider_id: Option<String>,
    role: String,
    source: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunRequest {
    question: String,
    scope: Option<Vec<String>>,
    conversation_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRun {
    id: String,
    route: String,
    reason: String,
    provider_id: Option<String>,
    cloud_sent_automatically: bool,
    source_count: usize,
    restricted_source_count: usize,
    redaction_count: usize,
    status: String,
    package_preview: String,
    request_preview: String,
    feedback: String,
    advice: Option<String>,
    cloud_advice: Option<CloudAdvice>,
    source_citations: Vec<SourceCitation>,
    conversation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationIdInput {
    conversation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceAdviceInput {
    run_id: String,
    workspace_id: String,
    #[serde(default)]
    allow_existing_edits: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCheckInput {
    workspace_id: String,
    command: String,
    run_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceActionResult {
    status: String,
    written_files: Vec<String>,
    output: String,
}

#[derive(Clone)]
struct GeneratedFile {
    relative_path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunIdInput {
    run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdInput {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SensitiveRuleInput {
    id: Option<String>,
    name: String,
    pattern: String,
    enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SensitiveRule {
    id: String,
    name: String,
    pattern: String,
    enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEvent {
    id: String,
    run_id: String,
    status: String,
    message: String,
    created_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEvidenceReport {
    run_id: String,
    status: String,
    final_evidence: Vec<String>,
    restricted_bindings: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderIdInput {
    folder_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalModelInput {
    path: String,
    display_name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalModel {
    id: String,
    display_name: String,
    path: String,
    active: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClearLocalDataInput {
    scope: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GovernanceExport {
    exported_at: String,
    conversations: Vec<Conversation>,
    sensitive_rules: Vec<SensitiveRule>,
    metadata_audit_count: usize,
    agent_event_count: usize,
}

#[derive(Clone)]
struct PreparedCloudRun {
    run: AgentRun,
    request_body: String,
    last_diagnostic: Option<String>,
    repair_attempts: usize,
}

fn display_path(path: &Path) -> String {
    let value = path.display().to_string();
    value
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| value.strip_prefix(r"\\?\").map(str::to_string))
        .unwrap_or(value)
}

fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join(APP_FOLDER))
        .ok_or_else(|| "无法定位 Windows 本地应用数据目录。".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoRepairAgentInput {
    run_id: String,
    workspace_id: String,
    command: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Thumbnail {
    item_id: String,
    source_signature: String,
    mime_type: String,
    content: String,
    cached: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailInput {
    item_id: String,
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailCacheClearResult {
    removed: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaTaskInput {
    item_id: String,
    kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaTask {
    id: String,
    item_id: String,
    name: String,
    kind: String,
    status: String,
    error: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaTaskIdInput {
    id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaSettings {
    whisper_model_path: String,
    ocr_language: String,
}

fn database_key_entry() -> Result<Entry, String> {
    Entry::new(DATABASE_KEYRING_SERVICE, "database-key")
        .map_err(|_| "无法访问 Windows 凭据库。".to_string())
}

fn valid_database_key(key: &str) -> bool {
    key.len() >= 32 && key.chars().all(|value| value.is_ascii_alphanumeric() || matches!(value, '+' | '/' | '='))
}

#[cfg(windows)]
fn protect_database_key_with_dpapi(value: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN},
    };

    if value.is_empty() || value.len() > u32::MAX as usize {
        return Err("数据库密钥备份长度无效。".to_string());
    }
    let input = CRYPT_INTEGER_BLOB { cbData: value.len() as u32, pbData: value.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let protected = unsafe {
        CryptProtectData(&input, ptr::null(), ptr::null(), ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    };
    if protected == 0 || output.pbData.is_null() {
        return Err("Windows DPAPI 无法保护数据库密钥副本。".to_string());
    }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as *mut std::ffi::c_void); }
    Ok(result)
}

#[cfg(windows)]
fn unprotect_database_key_with_dpapi(value: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN},
    };

    if value.is_empty() || value.len() > u32::MAX as usize {
        return Err("数据库密钥备份无效。".to_string());
    }
    let input = CRYPT_INTEGER_BLOB { cbData: value.len() as u32, pbData: value.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let unprotected = unsafe {
        CryptUnprotectData(&input, ptr::null_mut(), ptr::null(), ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
    };
    if unprotected == 0 || output.pbData.is_null() {
        return Err("Windows DPAPI 无法解锁数据库密钥副本。".to_string());
    }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as *mut std::ffi::c_void); }
    Ok(result)
}

#[cfg(not(windows))]
fn protect_database_key_with_dpapi(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("数据库密钥恢复仅支持 Windows。".to_string())
}

#[cfg(not(windows))]
fn unprotect_database_key_with_dpapi(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("数据库密钥恢复仅支持 Windows。".to_string())
}

fn database_key_backup_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DATABASE_KEY_BACKUP_FILE)
}

fn read_database_key_backup(data_dir: &Path) -> Result<String, String> {
    let protected = fs::read(database_key_backup_path(data_dir))
        .map_err(|_| "找不到可用的 Windows DPAPI 数据库密钥副本。".to_string())?;
    let key = String::from_utf8(unprotect_database_key_with_dpapi(&protected)?)
        .map_err(|_| "Windows DPAPI 数据库密钥副本无效。".to_string())?;
    if valid_database_key(&key) {
        Ok(key)
    } else {
        Err("Windows DPAPI 数据库密钥副本无效。".to_string())
    }
}

fn save_database_key_backup(data_dir: &Path, key: &str) -> Result<(), String> {
    if let Ok(saved) = read_database_key_backup(data_dir) {
        if saved == key {
            return Ok(());
        }
    }
    let protected = protect_database_key_with_dpapi(key.as_bytes())?;
    let temporary = data_dir.join(format!("{DATABASE_KEY_BACKUP_FILE}.{}.pending", Uuid::new_v4()));
    {
        let mut file = File::create(&temporary).map_err(|_| "无法创建 Windows DPAPI 数据库密钥副本。".to_string())?;
        file.write_all(&protected).map_err(|_| "无法写入 Windows DPAPI 数据库密钥副本。".to_string())?;
        file.sync_all().map_err(|_| "无法保存 Windows DPAPI 数据库密钥副本。".to_string())?;
    }
    fs::rename(&temporary, database_key_backup_path(data_dir))
        .or_else(|_| {
            // The key never rotates. Replacing a damaged fallback is safe only after the new DPAPI blob is fully written.
            fs::copy(&temporary, database_key_backup_path(data_dir)).map(|_| ()).and_then(|_| fs::remove_file(&temporary))
        })
        .map_err(|_| "无法保存 Windows DPAPI 数据库密钥副本。".to_string())
}

fn generate_and_store_database_key(data_dir: &Path) -> Result<String, String> {
    let mut raw = [0u8; 32];
    rand::rng().fill_bytes(&mut raw);
    let key = BASE64.encode(raw);
    database_key_entry()?.set_password(&key).map_err(|_| "无法将数据库密钥保存到 Windows 凭据库。".to_string())?;
    if let Err(error) = save_database_key_backup(data_dir, &key) {
        let _ = database_key_entry().and_then(|entry| entry.delete_credential().map_err(|_| "".to_string()));
        return Err(error);
    }
    Ok(key)
}

fn load_database_key(data_dir: &Path, database_exists: bool) -> Result<String, String> {
    let credential_key = database_key_entry().and_then(|entry| match entry.get_password() {
        Ok(key) if valid_database_key(&key) => Ok(key),
        Ok(_) => Err("本地数据库密钥无效。".to_string()),
        Err(keyring::Error::NoEntry) => Err("Windows 凭据库中没有数据库密钥。".to_string()),
        Err(_) => Err("无法读取 Windows 凭据库中的数据库密钥。".to_string()),
    });
    if let Ok(key) = credential_key {
        // Keep legacy installs available even if DPAPI is temporarily unavailable; a later start retries the fallback copy.
        if !database_exists {
            save_database_key_backup(data_dir, &key)?;
        } else {
            let _ = save_database_key_backup(data_dir, &key);
        }
        return Ok(key);
    }
    if let Ok(key) = read_database_key_backup(data_dir) {
        if let Ok(entry) = database_key_entry() {
            let _ = entry.set_password(&key);
        }
        return Ok(key);
    }
    if database_exists {
        return Err("已有本地数据库但找不到可用密钥；为保护原数据，应用未创建空数据库。请保留资料终端数据目录，并使用原 Windows 用户账户或加密备份恢复。".to_string());
    }
    generate_and_store_database_key(data_dir)
}

fn apply_database_key(connection: &Connection, key: &str) -> Result<(), String> {
    connection.execute_batch(&format!("PRAGMA key = '{key}';"))
        .map_err(|_| "无法应用本地数据库密钥。".to_string())?;
    let cipher_version = connection.query_row("PRAGMA cipher_version", [], |row| row.get::<_, String>(0))
        .map_err(|_| "当前运行时未包含 SQLCipher；应用拒绝打开数据库。".to_string())?;
    if cipher_version.trim().is_empty() {
        return Err("当前运行时未启用 SQLCipher；应用拒绝打开数据库。".to_string());
    }
    Ok(())
}

fn open_encrypted_database(path: &Path, key: &str) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    apply_database_key(&connection, key)?;
    connection.execute_batch("PRAGMA foreign_keys = ON;").map_err(|error| error.to_string())?;
    connection.query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))
        .map_err(|_| "无法使用本机凭据解锁数据库；数据未被修改。".to_string())?;
    Ok(connection)
}

fn migrate_plaintext_database(database: &Path, key: &str) -> Result<(), String> {
    let migrated = database.with_extension("sqlcipher-migrating");
    let preserved = database.with_extension("plaintext-migration-backup");
    let _ = fs::remove_file(&migrated);
    let _ = fs::remove_file(&preserved);
    let source = Connection::open(database).map_err(|error| error.to_string())?;
    source.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").map_err(|error| error.to_string())?;
    let target_path = migrated.display().to_string().replace('\'', "''");
    let escaped_key = key.replace('\'', "''");
    source.execute_batch(&format!("ATTACH DATABASE '{target_path}' AS encrypted KEY '{escaped_key}';"))
        .map_err(|error| format!("无法创建加密迁移数据库；原始数据库未被修改：{error}"))?;
    let exported = source.query_row("SELECT sqlcipher_export('encrypted')", [], |_| Ok::<(), rusqlite::Error>(()))
        .map_err(|error| format!("无法导出加密数据库；原始数据库未被修改：{error}"));
    let _ = source.execute_batch("DETACH DATABASE encrypted;");
    drop(source);
    if let Err(error) = exported {
        let _ = fs::remove_file(&migrated);
        return Err(format!("数据库加密导出失败；原始数据库未被修改：{error}"));
    }
    if let Err(error) = open_encrypted_database(&migrated, key) {
        let _ = fs::remove_file(&migrated);
        return Err(format!("数据库加密迁移校验失败；原始数据库未被修改：{error}"));
    }
    fs::rename(database, &preserved).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&migrated, database) {
        let _ = fs::rename(&preserved, database);
        return Err(format!("数据库加密迁移未完成；原始数据库已保留：{error}"));
    }
    let _ = fs::remove_file(&preserved);
    let _ = fs::remove_file(database.with_extension("db-wal"));
    let _ = fs::remove_file(database.with_extension("db-shm"));
    Ok(())
}

fn open_app_database(data_dir: &Path) -> Result<Connection, String> {
    let database = data_dir.join("file-terminal.db");
    let key = load_database_key(data_dir, database.is_file())?;
    if database.is_file() && fs::read(&database).map_err(|error| error.to_string())?.starts_with(b"SQLite format 3\0") {
        migrate_plaintext_database(&database, &key)?;
    }
    open_encrypted_database(&database, &key)
}

const AUTO_RESTORE_STATUS_FILE: &str = "AUTO_RESTORE_STATUS.txt";
const RECOVERABLE_TABLES: &[&str] = &[
    "folder_refs",
    "embedding_models",
    "index_items",
    "item_embeddings",
    "thumbnail_cache",
    "media_tasks",
    "media_extractions",
    "metadata_audit",
    "agent_workspaces",
    "cloud_provider_config",
    "conversations",
    "conversation_messages",
    "sensitive_rules",
    "agent_runs",
    "agent_events",
    "agent_source_bindings",
    "local_models",
    "index_jobs",
];

fn database_table_columns(connection: &Connection, schema: &str, table: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA {schema}.table_info('{table}')"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(columns)
}

fn restore_table_without_overwrite(connection: &Connection, table: &str) -> Result<usize, String> {
    let source_columns = database_table_columns(connection, "recovery", table)?;
    if source_columns.is_empty() {
        return Ok(0);
    }
    let target_columns = database_table_columns(connection, "main", table)?;
    let columns = target_columns
        .into_iter()
        .filter(|column| source_columns.contains(column))
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Ok(0);
    }
    let quoted = columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    connection
        .execute(
            &format!("INSERT OR IGNORE INTO main.\"{table}\" ({quoted}) SELECT {quoted} FROM recovery.\"{table}\""),
            [],
        )
        .map_err(|error| format!("无法合并 {table}：{error}"))?;
    Ok(connection.changes() as usize)
}

fn restore_fts_without_duplicates(connection: &Connection) -> Result<usize, String> {
    if database_table_columns(connection, "recovery", "index_content_fts")?.is_empty() {
        return Ok(0);
    }
    connection
        .execute(
            "INSERT INTO main.index_content_fts (item_id, content) \
             SELECT source.item_id, source.content FROM recovery.index_content_fts AS source \
             WHERE EXISTS (SELECT 1 FROM main.index_items AS item WHERE item.id = source.item_id) \
             AND NOT EXISTS (SELECT 1 FROM main.index_content_fts AS existing WHERE existing.item_id = source.item_id)",
            [],
        )
        .map_err(|error| format!("无法合并全文索引：{error}"))?;
    Ok(connection.changes() as usize)
}

fn restore_default_singleton_setting(connection: &Connection, table: &str, default_predicate: &str) -> Result<usize, String> {
    if database_table_columns(connection, "recovery", table)?.is_empty() {
        return Ok(0);
    }
    let has_only_default = connection
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM main.\"{table}\" WHERE id = 1 AND {default_predicate})"),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        != 0;
    if !has_only_default {
        return Ok(0);
    }
    let source_columns = database_table_columns(connection, "recovery", table)?;
    let target_columns = database_table_columns(connection, "main", table)?;
    let columns = target_columns
        .into_iter()
        .filter(|column| source_columns.contains(column))
        .collect::<Vec<_>>();
    let quoted = columns.iter().map(|column| format!("\"{column}\"")).collect::<Vec<_>>().join(", ");
    connection
        .execute(
            &format!("INSERT OR REPLACE INTO main.\"{table}\" ({quoted}) SELECT {quoted} FROM recovery.\"{table}\" WHERE id = 1"),
            [],
        )
        .map_err(|error| format!("无法合并 {table}：{error}"))?;
    Ok(connection.changes() as usize)
}

fn restore_quarantined_database(connection: &Connection, recovery: &Path, key: &str) -> Result<usize, String> {
    let database = recovery.join("file-terminal.db");
    if !database.is_file() {
        return Err("恢复目录中没有 file-terminal.db。".to_string());
    }
    let database_path = database.display().to_string().replace('\'', "''");
    let escaped_key = key.replace('\'', "''");
    connection
        .execute_batch(&format!("ATTACH DATABASE '{database_path}' AS recovery KEY '{escaped_key}';"))
        .map_err(|_| "当前 Windows 凭据无法解锁旧数据库。".to_string())?;
    if connection
        .query_row("PRAGMA recovery.schema_version", [], |row| row.get::<_, i64>(0))
        .is_err()
    {
        let _ = connection.execute_batch("DETACH DATABASE recovery;");
        return Err("当前 Windows 凭据无法解锁旧数据库。".to_string());
    }

    let restored = (|| -> Result<usize, String> {
        connection.execute_batch("BEGIN IMMEDIATE;").map_err(|error| error.to_string())?;
        let result = (|| -> Result<usize, String> {
            // Parent records are deliberately restored first so foreign-key relationships stay valid.
            let mut restored = 0;
            for table in RECOVERABLE_TABLES {
                restored += restore_table_without_overwrite(connection, table)?;
            }
            restored += restore_fts_without_duplicates(connection)?;
            // New empty databases contain these defaults. Restore an older user setting only while it is untouched.
            restored += restore_default_singleton_setting(connection, "media_settings", "whisper_model_path = '' AND ocr_language = 'chi_sim+eng'")?;
            restored += restore_default_singleton_setting(connection, "agent_preferences", "auto_apply_low_risk = 0")?;
            restored += restore_default_singleton_setting(connection, "runtime_settings", "execution_mode = 'auto' AND threads = 4 AND context_size = 4096")?;
            connection.execute_batch("COMMIT;").map_err(|error| error.to_string())?;
            Ok(restored)
        })();
        if result.is_err() {
            let _ = connection.execute_batch("ROLLBACK;");
        }
        result
    })();
    let _ = connection.execute_batch("DETACH DATABASE recovery;");
    restored
}

fn restore_quarantined_databases(connection: &Connection, data_dir: &Path) -> Option<String> {
    let recovery_root = data_dir.join("database-recovery");
    let entries = fs::read_dir(&recovery_root).ok()?;
    let key = match load_database_key(data_dir, true) {
        Ok(key) => key,
        Err(_) => return Some("已自动尝试恢复旧数据库，但 Windows 凭据库不可用；恢复副本仍被保留，未上传或修改任何旧数据。".to_string()),
    };
    let mut restored_records = 0;
    let mut restored_directories = 0;
    let mut unreadable_directories = 0;

    for entry in entries.flatten() {
        let recovery = entry.path();
        if !recovery.is_dir() || !entry.file_name().to_string_lossy().starts_with("unreadable-") {
            continue;
        }
        let status_file = recovery.join(AUTO_RESTORE_STATUS_FILE);
        if fs::read_to_string(&status_file)
            .map(|status| status.starts_with("status=restored"))
            .unwrap_or(false)
        {
            continue;
        }
        match restore_quarantined_database(connection, &recovery, &key) {
            Ok(records) => {
                let _ = fs::write(
                    recovery.join(AUTO_RESTORE_STATUS_FILE),
                    format!("status=restored\nrecords={records}\noriginal_database_retained=true\n"),
                );
                restored_records += records;
                restored_directories += 1;
            }
            Err(error) => {
                let status = if error == "当前 Windows 凭据无法解锁旧数据库。" {
                    "status=unreadable\nreason=current_windows_credential_cannot_unlock\n"
                } else {
                    "status=failed\nreason=automatic_restore_failed_without_modifying_original\n"
                };
                let _ = fs::write(status_file, status);
                unreadable_directories += 1;
            }
        }
    }

    if restored_directories > 0 {
        Some(format!(
            "已自动恢复 {restored_records} 条本地资料记录（来自 {restored_directories} 个旧数据库副本）；同 ID 的新数据未被覆盖，原数据库副本仍保留在 {}。",
            display_path(&recovery_root)
        ))
    } else if unreadable_directories > 0 {
        Some(format!(
            "已自动尝试恢复 {unreadable_directories} 个旧数据库副本，但当前 Windows 凭据仍无法解锁它们；原文件和 WAL/SHM 恢复文件继续保留在 {}。",
            display_path(&recovery_root)
        ))
    } else {
        None
    }
}

fn open_app_database_with_recovery(data_dir: &Path) -> Result<(Connection, Option<String>), String> {
    match open_app_database(data_dir) {
        Ok(connection) => Ok((connection, None)),
        Err(error) => Err(error),
    }
}

fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS folder_refs (
                id TEXT PRIMARY KEY,
                root_path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                note TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                cloud_policy TEXT NOT NULL DEFAULT 'local_only',
                imported_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS index_items (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                item_type TEXT NOT NULL,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                note TEXT NOT NULL,
                tags_json TEXT NOT NULL,
                cloud_policy TEXT NOT NULL DEFAULT 'inherit',
                source_size INTEGER,
                source_modified_ms INTEGER,
                source_sha256 TEXT,
                FOREIGN KEY(folder_id) REFERENCES folder_refs(id)
            );
            CREATE INDEX IF NOT EXISTS index_items_folder_idx ON index_items(folder_id);
            CREATE VIRTUAL TABLE IF NOT EXISTS index_content_fts USING fts5(item_id UNINDEXED, content);
            CREATE TABLE IF NOT EXISTS embedding_models (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                active INTEGER NOT NULL DEFAULT 0,
                dimensions INTEGER,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS item_embeddings (
                item_id TEXT NOT NULL,
                model_id TEXT NOT NULL,
                source_signature TEXT NOT NULL,
                vector_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (item_id, model_id),
                FOREIGN KEY(item_id) REFERENCES index_items(id),
                FOREIGN KEY(model_id) REFERENCES embedding_models(id)
            );
            CREATE INDEX IF NOT EXISTS item_embeddings_model_idx ON item_embeddings(model_id);
            CREATE TABLE IF NOT EXISTS thumbnail_cache (
                item_id TEXT NOT NULL,
                source_signature TEXT NOT NULL,
                cache_path TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (item_id, source_signature),
                FOREIGN KEY(item_id) REFERENCES index_items(id)
            );
            CREATE INDEX IF NOT EXISTS thumbnail_cache_item_idx ON thumbnail_cache(item_id);
            CREATE TABLE IF NOT EXISTS media_tasks (
                id TEXT PRIMARY KEY,
                item_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('ocr', 'transcription')),
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(item_id) REFERENCES index_items(id)
            );
            CREATE INDEX IF NOT EXISTS media_tasks_status_idx ON media_tasks(status, created_at);
            CREATE TABLE IF NOT EXISTS media_extractions (
                item_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                source_signature TEXT NOT NULL,
                content TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (item_id, kind),
                FOREIGN KEY(item_id) REFERENCES index_items(id)
            );
            CREATE TABLE IF NOT EXISTS media_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                whisper_model_path TEXT NOT NULL DEFAULT '',
                ocr_language TEXT NOT NULL DEFAULT 'chi_sim+eng'
            );
            INSERT OR IGNORE INTO media_settings (id, whisper_model_path, ocr_language) VALUES (1, '', 'chi_sim+eng');
            CREATE TABLE IF NOT EXISTS metadata_audit (
                id TEXT PRIMARY KEY,
                target_type TEXT NOT NULL,
                target_id TEXT NOT NULL,
                action TEXT NOT NULL,
                old_policy TEXT,
                new_policy TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_workspaces (
                id TEXT PRIMARY KEY,
                root_path TEXT NOT NULL,
                is_app_workspace INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cloud_provider_config (
                provider_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                base_url TEXT NOT NULL,
                model TEXT NOT NULL,
                auto_collaboration INTEGER NOT NULL,
                review_each_request INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                provider_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conversation_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                source TEXT NOT NULL,
                content TEXT NOT NULL,
                parsed_json TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id)
            );
            CREATE INDEX IF NOT EXISTS conversation_messages_conversation_idx ON conversation_messages(conversation_id, created_at);
            CREATE TABLE IF NOT EXISTS sensitive_rules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                pattern TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_runs (
                id TEXT PRIMARY KEY,
                route TEXT NOT NULL,
                reason TEXT NOT NULL,
                provider_id TEXT,
                cloud_sent_automatically INTEGER NOT NULL,
                source_count INTEGER NOT NULL,
                restricted_source_count INTEGER NOT NULL,
                redaction_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                package_preview TEXT NOT NULL,
                feedback TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_events (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                status TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS agent_events_run_idx ON agent_events(run_id, created_at);
            CREATE TABLE IF NOT EXISTS agent_source_bindings (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                source_item_id TEXT NOT NULL,
                source_path TEXT NOT NULL,
                cloud_policy TEXT NOT NULL,
                is_restricted INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS agent_source_bindings_run_idx ON agent_source_bindings(run_id);
            CREATE TABLE IF NOT EXISTS local_models (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                active INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_preferences (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                auto_apply_low_risk INTEGER NOT NULL DEFAULT 0
            );
            INSERT OR IGNORE INTO agent_preferences (id, auto_apply_low_risk) VALUES (1, 0);
            CREATE TABLE IF NOT EXISTS runtime_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                execution_mode TEXT NOT NULL DEFAULT 'auto',
                threads INTEGER NOT NULL DEFAULT 4,
                context_size INTEGER NOT NULL DEFAULT 4096
            );
            INSERT OR IGNORE INTO runtime_settings (id, execution_mode, threads, context_size) VALUES (1, 'auto', 4, 4096);
            CREATE TABLE IF NOT EXISTS index_jobs (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                status TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0,
                total INTEGER NOT NULL DEFAULT 0,
                changed INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(folder_id) REFERENCES folder_refs(id)
            );
            CREATE INDEX IF NOT EXISTS index_jobs_status_idx ON index_jobs(status, created_at);
            ",
        )
        .map_err(|error| error.to_string())?;
    ensure_column(
        connection,
        "folder_refs",
        "cloud_policy",
        "TEXT NOT NULL DEFAULT 'local_only'",
    )?;
    ensure_column(connection, "index_items", "source_size", "INTEGER")?;
    ensure_column(connection, "index_items", "source_modified_ms", "INTEGER")?;
    ensure_column(connection, "index_items", "source_sha256", "TEXT")?;
    ensure_column(
        connection,
        "index_items",
        "cloud_policy",
        "TEXT NOT NULL DEFAULT 'inherit'",
    )?;
    ensure_column(
        connection,
        "cloud_provider_config",
        "display_name",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;
    if columns.filter_map(Result::ok).any(|name| name == column) {
        return Ok(());
    }
    connection
        .execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))
        .map_err(|error| error.to_string())
}

fn start_folder_change_watch(app: AppHandle, data_dir: PathBuf) {
    thread::spawn(move || {
        let (sender, receiver) = std::sync::mpsc::channel();
        let Ok(mut watcher) = RecommendedWatcher::new(sender, NotifyConfig::default()) else {
            return;
        };
        let mut watched_roots = HashMap::<PathBuf, String>::new();
        loop {
            let Ok(connection) = open_app_database(&data_dir) else {
                thread::sleep(Duration::from_secs(5));
                continue;
            };
            let Ok(mut statement) = connection.prepare("SELECT id, root_path FROM folder_refs")
            else {
                thread::sleep(Duration::from_secs(5));
                continue;
            };
            let roots = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        PathBuf::from(row.get::<_, String>(1)?),
                    ))
                })
                .map(|rows| rows.filter_map(Result::ok).collect::<Vec<_>>())
                .unwrap_or_default();
            let active_roots = roots.iter().map(|(_, root)| root.clone()).collect::<HashSet<_>>();
            let removed_roots = watched_roots
                .keys()
                .filter(|root| !active_roots.contains(*root))
                .cloned()
                .collect::<Vec<_>>();
            for root in removed_roots {
                let _ = watcher.unwatch(&root);
                watched_roots.remove(&root);
            }
            for (folder_id, root) in roots {
                if root.is_dir() && !watched_roots.contains_key(&root) {
                    if watcher.watch(&root, RecursiveMode::Recursive).is_ok() {
                        watched_roots.insert(root, folder_id);
                    }
                }
            }
            while let Ok(Ok(event)) = receiver.try_recv() {
                let folder_id = event.paths.iter().find_map(|path| {
                    watched_roots
                        .iter()
                        .find(|(root, _)| path.starts_with(root))
                        .map(|(_, id)| id.clone())
                });
                if let Some(folder_id) = folder_id {
                    let _ = app.emit(
                        "folder-change-detected",
                        FolderChangeDetected {
                            folder_id,
                            changed_at: "现在".to_string(),
                        },
                    );
                }
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn ai_output_roots(data_dir: &Path) -> Result<PathBuf, String> {
    let root = data_dir.join("AI Outputs");
    fs::create_dir_all(&root).map_err(|error| format!("无法创建 AI 输出目录：{error}"))?;
    fs::canonicalize(root).map_err(|error| error.to_string())
}

fn safe_workspace_name(value: &str) -> String {
    let trimmed = value.trim();
    let filtered = trimmed
        .chars()
        .map(|character| {
            if "<>:\\/?*\"|".contains(character) || character.is_control() {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if filtered.trim_matches([' ', '.']).is_empty() {
        "AI Project".to_string()
    } else {
        filtered.trim_matches([' ', '.']).to_string()
    }
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("AI 写入路径必须是工作区内的相对路径。".to_string());
    }
    let clean = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect::<PathBuf>();
    if clean.as_os_str().is_empty() {
        return Err("AI 写入文件名不能为空。".to_string());
    }
    Ok(clean)
}

fn validate_folder_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_dir() {
        return Err("请选择一个存在的文件夹。".to_string());
    }
    fs::canonicalize(path).map_err(|error| format!("无法访问文件夹：{error}"))
}

fn indexed_path(path: &Path, state: &AppState) -> Result<PathBuf, String> {
    let target = fs::canonicalize(path).map_err(|_| "文件不存在或无法访问。".to_string())?;
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection
        .prepare("SELECT root_path FROM folder_refs")
        .map_err(|error| error.to_string())?;
    let roots = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let permitted = roots
        .filter_map(Result::ok)
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| target.starts_with(root));
    permitted
        .then_some(target)
        .ok_or_else(|| "只能预览已接入资料夹中的文件。".to_string())
}

fn folder_path(folder_id: &str, path: Option<&str>, state: &AppState) -> Result<PathBuf, String> {
    let root_value = {
        let connection = state
            .database
            .lock()
            .map_err(|_| "本地数据库被占用。".to_string())?;
        connection
            .query_row(
                "SELECT root_path FROM folder_refs WHERE id = ?1",
                params![folder_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| "已接入的文件夹不存在。".to_string())?
    };
    let root =
        fs::canonicalize(root_value).map_err(|_| "已接入的文件夹已无法访问。".to_string())?;
    let target = match path {
        Some(value) => {
            fs::canonicalize(value).map_err(|_| "文件夹不存在或无法访问。".to_string())?
        }
        None => root.clone(),
    };
    if !target.is_dir() || !target.starts_with(&root) {
        return Err("只能浏览已接入资料夹中的目录。".to_string());
    }
    Ok(target)
}

fn preview_mime(extension: &str) -> Option<(&'static str, &'static str)> {
    match extension {
        "png" => Some(("image", "image/png")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        "bmp" => Some(("image", "image/bmp")),
        "pdf" => Some(("pdf", "application/pdf")),
        "txt" | "md" | "csv" | "json" | "log" | "rs" | "ts" | "js" | "html" | "css" | "xml"
        | "yml" | "yaml" | "toml" => Some(("text", "text/plain")),
        _ => None,
    }
}

fn command_available(command: &str) -> bool {
    Command::new(command).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok()
}

fn unique_library_file_path(library: &Path, original_name: &std::ffi::OsStr) -> PathBuf {
    let original = PathBuf::from(original_name);
    let stem = original.file_stem().unwrap_or(original_name).to_string_lossy();
    let extension = original.extension().map(|value| format!(".{}", value.to_string_lossy())).unwrap_or_default();
    let mut candidate = library.join(original_name);
    let mut number = 2usize;
    while candidate.exists() {
        candidate = library.join(format!("{stem} ({number}){extension}"));
        number += 1;
    }
    candidate
}

fn pdf_renderer_available() -> bool {
    Command::new("pdftoppm").arg("-v").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok()
}

#[tauri::command]
fn get_local_tool_status() -> LocalToolStatus {
    LocalToolStatus {
        pdf_text: true,
        ffmpeg: command_available("ffmpeg"),
        ocr: command_available("tesseract"),
        transcription: command_available("whisper-cli") || command_available("whisper"),
        office_converter: command_available("soffice"),
    }
}

fn extract_pdf_text(path: &Path) -> Option<String> {
    const MAX_PDF_INDEX_BYTES: u64 = 32 * 1024 * 1024;
    const MAX_PDF_INDEX_CHARS: usize = 100_000;
    if fs::metadata(path).ok()?.len() > MAX_PDF_INDEX_BYTES { return None; }
    let document = Document::load(path).ok()?;
    let pages = document.get_pages().into_iter().take(200).map(|(page, _)| page).collect::<Vec<_>>();
    document.extract_text(&pages).ok().map(|content| content.chars().take(MAX_PDF_INDEX_CHARS).collect()).filter(|content: &String| !content.trim().is_empty())
}

fn office_preview_text(path: &Path) -> Option<String> {
    extract_document_text(path)
}

fn extract_document_text(path: &Path) -> Option<String> {
    const MAX_INDEX_CONTENT_BYTES: u64 = 512 * 1024;
    const MAX_INDEX_CHARS: usize = 80_000;
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_INDEX_CONTENT_BYTES {
        return None;
    }
    match extension.as_str() {
        "pdf" => extract_pdf_text(path),
        "txt" | "md" | "csv" | "json" | "log" | "rs" | "ts" | "js" | "html" | "css" | "xml"
        | "yml" | "yaml" | "toml" | "py" | "java" | "kt" | "sql" => {
            let content = fs::read(path).ok()?;
            if content.iter().take(8_192).any(|byte| *byte == 0) {
                return None;
            }
            Some(
                String::from_utf8_lossy(&content)
                    .chars()
                    .take(MAX_INDEX_CHARS)
                    .collect(),
            )
        }
        // Office files are zip containers. Extract XML text only; unsupported layouts stay metadata-only.
        "docx" | "pptx" | "xlsx" => {
            let bytes = fs::read(path).ok()?;
            let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
            let mut output = String::new();
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index).ok()?;
                let name = entry.name().to_ascii_lowercase();
                if !(name.ends_with(".xml")
                    && (name.starts_with("word/")
                        || name.starts_with("ppt/slides/")
                        || name.starts_with("xl/sharedstrings")))
                {
                    continue;
                }
                let mut xml = String::new();
                if entry.read_to_string(&mut xml).is_ok() {
                    output.push_str(&strip_xml_tags(&xml));
                    output.push('\n');
                }
                if output.chars().count() >= MAX_INDEX_CHARS {
                    break;
                }
            }
            (!output.trim().is_empty()).then(|| output.chars().take(MAX_INDEX_CHARS).collect())
        }
        _ => None,
    }
}

fn strip_xml_tags(value: &str) -> String {
    Regex::new(r"<[^>]+>")
        .ok()
        .map(|expression| expression.replace_all(value, " ").into_owned())
        .unwrap_or_default()
}

fn text_content_for_index(path: &Path) -> Option<String> {
    extract_document_text(path)
}

fn active_model_path(state: &AppState) -> PathBuf {
    let selected = state
        .database
        .lock()
        .ok()
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT path FROM local_models WHERE active = 1 LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .ok()
        })
        .map(PathBuf::from);
    selected.unwrap_or_else(|| state.data_dir.join("models").join(MODEL_FILE))
}

fn runtime_settings(state: &AppState) -> RuntimeSettings {
    state.database.lock().ok().and_then(|connection| connection.query_row("SELECT execution_mode, threads, context_size FROM runtime_settings WHERE id = 1", [], |row| Ok(RuntimeSettings { execution_mode: row.get(0)?, threads: row.get::<_, usize>(1)?, context_size: row.get::<_, usize>(2)? })).ok()).unwrap_or(RuntimeSettings { execution_mode: "auto".into(), threads: 4, context_size: 4096 })
}

fn detect_gpu_compatibility() -> bool {
    Command::new("nvidia-smi")
        .args(["--query-gpu=name,driver_version", "--format=csv,noheader"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| String::from_utf8_lossy(&output.stdout).to_ascii_lowercase().contains("nvidia"))
}

fn runtime_variant_for_settings(settings: &RuntimeSettings) -> Result<&'static RuntimeManifest, String> {
    let wants_gpu = settings.execution_mode == "gpu" || (settings.execution_mode == "auto" && detect_gpu_compatibility());
    if wants_gpu && detect_gpu_compatibility() {
        return RUNTIME_MANIFEST.iter().find(|manifest| manifest.gpu)
            .ok_or_else(|| "未找到受支持的 GPU 运行时清单。".to_string());
    }
    if settings.execution_mode == "gpu" {
        return Err("未检测到兼容的 NVIDIA GPU / 驱动，已拒绝下载 GPU 运行时。请切换到自动或 CPU 模式。".to_string());
    }
    RUNTIME_MANIFEST.iter().find(|manifest| !manifest.gpu)
        .ok_or_else(|| "未找到 CPU 运行时清单。".to_string())
}

#[tauri::command]
fn get_runtime_settings(state: State<'_, AppState>) -> RuntimeSettings { runtime_settings(&state) }

#[tauri::command]
fn save_runtime_settings(input: RuntimeSettings, state: State<'_, AppState>) -> Result<RuntimeSettings, String> {
    if !matches!(input.execution_mode.as_str(), "auto" | "cpu" | "gpu") || !(1..=64).contains(&input.threads) || !(512..=32768).contains(&input.context_size) { return Err("运行设置超出安全范围。".to_string()); }
    state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?.execute("UPDATE runtime_settings SET execution_mode = ?1, threads = ?2, context_size = ?3 WHERE id = 1", params![input.execution_mode, input.threads, input.context_size]).map_err(|error| error.to_string())?;
    Ok(input)
}

#[tauri::command]
fn run_environment_acceptance(state: State<'_, AppState>) -> Vec<AcceptanceCheck> {
    let runtime = state.data_dir.join("runtime").join("llama-cli.exe");
    let model = active_model_path(&state);
    let tools = get_local_tool_status();
    vec![
        AcceptanceCheck { id: "runtime".into(), label: "llama.cpp 运行时".into(), status: if runtime.is_file() { "passed" } else { "failed" }.into(), detail: "运行时包通过版本固定清单与 SHA-256 校验后安装。".into() },
        AcceptanceCheck { id: "gpu".into(), label: "GPU 推理兼容性".into(), status: if detect_gpu_compatibility() { "manual" } else { "skipped" }.into(), detail: if detect_gpu_compatibility() { "已发现 NVIDIA GPU；仍需以实际 llama.cpp GPU 推理完成验收。".into() } else { "未发现可用 NVIDIA 驱动，应用将使用 CPU 运行时。".into() } },
        AcceptanceCheck { id: "model".into(), label: "本地 GGUF 模型".into(), status: if model.is_file() { "passed" } else { "failed" }.into(), detail: "检查当前模型文件可读。".into() },
        AcceptanceCheck { id: "pdf".into(), label: "PDF 正文解析".into(), status: if tools.pdf_text { "passed" } else { "failed" }.into(), detail: "内置本地 PDF 文本解析器。".into() },
        AcceptanceCheck { id: "office".into(), label: "Office 文本提取".into(), status: "manual".into(), detail: "需要在用户含复杂 Office 文件的设备上实测。".into() },
        AcceptanceCheck { id: "ocr".into(), label: "OCR".into(), status: if tools.ocr { "manual" } else { "skipped" }.into(), detail: "需安装本地 Tesseract 后使用。".into() },
        AcceptanceCheck { id: "transcription".into(), label: "音视频转写".into(), status: if tools.transcription && tools.ffmpeg { "manual" } else { "skipped" }.into(), detail: "需安装本地 Whisper 和 FFmpeg 后使用。".into() },
        AcceptanceCheck { id: "chinese_path".into(), label: "中文路径".into(), status: "manual".into(), detail: "需在最终用户设备选择中文路径资料夹实测。".into() },
        AcceptanceCheck { id: "cloud".into(), label: "云端协作".into(), status: "manual".into(), detail: "需配置用户自己的供应商后发送脱敏测试请求。".into() },
        AcceptanceCheck { id: "updater".into(), label: "自动更新".into(), status: "manual".into(), detail: "需使用已签名发布包在最终用户设备实测。".into() },
    ]
}

fn index_content(connection: &Connection, item_id: &str, path: &Path) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM index_content_fts WHERE item_id = ?1",
            params![item_id],
        )
        .map_err(|error| error.to_string())?;
    let mut content = text_content_for_index(path).unwrap_or_default();
    let extracted = {
        let mut statement = connection
            .prepare("SELECT content FROM media_extractions WHERE item_id = ?1")
            .map_err(|error| error.to_string())?;
        let values = statement
            .query_map(params![item_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        values
    };
    for value in extracted {
        if !content.is_empty() { content.push('\n'); }
        content.push_str(&value);
        if content.chars().count() >= MAX_MEDIA_OUTPUT_CHARS { break; }
    }
    if !content.trim().is_empty() {
        connection
            .execute(
                "INSERT INTO index_content_fts (item_id, content) VALUES (?1, ?2)",
                params![item_id, content.chars().take(MAX_MEDIA_OUTPUT_CHARS).collect::<String>()],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn source_state(path: &Path) -> (Option<i64>, Option<i64>) {
    let Ok(metadata) = fs::metadata(path) else {
        return (None, None);
    };
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64);
    (Some(metadata.len().min(i64::MAX as u64) as i64), modified_ms)
}

fn source_content_hash(path: &Path) -> Option<String> {
    const MAX_HASH_BYTES: u64 = 32 * 1024 * 1024;
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_HASH_BYTES {
        return None;
    }
    let mut file = File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn source_signature(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_THUMBNAIL_SOURCE_BYTES {
        return Err("图片或 PDF 超过缩略图安全大小限制。".to_string());
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified.to_le_bytes());
    if let Some(content_hash) = source_content_hash(path) {
        hasher.update(content_hash.as_bytes());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn thumbnail_cache_dir(data_dir: &Path) -> Result<PathBuf, String> {
    let directory = data_dir.join("thumbnail-cache");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn image_thumbnail_bytes(path: &Path) -> Result<(&'static str, Vec<u8>), String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let Some((kind, mime_type)) = preview_mime(&extension) else {
        return Err("此文件不支持生成缩略图。".to_string());
    };
    if kind != "image" {
        return Err("PDF 缩略图需要本地渲染器，当前不会伪造预览。".to_string());
    }
    let image = image::ImageReader::open(path)
        .map_err(|error| error.to_string())?
        .with_guessed_format()
        .map_err(|error| error.to_string())?
        .decode()
        .map_err(|_| "无法安全解码该图片。".to_string())?;
    let thumbnail = image.thumbnail(320, 240);
    let mut output = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    let bytes = output.into_inner();
    if bytes.len() > MAX_THUMBNAIL_BYTES {
        return Err("生成的缩略图超过安全大小限制。".to_string());
    }
    let _ = mime_type;
    Ok(("image/png", bytes))
}

fn pdf_thumbnail_bytes(path: &Path, cache_dir: &Path) -> Result<(&'static str, Vec<u8>), String> {
    if !pdf_renderer_available() {
        return Err("未检测到本地 PDF 渲染器 pdftoppm。".to_string());
    }
    let work_dir = cache_dir.join(format!("pdf-work-{}", Uuid::new_v4()));
    fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;
    let prefix = work_dir.join("page");
    let result = command_output_with_timeout(
        Command::new("pdftoppm")
            .arg("-f").arg("1").arg("-l").arg("1")
            .arg("-png").arg("-scale-to-x").arg("320").arg("-scale-to-y").arg("-1")
            .arg(path).arg(&prefix),
        Duration::from_secs(30),
    );
    let output = prefix.with_file_name("page-1.png");
    let bytes = result.and_then(|result| {
        if !result.status.success() { return Err("本地 PDF 渲染失败。".to_string()); }
        fs::read(&output).map_err(|error| error.to_string())
    });
    let _ = fs::remove_dir_all(&work_dir);
    let bytes = bytes?;
    if bytes.len() > MAX_THUMBNAIL_BYTES { return Err("生成的 PDF 缩略图超过安全大小限制。".to_string()); }
    Ok(("image/png", bytes))
}

fn embedding_source_signature(
    item_id: &str,
    name: &str,
    note: &str,
    tags_json: &str,
    source_size: Option<i64>,
    source_modified_ms: Option<i64>,
    content: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(item_id.as_bytes());
    hasher.update(name.as_bytes());
    hasher.update(note.as_bytes());
    hasher.update(tags_json.as_bytes());
    hasher.update(source_size.unwrap_or_default().to_le_bytes());
    hasher.update(source_modified_ms.unwrap_or_default().to_le_bytes());
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn embedding_text(name: &str, path: &str, note: &str, tags_json: &str, content: &str) -> String {
    let tags = serde_json::from_str::<Vec<String>>(tags_json)
        .unwrap_or_default()
        .join(" ");
    format!(
        "名称：{name}\n路径：{path}\n备注：{note}\n标签：{tags}\n正文：{}",
        content.chars().take(6_000).collect::<String>()
    )
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> Option<f32> {
    if left.is_empty() || left.len() != right.len() {
        return None;
    }
    let mut dot = 0.0f32;
    let mut left_norm = 0.0f32;
    let mut right_norm = 0.0f32;
    for (&a, &b) in left.iter().zip(right.iter()) {
        if !a.is_finite() || !b.is_finite() {
            return None;
        }
        dot += a * b;
        left_norm += a * a;
        right_norm += b * b;
    }
    let magnitude = left_norm.sqrt() * right_norm.sqrt();
    (magnitude > f32::EPSILON).then_some(dot / magnitude)
}

fn active_embedding_model(connection: &Connection) -> Result<Option<EmbeddingModel>, String> {
    connection
        .query_row(
            "SELECT id, display_name, path, active, dimensions FROM embedding_models WHERE active = 1 LIMIT 1",
            [],
            |row| Ok(EmbeddingModel {
                id: row.get(0)?,
                display_name: row.get(1)?,
                path: row.get(2)?,
                active: row.get::<_, i64>(3)? != 0,
                dimensions: row.get::<_, Option<i64>>(4)?.map(|value| value as usize),
            }),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn llama_server_path(state: &AppState) -> PathBuf {
    state.data_dir.join("runtime").join("llama-server.exe")
}

async fn start_embedding_server(state: &AppState, model: &EmbeddingModel) -> Result<(std::process::Child, reqwest::Client, String), String> {
    const EMBEDDING_PORT: u16 = 18081;
    let runtime = llama_server_path(state);
    if !runtime.is_file() || !Path::new(&model.path).is_file() {
        return Err("本地 embedding 运行时或模型文件不可用。".to_string());
    }
    let mut child = Command::new(runtime)
        .arg("-m")
        .arg(&model.path)
        .arg("--embedding")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(EMBEDDING_PORT.to_string())
        .arg("--ctx-size")
        .arg("8192")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动本地 embedding 服务：{error}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("http://127.0.0.1:{EMBEDDING_PORT}/embedding");
    for _ in 0..30 {
        if client.get(format!("http://127.0.0.1:{EMBEDDING_PORT}/health")).send().await.is_ok() {
            return Ok((child, client, url));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("本地 embedding 服务启动超时。".to_string())
}

async fn request_embedding(client: &reqwest::Client, url: &str, text: &str) -> Result<Vec<f32>, String> {
    const MAX_EMBEDDING_CHARS: usize = 7_000;
    let payload = serde_json::json!({ "content": text.chars().take(MAX_EMBEDDING_CHARS).collect::<String>() });
    let body = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("本地 embedding 请求失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("本地 embedding 服务拒绝请求：{error}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("读取 embedding 响应失败：{error}"))?;
    let values = body
        .get("embedding")
        .and_then(serde_json::Value::as_array)
        .or_else(|| body.get("data").and_then(serde_json::Value::as_array).and_then(|items| items.first()).and_then(|item| item.get("embedding")).and_then(serde_json::Value::as_array))
        .ok_or_else(|| "本地 embedding 服务返回了不受支持的响应。".to_string())?;
    let vector = values
        .iter()
        .map(|value| value.as_f64().map(|item| item as f32).filter(|item| item.is_finite()).ok_or_else(|| "本地 embedding 向量包含无效数值。".to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    if vector.is_empty() || vector.len() > 16_384 {
        return Err("本地 embedding 向量维度无效。".to_string());
    }
    Ok(vector)
}

async fn embed_text(state: &AppState, model: &EmbeddingModel, text: &str) -> Result<Vec<f32>, String> {
    let (mut child, client, url) = start_embedding_server(state, model).await?;
    let result = request_embedding(&client, &url, text).await;
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn index_job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexJob> {
    Ok(IndexJob {
        id: row.get(0)?,
        folder_id: row.get(1)?,
        status: row.get(2)?,
        completed: row.get(3)?,
        total: row.get(4)?,
        changed: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        error: row.get(8)?,
    })
}

fn emit_index_job(app: &AppHandle, job: &IndexJob) {
    let _ = app.emit("index-job-progress", job);
}

fn create_index_job(connection: &Connection, folder_id: &str) -> Result<IndexJob, String> {
    connection
        .query_row(
            "SELECT id, folder_id, status, completed, total, changed, created_at, updated_at, error FROM index_jobs WHERE folder_id = ?1 AND status IN ('queued', 'running', 'paused') ORDER BY created_at DESC LIMIT 1",
            params![folder_id],
            index_job_from_row,
        )
        .or_else(|_| {
            let id = Uuid::new_v4().to_string();
            connection.execute(
                "INSERT INTO index_jobs (id, folder_id, status, completed, total, changed, created_at, updated_at) VALUES (?1, ?2, 'queued', 0, 0, 0, datetime('now'), datetime('now'))",
                params![id, folder_id],
            )?;
            connection.query_row(
                "SELECT id, folder_id, status, completed, total, changed, created_at, updated_at, error FROM index_jobs WHERE id = ?1",
                params![id],
                index_job_from_row,
            )
        })
        .map_err(|error| error.to_string())
}

fn incremental_index_folder(
    connection: &Connection,
    app: &AppHandle,
    job_id: &str,
    folder_id: &str,
) -> Result<usize, String> {
    incremental_index_folder_inner(connection, job_id, folder_id, |job| {
        emit_index_job(app, job);
    })
}

// The queue worker and the benchmark share this core so measured behavior is production behavior.
fn incremental_index_folder_inner<F>(
    connection: &Connection,
    job_id: &str,
    folder_id: &str,
    mut report_progress: F,
) -> Result<usize, String>
where
    F: FnMut(&IndexJob),
{
    let (root_path, folder_note, folder_tags) = connection
        .query_row(
            "SELECT root_path, note, tags_json FROM folder_refs WHERE id = ?1",
            params![folder_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .map_err(|_| "接入文件夹不存在。".to_string())?;
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Err("接入文件夹原位置不可用。".to_string());
    }
    let existing = connection
        .prepare("SELECT id, path, item_type, note, tags_json, cloud_policy, source_size, source_modified_ms, source_sha256 FROM index_items WHERE folder_id = ?1")
        .map_err(|error| error.to_string())?
        .query_map(params![folder_id], |row| {
            Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                row.get::<_, Option<i64>>(6)?, row.get::<_, Option<i64>>(7)?, row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|value| (value.1.clone(), value))
        .collect::<HashMap<_, _>>();
    let entries = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    let total = entries.len().max(1);
    connection.execute(
        "UPDATE index_jobs SET status = 'running', total = ?1, completed = 0, changed = 0, error = NULL, updated_at = datetime('now') WHERE id = ?2",
        params![total, job_id],
    ).map_err(|error| error.to_string())?;
    let mut seen = HashSet::new();
    let mut changed = 0usize;
    for (position, entry) in entries.into_iter().enumerate() {
        let status = connection.query_row("SELECT status FROM index_jobs WHERE id = ?1", params![job_id], |row| row.get::<_, String>(0)).unwrap_or_else(|_| "cancelled".to_string());
        if status == "paused" {
            return Ok(changed);
        }
        if status != "running" {
            return Err("索引任务已取消。".to_string());
        }
        let path = entry.path();
        let item_path = path.display().to_string();
        seen.insert(item_path.clone());
        let item_type = if entry.file_type().is_dir() { "folder" } else { "file" };
        let name = if path == root {
            root.file_name().and_then(|value| value.to_str()).unwrap_or("未命名文件夹").to_string()
        } else {
            entry.file_name().to_string_lossy().to_string()
        };
        let (source_size, source_modified_ms) = source_state(path);
        let source_sha256 = source_content_hash(path);
        match existing.get(&item_path) {
            Some((id, _, previous_type, _, _, _, previous_size, previous_modified, previous_hash))
                if previous_type == item_type && previous_size == &source_size && previous_modified == &source_modified_ms && previous_hash == &source_sha256 => {}
            Some((id, _, _, _, _, _, _, _, _)) => {
                connection.execute(
                    "UPDATE index_items SET item_type = ?1, name = ?2, source_size = ?3, source_modified_ms = ?4, source_sha256 = ?5 WHERE id = ?6",
                    params![item_type, name, source_size, source_modified_ms, source_sha256, id],
                ).map_err(|error| error.to_string())?;
                if item_type == "file" { index_content(connection, id, path)?; }
                changed += 1;
            }
            None => {
                let id = Uuid::new_v4().to_string();
                let (note, tags, policy) = if path == root {
                    (folder_note.clone(), folder_tags.clone(), "inherit".to_string())
                } else {
                    (String::new(), folder_tags.clone(), "inherit".to_string())
                };
                connection.execute(
                    "INSERT INTO index_items (id, folder_id, item_type, name, path, note, tags_json, cloud_policy, source_size, source_modified_ms, source_sha256) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![id, folder_id, item_type, name, item_path, note, tags, policy, source_size, source_modified_ms, source_sha256],
                ).map_err(|error| error.to_string())?;
                if item_type == "file" { index_content(connection, &id, path)?; }
                changed += 1;
            }
        }
        if position % 25 == 0 || position + 1 == total {
            connection.execute(
                "UPDATE index_jobs SET completed = ?1, changed = ?2, updated_at = datetime('now') WHERE id = ?3",
                params![position + 1, changed, job_id],
            ).map_err(|error| error.to_string())?;
            if let Ok(job) = connection.query_row("SELECT id, folder_id, status, completed, total, changed, created_at, updated_at, error FROM index_jobs WHERE id = ?1", params![job_id], index_job_from_row) {
                report_progress(&job);
            }
        }
    }
    for (path, (id, _, _, _, _, _, _, _, _)) in existing {
        if !seen.contains(&path) {
            connection.execute("DELETE FROM index_content_fts WHERE item_id = ?1", params![id]).map_err(|error| error.to_string())?;
            connection.execute("DELETE FROM index_items WHERE id = ?1", params![id]).map_err(|error| error.to_string())?;
            changed += 1;
        }
    }
    connection.execute(
        "UPDATE index_jobs SET status = 'completed', completed = ?1, total = ?1, changed = ?2, updated_at = datetime('now') WHERE id = ?3",
        params![total, changed, job_id],
    ).map_err(|error| error.to_string())?;
    Ok(changed)
}

fn start_index_worker(app: AppHandle, data_dir: PathBuf) {
    thread::spawn(move || loop {
        let Ok(connection) = open_app_database(&data_dir) else {
            thread::sleep(Duration::from_secs(1));
            continue;
        };
        let next = connection.query_row(
            "SELECT id, folder_id FROM index_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        );
        if let Ok((job_id, folder_id)) = next {
            let result = incremental_index_folder(&connection, &app, &job_id, &folder_id);
            if let Err(error) = result {
                let _ = connection.execute(
                    "UPDATE index_jobs SET status = 'failed', error = ?1, updated_at = datetime('now') WHERE id = ?2 AND status <> 'paused'",
                    params![error, job_id],
                );
            }
            if let Ok(job) = connection.query_row("SELECT id, folder_id, status, completed, total, changed, created_at, updated_at, error FROM index_jobs WHERE id = ?1", params![job_id], index_job_from_row) {
                emit_index_job(&app, &job);
            }
        }
        thread::sleep(Duration::from_millis(300));
    });
}

fn model_terms(question: &str, state: &AppState) -> Vec<String> {
    let runtime = state.data_dir.join("runtime").join("llama-cli.exe");
    let model = active_model_path(state);
    if !runtime.is_file() || !model.is_file() {
        return extract_search_terms(question);
    }
    let prompt = format!(
        "You extract local-file search keywords. Return only a comma-separated list of at most 6 Chinese or English keywords. User question: {question}"
    );
    let settings = runtime_settings(state);
    let output = Command::new(runtime)
        .arg("-m")
        .arg(model)
        .arg("-p")
        .arg(prompt)
        .arg("-n")
        .arg("48")
        .arg("--temp")
        .arg("0")
        .arg("--threads")
        .arg(settings.threads.to_string())
        .arg("--ctx-size")
        .arg(settings.context_size.to_string())
        .output();
    output
        .ok()
        .filter(|result| result.status.success())
        .map(|result| parse_model_terms(&String::from_utf8_lossy(&result.stdout)))
        .filter(|terms| !terms.is_empty())
        .unwrap_or_else(|| extract_search_terms(question))
}

fn recent_local_context(conversation_id: &str, state: &AppState) -> Result<String, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection
        .prepare("SELECT role, content FROM conversation_messages WHERE conversation_id = ?1 ORDER BY rowid DESC LIMIT 8")
        .map_err(|error| error.to_string())?;
    let mut messages = statement
        .query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    messages.reverse();
    let mut context = String::new();
    for (role, content) in messages {
        let entry = format!(
            "{role}: {}\n",
            content.chars().take(900).collect::<String>()
        );
        if context.len() + entry.len() > 6_000 {
            break;
        }
        context.push_str(&entry);
    }
    Ok(context)
}

fn local_agent_reply(
    question: &str,
    sources: &[IndexItem],
    conversation_id: &str,
    state: &AppState,
) -> Result<String, String> {
    let fallback = format!(
        "本地检索完成，找到 {} 项相关资料。可从下方结果打开真实位置；未向云端发送内容。",
        sources.len()
    );
    let runtime = state.data_dir.join("runtime").join("llama-cli.exe");
    let model = active_model_path(state);
    if !runtime.is_file() || !model.is_file() {
        return Ok(fallback);
    }
    let context = recent_local_context(conversation_id, state)?;
    let source_summary = sources
        .iter()
        .take(12)
        .map(|source| {
            format!(
                "- {} | {} | 备注：{} | 标签：{}",
                source.name,
                source.display_path,
                source.note,
                source.tags.join(",")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "你是完全离线的资料助手。仅根据下方本地对话和索引摘要回答，不能编造文件、不能执行命令、不能联网。返回单个 JSON 对象：{{\"answer\":\"...\",\"steps\":[\"...\"]}}。回答中文、简短。\n本地对话：\n{context}\n当前问题：{question}\n本地索引：\n{source_summary}"
    );
    let settings = runtime_settings(state);
    let mut command = Command::new(runtime);
    command
        .arg("-m")
        .arg(model)
        .arg("-p")
        .arg(prompt)
        .arg("-n")
        .arg("360")
        .arg("--temp")
        .arg("0.2")
        .arg("--threads")
        .arg(settings.threads.to_string())
        .arg("--ctx-size")
        .arg(settings.context_size.to_string())
        .arg("--no-display-prompt")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if settings.execution_mode == "cpu" { command.arg("-ngl").arg("0"); }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return Ok(fallback),
    };
    let mut finished = false;
    for _ in 0..900 {
        match child.try_wait() {
            Ok(Some(_)) => {
                finished = true;
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    if !finished {
        let _ = child.kill();
    }
    let Ok(output) = child.wait_with_output() else {
        return Ok(fallback);
    };
    if !finished || !output.status.success() {
        return Ok(fallback);
    }
    let answer = String::from_utf8_lossy(&output.stdout)
        .chars()
        .take(12_000)
        .collect::<String>();
    if answer.trim().is_empty() {
        Ok(fallback)
    } else {
        Ok(answer)
    }
}

fn recent_cloud_context(
    conversation_id: &str,
    state: &AppState,
) -> Result<(Vec<String>, usize), String> {
    let messages = {
        let connection = state
            .database
            .lock()
            .map_err(|_| "本地数据库被占用。".to_string())?;
        let mut statement = connection
            .prepare("SELECT content FROM conversation_messages WHERE conversation_id = ?1 AND role = 'user' ORDER BY rowid DESC LIMIT 6")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![conversation_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        rows
    };
    let mut context = Vec::new();
    let mut redactions = 0;
    for message in messages.into_iter().rev() {
        let (safe, count) =
            redact_with_custom_rules(&message.chars().take(900).collect::<String>(), state)?;
        redactions += count;
        context.push(safe);
    }
    Ok((context, redactions))
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("无法校验下载文件：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取下载文件失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err("下载文件完整性校验失败，请重试。".to_string())
    }
}

async fn download_to(
    app: AppHandle,
    kind: &str,
    source: &str,
    url: &str,
    destination: &Path,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    let temporary = destination.with_extension("partial");
    let result = async {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            // The model is roughly 1 GB, so allow slow connections to finish after connecting.
            .timeout(std::time::Duration::from_secs(4 * 60 * 60))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|error| format!("无法初始化下载连接：{error}"))?;
        let resumed_bytes = fs::metadata(&temporary)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let mut request = client.get(url);
        if resumed_bytes > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={resumed_bytes}-"));
            // Range resume
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("下载请求失败：{error}"))?;
        if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && resumed_bytes > 0 {
            if let Some(expected) = expected_sha256 {
                verify_sha256(&temporary, expected)?;
                if destination.exists() {
                    fs::remove_file(destination).map_err(|error| error.to_string())?;
                }
                return fs::rename(&temporary, destination).map_err(|error| error.to_string());
            }
            return Err("下载服务器无法续传运行时文件；请删除 partial 文件后重试。".to_string());
        }
        let response = response
            .error_for_status()
            .map_err(|error| format!("下载地址不可用：{error}"))?;
        let append = resumed_bytes > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        let total = response
            .content_length()
            .map(|length| length + if append { resumed_bytes } else { 0 });
        let mut output = if append {
            fs::OpenOptions::new().append(true).open(&temporary)
        } else {
            File::create(&temporary)
        }
        .map_err(|error| error.to_string())?;
        let mut stream = response.bytes_stream();
        let mut completed = if append { resumed_bytes } else { 0 };

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|error| format!("下载中断：{error}"))?;
            output
                .write_all(&bytes)
                .map_err(|error| error.to_string())?;
            completed += bytes.len() as u64;
            app.emit(
                "download-progress",
                DownloadProgress {
                    kind: kind.to_string(),
                    source: source.to_string(),
                    completed,
                    total,
                },
            )
            .map_err(|error| error.to_string())?;
        }
        output.flush().map_err(|error| error.to_string())?;
        drop(output);
        if let Some(expected) = expected_sha256 {
            verify_sha256(&temporary, expected)?;
        }
        if destination.exists() {
            fs::remove_file(destination).map_err(|error| error.to_string())?;
        }
        fs::rename(&temporary, destination).map_err(|error| error.to_string())
    }
    .await;
    // Keep a verified partial file so a transient network failure can resume safely.
    result
}

async fn download_with_fallback(app: AppHandle, destination: &Path) -> Result<(), String> {
    let mut failures = Vec::new();
    for (source, url) in MODEL_URLS {
        for attempt in 1..=2 {
            match download_to(
                app.clone(),
                "model",
                source,
                url,
                destination,
                Some(MODEL_SHA256),
            )
            .await
            {
                Ok(()) => return Ok(()),
                Err(error) => failures.push(format!("{source} 第 {attempt} 次：{error}")),
            }
        }
    }
    Err(format!(
        "模型下载失败，已依次尝试官方源和镜像：{}",
        failures.join("；")
    ))
}

#[tauri::command]
fn get_runtime_status(state: State<'_, AppState>) -> RuntimeStatus {
    let model_path = active_model_path(&state);
    let runtime_dir = state.data_dir.join("runtime");
    RuntimeStatus {
        model_installed: model_path.is_file(),
        runtime_installed: runtime_dir.join("llama-server.exe").is_file()
            || runtime_dir.join("llama-cli.exe").is_file(),
        model_path: model_path.display().to_string(),
        active_model_name: model_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("默认模型")
            .to_string(),
    }
}

#[tauri::command]
async fn download_model(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeStatus, String> {
    let models_dir = state.data_dir.join("models");
    fs::create_dir_all(&models_dir).map_err(|error| error.to_string())?;
    let target = models_dir.join(MODEL_FILE);
    if target.is_file() && verify_sha256(&target, MODEL_SHA256).is_err() {
        let _ = fs::remove_file(&target);
    }
    if !target.is_file() {
        download_with_fallback(app, &target).await?;
    }
    Ok(get_runtime_status(state))
}

#[tauri::command]
fn list_local_models(state: State<'_, AppState>) -> Result<Vec<LocalModel>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection.prepare("SELECT id, display_name, path, active FROM local_models ORDER BY active DESC, created_at DESC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(LocalModel {
                id: row.get(0)?,
                display_name: row.get(1)?,
                path: row.get(2)?,
                active: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows
        .filter_map(Result::ok)
        .filter(|model| Path::new(&model.path).is_file())
        .collect())
}

#[tauri::command]
fn register_local_model(
    input: LocalModelInput,
    state: State<'_, AppState>,
) -> Result<LocalModel, String> {
    let model_path =
        fs::canonicalize(input.path.trim()).map_err(|_| "找不到本地模型文件。".to_string())?;
    if !model_path.is_file()
        || !model_path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"))
    {
        return Err("仅支持已存在的 GGUF 模型文件。".to_string());
    }
    let display_name = input
        .display_name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            model_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("本地 GGUF 模型")
                .to_string()
        })
        .chars()
        .take(100)
        .collect::<String>();
    let id = Uuid::new_v4().to_string();
    let mut connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("UPDATE local_models SET active = 0", [])
        .map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO local_models (id, display_name, path, active, created_at) VALUES (?1, ?2, ?3, 1, datetime('now')) ON CONFLICT(path) DO UPDATE SET display_name = excluded.display_name, active = 1", params![id, display_name, model_path.display().to_string()]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(LocalModel {
        id,
        display_name,
        path: model_path.display().to_string(),
        active: true,
    })
}

#[tauri::command]
fn select_local_model(input: IdInput, state: State<'_, AppState>) -> Result<(), String> {
    let mut connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let path = connection
        .query_row(
            "SELECT path FROM local_models WHERE id = ?1",
            params![input.id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "本地模型不存在。".to_string())?;
    if !Path::new(&path).is_file() {
        return Err("本地模型文件已不存在。".to_string());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("UPDATE local_models SET active = 0", [])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE local_models SET active = 1 WHERE id = ?1",
            params![input.id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_local_model(input: IdInput, state: State<'_, AppState>) -> Result<(), String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let deleted = connection
        .execute("DELETE FROM local_models WHERE id = ?1", params![input.id])
        .map_err(|error| error.to_string())?;
    if deleted == 0 {
        return Err("本地模型记录不存在。".to_string());
    }
    // Only the registry entry is removed. The user-owned GGUF file stays untouched.
    Ok(())
}

#[tauri::command]
fn list_embedding_models(state: State<'_, AppState>) -> Result<Vec<EmbeddingModel>, String> {
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection
        .prepare("SELECT id, display_name, path, active, dimensions FROM embedding_models ORDER BY active DESC, created_at DESC")
        .map_err(|error| error.to_string())?;
    let models = statement
        .query_map([], |row| Ok(EmbeddingModel {
            id: row.get(0)?, display_name: row.get(1)?, path: row.get(2)?,
            active: row.get::<_, i64>(3)? != 0,
            dimensions: row.get::<_, Option<i64>>(4)?.map(|value| value as usize),
        }))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|model| Path::new(&model.path).is_file())
        .collect();
    Ok(models)
}

#[tauri::command]
fn register_embedding_model(input: EmbeddingModelInput, state: State<'_, AppState>) -> Result<EmbeddingModel, String> {
    let path = fs::canonicalize(input.path.trim()).map_err(|_| "找不到本地 embedding GGUF 文件。".to_string())?;
    if !path.is_file() || !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("gguf")) {
        return Err("仅支持已存在的 embedding GGUF 模型文件。".to_string());
    }
    let model = EmbeddingModel {
        id: Uuid::new_v4().to_string(),
        display_name: input.display_name.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| path.file_stem().and_then(|name| name.to_str()).unwrap_or("本地 embedding 模型").chars().take(100).collect()),
        path: path.display().to_string(), active: true, dimensions: None,
    };
    let mut connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction.execute("UPDATE embedding_models SET active = 0", []).map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO embedding_models (id, display_name, path, active, created_at) VALUES (?1, ?2, ?3, 1, datetime('now')) ON CONFLICT(path) DO UPDATE SET display_name = excluded.display_name, active = 1", params![model.id, model.display_name, model.path]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(model)
}

#[tauri::command]
async fn build_embedding_index(app: AppHandle, state: State<'_, AppState>) -> Result<EmbeddingIndexProgress, String> {
    let model = {
        let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
        active_embedding_model(&connection)?.ok_or_else(|| "请先选择本地 embedding GGUF 模型。".to_string())?
    };
    let rows = {
        let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
        let mut statement = connection.prepare(
            "SELECT index_items.id, index_items.name, index_items.path, index_items.note, index_items.tags_json, index_items.source_size, index_items.source_modified_ms, COALESCE(index_content_fts.content, '') FROM index_items LEFT JOIN index_content_fts ON index_items.id = index_content_fts.item_id ORDER BY index_items.name COLLATE NOCASE"
        ).map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<i64>>(5)?, row.get::<_, Option<i64>>(6)?, row.get::<_, String>(7)?
        ))).map_err(|error| error.to_string())?.filter_map(Result::ok).collect::<Vec<_>>();
        rows
    };
    let total = rows.len();
    let (mut child, client, url) = start_embedding_server(&state, &model).await?;
    let mut completed = 0;
    let mut failed = 0;
    for (item_id, name, path, note, tags_json, source_size, source_modified_ms, content) in rows {
        let signature = embedding_source_signature(&item_id, &name, &note, &tags_json, source_size, source_modified_ms, &content);
        let current = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?.query_row(
            "SELECT source_signature FROM item_embeddings WHERE item_id = ?1 AND model_id = ?2", params![item_id, model.id], |row| row.get::<_, String>(0)
        ).optional().map_err(|error| error.to_string())?;
        if current.as_deref() != Some(signature.as_str()) {
            match request_embedding(&client, &url, &embedding_text(&name, &path, &note, &tags_json, &content)).await {
                Ok(vector) => {
                    let vector_json = serde_json::to_string(&vector).map_err(|error| error.to_string())?;
                    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
                    connection.execute("INSERT INTO item_embeddings (item_id, model_id, source_signature, vector_json, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now')) ON CONFLICT(item_id, model_id) DO UPDATE SET source_signature = excluded.source_signature, vector_json = excluded.vector_json, updated_at = excluded.updated_at", params![item_id, model.id, signature, vector_json]).map_err(|error| error.to_string())?;
                    connection.execute("UPDATE embedding_models SET dimensions = ?1 WHERE id = ?2", params![vector.len() as i64, model.id]).map_err(|error| error.to_string())?;
                }
                Err(_) => failed += 1,
            }
        }
        completed += 1;
        let progress = EmbeddingIndexProgress { completed, total, failed };
        let _ = app.emit("embedding-index-progress", &progress);
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(EmbeddingIndexProgress { completed, total, failed })
}

#[tauri::command]
async fn download_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeStatus, String> {
    let runtime_dir = state.data_dir.join("runtime");
    fs::create_dir_all(&runtime_dir).map_err(|error| error.to_string())?;
    let manifest = runtime_variant_for_settings(&runtime_settings(&state))?;
    let archive = state.data_dir.join(format!("{}.zip", manifest.id));
    download_to(
        app.clone(),
        "runtime",
        manifest.id,
        manifest.url,
        &archive,
        Some(manifest.archive_sha256),
    )
    .await?;
    verify_sha256(&archive, manifest.archive_sha256)?;
    let file = File::open(&archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| error.to_string())?;
        let Some(file_name) = Path::new(entry.name()).file_name() else {
            continue;
        };
        if !matches!(
            file_name.to_string_lossy().as_ref(),
            "llama-server.exe" | "llama-cli.exe"
        ) {
            continue;
        }
        let output = runtime_dir.join(file_name);
        let mut writer = File::create(output).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut writer).map_err(|error| error.to_string())?;
    }
    if !runtime_dir.join(manifest.executable).is_file() {
        return Err("已校验的运行时压缩包缺少预期可执行文件。".to_string());
    }
    let _ = fs::remove_file(archive);
    Ok(get_runtime_status(state))
}

#[tauri::command]
fn import_folder(
    input: FolderImport,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let root = validate_folder_path(&input.path)?;
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名文件夹")
        .to_string();
    let tags_json = serde_json::to_string(&input.tags).map_err(|error| error.to_string())?;
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;

    let existing_folder = connection
        .query_row(
            "SELECT id FROM folder_refs WHERE root_path = ?1",
            params![root.display().to_string()],
            |row| row.get::<_, String>(0),
        )
        .ok();
    let mut roots = connection
        .prepare("SELECT id, root_path FROM folder_refs")
        .map_err(|error| error.to_string())?;
    let overlaps = roots
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|(id, path)| {
            if existing_folder
                .as_ref()
                .is_some_and(|existing_id| existing_id == id)
            {
                return false;
            }
            fs::canonicalize(path)
                .map(|existing| root.starts_with(&existing) || existing.starts_with(&root))
                .unwrap_or(false)
        })
        .map(|(_, path)| display_path(Path::new(&path)))
        .next();
    if let Some(overlap) = overlaps {
        return Err(format!(
            "拒绝接入重叠文件夹：{overlap} 已作为独立引用接入。请保留其中一个引用，避免重复索引。"
        ));
    }
    let folder_id = existing_folder
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    // Preserve item-level annotations across explicit refreshes of the same reference.
    let existing_item_metadata = {
        let mut statement = connection
            .prepare(
                "SELECT path, note, tags_json, cloud_policy FROM index_items WHERE folder_id = ?1",
            )
            .map_err(|error| error.to_string())?;
        let metadata = statement
            .query_map(params![folder_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ),
                ))
            })
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .collect::<HashMap<_, _>>();
        metadata
    };
    connection.execute("DELETE FROM index_content_fts WHERE item_id IN (SELECT id FROM index_items WHERE folder_id = ?1)", params![folder_id]).map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM index_items WHERE folder_id = ?1",
            params![folder_id],
        )
        .map_err(|error| error.to_string())?;
    if existing_folder.is_some() {
        connection.execute("UPDATE folder_refs SET name = ?1, note = ?2, tags_json = ?3, imported_at = datetime('now') WHERE id = ?4", params![name, input.note, tags_json, folder_id]).map_err(|error| error.to_string())?;
    } else {
        connection.execute("INSERT INTO folder_refs (id, root_path, name, note, tags_json, cloud_policy, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, 'local_only', datetime('now'))", params![folder_id, root.display().to_string(), name, input.note, tags_json]).map_err(|error| error.to_string())?;
    }

    let root_item_id = Uuid::new_v4().to_string();
    let root_metadata = existing_item_metadata
        .get(&root.display().to_string())
        .cloned()
        .unwrap_or_else(|| {
            (
                input.note.clone(),
                serde_json::to_string(&input.tags).unwrap_or_else(|_| "[]".to_string()),
                "inherit".to_string(),
            )
        });
    connection
        .execute(
            "INSERT INTO index_items (id, folder_id, item_type, name, path, note, tags_json, cloud_policy) VALUES (?1, ?2, 'folder', ?3, ?4, ?5, ?6, ?7)",
            params![root_item_id, folder_id, name, root.display().to_string(), root_metadata.0, root_metadata.1, root_metadata.2],
        )
        .map_err(|error| error.to_string())?;

    let entries = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    let total = entries.len().max(1);
    let _ = app.emit(
        "index-progress",
        IndexProgress {
            folder_id: folder_id.clone(),
            phase: "indexing".to_string(),
            completed: 0,
            total,
        },
    );
    let mut count = 1;
    for (entry_index, entry) in entries.into_iter().enumerate() {
        if entry.path() == root {
            continue;
        }
        let kind = if entry.file_type().is_dir() {
            "folder"
        } else {
            "file"
        };
        let item_name = entry.file_name().to_string_lossy().to_string();
        let item_path = entry.path().display().to_string();
        let item_metadata = existing_item_metadata
            .get(&item_path)
            .cloned()
            .unwrap_or_else(|| {
                (
                    String::new(),
                    serde_json::to_string(&input.tags).unwrap_or_else(|_| "[]".to_string()),
                    "inherit".to_string(),
                )
            });
        let item_id = Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO index_items (id, folder_id, item_type, name, path, note, tags_json, cloud_policy) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![item_id, folder_id, kind, item_name, item_path, item_metadata.0, item_metadata.1, item_metadata.2],
            )
            .map_err(|error| error.to_string())?;
        if kind == "file" {
            index_content(&connection, &item_id, entry.path())?;
        }
        count += 1;
        if entry_index % 25 == 0 || entry_index + 1 == total {
            let _ = app.emit(
                "index-progress",
                IndexProgress {
                    folder_id: folder_id.clone(),
                    phase: "indexing".to_string(),
                    completed: entry_index + 1,
                    total,
                },
            );
        }
    }
    let _ = app.emit(
        "index-progress",
        IndexProgress {
            folder_id,
            phase: "complete".to_string(),
            completed: count,
            total,
        },
    );
    Ok(count)
}

#[tauri::command]
fn import_files_to_library(
    input: FileImport,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    if input.paths.is_empty() || input.paths.len() > 100 {
        return Err("请一次选择 1 至 100 个普通文件。".to_string());
    }
    let library = state.data_dir.join("uploaded-files");
    fs::create_dir_all(&library).map_err(|error| error.to_string())?;
    let library = fs::canonicalize(&library).map_err(|error| error.to_string())?;
    let mut copied = 0;
    for value in input.paths {
        let source = fs::canonicalize(&value).map_err(|_| "选择的文件不存在或无法访问。".to_string())?;
        if !source.is_file() {
            return Err("上传入口仅接受文件；文件夹请使用“接入文件夹”。".to_string());
        }
        let file_name = source.file_name().ok_or_else(|| "无法确定上传文件名。".to_string())?;
        let target = unique_library_file_path(&library, file_name);
        fs::copy(&source, &target).map_err(|error| format!("无法复制 {}：{error}", display_path(&source)))?;
        copied += 1;
    }
    // The managed upload folder is indexed as one reference, preserving imported file copies.
    import_folder(
        FolderImport {
            path: library.display().to_string(),
            note: "由文件上传入口管理；原文件不会被移动或删除。".to_string(),
            tags: vec!["已上传".to_string()],
        },
        app,
        state,
    )?;
    Ok(copied)
}

#[tauri::command]
fn refresh_folder_index(
    input: FolderIdInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<IndexJob, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let job = create_index_job(&connection, &input.folder_id)?;
    emit_index_job(&app, &job);
    Ok(job)
}

#[tauri::command]
fn enqueue_index_job(
    input: IndexJobInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<IndexJob, String> {
    refresh_folder_index(
        FolderIdInput {
            folder_id: input.folder_id,
        },
        app,
        state,
    )
}

#[tauri::command]
fn list_index_jobs(state: State<'_, AppState>) -> Result<Vec<IndexJob>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection
        .prepare("SELECT id, folder_id, status, completed, total, changed, created_at, updated_at, error FROM index_jobs WHERE status IN ('queued', 'running', 'paused', 'failed') ORDER BY created_at")
        .map_err(|error| error.to_string())?;
    let jobs = statement
        .query_map([], index_job_from_row)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    Ok(jobs)
}

#[tauri::command]
fn pause_index_job(input: IdInput, state: State<'_, AppState>) -> Result<(), String> {
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let changed = connection.execute(
        "UPDATE index_jobs SET status = 'paused', updated_at = datetime('now') WHERE id = ?1 AND status IN ('queued', 'running')",
        params![input.id],
    ).map_err(|error| error.to_string())?;
    if changed == 0 { return Err("索引任务不可暂停。".to_string()); }
    Ok(())
}

#[tauri::command]
fn resume_index_job(input: IdInput, state: State<'_, AppState>) -> Result<(), String> {
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let changed = connection.execute(
        "UPDATE index_jobs SET status = 'queued', updated_at = datetime('now') WHERE id = ?1 AND status IN ('paused', 'failed')",
        params![input.id],
    ).map_err(|error| error.to_string())?;
    if changed == 0 { return Err("索引任务不可恢复。".to_string()); }
    Ok(())
}

#[tauri::command]
fn remove_folder_reference(input: FolderIdInput, state: State<'_, AppState>) -> Result<(), String> {
    let mut connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM index_content_fts WHERE item_id IN (SELECT id FROM index_items WHERE folder_id = ?1)", params![input.folder_id]).map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM index_items WHERE folder_id = ?1",
            params![input.folder_id],
        )
        .map_err(|error| error.to_string())?;
    let removed = transaction
        .execute(
            "DELETE FROM folder_refs WHERE id = ?1",
            params![input.folder_id],
        )
        .map_err(|error| error.to_string())?;
    if removed == 0 {
        return Err("接入文件夹不存在。".to_string());
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn folder_reference_status(
    input: FolderIdInput,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let path = {
        let connection = state
            .database
            .lock()
            .map_err(|_| "本地数据库被占用。".to_string())?;
        connection
            .query_row(
                "SELECT root_path FROM folder_refs WHERE id = ?1",
                params![input.folder_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| "接入文件夹不存在。".to_string())?
    };
    Ok(if Path::new(&path).is_dir() {
        "available".to_string()
    } else {
        "missing".to_string()
    })
}

#[tauri::command]
fn list_folder_refs(state: State<'_, AppState>) -> Result<Vec<FolderRef>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT folder_refs.id, folder_refs.name, folder_refs.root_path, folder_refs.note, folder_refs.tags_json, folder_refs.cloud_policy, COUNT(index_items.id)
             FROM folder_refs LEFT JOIN index_items ON index_items.folder_id = folder_refs.id
             GROUP BY folder_refs.id
             ORDER BY folder_refs.imported_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, usize>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    Ok(rows
        .filter_map(Result::ok)
        .map(
            |(id, name, path, note, tags_json, cloud_policy, item_count)| FolderRef {
                id,
                name,
                display_path: display_path(Path::new(&path)),
                path: path.clone(),
                note,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                cloud_policy: CloudPolicy::from_database(&cloud_policy),
                item_count,
                source_status: if Path::new(&path).is_dir() {
                    "available".to_string()
                } else {
                    "missing".to_string()
                },
            },
        )
        .collect())
}

#[tauri::command]
fn list_folder_children(
    folder_id: String,
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<FolderEntry>, String> {
    let directory = folder_path(&folder_id, path.as_deref(), &state)?;
    let folder_policy = {
        let connection = state
            .database
            .lock()
            .map_err(|_| "本地数据库被占用。".to_string())?;
        connection
            .query_row(
                "SELECT cloud_policy FROM folder_refs WHERE id = ?1",
                params![folder_id],
                |row| row.get::<_, String>(0),
            )
            .map(|value| CloudPolicy::from_database(&value))
            .map_err(|error| error.to_string())?
    };
    let mut entries = fs::read_dir(&directory)
        .map_err(|error| format!("无法读取文件夹：{error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let entry_path = entry.path();
            let item_type = if entry_path.is_dir() {
                "folder"
            } else {
                "file"
            };
            let metadata = {
                let connection = state.database.lock().ok()?;
                connection.query_row(
                    "SELECT id, note, tags_json, cloud_policy FROM index_items WHERE folder_id = ?1 AND path = ?2",
                    params![folder_id, entry_path.display().to_string()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
                ).ok()
            };
            let (id, note, tags_json, item_policy) = metadata.unwrap_or_else(|| (String::new(), String::new(), "[]".to_string(), "inherit".to_string()));
            Some(FolderEntry {
                id,
                name: entry.file_name().to_string_lossy().to_string(),
                display_path: display_path(&entry_path),
                path: entry_path.display().to_string(),
                item_type: item_type.to_string(),
                note,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                cloud_policy: effective_cloud_policy(folder_policy, CloudPolicy::from_database(&item_policy)),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left.item_type
            .cmp(&right.item_type)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

#[tauri::command]
fn update_metadata(input: MetadataUpdate, state: State<'_, AppState>) -> Result<(), String> {
    if input.note.is_none() && input.tags.is_none() && input.cloud_policy.is_none() {
        return Ok(());
    }
    let mut connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (table, id_column) = match input.target_type.as_str() {
        "folder" => ("folder_refs", "id"),
        "item" => ("index_items", "id"),
        _ => return Err("不支持的元数据对象。".to_string()),
    };
    let (old_note, old_tags, old_policy): (String, String, String) = transaction
        .query_row(
            &format!("SELECT note, tags_json, cloud_policy FROM {table} WHERE {id_column} = ?1"),
            params![input.target_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "找不到要更新的资料。".to_string())?;
    let note = input.note.unwrap_or(old_note);
    let tags = input
        .tags
        .map(|tags| serde_json::to_string(&tags).map_err(|error| error.to_string()))
        .transpose()?
        .unwrap_or(old_tags);
    let policy = input
        .cloud_policy
        .unwrap_or_else(|| CloudPolicy::from_database(&old_policy));
    transaction
        .execute(
            &format!("UPDATE {table} SET note = ?1, tags_json = ?2, cloud_policy = ?3 WHERE {id_column} = ?4"),
            params![note, tags, policy.as_database(), input.target_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO metadata_audit (id, target_type, target_id, action, old_policy, new_policy, created_at) VALUES (?1, ?2, ?3, 'update_metadata', ?4, ?5, datetime('now'))",
            params![Uuid::new_v4().to_string(), input.target_type, input.target_id, old_policy, policy.as_database()],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn prepare_ai_output(
    input: AiOutputRequest,
    state: State<'_, AppState>,
) -> Result<AiOutputTarget, String> {
    let (base, is_app_workspace) =
        match input.output_folder.filter(|value| !value.trim().is_empty()) {
            Some(value) => {
                let selected = PathBuf::from(value);
                if !selected.is_dir() {
                    return Err("请选择一个存在的 AI 写入文件夹。".to_string());
                }
                (
                    fs::canonicalize(selected).map_err(|error| error.to_string())?,
                    false,
                )
            }
            None => (ai_output_roots(&state.data_dir)?, true),
        };
    let workspace_id = Uuid::new_v4().to_string();
    let workspace = base.join(format!(
        "{}-{}",
        safe_workspace_name(&input.project_name),
        &workspace_id[..8]
    ));
    fs::create_dir_all(&workspace).map_err(|error| format!("无法创建 AI 工作区：{error}"))?;
    let workspace = fs::canonicalize(workspace).map_err(|error| error.to_string())?;
    if !workspace.starts_with(&base) {
        return Err("AI 工作区超出允许的写入目录。".to_string());
    }
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection
        .execute(
            "INSERT INTO agent_workspaces (id, root_path, is_app_workspace, created_at) VALUES (?1, ?2, ?3, datetime('now'))",
            params![workspace_id, workspace.display().to_string(), is_app_workspace],
        )
        .map_err(|error| error.to_string())?;
    Ok(AiOutputTarget {
        workspace_id,
        display_path: display_path(&workspace),
        path: workspace.display().to_string(),
        is_app_workspace,
    })
}

#[tauri::command]
fn write_ai_file(input: AiFileWrite, state: State<'_, AppState>) -> Result<String, String> {
    let root_value = {
        let connection = state
            .database
            .lock()
            .map_err(|_| "本地数据库被占用。".to_string())?;
        connection
            .query_row(
                "SELECT root_path FROM agent_workspaces WHERE id = ?1",
                params![input.workspace_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| "AI 工作区不存在或已失效。".to_string())?
    };
    let root = fs::canonicalize(root_value).map_err(|_| "AI 工作区已无法访问。".to_string())?;
    let relative = safe_relative_path(&input.relative_path)?;
    let target = root.join(relative);
    if target.exists() {
        return Err(format!("拒绝覆盖已有工作区文件：{}", display_path(&target)));
    }
    let parent = target
        .parent()
        .ok_or_else(|| "AI 写入路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
    if !parent.starts_with(&root) {
        return Err("AI 写入被阻止：路径超出工作区。".to_string());
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|_| format!("拒绝覆盖已有工作区文件：{}", display_path(&target)))?;
    output
        .write_all(input.content.as_bytes())
        .map_err(|error| format!("无法写入 AI 文件：{error}"))?;
    Ok(display_path(&target))
}

fn workspace_root(workspace_id: &str, state: &AppState) -> Result<PathBuf, String> {
    let root_value = {
        let connection = state
            .database
            .lock()
            .map_err(|_| "本地数据库被占用。".to_string())?;
        connection
            .query_row(
                "SELECT root_path FROM agent_workspaces WHERE id = ?1",
                params![workspace_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| "AI 工作区不存在或已失效。".to_string())?
    };
    fs::canonicalize(root_value).map_err(|_| "AI 工作区已无法访问。".to_string())
}

fn extract_generated_files(advice: &str) -> Vec<GeneratedFile> {
    let json_files = serde_json::from_str::<serde_json::Value>(advice)
        .ok()
        .and_then(|value| {
            value
                .get("files")
                .and_then(|files| files.as_array())
                .cloned()
        })
        .unwrap_or_default();
    let mut files = json_files
        .into_iter()
        .filter_map(|item| {
            Some(GeneratedFile {
                relative_path: item
                    .get("path")
                    .or_else(|| item.get("pathHint"))?
                    .as_str()?
                    .trim()
                    .to_string(),
                content: item.get("content")?.as_str()?.to_string(),
            })
        })
        .collect::<Vec<_>>();
    if files.is_empty() {
        if let Ok(regex) = Regex::new(
            r"(?ms)```[^\r\n]*\r?\n(?:\s*(?://|#)\s*)?(?:file|path)\s*:\s*([^\r\n]+)\r?\n(.*?)```",
        ) {
            files = regex
                .captures_iter(advice)
                .filter_map(|capture| {
                    Some(GeneratedFile {
                        relative_path: capture.get(1)?.as_str().trim().to_string(),
                        content: capture.get(2)?.as_str().to_string(),
                    })
                })
                .collect();
        }
    }
    files
        .into_iter()
        .take(MAX_GENERATED_FILES)
        .filter(|file| file.content.len() <= MAX_GENERATED_FILE_BYTES)
        .collect()
}

fn scan_generated_content(content: &str) -> Result<(), String> {
    let forbidden = [
        (
            r"(?i)child_process|powershell(?:\.exe)?|cmd(?:\.exe)?|shell_exec",
            "命令执行",
        ),
        (r"(?i)https?://|WebSocket|fetch\s*\(", "网络访问"),
        (
            r"(?i)BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|password\s*[:=]",
            "凭据或密钥",
        ),
        (
            r"(?i)rm\s+-rf|Remove-Item\s+-Recurse|del\s+/[fq]",
            "删除操作",
        ),
    ];
    for (pattern, label) in forbidden {
        if Regex::new(pattern)
            .map_err(|_| "安全规则初始化失败。".to_string())?
            .is_match(content)
        {
            return Err(format!(
                "blocked_by_policy：生成内容包含受限{label}，未写入工作区。"
            ));
        }
    }
    Ok(())
}

fn is_low_risk_advice(advice: &str) -> bool {
    let structured = parse_cloud_advice(advice);
    if structured.files.is_empty() || structured.steps.is_empty() {
        return false;
    }
    structured.steps.iter().all(|step| {
        let tool = step
            .requested_tool
            .as_deref()
            .unwrap_or("write_file")
            .to_ascii_lowercase();
        matches!(
            step.risk.trim().to_ascii_lowercase().as_str(),
            "low" | "低" | "低风险"
        ) && matches!(
            tool.as_str(),
            "write_file" | "write-file" | "create_file" | "create-file"
        )
    })
}

fn apply_agent_advice_inner(
    input: WorkspaceAdviceInput,
    allow_low_risk_auto_apply: bool,
    state: &AppState,
) -> Result<WorkspaceActionResult, String> {
    let prepared = state
        .prepared_runs
        .lock()
        .map_err(|_| "任务状态被占用。".to_string())?
        .get(&input.run_id)
        .cloned()
        .ok_or_else(|| "任务已失效；请重新发起。".to_string())?;
    let approved = prepared.run.status == "approved";
    if !approved && !(allow_low_risk_auto_apply && prepared.run.status == "awaiting_approval") {
        return Err("写入建议前必须明确批准该受控步骤。".to_string());
    }
    let advice = prepared
        .run
        .advice
        .clone()
        .ok_or_else(|| "当前任务没有可写入的云端建议。".to_string())?;
    if allow_low_risk_auto_apply && !is_low_risk_advice(&advice) {
        return Err("云端建议不满足低风险自动执行条件；请逐项审阅后手动批准。".to_string());
    }
    let files = extract_generated_files(&advice);
    if files.is_empty() {
        return Err("未识别到带有 file: 相对路径的代码文件。".to_string());
    }
    let root = workspace_root(&input.workspace_id, &state)?;
    let mut targets = Vec::new();
    // Validate the whole batch before creating or changing any workspace file.
    for file in files {
        let relative = safe_relative_path(&file.relative_path)?;
        scan_generated_content(&file.content)?;
        let target = root.join(relative);
        if targets
            .iter()
            .any(|(_, existing, _): &(GeneratedFile, PathBuf, PathBuf)| existing == &target)
        {
            return Err("云端建议包含重复文件路径。".to_string());
        }
        if target.exists() && (!input.allow_existing_edits || allow_low_risk_auto_apply) {
            return Err(format!("拒绝修改已有工作区文件：{}；请在界面中审阅后单独批准。", display_path(&target)));
        }
        if target.exists() && (!target.is_file() || fs::metadata(&target).map_err(|error| error.to_string())?.len() > 2 * 1024 * 1024) {
            return Err(format!("拒绝修改非普通文件或超过 2 MB 的已有文件：{}", display_path(&target)));
        }
        if target.exists() && !fs::canonicalize(&target).map_err(|error| error.to_string())?.starts_with(&root) {
            return Err("拒绝修改指向工作区外部的已有文件。".to_string());
        }
        let parent = target
            .parent()
            .ok_or_else(|| "AI 写入路径无效。".to_string())?
            .to_path_buf();
        targets.push((file, target, parent));
    }
    let mut written = Vec::new();
    let backup_root = state.data_dir.join("agent-edit-backups").join(&input.run_id);
    for (file, target, parent) in targets {
        fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
        let parent = fs::canonicalize(&parent).map_err(|error| error.to_string())?;
        if !parent.starts_with(&root) {
            return Err("AI 写入被阻止：路径超出工作区。".to_string());
        }
        let existed = target.exists();
        if existed {
            let relative = safe_relative_path(&file.relative_path)?;
            let backup = backup_root.join(relative);
            let backup_parent = backup.parent().ok_or_else(|| "备份路径无效。".to_string())?;
            fs::create_dir_all(backup_parent).map_err(|error| error.to_string())?;
            fs::copy(&target, &backup).map_err(|error| format!("无法创建已有文件备份：{error}"))?;
        }
        let mut output = if existed {
            fs::OpenOptions::new().write(true).truncate(true).open(&target)
                .map_err(|error| format!("无法修改已批准文件：{error}"))?
        } else {
            fs::OpenOptions::new().write(true).create_new(true).open(&target)
                .map_err(|_| format!("拒绝覆盖已有工作区文件：{}", display_path(&target)))?
        };
        output
            .write_all(file.content.as_bytes())
            .map_err(|error| error.to_string())?;
        written.push(display_path(&target));
    }
    let feedback = if input.allow_existing_edits {
        "已按本次明确批准修改已有文件；每个原文件已创建可恢复备份，未执行删除、命令或网络操作。"
    } else if allow_low_risk_auto_apply {
        "已按用户开启的低风险自动执行设置写入受控工作区；未覆盖已有文件、未执行网络或命令。"
    } else {
        "已将经过路径校验的建议写入受控工作区；未覆盖已有文件。"
    };
    update_agent_run_status(&input.run_id, "files_written", feedback, state)?;
    Ok(WorkspaceActionResult {
        status: "files_written".to_string(),
        written_files: written,
        output: if input.allow_existing_edits { "代码已写入；已创建可恢复备份（agent-edit-backups），请主动选择只读构建或测试检查。".to_string() } else { "代码已写入；请主动选择只读构建或测试检查。".to_string() },
    })
}

#[tauri::command]
fn apply_agent_advice(
    input: WorkspaceAdviceInput,
    state: State<'_, AppState>,
) -> Result<WorkspaceActionResult, String> {
    apply_agent_advice_inner(input, false, &state)
}

#[tauri::command]
fn auto_apply_low_risk_agent_advice(
    input: WorkspaceAdviceInput,
    state: State<'_, AppState>,
) -> Result<WorkspaceActionResult, String> {
    let preferences = get_agent_preferences(state.clone())?;
    if !preferences.auto_apply_low_risk {
        return Err("低风险自动执行尚未由用户开启。".to_string());
    }
    apply_agent_advice_inner(input, true, &state)
}

#[tauri::command]
fn run_workspace_check(
    input: WorkspaceCheckInput,
    state: State<'_, AppState>,
) -> Result<WorkspaceActionResult, String> {
    if !ALLOWED_WORKSPACE_CHECKS.contains(&input.command.as_str()) {
        return Err("仅允许执行固定的构建/测试检查。".to_string());
    }
    let root = workspace_root(&input.workspace_id, &state)?;
    let mut parts = input.command.split_whitespace();
    let program = parts.next().ok_or_else(|| "检查命令无效。".to_string())?;
    let mut child = Command::new(program)
        .args(parts)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "无法启动检查命令；请确认工具已安装。".to_string())?;
    let mut finished = false;
    for _ in 0..1_200 {
        if let Some(run_id) = &input.run_id {
            if state
                .cancelled_runs
                .lock()
                .map_err(|_| "任务状态被占用。".to_string())?
                .get(run_id)
                .is_some_and(|token| token.load(Ordering::Acquire))
            {
                let _ = child.kill();
                return Err("任务已取消；本地检查已停止。".to_string());
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                finished = true;
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(500)),
            Err(_) => break,
        }
    }
    if !finished {
        let _ = child.kill();
    }
    let command_output = child
        .wait_with_output()
        .map_err(|_| "无法读取检查命令结果。".to_string())?;
    if !finished {
        return Err("检查超过 10 分钟已停止；未执行其他操作。".to_string());
    }
    let mut text = String::from_utf8_lossy(&command_output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&command_output.stderr));
    let output = text.chars().take(8_000).collect::<String>();
    let status = if command_output.status.success() {
        "check_complete"
    } else {
        "check_failed"
    };
    if let Some(run_id) = &input.run_id {
        let feedback = if status == "check_complete" {
            "本地检查成功完成。"
        } else {
            "本地检查失败；可重试以生成最小脱敏修复请求。"
        };
        update_agent_run_status(run_id, status, feedback, &state)?;
        if status == "check_failed" {
            let (diagnostic, _) =
                redact_with_custom_rules(&output.chars().take(2_000).collect::<String>(), &state)?;
            if let Some(prepared) = state
                .prepared_runs
                .lock()
                .map_err(|_| "任务状态被占用。".to_string())?
                .get_mut(run_id)
            {
                prepared.last_diagnostic = Some(diagnostic);
                prepared.run.status = "check_failed".to_string();
                prepared.run.feedback = "本地检查失败；可重试或请求受限的自动最小修复。".to_string();
            }
        } else if let Some(prepared) = state.prepared_runs.lock().map_err(|_| "任务状态被占用。".to_string())?.get_mut(run_id) {
            prepared.run.status = "check_complete".to_string();
            prepared.run.feedback = "本地检查成功完成。".to_string();
        }
    }
    Ok(WorkspaceActionResult {
        status: status.to_string(),
        written_files: Vec::new(),
        output,
    })
}

fn cloud_key_entry(provider_id: &str) -> Result<Entry, String> {
    if provider_id.trim().is_empty() || provider_id.len() > 80 {
        return Err("云端提供商标识无效。".to_string());
    }
    Entry::new(CLOUD_KEYRING_SERVICE, provider_id)
        .map_err(|_| "无法访问 Windows 凭据库。".to_string())
}

fn validate_cloud_base_url(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value.trim()).map_err(|_| "云端地址格式无效。".to_string())?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("云端地址必须是不含凭据的 HTTPS 地址。".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "云端地址缺少主机名。".to_string())?;
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".local")
        || host.parse::<IpAddr>().is_ok()
    {
        return Err("云端地址不能指向本机、内网或 IP 地址。".to_string());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn redact_sensitive_text(value: &str) -> (String, usize) {
    let patterns = [
        r"(?i)\b(?:sk|rk|pk)_[a-z0-9_-]{16,}\b",
        r"(?i)\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]{6,}",
        r"-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----",
        r"\b1[3-9]\d{9}\b",
        r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b",
        r"\b\d{17}[\dXx]\b",
    ];
    let mut output = value.to_string();
    let mut count = 0;
    for pattern in patterns {
        if let Ok(regex) = Regex::new(pattern) {
            count += regex.find_iter(&output).count();
            output = regex.replace_all(&output, "[已脱敏]").into_owned();
        }
    }
    (output, count)
}

fn redact_with_custom_rules(value: &str, state: &AppState) -> Result<(String, usize), String> {
    let (mut output, mut count) = redact_sensitive_text(value);
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection
        .prepare("SELECT pattern FROM sensitive_rules WHERE enabled = 1")
        .map_err(|error| error.to_string())?;
    let rules = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    for pattern in rules.filter_map(Result::ok) {
        let regex =
            Regex::new(&pattern).map_err(|_| "存在无效的敏感规则，已拒绝外发。".to_string())?;
        count += regex.find_iter(&output).count();
        output = regex.replace_all(&output, "[已脱敏]").into_owned();
    }
    Ok((output, count))
}

fn contains_prompt_injection(content: &str) -> bool {
    let normalized = content.to_lowercase();
    [
        "ignore previous instructions",
        "ignore all previous instructions",
        "ignore the above instructions",
        "system prompt",
        "reveal your instructions",
        "忽略之前",
        "忽略上述",
        "忽略前面的指令",
        "系统提示",
        "不要遵守",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn summarize_source_for_cloud(
    source: &IndexItem,
    opaque_id: &str,
    state: &AppState,
) -> Result<(serde_json::Value, usize), String> {
    let path = Path::new(&source.path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let metadata = fs::metadata(path).ok();
    let mut result = serde_json::json!({
        "id": opaque_id,
        "type": source.item_type,
        "format": extension,
        "purpose": "用户允许外发的最小化本地资料",
    });
    if source.item_type == "file" {
        if let Some(content) = text_content_for_index(path) {
            // Retrieved documents are untrusted data, never cloud prompt instructions.
            if contains_prompt_injection(&content) {
                return Err("允许外发的资料疑似包含提示词注入，已阻止本次云端请求。".to_string());
            }
            let (safe_content, redactions) =
                redact_with_custom_rules(&content.chars().take(20_000).collect::<String>(), state)?;
            result["content"] = serde_json::Value::String(safe_content);
            return Ok((result, redactions));
        }
        if let Some(metadata) = metadata {
            result["sizeBytes"] = serde_json::json!(metadata.len());
        }
    }
    // Images, binaries and folders are represented only by an opaque capability description.
    Ok((result, 0))
}

#[tauri::command]
fn list_sensitive_rules(state: State<'_, AppState>) -> Result<Vec<SensitiveRule>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection
        .prepare("SELECT id, name, pattern, enabled FROM sensitive_rules ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(SensitiveRule {
                id: row.get(0)?,
                name: row.get(1)?,
                pattern: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
fn save_sensitive_rule(
    input: SensitiveRuleInput,
    state: State<'_, AppState>,
) -> Result<SensitiveRule, String> {
    let name = input.name.trim().to_string();
    let pattern = input.pattern.trim().to_string();
    if name.is_empty()
        || name.len() > 80
        || pattern.is_empty()
        || pattern.len() > 500
        || Regex::new(&pattern).is_err()
    {
        return Err("敏感规则名称或正则表达式无效。".to_string());
    }
    let id = input
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection.execute("INSERT INTO sensitive_rules (id, name, pattern, enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now')) ON CONFLICT(id) DO UPDATE SET name = excluded.name, pattern = excluded.pattern, enabled = excluded.enabled, updated_at = datetime('now')", params![id, name, pattern, input.enabled]).map_err(|error| error.to_string())?;
    Ok(SensitiveRule {
        id,
        name,
        pattern,
        enabled: input.enabled,
    })
}

#[tauri::command]
fn export_local_governance(state: State<'_, AppState>) -> Result<GovernanceExport, String> {
    let conversations = list_conversations(state.clone())?;
    let sensitive_rules = list_sensitive_rules(state.clone())?;
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let metadata_audit_count = connection
        .query_row("SELECT COUNT(*) FROM metadata_audit", [], |row| {
            row.get::<_, usize>(0)
        })
        .map_err(|error| error.to_string())?;
    let agent_event_count = connection
        .query_row("SELECT COUNT(*) FROM agent_events", [], |row| {
            row.get::<_, usize>(0)
        })
        .map_err(|error| error.to_string())?;
    Ok(GovernanceExport {
        exported_at: "本地导出".to_string(),
        conversations,
        sensitive_rules,
        metadata_audit_count,
        agent_event_count,
    })
}

#[tauri::command]
fn clear_local_data(input: ClearLocalDataInput, state: State<'_, AppState>) -> Result<(), String> {
    let mut connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    match input.scope.as_str() {
        "conversations" => {
            transaction
                .execute("DELETE FROM conversation_messages", [])
                .map_err(|error| error.to_string())?;
            transaction
                .execute("DELETE FROM conversations", [])
                .map_err(|error| error.to_string())?;
        }
        "audit" => {
            transaction
                .execute("DELETE FROM metadata_audit", [])
                .map_err(|error| error.to_string())?;
            transaction
                .execute("DELETE FROM agent_events", [])
                .map_err(|error| error.to_string())?;
            transaction
                .execute("DELETE FROM agent_runs", [])
                .map_err(|error| error.to_string())?;
        }
        "rules" => {
            transaction
                .execute("DELETE FROM sensitive_rules", [])
                .map_err(|error| error.to_string())?;
        }
        _ => return Err("仅支持清理对话、审计或敏感规则。".to_string()),
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_sensitive_rule(input: IdInput, state: State<'_, AppState>) -> Result<(), String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection
        .execute(
            "DELETE FROM sensitive_rules WHERE id = ?1",
            params![input.id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn cloud_config(state: &AppState) -> Result<Option<CloudProviderConfig>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let row = connection.query_row(
        "SELECT provider_id, display_name, base_url, model, auto_collaboration, review_each_request FROM cloud_provider_config ORDER BY updated_at DESC LIMIT 1",
        [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?)),
    );
    match row {
        Ok((
            provider_id,
            display_name,
            base_url,
            model,
            auto_collaboration,
            review_each_request,
        )) => {
            let configured = cloud_key_entry(&provider_id)
                .and_then(|entry| entry.get_password().map_err(|_| "未配置密钥。".to_string()))
                .is_ok();
            Ok(Some(CloudProviderConfig {
                provider_id,
                display_name,
                base_url,
                model,
                auto_collaboration: auto_collaboration != 0,
                review_each_request: review_each_request != 0,
                configured,
            }))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn provider_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CloudProviderConfig> {
    let provider_id: String = row.get(0)?;
    let configured = cloud_key_entry(&provider_id)
        .and_then(|entry| entry.get_password().map_err(|_| "未配置密钥。".to_string()))
        .is_ok();
    Ok(CloudProviderConfig {
        provider_id,
        display_name: row.get(1)?,
        base_url: row.get(2)?,
        model: row.get(3)?,
        auto_collaboration: row.get::<_, i64>(4)? != 0,
        review_each_request: row.get::<_, i64>(5)? != 0,
        configured,
    })
}

#[tauri::command]
fn list_cloud_providers(state: State<'_, AppState>) -> Result<Vec<CloudProviderConfig>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection.prepare("SELECT provider_id, display_name, base_url, model, auto_collaboration, review_each_request FROM cloud_provider_config ORDER BY updated_at DESC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], provider_from_row)
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
fn get_cloud_provider_config(
    state: State<'_, AppState>,
) -> Result<Option<CloudProviderConfig>, String> {
    cloud_config(&state)
}

#[tauri::command]
fn save_cloud_provider_config(
    input: CloudProviderConfigInput,
    state: State<'_, AppState>,
) -> Result<CloudProviderConfig, String> {
    let provider_id = input.provider_id.trim().to_string();
    let display_name = input.display_name.trim().to_string();
    let base_url = validate_cloud_base_url(&input.base_url)?;
    let model = input.model.trim().to_string();
    if provider_id.is_empty() || display_name.is_empty() || model.is_empty() || model.len() > 160 {
        return Err("请填写提供商标识和模型名。".to_string());
    }
    if let Some(api_key) = input.api_key.filter(|value| !value.trim().is_empty()) {
        cloud_key_entry(&provider_id)?
            .set_password(api_key.trim())
            .map_err(|_| "无法将密钥保存到 Windows 凭据库。".to_string())?;
    }
    let has_key = cloud_key_entry(&provider_id)?.get_password().is_ok();
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection.execute(
        "INSERT INTO cloud_provider_config (provider_id, display_name, base_url, model, auto_collaboration, review_each_request, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now')) ON CONFLICT(provider_id) DO UPDATE SET display_name = excluded.display_name, base_url = excluded.base_url, model = excluded.model, auto_collaboration = excluded.auto_collaboration, review_each_request = excluded.review_each_request, updated_at = datetime('now')",
        params![provider_id, display_name, base_url, model, input.auto_collaboration, input.review_each_request],
    ).map_err(|error| error.to_string())?;
    Ok(CloudProviderConfig {
        provider_id,
        display_name,
        base_url,
        model,
        auto_collaboration: input.auto_collaboration,
        review_each_request: input.review_each_request,
        configured: has_key,
    })
}

fn cloud_provider_by_id(
    provider_id: &str,
    state: &AppState,
) -> Result<CloudProviderConfig, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection.query_row("SELECT provider_id, display_name, base_url, model, auto_collaboration, review_each_request FROM cloud_provider_config WHERE provider_id = ?1", params![provider_id], provider_from_row).map_err(|_| "找不到云端提供商配置。".to_string())
}

#[tauri::command]
fn select_cloud_provider(
    input: ProviderIdInput,
    state: State<'_, AppState>,
) -> Result<CloudProviderConfig, String> {
    let config = cloud_provider_by_id(input.provider_id.trim(), &state)?;
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection
        .execute(
            "UPDATE cloud_provider_config SET updated_at = datetime('now') WHERE provider_id = ?1",
            params![config.provider_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(config)
}

#[tauri::command]
fn delete_cloud_provider(input: ProviderIdInput, state: State<'_, AppState>) -> Result<(), String> {
    let provider_id = input.provider_id.trim();
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection
        .execute(
            "DELETE FROM cloud_provider_config WHERE provider_id = ?1",
            params![provider_id],
        )
        .map_err(|error| error.to_string())?;
    let _ = cloud_key_entry(provider_id).and_then(|entry| {
        entry
            .delete_credential()
            .map_err(|_| "无法删除 Windows 凭据。".to_string())
    });
    Ok(())
}

fn model_endpoint(base_url: &str) -> String {
    let root = base_url.trim_end_matches('/');
    if root.ends_with("/v1") {
        format!("{root}/models")
    } else {
        format!("{root}/v1/models")
    }
}

fn chat_endpoint(base_url: &str) -> String {
    let root = base_url.trim_end_matches('/');
    if root.ends_with("/v1") {
        format!("{root}/chat/completions")
    } else {
        format!("{root}/v1/chat/completions")
    }
}

#[tauri::command]
async fn fetch_cloud_models(
    input: ProviderIdInput,
    state: State<'_, AppState>,
) -> Result<Vec<CloudModel>, String> {
    let config = cloud_provider_by_id(input.provider_id.trim(), &state)?;
    let api_key = cloud_key_entry(&config.provider_id)?
        .get_password()
        .map_err(|_| "请先保存该提供商的 API 密钥。".to_string())?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "无法建立安全云端连接。".to_string())?
        .get(model_endpoint(&config.base_url))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|_| "获取模型列表失败；未记录密钥。".to_string())?;
    if !response.status().is_success() {
        return Err("上游未返回可用模型列表。".to_string());
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "模型列表格式无效。".to_string())?;
    let mut models = value
        .get("data")
        .and_then(|data| data.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(|id| id.as_str()))
        .filter(|id| !id.is_empty() && id.len() <= 160)
        .map(|id| CloudModel { id: id.to_string() })
        .collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models.dedup_by(|left, right| left.id == right.id);
    Ok(models)
}

fn parse_ai_reply(content: &str) -> ParsedReply {
    let trimmed = content.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let answer = value
            .get("answer")
            .or_else(|| value.get("content"))
            .and_then(|value| value.as_str())
            .unwrap_or(trimmed)
            .to_string();
        let steps = value
            .get("steps")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(str::to_string)
                    .take(20)
                    .collect()
            })
            .unwrap_or_default();
        return ParsedReply {
            answer,
            steps,
            code_blocks: trimmed.matches("```").count() / 2,
        };
    }
    let steps = trimmed
        .lines()
        .filter_map(|line| {
            let value = line.trim_start();
            (value.starts_with("- ")
                || value.starts_with("* ")
                || value
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_digit())
                    && value.contains('.'))
            .then(|| {
                value
                    .trim_start_matches(|character: char| {
                        character == '-'
                            || character == '*'
                            || character.is_ascii_digit()
                            || character == '.'
                            || character.is_whitespace()
                    })
                    .to_string()
            })
        })
        .filter(|value| !value.is_empty())
        .take(20)
        .collect();
    ParsedReply {
        answer: trimmed.to_string(),
        steps,
        code_blocks: trimmed.matches("```").count() / 2,
    }
}

fn parse_cloud_advice(content: &str) -> CloudAdvice {
    serde_json::from_str::<CloudAdvice>(content).unwrap_or_else(|_| CloudAdvice {
        answer: content.to_string(),
        assumptions: Vec::new(),
        files: Vec::new(),
        steps: Vec::new(),
        uncertainties: vec!["云端未返回可验证的结构化建议。".to_string()],
    })
}

#[tauri::command]
fn get_privacy_status(state: State<'_, AppState>) -> PrivacyStatus {
    PrivacyStatus {
        database_encrypted: true,
        message: state.startup_recovery_notice.clone().unwrap_or_else(|| {
            "索引和对话数据库使用 SQLCipher 加密；云端 API Key 不写入 SQLite。".to_string()
        }),
        recommendation: "请启用 Windows 磁盘加密（BitLocker 或设备加密），并保留 Windows Credential Manager 中的资料终端凭据。".to_string(),
    }
}

#[tauri::command]
fn get_startup_recovery_notice(state: State<'_, AppState>) -> Option<String> {
    state.startup_recovery_notice.clone()
}

fn backup_key_entry() -> Result<Entry, String> {
    Entry::new(BACKUP_KEYRING_SERVICE, "database-backup-key")
        .map_err(|_| "无法访问 Windows 凭据库。".to_string())
}

fn backup_key() -> Result<[u8; 32], String> {
    let entry = backup_key_entry()?;
    match entry.get_password() {
        Ok(encoded) => {
            let decoded = BASE64.decode(encoded).map_err(|_| "本地备份密钥无效。".to_string())?;
            return decoded.try_into().map_err(|_| "本地备份密钥长度无效。".to_string());
        }
        Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("无法读取 Windows 凭据库中的备份密钥。".to_string()),
    }
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    entry.set_password(&BASE64.encode(key)).map_err(|_| "无法在 Windows 凭据库保存备份密钥。".to_string())?;
    Ok(key)
}

fn encrypt_backup(plain: &[u8]) -> Result<Vec<u8>, String> {
    let key = backup_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "无法初始化备份加密。".to_string())?;
    let mut nonce = [0u8; 12];
    rand::rng().fill_bytes(&mut nonce);
    let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), plain).map_err(|_| "无法加密本地备份。".to_string())?;
    let mut result = Vec::with_capacity(BACKUP_MAGIC.len() + nonce.len() + encrypted.len());
    result.extend_from_slice(BACKUP_MAGIC);
    result.extend_from_slice(&nonce);
    result.extend_from_slice(&encrypted);
    Ok(result)
}

fn decrypt_backup(value: &[u8]) -> Result<Vec<u8>, String> {
    if value.len() <= BACKUP_MAGIC.len() + 12 || !value.starts_with(BACKUP_MAGIC) { return Err("不是资料终端加密备份。".to_string()); }
    let key = backup_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "无法初始化备份解密。".to_string())?;
    cipher.decrypt(Nonce::from_slice(&value[BACKUP_MAGIC.len()..BACKUP_MAGIC.len() + 12]), &value[BACKUP_MAGIC.len() + 12..])
        .map_err(|_| "无法解密备份；请在创建备份的同一 Windows 用户账户中恢复。".to_string())
}

#[tauri::command]
fn create_encrypted_backup(state: State<'_, AppState>) -> Result<EncryptedBackup, String> {
    let backup_path = state.data_dir.join("backups").join(format!("file-terminal-{}.ftbackup", Uuid::new_v4()));
    fs::create_dir_all(backup_path.parent().ok_or_else(|| "备份路径无效。".to_string())?).map_err(|error| error.to_string())?;
    let temporary = state.data_dir.join(format!("backup-{}.db", Uuid::new_v4()));
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    connection.execute("VACUUM INTO ?1", params![temporary.display().to_string()]).map_err(|error| error.to_string())?;
    drop(connection);
    let plain = fs::read(&temporary).map_err(|error| error.to_string())?;
    fs::write(&backup_path, encrypt_backup(&plain)?).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(temporary);
    Ok(EncryptedBackup { path: backup_path.display().to_string(), display_path: display_path(&backup_path), created_at: "刚刚".to_string(), database_bytes: plain.len() })
}

#[tauri::command]
fn stage_encrypted_restore(input: BackupPathInput, state: State<'_, AppState>) -> Result<RestoreStage, String> {
    let source = PathBuf::from(input.path);
    if !source.is_file() || source.extension().and_then(|value| value.to_str()) != Some("ftbackup") { return Err("请选择 .ftbackup 加密备份文件。".to_string()); }
    let staged = state.data_dir.join("pending-restore.db");
    fs::write(&staged, decrypt_backup(&fs::read(source).map_err(|error| error.to_string())?)?).map_err(|error| error.to_string())?;
    if load_database_key(&state.data_dir, state.data_dir.join("file-terminal.db").is_file())
        .and_then(|key| open_encrypted_database(&staged, &key))
        .is_err()
    {
        let _ = fs::remove_file(staged);
        return Err("备份数据库校验失败，未替换任何本地数据。".to_string());
    }
    Ok(RestoreStage { pending: true, message: "备份已校验，重启应用后才会安全替换当前数据库。".to_string() })
}

fn apply_pending_restore(data_dir: &Path) -> Result<(), String> {
    let staged = data_dir.join("pending-restore.db");
    if !staged.is_file() { return Ok(()); }
    let database = data_dir.join("file-terminal.db");
    let preserved = data_dir.join("pre-restore.db");
    let _ = fs::remove_file(&preserved);
    if database.is_file() { fs::rename(&database, &preserved).map_err(|error| error.to_string())?; }
    fs::rename(staged, database).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(data_dir.join("file-terminal.db-wal"));
    let _ = fs::remove_file(data_dir.join("file-terminal.db-shm"));
    Ok(())
}

#[tauri::command]
fn scan_sensitive_index(state: State<'_, AppState>) -> Result<Vec<SensitiveFinding>, String> {
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection.prepare("SELECT index_items.id, index_items.name, index_items.path, index_content_fts.content FROM index_items INNER JOIN index_content_fts ON index_items.id = index_content_fts.item_id LIMIT 10000").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))).map_err(|error| error.to_string())?;
    let patterns = [("key", r"(?i)\b(?:sk|rk|pk)_[a-z0-9_-]{16,}\b"), ("email", r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b"), ("phone", r"\b1[3-9]\d{9}\b"), ("id", r"\b\d{17}[\dXx]\b")];
    let mut findings = Vec::new();
    for row in rows.filter_map(Result::ok) { for (category, pattern) in patterns {
        let count = Regex::new(pattern).map_err(|_| "敏感扫描规则无效。".to_string())?.find_iter(&row.3).count();
        if count > 0 { findings.push(SensitiveFinding { item_id: row.0.clone(), name: row.1.clone(), display_path: display_path(Path::new(&row.2)), category: category.to_string(), match_count: count }); }
    }}
    Ok(findings)
}

#[tauri::command]
fn list_metadata_audit(input: AuditFilterInput, state: State<'_, AppState>) -> Result<Vec<MetadataAuditEntry>, String> {
    let target_type = input.target_type.filter(|value| matches!(value.as_str(), "folder" | "item"));
    let limit = input.limit.unwrap_or(100).clamp(1, 500);
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection.prepare("SELECT id, target_type, target_id, action, old_policy, new_policy, created_at FROM metadata_audit WHERE (?1 IS NULL OR target_type = ?1) ORDER BY rowid DESC LIMIT ?2").map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![target_type, limit], |row| Ok(MetadataAuditEntry { id: row.get(0)?, target_type: row.get(1)?, target_id: row.get(2)?, action: row.get(3)?, old_policy: row.get(4)?, new_policy: row.get(5)?, created_at: row.get(6)? })).map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
fn save_agent_preferences(
    input: AgentPreferences,
    state: State<'_, AppState>,
) -> Result<AgentPreferences, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection
        .execute(
            "UPDATE agent_preferences SET auto_apply_low_risk = ?1 WHERE id = 1",
            params![input.auto_apply_low_risk],
        )
        .map_err(|error| error.to_string())?;
    Ok(input)
}

#[tauri::command]
fn get_agent_preferences(state: State<'_, AppState>) -> Result<AgentPreferences, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let auto_apply_low_risk = connection
        .query_row(
            "SELECT auto_apply_low_risk FROM agent_preferences WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        != 0;
    Ok(AgentPreferences {
        auto_apply_low_risk,
    })
}

fn save_conversation_message(
    input: ConversationMessageInput,
    state: &AppState,
) -> Result<ConversationMessage, String> {
    let role = input.role.trim();
    let source = input.source.trim();
    let content = input.content.trim();
    if !matches!(role, "user" | "assistant" | "system")
        || !matches!(source, "local" | "cloud" | "system")
        || content.is_empty()
        || content.chars().count() > 100_000
    {
        return Err("对话内容或角色无效。".to_string());
    }
    let mut connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let conversation_id = input
        .conversation_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let title = input
        .title
        .unwrap_or_else(|| content.chars().take(40).collect())
        .trim()
        .chars()
        .take(80)
        .collect::<String>();
    transaction.execute("INSERT INTO conversations (id, title, provider_id, created_at, updated_at) VALUES (?1, ?2, ?3, datetime('now'), datetime('now')) ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')", params![conversation_id, if title.is_empty() { "新对话" } else { &title }, input.provider_id]).map_err(|error| error.to_string())?;
    let parsed_reply = (role == "assistant").then(|| parse_ai_reply(content));
    let parsed_json = parsed_reply
        .as_ref()
        .map(|reply| serde_json::to_string(reply))
        .transpose()
        .map_err(|error| error.to_string())?;
    let id = Uuid::new_v4().to_string();
    transaction.execute("INSERT INTO conversation_messages (id, conversation_id, role, source, content, parsed_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))", params![id, conversation_id, role, source, content, parsed_json]).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ConversationMessage {
        id,
        conversation_id,
        role: role.to_string(),
        source: source.to_string(),
        content: content.to_string(),
        parsed_reply,
        created_at: "刚刚".to_string(),
    })
}

#[tauri::command]
fn list_conversations(state: State<'_, AppState>) -> Result<Vec<Conversation>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection.prepare("SELECT id, title, provider_id, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                provider_id: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
fn list_conversation_messages(
    input: ConversationIdInput,
    state: State<'_, AppState>,
) -> Result<Vec<ConversationMessage>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection.prepare("SELECT id, conversation_id, role, source, content, parsed_json, created_at FROM conversation_messages WHERE conversation_id = ?1 ORDER BY created_at ASC, rowid ASC LIMIT 300").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![input.conversation_id], |row| {
            let parsed: Option<String> = row.get(5)?;
            Ok(ConversationMessage {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                source: row.get(3)?,
                content: row.get(4)?,
                parsed_reply: parsed.and_then(|value| serde_json::from_str(&value).ok()),
                created_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
fn delete_conversation(
    input: ConversationIdInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM conversation_messages WHERE conversation_id = ?1",
            params![input.conversation_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![input.conversation_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn is_complex_task(question: &str, result_count: usize, local_model_ready: bool) -> bool {
    let normalized = question.to_ascii_lowercase();
    let signals = [
        "制作",
        "开发",
        "实现",
        "游戏",
        "代码",
        "项目",
        "build",
        "create",
        "implement",
        "refactor",
    ];
    question.chars().count() > 110
        || result_count > 10
        || !local_model_ready
        || signals.iter().any(|signal| normalized.contains(signal))
}

fn safe_run_preview(allowed: usize, restricted: usize, redactions: usize) -> String {
    format!("已准备脱敏云端请求。允许外发资料：{} 项；本地受限资料：{} 项；已脱敏：{} 处。数据库未保存原始问题或请求正文。", allowed, restricted, redactions)
}

fn store_agent_run(run: &AgentRun, state: &AppState) -> Result<(), String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection.execute(
        "INSERT INTO agent_runs (id, route, reason, provider_id, cloud_sent_automatically, source_count, restricted_source_count, redaction_count, status, package_preview, feedback, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'), datetime('now'))",
        params![run.id, run.route, run.reason, run.provider_id, run.cloud_sent_automatically, run.source_count, run.restricted_source_count, run.redaction_count, run.status, run.package_preview, run.feedback],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

// Bind source identities and paths locally only; cloud payloads never receive these bindings.
fn bind_agent_sources(run_id: &str, sources: &[IndexItem], state: &AppState) -> Result<(), String> {
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    for source in sources {
        connection.execute("INSERT INTO agent_source_bindings (id, run_id, source_item_id, source_path, cloud_policy, is_restricted, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))", params![Uuid::new_v4().to_string(), run_id, source.id, source.path, source.cloud_policy.as_database(), source.cloud_policy != CloudPolicy::CloudAllowed]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_agent_evidence_report(input: AgentRunIdInput, state: State<'_, AppState>) -> Result<AgentEvidenceReport, String> {
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let status = connection.query_row("SELECT status FROM agent_runs WHERE id = ?1", params![input.run_id], |row| row.get::<_, String>(0)).map_err(|_| "任务不存在。".to_string())?;
    let restricted_bindings = connection.query_row("SELECT COUNT(*) FROM agent_source_bindings WHERE run_id = ?1 AND is_restricted = 1", params![input.run_id], |row| row.get::<_, usize>(0)).map_err(|error| error.to_string())?;
    let mut statement = connection.prepare("SELECT status, message, created_at FROM agent_events WHERE run_id = ?1 ORDER BY rowid ASC LIMIT 100").map_err(|error| error.to_string())?;
    let evidence = statement.query_map(params![input.run_id], |row| Ok(format!("{} · {} · {}", row.get::<_, String>(2)?, row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|error| error.to_string())?.filter_map(Result::ok).collect();
    Ok(AgentEvidenceReport { run_id: input.run_id, status, final_evidence: evidence, restricted_bindings })
}

fn update_agent_run_status(
    run_id: &str,
    status: &str,
    feedback: &str,
    state: &AppState,
) -> Result<(), String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection.execute("UPDATE agent_runs SET status = ?1, feedback = ?2, updated_at = datetime('now') WHERE id = ?3", params![status, feedback, run_id]).map_err(|error| error.to_string())?;
    connection.execute("INSERT INTO agent_events (id, run_id, status, message, created_at) VALUES (?1, ?2, ?3, ?4, datetime('now'))", params![Uuid::new_v4().to_string(), run_id, status, feedback]).map_err(|error| error.to_string())?;
    Ok(())
}

fn add_agent_event(
    run_id: &str,
    status: &str,
    message: &str,
    state: &AppState,
) -> Result<(), String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection.execute("INSERT INTO agent_events (id, run_id, status, message, created_at) VALUES (?1, ?2, ?3, ?4, datetime('now'))", params![Uuid::new_v4().to_string(), run_id, status, message]).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_agent_events(
    input: AgentRunIdInput,
    state: State<'_, AppState>,
) -> Result<Vec<AgentEvent>, String> {
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection.prepare("SELECT id, run_id, status, message, created_at FROM agent_events WHERE run_id = ?1 ORDER BY rowid ASC LIMIT 100").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![input.run_id], |row| {
            Ok(AgentEvent {
                id: row.get(0)?,
                run_id: row.get(1)?,
                status: row.get(2)?,
                message: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
fn cancel_agent_run(input: AgentRunIdInput, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancelled) = state
        .cancelled_runs
        .lock()
        .map_err(|_| "任务状态被占用。".to_string())?
        .get(&input.run_id)
    {
        cancelled.store(true, Ordering::Release);
    }
    let mut prepared = state
        .prepared_runs
        .lock()
        .map_err(|_| "任务状态被占用。".to_string())?;
    if let Some(run) = prepared.get_mut(&input.run_id) {
        run.run.status = "cancelled".to_string();
        run.run.feedback = "任务已取消；未执行后续云端请求或本地写入。".to_string();
    }
    update_agent_run_status(
        &input.run_id,
        "cancelled",
        "任务已取消；未执行后续云端请求或本地写入。",
        &state,
    )
}

#[tauri::command]
fn approve_agent_step(input: AgentRunIdInput, state: State<'_, AppState>) -> Result<(), String> {
    let mut prepared = state
        .prepared_runs
        .lock()
        .map_err(|_| "任务状态被占用。".to_string())?;
    let run = prepared
        .get_mut(&input.run_id)
        .ok_or_else(|| "任务已失效；请重新发起。".to_string())?;
    if run.run.status != "awaiting_approval" && run.run.status != "awaiting_confirmation" {
        return Err("当前任务没有等待确认的高风险步骤。".to_string());
    }
    run.run.status = "approved".to_string();
    run.run.feedback = "已批准受控工作区写入；仍不会覆盖工作区外文件或执行外部操作。".to_string();
    update_agent_run_status(&input.run_id, "approved", &run.run.feedback, &state)
}

#[tauri::command]
fn retry_agent_run(input: AgentRunIdInput, state: State<'_, AppState>) -> Result<AgentRun, String> {
    let mut prepared = state
        .prepared_runs
        .lock()
        .map_err(|_| "任务状态被占用。".to_string())?;
    let run = prepared
        .get_mut(&input.run_id)
        .ok_or_else(|| "任务已失效；请重新发起。".to_string())?;
    if !matches!(
        run.run.route.as_str(),
        "cloud_auto" | "cloud_needs_confirmation"
    ) {
        return Err("当前任务没有可重试的云端协作步骤。".to_string());
    }
    run.run.advice = None;
    run.run.status = if run.run.route == "cloud_needs_confirmation" {
        "awaiting_confirmation"
    } else {
        "prepared"
    }
    .to_string();
    run.run.feedback = "已重置协作步骤；将重新发送原有的脱敏请求包。".to_string();
    if let Some(diagnostic) = &run.last_diagnostic {
        run.request_body = serde_json::to_string(&serde_json::json!({"task": "根据以下经过脱敏的本地检查摘要，提供最小修复建议。", "diagnostic": diagnostic, "constraints": ["仅返回相对路径代码", "不请求完整日志或私密资料", "不执行外部操作"]})).map_err(|error| error.to_string())?;
    }
    update_agent_run_status(&input.run_id, &run.run.status, &run.run.feedback, &state)?;
    Ok(run.run.clone())
}

#[tauri::command]
async fn auto_repair_agent_run(
    input: AutoRepairAgentInput,
    state: State<'_, AppState>,
) -> Result<WorkspaceActionResult, String> {
    if !ALLOWED_WORKSPACE_CHECKS.contains(&input.command.as_str()) {
        return Err("自动最小修复仅支持固定构建/测试检查。".to_string());
    }
    let prepared = state.prepared_runs.lock().map_err(|_| "任务状态被占用。".to_string())?
        .get(&input.run_id).cloned().ok_or_else(|| "任务已失效；请重新发起。".to_string())?;
    if prepared.run.route != "cloud_auto" || prepared.run.status != "check_failed" {
        return Err("自动最小修复仅适用于已失败的自动云端协作任务。".to_string());
    }
    if prepared.repair_attempts >= MAX_AGENT_REPAIR_ATTEMPTS {
        return Err("已达到自动最小修复次数上限；请人工审阅最终证据报告。".to_string());
    }
    let diagnostic = prepared.last_diagnostic.clone().ok_or_else(|| "未找到经过脱敏的失败摘要，不能请求修复。".to_string())?;
    let config = cloud_config(&state)?.filter(|config| config.configured)
        .ok_or_else(|| "未配置可用的云端提供商或密钥。".to_string())?;
    let api_key = cloud_key_entry(&config.provider_id)?.get_password()
        .map_err(|_| "无法从 Windows 凭据库读取云端密钥。".to_string())?;
    let request_body = serde_json::json!({
        "task": "根据以下经过脱敏的本地检查摘要，提供最小修复建议。",
        "diagnostic": diagnostic,
        "constraints": ["只返回新增相对路径文件", "不得修改或覆盖已有文件", "不得请求受限资料", "不得调用命令、网络或发布"],
    });
    let request_text = serde_json::to_string(&request_body).map_err(|error| error.to_string())?;
    if request_text.len() > MAX_CLOUD_REQUEST_BYTES { return Err("最小修复请求超过安全大小限制。".to_string()); }
    update_agent_run_status(&input.run_id, "repairing_cloud", "正在请求自动最小修复；仅发送脱敏失败摘要。", &state)?;
    let endpoint = chat_endpoint(&config.base_url);
    let response = reqwest::Client::builder().timeout(Duration::from_secs(45)).build()
        .map_err(|_| "无法建立安全云端连接。".to_string())?
        .post(endpoint).bearer_auth(api_key)
        .json(&serde_json::json!({"model": config.model, "messages":[{"role":"system","content":"你是受限修复助手。仅返回 JSON，包含 answer、assumptions、files、steps、uncertainties。files 只能是新建的相对路径；严禁覆盖、删除、命令、联网或敏感资料。"},{"role":"user","content":request_text}]}))
        .send().await.map_err(|_| "云端最小修复请求失败；未记录请求内容。".to_string())?;
    if !response.status().is_success() { update_agent_run_status(&input.run_id, "check_failed", "云端最小修复请求失败；工作区未被改写。", &state)?; return Err("云端服务返回错误；工作区未被改写。".to_string()); }
    let value = response.json::<serde_json::Value>().await.map_err(|_| "云端修复响应格式无效。".to_string())?;
    let raw_advice = value.pointer("/choices/0/message/content").and_then(|value| value.as_str()).unwrap_or("");
    let (safe_advice, _) = redact_sensitive_text(raw_advice);
    {
        let mut runs = state.prepared_runs.lock().map_err(|_| "任务状态被占用。".to_string())?;
        let run = runs.get_mut(&input.run_id).ok_or_else(|| "任务已失效；请重新发起。".to_string())?;
        run.repair_attempts += 1;
        run.run.status = "approved".to_string();
        run.run.advice = Some(safe_advice);
        run.run.feedback = format!("云端最小修复建议已返回，开始第 {} 次受控写入。", run.repair_attempts);
    }
    add_agent_event(&input.run_id, "repair_advice_received", "已收到最小修复建议；仅验证新建相对路径文件。", &state)?;
    let write = apply_agent_advice_inner(WorkspaceAdviceInput { run_id: input.run_id.clone(), workspace_id: input.workspace_id.clone(), allow_existing_edits: false }, false, &state)?;
    let check = run_workspace_check(WorkspaceCheckInput { workspace_id: input.workspace_id, command: input.command, run_id: Some(input.run_id.clone()) }, state.clone())?;
    let status = if check.status == "check_complete" { "repair_complete" } else { "check_failed" };
    update_agent_run_status(&input.run_id, status, if status == "repair_complete" { "自动最小修复已通过固定检查。" } else { "自动最小修复写入后检查仍失败；未继续覆盖或删除任何文件。" }, &state)?;
    Ok(WorkspaceActionResult { status: status.to_string(), written_files: write.written_files, output: format!("{}\n\n修复检查：\n{}", write.output, check.output) })
}

#[tauri::command]
fn prepare_agent_run(
    input: AgentRunRequest,
    state: State<'_, AppState>,
) -> Result<AgentRun, String> {
    let question = input.question.trim();
    if question.is_empty() || question.chars().count() > 2_000 {
        return Err("任务描述不能为空且不能超过 2000 个字符。".to_string());
    }
    let user_message = save_conversation_message(
        ConversationMessageInput {
            conversation_id: input.conversation_id.clone(),
            title: None,
            provider_id: None,
            role: "user".to_string(),
            source: "local".to_string(),
            content: question.to_string(),
        },
        &state,
    )?;
    let scoped = input.scope.unwrap_or_default();
    let mut sources = ask_assistant(question.to_string(), state.clone())?;
    if !scoped.is_empty() {
        sources.retain(|source| scoped.iter().any(|id| id == &source.id));
    }
    let allowed = sources
        .iter()
        .filter(|source| source.cloud_policy == CloudPolicy::CloudAllowed)
        .collect::<Vec<_>>();
    let ask_count = sources
        .iter()
        .filter(|source| source.cloud_policy == CloudPolicy::AskEachTime)
        .count();
    let restricted = sources.len().saturating_sub(allowed.len());
    let (safe_question, question_redactions) = redact_with_custom_rules(question, &state)?;
    // Only prior user requests enter cloud context; local replies may contain restricted paths.
    let (cloud_context, context_redactions) =
        recent_cloud_context(&user_message.conversation_id, &state)?;
    let redactions = question_redactions + context_redactions;
    let mut allowed_sources = Vec::new();
    let mut source_redactions = 0;
    for (index, source) in allowed.iter().take(8).enumerate() {
        let (summary, count) =
            summarize_source_for_cloud(source, &format!("source-{}", index + 1), &state)?;
        source_redactions += count;
        allowed_sources.push(summary);
    }
    let request_payload = serde_json::json!({
        "task": safe_question,
        "priorUserRequests": cloud_context,
        "constraints": ["只返回建议和相对路径", "不请求、上传或推测本地受限资料", "不要执行外部操作"],
        "uploadAllowedSources": allowed_sources,
        "restrictedCapabilities": if restricted > 0 { vec![serde_json::json!({"id":"restricted-local-assets", "description": format!("本地有 {} 项受限资料可由本地 Agent 绑定；不上传原文或标识信息。", restricted), "constraints":["不得要求上传受限资料", "使用本地 asset://restricted/ 接口占位"]})] } else { Vec::new() },
    });
    let serialized = serde_json::to_string(&request_payload).map_err(|error| error.to_string())?;
    if serialized.len() > MAX_CLOUD_REQUEST_BYTES {
        return Err("脱敏后的云端请求包超过安全大小限制。".to_string());
    }
    let provider = cloud_config(&state)?;
    let complex = is_complex_task(
        question,
        sources.len(),
        get_runtime_status(state.clone()).model_installed,
    );
    let (route, reason, status, automatic, provider_id) = if !complex {
        (
            "local",
            "本地检索足以处理当前任务。",
            "local_complete",
            false,
            None,
        )
    } else if ask_count > 0
        || provider
            .as_ref()
            .map(|config| config.review_each_request)
            .unwrap_or(false)
    {
        (
            "cloud_needs_confirmation",
            "包含每次询问资料或全局审阅开关，等待确认。",
            "awaiting_confirmation",
            false,
            provider.as_ref().map(|config| config.provider_id.clone()),
        )
    } else if let Some(config) =
        provider.filter(|config| config.configured && config.auto_collaboration)
    {
        (
            "cloud_auto",
            "复杂任务可由已配置的云端协作补足。",
            "prepared",
            true,
            Some(config.provider_id),
        )
    } else {
        (
            "blocked",
            "复杂任务尚未配置可用的自动云端协作。",
            "local_only",
            false,
            None,
        )
    };
    let redactions = redactions + source_redactions;
    let source_citations = build_source_citations(&sources);
    let run = AgentRun {
        id: Uuid::new_v4().to_string(),
        route: route.into(),
        reason: reason.into(),
        provider_id,
        cloud_sent_automatically: automatic,
        source_count: allowed.len(),
        restricted_source_count: restricted,
        redaction_count: redactions,
        status: status.into(),
        package_preview: safe_run_preview(allowed.len(), restricted, redactions),
        request_preview: serialized.clone(),
        feedback: if route == "local" {
            "已完成本地检索；未向云端发送内容。".into()
        } else {
            "已生成脱敏请求包，尚未执行云端写入或外部操作。".into()
        },
        advice: None,
        cloud_advice: None,
        source_citations,
        conversation_id: Some(user_message.conversation_id.clone()),
    };
    store_agent_run(&run, &state)?;
    bind_agent_sources(&run.id, &sources, &state)?;
    state
        .prepared_runs
        .lock()
        .map_err(|_| "任务状态被占用。".to_string())?
        .insert(
            run.id.clone(),
            PreparedCloudRun {
                run: run.clone(),
                request_body: serialized,
                last_diagnostic: None,
                repair_attempts: 0,
            },
        );
    add_agent_event(&run.id, &run.status, &run.feedback, &state)?;
    // Every task receives a bounded local analysis before any optional cloud step.
    let answer = local_agent_reply(question, &sources, &user_message.conversation_id, &state)?;
    let _ = save_conversation_message(
        ConversationMessageInput {
            conversation_id: Some(user_message.conversation_id),
            title: None,
            provider_id: None,
            role: "assistant".to_string(),
            source: "local".to_string(),
            content: answer,
        },
        &state,
    )?;
    Ok(run)
}

#[tauri::command]
async fn run_cloud_collaboration(
    run_id: String,
    state: State<'_, AppState>,
) -> Result<AgentRun, String> {
    let prepared = state
        .prepared_runs
        .lock()
        .map_err(|_| "任务状态被占用。".to_string())?
        .get(&run_id)
        .cloned()
        .ok_or_else(|| "云端请求已失效；请重新准备任务。".to_string())?;
    if prepared.run.status == "cancelled" {
        return Err("任务已取消，不能发送云端请求。".to_string());
    }
    if prepared.run.route != "cloud_auto" && prepared.run.route != "cloud_needs_confirmation" {
        return Err("当前任务不允许发送云端请求。".to_string());
    }
    let config = cloud_config(&state)?
        .filter(|config| config.configured)
        .ok_or_else(|| "未配置可用的云端提供商或密钥。".to_string())?;
    let api_key = cloud_key_entry(&config.provider_id)?
        .get_password()
        .map_err(|_| "无法从 Windows 凭据库读取云端密钥。".to_string())?;
    let endpoint = chat_endpoint(&config.base_url);
    let body = serde_json::json!({"model": config.model, "messages":[{"role":"system","content":"你是受限协作助手。仅返回一个 JSON 对象，字段为 answer、assumptions、files、steps、uncertainties。files 仅可含 pathHint（相对路径）、content、purpose；默认只新增文件。若确有必要修改已有文件，必须在 purpose 中明确说明修改原因，并在 steps 中使用 write_file 且 risk=requires_confirmation；本地应用会显示二次确认并建立可恢复备份。不要调用工具、不要联网、不要要求敏感资料、不要返回绝对路径或命令。"},{"role":"user","content": prepared.request_body}], "temperature":0.2, "max_tokens":1200});
    let cancel_token = Arc::new(AtomicBool::new(false));
    state
        .cancelled_runs
        .lock()
        .map_err(|_| "任务状态被占用。".to_string())?
        .insert(run_id.clone(), cancel_token.clone());
    update_agent_run_status(
        &run_id,
        "running_cloud",
        "正在发送脱敏云端请求；现在可以取消。",
        &state,
    )?;
    let request = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "无法建立安全云端连接。".to_string())?
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&body)
        .send();
    tokio::pin!(request);
    let mut pulse = tokio::time::interval(Duration::from_millis(150));
    let response = loop {
        tokio::select! {
            _ = pulse.tick() => {
                if cancel_token.load(Ordering::Acquire) {
                    state.cancelled_runs.lock().map_err(|_| "任务状态被占用。".to_string())?.remove(&run_id);
                    return Err("任务已取消；云端请求已中止。".to_string());
                }
            }
            value = &mut request => break value.map_err(|_| "云端请求失败；未记录请求内容。".to_string())?,
        }
    };
    state
        .cancelled_runs
        .lock()
        .map_err(|_| "任务状态被占用。".to_string())?
        .remove(&run_id);
    if !response.status().is_success() {
        return Err("云端服务返回错误；未记录请求内容。".to_string());
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "云端响应格式无效。".to_string())?;
    let answer = value
        .pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .unwrap_or("云端未返回可用建议。");
    let (safe_answer, _) = redact_sensitive_text(answer);
    let cloud_advice = parse_cloud_advice(&safe_answer);
    let mut run = prepared.run;
    run.status = "awaiting_approval".into();
    run.advice = Some(safe_answer.clone());
    run.cloud_advice = Some(cloud_advice);
    run.feedback = format!(
        "云端建议已返回（{} 字）。如需写入受控工作区，请先批准该步骤。",
        safe_answer.chars().count()
    );
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    connection.execute("UPDATE agent_runs SET status = ?1, feedback = ?2, updated_at = datetime('now') WHERE id = ?3", params![run.status, run.feedback, run.id]).map_err(|error| error.to_string())?;
    drop(connection);
    if let Some(conversation_id) = run.conversation_id.clone() {
        save_conversation_message(
            ConversationMessageInput {
                conversation_id: Some(conversation_id),
                title: None,
                provider_id: Some(config.provider_id),
                role: "assistant".to_string(),
                source: "cloud".to_string(),
                content: safe_answer,
            },
            &state,
        )?;
    }
    state
        .prepared_runs
        .lock()
        .map_err(|_| "任务状态被占用。".to_string())?
        .insert(
            run.id.clone(),
            PreparedCloudRun {
                run: run.clone(),
                request_body: prepared.request_body,
                last_diagnostic: prepared.last_diagnostic,
                repair_attempts: prepared.repair_attempts,
            },
        );
    Ok(run)
}

#[tauri::command]
fn ask_assistant(question: String, state: State<'_, AppState>) -> Result<Vec<IndexItem>, String> {
    let terms = model_terms(&question, &state);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let full_text_hits = if terms.is_empty() {
        HashSet::new()
    } else {
        let query = terms
            .iter()
            .map(|term| format!("\"{}\"", term.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" OR ");
        let mut statement = connection
            .prepare(
                "SELECT item_id FROM index_content_fts WHERE index_content_fts MATCH ?1 LIMIT 80",
            )
            .map_err(|error| error.to_string())?;
        let hits = statement
            .query_map(params![query], |row| row.get::<_, String>(0))
            .map_err(|_| "正文索引查询失败；请刷新资料索引。".to_string())?
            .filter_map(Result::ok)
            .collect::<HashSet<_>>();
        hits
    };
    let mut statement = connection
        .prepare(
            "SELECT index_items.id, index_items.item_type, index_items.name, index_items.path, index_items.note, index_items.tags_json, folder_refs.note, folder_refs.tags_json, folder_refs.cloud_policy, index_items.cloud_policy
             FROM index_items INNER JOIN folder_refs ON index_items.folder_id = folder_refs.id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut results = rows
        .filter_map(Result::ok)
        .filter_map(
            |(
                id,
                item_type,
                name,
                path,
                note,
                tags_json,
                folder_note,
                folder_tags_json,
                folder_policy,
                item_policy,
            )| {
                let tags = serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();
                let folder_tags =
                    serde_json::from_str::<Vec<String>>(&folder_tags_json).unwrap_or_default();
                let score = matches_terms(
                    &format!(
                        "{name} {path} {note} {} {folder_note} {}",
                        tags.join(" "),
                        folder_tags.join(" ")
                    ),
                    &terms,
                ) + if full_text_hits.contains(&id) { 3 } else { 0 };
                (score > 0).then_some(IndexItem {
                    id,
                    item_type,
                    name,
                    display_path: display_path(Path::new(&path)),
                    path,
                    note,
                    tags,
                    cloud_policy: effective_cloud_policy(
                        CloudPolicy::from_database(&folder_policy),
                        CloudPolicy::from_database(&item_policy),
                    ),
                    score,
                })
            },
        )
        .collect::<Vec<_>>();
    results.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.name.cmp(&right.name))
    });
    results.truncate(30);
    Ok(results)
}

fn build_source_citations(sources: &[IndexItem]) -> Vec<SourceCitation> {
    sources
        .iter()
        .take(12)
        .map(|source| SourceCitation {
            id: source.id.clone(),
            name: source.name.clone(),
            path: source.path.clone(),
            display_path: source.display_path.clone(),
            reason: if source.score >= 3 {
                "正文或元数据匹配".to_string()
            } else {
                "名称或标签匹配".to_string()
            },
        })
        .collect()
}

fn embedding_fallback_fts(input: SearchDocumentsInput, state: State<'_, AppState>) -> Result<SearchDocumentsResult, String> {
    search_documents(input, state)
}

#[tauri::command]
async fn semantic_search(input: SearchDocumentsInput, state: State<'_, AppState>) -> Result<SearchDocumentsResult, String> {
    let query = input.query.trim();
    if query.is_empty() || query.chars().count() > 500 {
        return Err("搜索内容不能为空且不能超过 500 个字符。".to_string());
    }
    let model = {
        let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
        active_embedding_model(&connection)?
    };
    let Some(model) = model else {
        let mut result = embedding_fallback_fts(input, state)?;
        result.search_mode = "embedding_fallback_fts".to_string();
        return Ok(result);
    };
    let query_vector = embed_text(&state, &model, query).await?;
    let page_size = input.page_size.unwrap_or(30).clamp(1, 100);
    let page = input.page.unwrap_or(0);
    let tag = input.tag.filter(|value| !value.trim().is_empty()).map(|value| value.to_ascii_lowercase());
    let folder_id = input.folder_id.filter(|value| !value.trim().is_empty());
    let item_type = input.item_type.filter(|value| matches!(value.as_str(), "file" | "folder"));
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection.prepare(
        "SELECT index_items.id, index_items.folder_id, index_items.item_type, index_items.name, index_items.path, index_items.note, index_items.tags_json, folder_refs.cloud_policy, index_items.cloud_policy, item_embeddings.vector_json FROM item_embeddings INNER JOIN index_items ON index_items.id = item_embeddings.item_id INNER JOIN folder_refs ON folder_refs.id = index_items.folder_id WHERE item_embeddings.model_id = ?1"
    ).map_err(|error| error.to_string())?;
    let mut ranked = statement.query_map(params![model.id], |row| Ok((
        row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?, row.get::<_, String>(9)?
    ))).map_err(|error| error.to_string())?.filter_map(Result::ok).filter_map(|(id, actual_folder_id, kind, name, path, note, tags_json, folder_policy, item_policy, vector_json)| {
        if folder_id.as_deref().is_some_and(|requested| requested != actual_folder_id) { return None; }
        if item_type.as_deref().is_some_and(|requested| requested != kind) { return None; }
        let tags = serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();
        if tag.as_ref().is_some_and(|requested| !tags.iter().any(|value| value.to_ascii_lowercase() == *requested)) { return None; }
        let vector = serde_json::from_str::<Vec<f32>>(&vector_json).ok()?;
        let similarity = cosine_similarity(&query_vector, &vector)?;
        Some((similarity, IndexItem { id, item_type: kind, name, display_path: display_path(Path::new(&path)), path, note, tags, cloud_policy: effective_cloud_policy(CloudPolicy::from_database(&folder_policy), CloudPolicy::from_database(&item_policy)), score: (similarity.max(0.0) * 1000.0).round() as usize }))
    }).collect::<Vec<_>>();
    ranked.sort_by(|left, right| right.0.total_cmp(&left.0).then_with(|| left.1.name.cmp(&right.1.name)));
    let total = ranked.len();
    let offset = page.saturating_mul(page_size);
    let items = ranked.into_iter().skip(offset).take(page_size).map(|(_, item)| item).collect();
    Ok(SearchDocumentsResult { items, total, page, page_size, search_mode: "semantic".to_string() })
}

#[tauri::command]
fn search_documents(
    input: SearchDocumentsInput,
    state: State<'_, AppState>,
) -> Result<SearchDocumentsResult, String> {
    let query = input.query.trim();
    if query.is_empty() || query.chars().count() > 500 {
        return Err("搜索内容不能为空且不能超过 500 个字符。".to_string());
    }
    let page_size = input.page_size.unwrap_or(30).clamp(1, 100);
    let page = input.page.unwrap_or(0);
    let offset = page.saturating_mul(page_size);
    let terms = extract_search_terms(query);
    if terms.is_empty() {
        return Ok(SearchDocumentsResult {
            items: Vec::new(),
            total: 0,
            page,
            page_size,
            search_mode: "fts".to_string(),
        });
    }
    let pattern = terms
        .iter()
        .map(|term| format!("%{}%", term.replace('%', r"\%").replace('_', r"\_")))
        .collect::<Vec<_>>();
    let mut predicates = Vec::new();
    let mut values = Vec::<Value>::new();
    for term in &pattern {
        predicates.push("(index_items.name LIKE ? ESCAPE '\\' OR index_items.path LIKE ? ESCAPE '\\' OR index_items.note LIKE ? ESCAPE '\\' OR index_items.tags_json LIKE ? ESCAPE '\\' OR folder_refs.note LIKE ? ESCAPE '\\' OR folder_refs.tags_json LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM index_content_fts WHERE index_content_fts.item_id = index_items.id AND index_content_fts.content LIKE ? ESCAPE '\\'))".to_string());
        for _ in 0..7 {
            values.push(Value::Text(term.clone()));
        }
    }
    if let Some(folder_id) = input.folder_id.filter(|value| !value.trim().is_empty()) {
        predicates.push("index_items.folder_id = ?".to_string());
        values.push(Value::Text(folder_id));
    }
    if let Some(item_type) = input
        .item_type
        .filter(|value| matches!(value.as_str(), "file" | "folder"))
    {
        predicates.push("index_items.item_type = ?".to_string());
        values.push(Value::Text(item_type));
    }
    if let Some(tag) = input.tag.filter(|value| !value.trim().is_empty()) {
        predicates.push("(lower(index_items.tags_json) LIKE ? ESCAPE '\\' OR lower(folder_refs.tags_json) LIKE ? ESCAPE '\\')".to_string());
        let tag_pattern = format!(
            "%\"{}\"%",
            tag.trim()
                .to_ascii_lowercase()
                .replace('%', r"\%")
                .replace('_', r"\_")
        );
        values.push(Value::Text(tag_pattern.clone()));
        values.push(Value::Text(tag_pattern));
    }
    let where_clause = predicates.join(" AND ");
    let from_clause =
        " FROM index_items INNER JOIN folder_refs ON index_items.folder_id = folder_refs.id ";
    let connection = state
        .database
        .lock()
        .map_err(|_| "本地数据库被占用。".to_string())?;
    let total_sql = format!("SELECT COUNT(*){from_clause} WHERE {where_clause}");
    let total = connection
        .query_row(&total_sql, params_from_iter(values.iter()), |row| {
            row.get::<_, usize>(0)
        })
        .map_err(|error| format!("搜索计数失败：{error}"))?;
    let mut item_values = values;
    item_values.push(Value::Integer(page_size as i64));
    item_values.push(Value::Integer(offset as i64));
    let item_sql = format!(
        "SELECT index_items.id, index_items.item_type, index_items.name, index_items.path, index_items.note, index_items.tags_json, folder_refs.cloud_policy, index_items.cloud_policy, \
        (CASE WHEN index_items.name LIKE ? ESCAPE '\\' THEN 4 ELSE 0 END + CASE WHEN index_items.note LIKE ? ESCAPE '\\' OR index_items.tags_json LIKE ? ESCAPE '\\' THEN 3 ELSE 0 END + CASE WHEN EXISTS (SELECT 1 FROM index_content_fts WHERE index_content_fts.item_id = index_items.id AND index_content_fts.content LIKE ? ESCAPE '\\') THEN 2 ELSE 0 END) AS score{from_clause} WHERE {where_clause} ORDER BY score DESC, index_items.name COLLATE NOCASE ASC LIMIT ? OFFSET ?"
    );
    // Bind scoring terms separately, then filters and stable SQLite LIMIT ? OFFSET ? pagination.
    let score_pattern = pattern.first().cloned().unwrap_or_default();
    let mut bound = vec![
        Value::Text(score_pattern.clone()),
        Value::Text(score_pattern.clone()),
        Value::Text(score_pattern.clone()),
        Value::Text(score_pattern),
    ];
    bound.extend(item_values);
    let mut statement = connection
        .prepare(&item_sql)
        .map_err(|error| format!("搜索失败：{error}"))?;
    let rows = statement
        .query_map(params_from_iter(bound.iter()), |row| {
            let path: String = row.get(3)?;
            let tags_json: String = row.get(5)?;
            let folder_policy: String = row.get(6)?;
            let item_policy: String = row.get(7)?;
            Ok(IndexItem {
                id: row.get(0)?,
                item_type: row.get(1)?,
                name: row.get(2)?,
                display_path: display_path(Path::new(&path)),
                path,
                note: row.get(4)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                cloud_policy: effective_cloud_policy(
                    CloudPolicy::from_database(&folder_policy),
                    CloudPolicy::from_database(&item_policy),
                ),
                score: row.get(8)?,
            })
        })
        .map_err(|error| format!("读取搜索结果失败：{error}"))?;
    let items = rows.filter_map(Result::ok).collect();
    Ok(SearchDocumentsResult {
        items,
        total,
        page,
        page_size,
        search_mode: "fts".to_string(),
    })
}

#[tauri::command]
fn preview_file(path: String, state: State<'_, AppState>) -> Result<FilePreview, String> {
    let target = indexed_path(Path::new(&path), &state)?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未命名文件")
        .to_string();
    if target.is_dir() {
        return Ok(FilePreview {
            kind: "folder".into(),
            name,
            display_path: display_path(&target),
            path: target.display().to_string(),
            mime_type: String::new(),
            content: String::new(),
            message: "文件夹不能直接预览；可在资源管理器中打开。".into(),
            truncated: false,
        });
    }
    let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "docx" | "pptx" | "xlsx") {
        let content = office_preview_text(&target).unwrap_or_default();
        return Ok(FilePreview {
            kind: "text".into(), name, display_path: display_path(&target), path: target.display().to_string(),
            mime_type: "text/plain".into(), message: if content.is_empty() { "无法从此 Office 文档提取可预览文本；原文件未改动。".into() } else { "只读文本预览，复杂版式、公式和嵌入对象可能不显示。".into() },
            content, truncated: false,
        });
    }
    let Some((kind, mime_type)) = preview_mime(&extension) else {
        return Ok(FilePreview {
            kind: "unsupported".into(),
            name,
            display_path: display_path(&target),
            path: target.display().to_string(),
            mime_type: String::new(),
            content: String::new(),
            message: "此文件格式暂不支持内置预览；可在资源管理器中打开。".into(),
            truncated: false,
        });
    };
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Ok(FilePreview {
            kind: "unsupported".into(),
            name,
            display_path: display_path(&target),
            path: target.display().to_string(),
            mime_type: mime_type.into(),
            content: String::new(),
            message: "文件超过 1 MB，为避免卡顿未加载预览；可在资源管理器中打开。".into(),
            truncated: true,
        });
    }
    let bytes = fs::read(&target).map_err(|error| error.to_string())?;
    let (content, message) = match kind {
        "text" => (String::from_utf8_lossy(&bytes).to_string(), String::new()),
        _ => (BASE64.encode(bytes), String::new()),
    };
    Ok(FilePreview {
        kind: kind.into(),
        name,
        display_path: display_path(&target),
        path: target.display().to_string(),
        mime_type: mime_type.into(),
        content,
        message,
        truncated: false,
    })
}

fn media_task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MediaTask> {
    Ok(MediaTask {
        id: row.get(0)?,
        item_id: row.get(1)?,
        name: row.get(2)?,
        kind: row.get(3)?,
        status: row.get(4)?,
        error: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn emit_media_task(app: &AppHandle, task: &MediaTask) {
    let _ = app.emit("media-task-progress", task);
}

fn media_settings(connection: &Connection) -> Result<MediaSettings, String> {
    connection.query_row(
        "SELECT whisper_model_path, ocr_language FROM media_settings WHERE id = 1",
        [],
        |row| Ok(MediaSettings { whisper_model_path: row.get(0)?, ocr_language: row.get(1)? }),
    ).map_err(|error| error.to_string())
}

fn bounded_command_output(command: &mut Command) -> Result<String, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let started = SystemTime::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let output = child.wait_with_output().map_err(|error| error.to_string())?;
            if !status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).chars().take(2_000).collect::<String>());
            }
            return Ok(String::from_utf8_lossy(&output.stdout).chars().take(MAX_MEDIA_OUTPUT_CHARS).collect());
        }
        if started.elapsed().unwrap_or_default() > MEDIA_TASK_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("本地媒体任务超时，已停止。".to_string());
        }
        thread::sleep(Duration::from_millis(150));
    }
}

fn managed_tool_package(tool: &ManagedTool) -> (&'static str, &'static str) {
    match tool {
        ManagedTool::Tesseract => ("UB-Mannheim.TesseractOCR", "Tesseract OCR"),
        ManagedTool::Ffmpeg => ("Gyan.FFmpeg", "FFmpeg"),
        ManagedTool::Libreoffice => ("TheDocumentFoundation.LibreOffice", "LibreOffice"),
    }
}

#[tauri::command]
fn install_local_tool(input: ManagedToolInput) -> Result<String, String> {
    let (package_id, label) = managed_tool_package(&input.tool);
    if !command_available("winget") {
        return Err("未检测到 Windows 包管理器 winget；请从 Microsoft Store 更新“应用安装程序”后重试。".to_string());
    }
    // Only a fixed package allowlist is passed to winget; user input never reaches a shell.
    let status = Command::new("winget")
        .args([
            "install", "--id", package_id, "--exact", "--silent", "--accept-source-agreements",
            "--accept-package-agreements", "--disable-interactivity",
        ])
        .status()
        .map_err(|_| "无法启动 winget；请确认 Windows 包管理器可用。".to_string())?;
    if !status.success() {
        return Err(format!("{label} 安装未完成；winget 未返回成功状态。"));
    }
    Ok(format!("{label} 已由 winget 安装。首次使用前请重新打开资料终端，以刷新工具检测。"))
}

fn command_output_with_timeout(command: &mut Command, timeout: Duration) -> Result<std::process::Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let started = SystemTime::now();
    loop {
        if child.try_wait().map_err(|error| error.to_string())?.is_some() {
            return child.wait_with_output().map_err(|error| error.to_string());
        }
        if started.elapsed().unwrap_or_default() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("本地 Office 转换超时，已停止。".to_string());
        }
        thread::sleep(Duration::from_millis(150));
    }
}

fn indexed_media_path(connection: &Connection, item_id: &str) -> Result<PathBuf, String> {
    let value = connection.query_row(
        "SELECT path FROM index_items WHERE id = ?1 AND item_type = 'file'",
        params![item_id],
        |row| row.get::<_, String>(0),
    ).map_err(|_| "媒体资料不存在或不是文件。".to_string())?;
    let path = fs::canonicalize(value).map_err(|_| "媒体文件不存在或无法访问。".to_string())?;
    let mut statement = connection.prepare("SELECT root_path FROM folder_refs").map_err(|error| error.to_string())?;
    let permitted = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| path.starts_with(root));
    permitted.then_some(path).ok_or_else(|| "媒体文件不在已接入资料夹内。".to_string())
}

fn run_media_extraction(connection: &Connection, task: &MediaTask, data_dir: &Path) -> Result<(), String> {
    let path = indexed_media_path(connection, &task.item_id)?;
    if fs::metadata(&path).map_err(|error| error.to_string())?.len() > MAX_MEDIA_SOURCE_BYTES {
        return Err("媒体文件超过本地识别安全大小限制。".to_string());
    }
    let signature = source_signature(&path)?;
    let settings = media_settings(connection)?;
    let content = match task.kind.as_str() {
        "ocr" => {
            if !command_available("tesseract") { return Err("未检测到 Tesseract；请安装本地 OCR 和语言包。".to_string()); }
            let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
            if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "bmp" | "tif" | "tiff" | "webp") { return Err("OCR 仅支持本地图片文件。".to_string()); }
            bounded_command_output(Command::new("tesseract").arg(&path).arg("stdout").arg("-l").arg(settings.ocr_language))?
        }
        "transcription" => {
            let whisper = if command_available("whisper-cli") { "whisper-cli" } else if command_available("whisper") { "whisper" } else { return Err("未检测到本地 Whisper CLI。".to_string()); };
            if !command_available("ffmpeg") { return Err("未检测到 FFmpeg，无法安全转换音视频。".to_string()); }
            if settings.whisper_model_path.trim().is_empty() || !Path::new(&settings.whisper_model_path).is_file() { return Err("请先选择本地 Whisper 模型文件。".to_string()); }
            let task_dir = data_dir.join("media-work").join(&task.id);
            fs::create_dir_all(&task_dir).map_err(|error| error.to_string())?;
            let wav = task_dir.join("input.wav");
            let prefix = task_dir.join("transcript");
            let converted = bounded_command_output(Command::new("ffmpeg").arg("-y").arg("-i").arg(&path).arg("-vn").arg("-ac").arg("1").arg("-ar").arg("16000").arg(&wav));
            if let Err(error) = converted { let _ = fs::remove_dir_all(&task_dir); return Err(error); }
            let result = bounded_command_output(Command::new(whisper).arg("-m").arg(settings.whisper_model_path).arg("-f").arg(&wav).arg("-otxt").arg("-of").arg(&prefix));
            let transcript = fs::read_to_string(prefix.with_extension("txt")).map_err(|_| result.err().unwrap_or_else(|| "Whisper 未生成可读取文本。".to_string()));
            let _ = fs::remove_dir_all(&task_dir);
            transcript?
        }
        _ => return Err("不支持的媒体任务类型。".to_string()),
    };
    let content = content.chars().take(MAX_MEDIA_OUTPUT_CHARS).collect::<String>();
    if content.trim().is_empty() { return Err("本地工具未识别出可索引文本。".to_string()); }
    connection.execute(
        "INSERT OR REPLACE INTO media_extractions (item_id, kind, source_signature, content, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        params![task.item_id, task.kind, signature, content],
    ).map_err(|error| error.to_string())?;
    index_content(connection, &task.item_id, &path)
}

fn start_media_worker(app: AppHandle, data_dir: PathBuf) {
    thread::spawn(move || loop {
        let Ok(connection) = open_app_database(&data_dir) else { thread::sleep(Duration::from_secs(2)); continue; };
        let task = connection.query_row(
            "SELECT media_tasks.id, media_tasks.item_id, index_items.name, media_tasks.kind, media_tasks.status, media_tasks.error, media_tasks.created_at, media_tasks.updated_at FROM media_tasks INNER JOIN index_items ON index_items.id = media_tasks.item_id WHERE media_tasks.status = 'queued' ORDER BY media_tasks.created_at ASC LIMIT 1",
            [], media_task_from_row,
        ).optional().ok().flatten();
        let Some(task) = task else { thread::sleep(Duration::from_millis(500)); continue; };
        let _ = connection.execute("UPDATE media_tasks SET status = 'running', error = NULL, updated_at = datetime('now') WHERE id = ?1 AND status = 'queued'", params![task.id]);
        let running = MediaTask { status: "running".to_string(), error: None, ..task.clone() };
        emit_media_task(&app, &running);
        let outcome = run_media_extraction(&connection, &running, &data_dir);
        let (status, error) = match outcome { Ok(()) => ("completed", None), Err(error) => ("failed", Some(error)) };
        let _ = connection.execute("UPDATE media_tasks SET status = ?1, error = ?2, updated_at = datetime('now') WHERE id = ?3 AND status = 'running'", params![status, error, task.id]);
        let finished = MediaTask { status: status.to_string(), error, ..task };
        emit_media_task(&app, &finished);
    });
}

#[tauri::command]
fn convert_office_preview(path: String, state: State<'_, AppState>) -> Result<FilePreview, String> {
    let target = indexed_path(Path::new(&path), &state)?;
    let extension = target.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !matches!(extension.as_str(), "doc" | "docx" | "ppt" | "pptx" | "xls" | "xlsx" | "odt" | "odp" | "ods") {
        return Err("高保真预览仅支持 Office 文档。".to_string());
    }
    if !command_available("soffice") { return Err("未检测到 LibreOffice；请安装后再使用高保真预览。".to_string()); }
    let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_OFFICE_PREVIEW_SOURCE_BYTES { return Err("Office 文件超过隔离预览安全大小限制。".to_string()); }
    let signature = source_signature(&target)?;
    let cache_dir = state.data_dir.join("office-preview-cache").join(signature);
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let pdf = cache_dir.join(format!("{}.pdf", target.file_stem().and_then(|value| value.to_str()).unwrap_or("preview")));
    if !pdf.is_file() {
        let profile_dir = cache_dir.join("profile");
        fs::create_dir_all(&profile_dir).map_err(|error| error.to_string())?;
        let profile_url = url::Url::from_directory_path(&profile_dir).map_err(|_| "无法创建 LibreOffice 隔离配置目录。".to_string())?;
        let output = command_output_with_timeout(
            Command::new("soffice")
                .arg("--headless")
                .arg("--nologo")
                .arg("--nodefault")
                .arg(format!("-env:UserInstallation={profile_url}"))
                .arg("--convert-to")
                .arg("pdf")
                .arg("--outdir")
                .arg(&cache_dir)
                .arg(&target),
            OFFICE_PREVIEW_TIMEOUT,
        )?;
        if !output.status.success() || !pdf.is_file() {
            return Err(format!("LibreOffice 转换失败：{}", String::from_utf8_lossy(&output.stderr).chars().take(2_000).collect::<String>()));
        }
    }
    let bytes = fs::read(&pdf).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_PREVIEW_BYTES * 20 { return Err("转换后的 PDF 过大；请在资源管理器中打开原文件。".to_string()); }
    Ok(FilePreview {
        kind: "pdf".to_string(),
        name: target.file_name().and_then(|value| value.to_str()).unwrap_or("Office 文档").to_string(),
        path: target.display().to_string(),
        mime_type: "application/pdf".to_string(),
        content: BASE64.encode(bytes),
        message: "由本机 LibreOffice 在隔离缓存目录转换；原始文档未被改写。嵌入对象、宏和部分公式可能仍与原应用显示不同。".to_string(),
        truncated: false,
        display_path: display_path(&target),
    })
}

#[tauri::command]
fn get_thumbnail(input: ThumbnailInput, state: State<'_, AppState>) -> Result<Thumbnail, String> {
    if input.item_id.trim().is_empty() {
        return Err("缩略图缺少资料项标识。".to_string());
    }
    let target = indexed_path(Path::new(&input.path), &state)?;
    let signature = source_signature(&target)?;
    let existing = {
        let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
        connection
            .query_row(
                "SELECT cache_path, mime_type FROM thumbnail_cache WHERE item_id = ?1 AND source_signature = ?2",
                params![input.item_id, signature],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
    };
    if let Some((cache_path, mime_type)) = existing {
        if let Ok(bytes) = fs::read(&cache_path) {
            return Ok(Thumbnail { item_id: input.item_id, source_signature: signature, mime_type, content: BASE64.encode(bytes), cached: true });
        }
    }
    let cache_dir = thumbnail_cache_dir(&state.data_dir)?;
    let extension = target.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let (mime_type, bytes) = if extension == "pdf" { pdf_thumbnail_bytes(&target, &cache_dir)? } else { image_thumbnail_bytes(&target)? };
    let cache_path = cache_dir.join(format!("{}-{}.png", input.item_id, signature));
    fs::write(&cache_path, &bytes).map_err(|error| error.to_string())?;
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    connection.execute(
        "DELETE FROM thumbnail_cache WHERE item_id = ?1 AND source_signature != ?2",
        params![input.item_id, signature],
    ).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT OR REPLACE INTO thumbnail_cache (item_id, source_signature, cache_path, mime_type, created_at) VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        params![input.item_id, signature, cache_path.display().to_string(), mime_type],
    ).map_err(|error| error.to_string())?;
    Ok(Thumbnail { item_id: input.item_id, source_signature: signature, mime_type: mime_type.into(), content: BASE64.encode(bytes), cached: false })
}

#[tauri::command]
fn clear_thumbnail_cache(state: State<'_, AppState>) -> Result<ThumbnailCacheClearResult, String> {
    let entries = {
        let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
        let cache_paths = {
            let mut statement = connection.prepare("SELECT cache_path FROM thumbnail_cache").map_err(|error| error.to_string())?;
            let paths = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .filter_map(Result::ok)
                .collect::<Vec<_>>();
            paths
        };
        connection.execute("DELETE FROM thumbnail_cache", []).map_err(|error| error.to_string())?;
        cache_paths
    };
    let mut removed = 0;
    for path in entries {
        if fs::remove_file(path).is_ok() { removed += 1; }
    }
    Ok(ThumbnailCacheClearResult { removed })
}

#[tauri::command]
fn list_media_tasks(state: State<'_, AppState>) -> Result<Vec<MediaTask>, String> {
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let mut statement = connection.prepare(
        "SELECT media_tasks.id, media_tasks.item_id, index_items.name, media_tasks.kind, media_tasks.status, media_tasks.error, media_tasks.created_at, media_tasks.updated_at FROM media_tasks INNER JOIN index_items ON index_items.id = media_tasks.item_id ORDER BY media_tasks.created_at DESC LIMIT 100"
    ).map_err(|error| error.to_string())?;
    let tasks = statement
        .query_map([], media_task_from_row)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    Ok(tasks)
}

#[tauri::command]
fn enqueue_media_task(input: MediaTaskInput, state: State<'_, AppState>) -> Result<MediaTask, String> {
    if !matches!(input.kind.as_str(), "ocr" | "transcription") { return Err("不支持的媒体任务类型。".to_string()); }
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let path = indexed_media_path(&connection, &input.item_id)?;
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if input.kind == "ocr" && !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "bmp" | "tif" | "tiff" | "webp") { return Err("OCR 只能加入图片文件。".to_string()); }
    if input.kind == "transcription" && !matches!(extension.as_str(), "wav" | "mp3" | "m4a" | "flac" | "ogg" | "mp4" | "mkv" | "mov" | "webm" | "avi") { return Err("转写只能加入音频或视频文件。".to_string()); }
    if let Some(task) = connection.query_row(
        "SELECT media_tasks.id, media_tasks.item_id, index_items.name, media_tasks.kind, media_tasks.status, media_tasks.error, media_tasks.created_at, media_tasks.updated_at FROM media_tasks INNER JOIN index_items ON index_items.id = media_tasks.item_id WHERE media_tasks.item_id = ?1 AND media_tasks.kind = ?2 AND media_tasks.status IN ('queued', 'running') ORDER BY media_tasks.created_at DESC LIMIT 1",
        params![input.item_id, input.kind], media_task_from_row,
    ).optional().map_err(|error| error.to_string())? { return Ok(task); }
    let id = Uuid::new_v4().to_string();
    connection.execute("INSERT INTO media_tasks (id, item_id, kind, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'queued', datetime('now'), datetime('now'))", params![id, input.item_id, input.kind]).map_err(|error| error.to_string())?;
    connection.query_row(
        "SELECT media_tasks.id, media_tasks.item_id, index_items.name, media_tasks.kind, media_tasks.status, media_tasks.error, media_tasks.created_at, media_tasks.updated_at FROM media_tasks INNER JOIN index_items ON index_items.id = media_tasks.item_id WHERE media_tasks.id = ?1",
        params![id], media_task_from_row,
    ).map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_media_task(input: MediaTaskIdInput, state: State<'_, AppState>) -> Result<(), String> {
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    let changed = connection.execute("UPDATE media_tasks SET status = 'cancelled', error = '用户取消', updated_at = datetime('now') WHERE id = ?1 AND status IN ('queued', 'running')", params![input.id]).map_err(|error| error.to_string())?;
    if changed == 0 { return Err("媒体任务无法取消或已完成。".to_string()); }
    Ok(())
}

#[tauri::command]
fn get_media_settings(state: State<'_, AppState>) -> Result<MediaSettings, String> {
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    media_settings(&connection)
}

#[tauri::command]
fn save_media_settings(input: MediaSettings, state: State<'_, AppState>) -> Result<MediaSettings, String> {
    if input.ocr_language.trim().is_empty() || input.ocr_language.len() > 80 || input.whisper_model_path.len() > 1_024 { return Err("媒体工具设置无效。".to_string()); }
    if !input.whisper_model_path.trim().is_empty() && !Path::new(&input.whisper_model_path).is_file() { return Err("Whisper 模型文件不存在。".to_string()); }
    let connection = state.database.lock().map_err(|_| "本地数据库被占用。".to_string())?;
    connection.execute("UPDATE media_settings SET whisper_model_path = ?1, ocr_language = ?2 WHERE id = 1", params![input.whisper_model_path, input.ocr_language]).map_err(|error| error.to_string())?;
    Ok(input)
}

#[tauri::command]
fn reveal_in_explorer(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let target = indexed_path(Path::new(&path), &state)?;
    let mut command = Command::new("explorer.exe");
    if target.is_file() {
        command.arg("/select,").arg(&target);
    } else {
        command.arg(&target);
    }
    command
        .spawn()
        .map_err(|error| format!("无法打开资源管理器：{error}"))?;
    Ok(())
}

fn main() {
    let data_dir = app_data_dir().expect("unable to locate app data directory");
    fs::create_dir_all(&data_dir).expect("unable to create app data directory");
    apply_pending_restore(&data_dir).expect("unable to apply pending restore");
    let (connection, startup_recovery_notice) = open_app_database_with_recovery(&data_dir)
        .expect("unable to open encrypted database");
    initialize_database(&connection).expect("unable to initialize database");
    let startup_recovery_notice = restore_quarantined_databases(&connection, &data_dir)
        .or(startup_recovery_notice);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            database: Mutex::new(connection),
            data_dir,
            startup_recovery_notice,
            prepared_runs: Mutex::new(HashMap::new()),
            cancelled_runs: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            start_folder_change_watch(app.handle().clone(), app_data_dir()?);
            start_index_worker(app.handle().clone(), app_data_dir()?);
            start_media_worker(app.handle().clone(), app_data_dir()?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_status,
            get_runtime_settings,
            save_runtime_settings,
            run_environment_acceptance,
            download_model,
            download_runtime,
            list_local_models,
            register_local_model,
            select_local_model,
            delete_local_model,
            list_embedding_models,
            register_embedding_model,
            build_embedding_index,
            import_folder,
            import_files_to_library,
            refresh_folder_index,
            enqueue_index_job,
            list_index_jobs,
            pause_index_job,
            resume_index_job,
            remove_folder_reference,
            folder_reference_status,
            list_folder_refs,
            list_folder_children,
            update_metadata,
            get_cloud_provider_config,
            list_cloud_providers,
            save_cloud_provider_config,
            select_cloud_provider,
            fetch_cloud_models,
            delete_cloud_provider,
            list_conversations,
            list_conversation_messages,
            delete_conversation,
            list_sensitive_rules,
            save_sensitive_rule,
            delete_sensitive_rule,
            export_local_governance,
            clear_local_data,
            get_privacy_status,
            get_startup_recovery_notice,
            get_local_tool_status,
            install_local_tool,
            create_encrypted_backup,
            stage_encrypted_restore,
            scan_sensitive_index,
            list_metadata_audit,
            get_agent_preferences,
            save_agent_preferences,
            prepare_agent_run,
            run_cloud_collaboration,
            cancel_agent_run,
            approve_agent_step,
            retry_agent_run,
            auto_repair_agent_run,
            list_agent_events,
            get_agent_evidence_report,
            prepare_ai_output,
            write_ai_file,
            apply_agent_advice,
            auto_apply_low_risk_agent_advice,
            run_workspace_check,
            ask_assistant,
            search_documents,
            semantic_search,
            preview_file,
            convert_office_preview,
            get_thumbnail,
            clear_thumbnail_cache,
            list_media_tasks,
            enqueue_media_task,
            cancel_media_task,
            get_media_settings,
            save_media_settings,
            reveal_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("error while running 资料终端");
}

#[cfg(test)]
mod preview_tests {
    use super::{
        cosine_similarity, display_path, effective_cloud_policy, incremental_index_folder_inner,
        initialize_database, migrate_plaintext_database, open_encrypted_database, preview_mime,
        read_database_key_backup, restore_quarantined_database, save_database_key_backup,
        safe_relative_path, unique_library_file_path, CloudPolicy,
    };
    use rusqlite::{params, Connection};
    use std::{fs, path::Path, time::Instant};
    use tempfile::tempdir;

    #[test]
    fn classifies_supported_preview_extensions() {
        assert_eq!(preview_mime("png"), Some(("image", "image/png")));
        assert_eq!(preview_mime("md"), Some(("text", "text/plain")));
        assert_eq!(preview_mime("pdf"), Some(("pdf", "application/pdf")));
        assert_eq!(preview_mime("docx"), None);
    }

    #[test]
    fn hides_windows_extended_path_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\D:\资料\模型")),
            r"D:\资料\模型"
        );
    }

    #[test]
    fn cloud_policy_keeps_the_most_restrictive_value() {
        assert_eq!(
            effective_cloud_policy(CloudPolicy::LocalOnly, CloudPolicy::CloudAllowed),
            CloudPolicy::LocalOnly
        );
        assert_eq!(
            effective_cloud_policy(CloudPolicy::CloudAllowed, CloudPolicy::AskEachTime),
            CloudPolicy::AskEachTime
        );
    }

    #[test]
    fn cosine_similarity_orders_local_embedding_vectors_and_rejects_bad_dimensions() {
        let query = [1.0, 0.0, 0.0];
        let close = cosine_similarity(&query, &[0.9, 0.1, 0.0]).unwrap();
        let distant = cosine_similarity(&query, &[0.0, 1.0, 0.0]).unwrap();
        assert!(close > distant);
        assert!(cosine_similarity(&query, &[1.0, 0.0]).is_none());
    }

    #[test]
    fn chooses_cpu_runtime_when_gpu_is_not_explicitly_available() {
        let settings = super::RuntimeSettings { execution_mode: "cpu".into(), threads: 4, context_size: 4096 };
        let runtime = super::runtime_variant_for_settings(&settings).unwrap();
        assert!(!runtime.gpu);
        assert_eq!(runtime.executable, "llama-cli.exe");
    }

    #[test]
    fn migrates_plaintext_sqlite_to_a_keyed_sqlcipher_database() {
        let temp = tempdir().unwrap();
        let database = temp.path().join("migration.db");
        let plain = Connection::open(&database).unwrap();
        plain.execute_batch("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('kept');").unwrap();
        drop(plain);
        let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        migrate_plaintext_database(&database, key).unwrap();
        let encrypted = open_encrypted_database(&database, key).unwrap();
        assert_eq!(encrypted.query_row("SELECT value FROM proof", [], |row| row.get::<_, String>(0)).unwrap(), "kept");
        assert!(!fs::read(&database).unwrap().starts_with(b"SQLite format 3\0"));
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_database_key_copy_round_trips_in_the_same_windows_account() {
        let temp = tempdir().unwrap();
        let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        save_database_key_backup(temp.path(), key).unwrap();
        assert_eq!(read_database_key_backup(temp.path()).unwrap(), key);
    }

    #[test]
    fn restores_readable_quarantined_records_without_overwriting_newer_records() {
        let temp = tempdir().unwrap();
        let recovery = temp.path().join("unreadable-fixture");
        fs::create_dir_all(&recovery).unwrap();
        let source_path = recovery.join("file-terminal.db");
        let target_path = temp.path().join("current.db");
        let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        let source = open_encrypted_database(&source_path, key).unwrap();
        initialize_database(&source).unwrap();
        source.execute(
            "INSERT INTO folder_refs (id, root_path, name, note, tags_json, cloud_policy, imported_at) VALUES ('old', 'C:/old', '旧资料', '来自旧库', '[]', 'local_only', '2026-01-01')",
            [],
        ).unwrap();
        source.execute("UPDATE runtime_settings SET execution_mode = 'cpu', threads = 7, context_size = 8192 WHERE id = 1", []).unwrap();
        drop(source);

        let target = open_encrypted_database(&target_path, key).unwrap();
        initialize_database(&target).unwrap();
        target.execute(
            "INSERT INTO folder_refs (id, root_path, name, note, tags_json, cloud_policy, imported_at) VALUES ('new', 'C:/new', '新资料', '', '[]', 'local_only', '2026-01-02')",
            [],
        ).unwrap();

        assert!(restore_quarantined_database(&target, &recovery, key).unwrap() >= 1);
        assert_eq!(target.query_row("SELECT COUNT(*) FROM folder_refs", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
        assert_eq!(target.query_row("SELECT note FROM folder_refs WHERE id = 'old'", [], |row| row.get::<_, String>(0)).unwrap(), "来自旧库");
        assert_eq!(target.query_row("SELECT threads FROM runtime_settings WHERE id = 1", [], |row| row.get::<_, i64>(0)).unwrap(), 7);
        assert!(source_path.is_file());
    }

    #[test]
    fn managed_file_upload_uses_a_distinct_name_without_replacing_an_existing_copy() {
        let temp = tempdir().unwrap();
        let library = temp.path().join("uploaded-files");
        fs::create_dir_all(&library).unwrap();
        fs::write(library.join("notes.txt"), "first copy").unwrap();

        let target = unique_library_file_path(&library, std::ffi::OsStr::new("notes.txt"));

        assert_eq!(target.file_name().unwrap(), "notes (2).txt");
        assert_eq!(fs::read_to_string(library.join("notes.txt")).unwrap(), "first copy");
    }

    #[test]
    fn indexing_handles_renames_deletes_and_unavailable_roots() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("source");
        fs::create_dir_all(&root).unwrap();
        let original = root.join("original.txt");
        fs::write(&original, "stable").unwrap();
        assert!(super::source_content_hash(&original).is_some());
        let renamed = root.join("renamed.txt");
        fs::rename(&original, &renamed).unwrap();
        assert_eq!(super::source_content_hash(&renamed).unwrap().len(), 64);
        fs::remove_file(renamed).unwrap();
        assert!(super::source_content_hash(&root.join("missing.txt")).is_none());
    }

    #[test]
    fn ai_write_paths_stay_relative_to_the_workspace() {
        assert_eq!(
            safe_relative_path("src/main.ts").unwrap(),
            Path::new("src/main.ts")
        );
        assert!(safe_relative_path("../outside.txt").is_err());
        assert!(safe_relative_path(r"C:\\outside.txt").is_err());
    }

    #[test]
    fn incremental_indexing_pauses_and_resumes_without_reextracting_unchanged_files() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("fixture");
        fs::create_dir_all(&root).unwrap();
        for index in 0..100 {
            fs::write(root.join(format!("item-{index}.txt")), "stable content").unwrap();
        }
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let folder_id = "pause-folder";
        let job_id = "pause-job";
        connection.execute(
            "INSERT INTO folder_refs (id, root_path, name, note, tags_json, cloud_policy, imported_at) VALUES (?1, ?2, 'fixture', '', '[]', 'local_only', datetime('now'))",
            params![folder_id, root.display().to_string()],
        ).unwrap();
        connection.execute(
            "INSERT INTO index_jobs (id, folder_id, status, completed, total, changed, created_at, updated_at) VALUES (?1, ?2, 'queued', 0, 0, 0, datetime('now'), datetime('now'))",
            params![job_id, folder_id],
        ).unwrap();

        let mut paused = false;
        let changed = incremental_index_folder_inner(&connection, job_id, folder_id, |job| {
            if !paused && job.completed >= 25 {
                connection.execute("UPDATE index_jobs SET status = 'paused' WHERE id = ?1", params![job_id]).unwrap();
                paused = true;
            }
        }).unwrap();
        assert!(paused);
        assert!(changed >= 25 && changed < 101);
        assert_eq!(connection.query_row("SELECT status FROM index_jobs WHERE id = ?1", params![job_id], |row| row.get::<_, String>(0)).unwrap(), "paused");

        connection.execute("UPDATE index_jobs SET status = 'queued' WHERE id = ?1", params![job_id]).unwrap();
        let resumed_changed = incremental_index_folder_inner(&connection, job_id, folder_id, |_| {}).unwrap();
        assert_eq!(resumed_changed, 101 - changed);
        assert_eq!(connection.query_row("SELECT status FROM index_jobs WHERE id = ?1", params![job_id], |row| row.get::<_, String>(0)).unwrap(), "completed");
    }

    #[test]
    fn benchmarks_incremental_indexing_for_ten_thousand_files() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("benchmark");
        fs::create_dir_all(&root).unwrap();
        for index in 0..10_000 {
            fs::write(root.join(format!("item-{index:05}.txt")), "benchmark content").unwrap();
        }
        let connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let folder_id = "benchmark-folder";
        let job_id = "benchmark-job";
        connection.execute(
            "INSERT INTO folder_refs (id, root_path, name, note, tags_json, cloud_policy, imported_at) VALUES (?1, ?2, 'benchmark', '', '[]', 'local_only', datetime('now'))",
            params![folder_id, root.display().to_string()],
        ).unwrap();
        connection.execute(
            "INSERT INTO index_jobs (id, folder_id, status, completed, total, changed, created_at, updated_at) VALUES (?1, ?2, 'queued', 0, 0, 0, datetime('now'), datetime('now'))",
            params![job_id, folder_id],
        ).unwrap();

        let first_start = Instant::now();
        assert_eq!(incremental_index_folder_inner(&connection, job_id, folder_id, |_| {}).unwrap(), 10_001);
        let first = first_start.elapsed();
        connection.execute("UPDATE index_jobs SET status = 'queued' WHERE id = ?1", params![job_id]).unwrap();
        let unchanged_start = Instant::now();
        assert_eq!(incremental_index_folder_inner(&connection, job_id, folder_id, |_| {}).unwrap(), 0);
        let unchanged = unchanged_start.elapsed();
        fs::write(root.join("item-05000.txt"), "changed benchmark content").unwrap();
        connection.execute("UPDATE index_jobs SET status = 'queued' WHERE id = ?1", params![job_id]).unwrap();
        let changed_start = Instant::now();
        assert_eq!(incremental_index_folder_inner(&connection, job_id, folder_id, |_| {}).unwrap(), 1);
        let one_changed = changed_start.elapsed();
        eprintln!("10k incremental benchmark: first={first:?}, unchanged={unchanged:?}, one_changed={one_changed:?}");
        // A deliberately broad ceiling catches accidental quadratic work without assuming a specific disk speed.
        assert!(first.as_secs() < 120 && unchanged.as_secs() < 120 && one_changed.as_secs() < 120);
    }
}
