#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use file_terminal_desktop::assistant::{extract_search_terms, matches_terms, parse_model_terms};
use futures_util::StreamExt;
use keyring::Entry;
use regex::Regex;
use rusqlite::{params, params_from_iter, types::Value, Connection};
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
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use walkdir::WalkDir;

const APP_FOLDER: &str = "资料终端";
const RUNTIME_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-win-cpu-x64.zip";
const MODEL_URLS: &[(&str, &str)] = &[
    ("官方 Hugging Face", "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"),
    ("HF 镜像", "https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"),
];
const MODEL_SHA256: &str = "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e";
const MODEL_FILE: &str = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
const MAX_PREVIEW_BYTES: u64 = 1_048_576;
const MAX_CLOUD_REQUEST_BYTES: usize = 48 * 1024;
const CLOUD_KEYRING_SERVICE: &str = "file-terminal-desktop.cloud-provider";
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
struct PrivacyStatus {
    database_encrypted: bool,
    message: String,
    recommendation: String,
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
                FOREIGN KEY(folder_id) REFERENCES folder_refs(id)
            );
            CREATE INDEX IF NOT EXISTS index_items_folder_idx ON index_items(folder_id);
            CREATE VIRTUAL TABLE IF NOT EXISTS index_content_fts USING fts5(item_id UNINDEXED, content);
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
            ",
        )
        .map_err(|error| error.to_string())?;
    ensure_column(
        connection,
        "folder_refs",
        "cloud_policy",
        "TEXT NOT NULL DEFAULT 'local_only'",
    )?;
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

fn safe_file_name(url: &str, default_name: &str) -> String {
    url.rsplit('/')
        .next()
        .filter(|name| !name.is_empty() && !name.contains('?'))
        .unwrap_or(default_name)
        .to_string()
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

fn index_content(connection: &Connection, item_id: &str, path: &Path) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM index_content_fts WHERE item_id = ?1",
            params![item_id],
        )
        .map_err(|error| error.to_string())?;
    if let Some(content) = text_content_for_index(path) {
        connection
            .execute(
                "INSERT INTO index_content_fts (item_id, content) VALUES (?1, ?2)",
                params![item_id, content],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
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
    let output = Command::new(runtime)
        .arg("-m")
        .arg(model)
        .arg("-p")
        .arg(prompt)
        .arg("-n")
        .arg("48")
        .arg("--temp")
        .arg("0")
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
    let mut child = match Command::new(runtime)
        .arg("-m")
        .arg(model)
        .arg("-p")
        .arg(prompt)
        .arg("-n")
        .arg("360")
        .arg("--temp")
        .arg("0.2")
        .arg("--no-display-prompt")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
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
async fn download_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeStatus, String> {
    let runtime_dir = state.data_dir.join("runtime");
    fs::create_dir_all(&runtime_dir).map_err(|error| error.to_string())?;
    let archive = state
        .data_dir
        .join(safe_file_name(RUNTIME_URL, "llama-runtime.zip"));
    download_to(
        app.clone(),
        "runtime",
        "GitHub",
        RUNTIME_URL,
        &archive,
        None,
    )
    .await?;
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
fn refresh_folder_index(
    input: FolderIdInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let folder = {
        let connection = state
            .database
            .lock()
            .map_err(|_| "本地数据库被占用。".to_string())?;
        connection
            .query_row(
                "SELECT root_path, note, tags_json FROM folder_refs WHERE id = ?1",
                params![input.folder_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(|_| "接入文件夹不存在。".to_string())?
    };
    let tags = serde_json::from_str::<Vec<String>>(&folder.2).unwrap_or_default();
    import_folder(
        FolderImport {
            path: folder.0,
            note: folder.1,
            tags,
        },
        app,
        state,
    )
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
        if target.exists() {
            return Err(format!("拒绝覆盖已有工作区文件：{}", display_path(&target)));
        }
        let parent = target
            .parent()
            .ok_or_else(|| "AI 写入路径无效。".to_string())?
            .to_path_buf();
        targets.push((file, target, parent));
    }
    let mut written = Vec::new();
    for (file, target, parent) in targets {
        fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
        let parent = fs::canonicalize(&parent).map_err(|error| error.to_string())?;
        if !parent.starts_with(&root) {
            return Err("AI 写入被阻止：路径超出工作区。".to_string());
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|_| format!("拒绝覆盖已有工作区文件：{}", display_path(&target)))?;
        output
            .write_all(file.content.as_bytes())
            .map_err(|error| error.to_string())?;
        written.push(display_path(&target));
    }
    let feedback = if allow_low_risk_auto_apply {
        "已按用户开启的低风险自动执行设置写入受控工作区；未覆盖已有文件、未执行网络或命令。"
    } else {
        "已将经过路径校验的建议写入受控工作区；未覆盖已有文件。"
    };
    update_agent_run_status(&input.run_id, "files_written", feedback, state)?;
    Ok(WorkspaceActionResult {
        status: "files_written".to_string(),
        written_files: written,
        output: "代码已写入；请主动选择只读构建或测试检查。".to_string(),
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
            }
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
fn get_privacy_status() -> PrivacyStatus {
    // 磁盘加密 remains the at-rest protection boundary until an application-level encryption design is approved.
    PrivacyStatus {
        database_encrypted: false,
        message: "资料终端不会在 SQLite 中保存云端 API Key；索引和对话数据库尚未应用级加密。"
            .to_string(),
        recommendation: "请启用 Windows 设备加密或 BitLocker 保护本机磁盘。".to_string(),
    }
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
    let body = serde_json::json!({"model": config.model, "messages":[{"role":"system","content":"你是受限协作助手。仅返回一个 JSON 对象，字段为 answer、assumptions、files、steps、uncertainties。files 仅可含 pathHint（相对路径）、content、purpose；steps 仅可申请 create_file 或 write_file，risk 只能为 low 或 requires_confirmation。不要调用工具、不要联网、不要要求敏感资料、不要返回绝对路径或命令。"},{"role":"user","content": prepared.request_body}], "temperature":0.2, "max_tokens":1200});
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
    let connection =
        Connection::open(data_dir.join("file-terminal.db")).expect("unable to open database");
    initialize_database(&connection).expect("unable to initialize database");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            database: Mutex::new(connection),
            data_dir,
            prepared_runs: Mutex::new(HashMap::new()),
            cancelled_runs: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_status,
            download_model,
            download_runtime,
            list_local_models,
            register_local_model,
            select_local_model,
            delete_local_model,
            import_folder,
            refresh_folder_index,
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
            get_agent_preferences,
            save_agent_preferences,
            prepare_agent_run,
            run_cloud_collaboration,
            cancel_agent_run,
            approve_agent_step,
            retry_agent_run,
            list_agent_events,
            prepare_ai_output,
            write_ai_file,
            apply_agent_advice,
            auto_apply_low_risk_agent_advice,
            run_workspace_check,
            ask_assistant,
            search_documents,
            preview_file,
            reveal_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("error while running 资料终端");
}

#[cfg(test)]
mod preview_tests {
    use super::{
        display_path, effective_cloud_policy, preview_mime, safe_relative_path, CloudPolicy,
    };
    use std::path::Path;

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
    fn ai_write_paths_stay_relative_to_the_workspace() {
        assert_eq!(
            safe_relative_path("src/main.ts").unwrap(),
            Path::new("src/main.ts")
        );
        assert!(safe_relative_path("../outside.txt").is_err());
        assert!(safe_relative_path(r"C:\\outside.txt").is_err());
    }
}
