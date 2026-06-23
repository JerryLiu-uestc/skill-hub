use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    Codex,
    Claude,
}

impl fmt::Display for HostKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HostKind::Codex => write!(formatter, "codex"),
            HostKind::Claude => write!(formatter, "claude"),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    Skill,
    Plugin,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Native,
    GitHub,
    Local,
    Linked,
    Registry,
}

impl fmt::Display for ResourceKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ResourceKind::Skill => write!(formatter, "skill"),
            ResourceKind::Plugin => write!(formatter, "plugin"),
            ResourceKind::Unknown => write!(formatter, "unknown"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HostRoot {
    pub host: HostKind,
    pub root: PathBuf,
}

impl HostRoot {
    pub fn new(host: HostKind, root: PathBuf) -> Self {
        Self { host, root }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillResource {
    pub id: String,
    pub name: String,
    pub kind: ResourceKind,
    pub host: HostKind,
    pub status: String,
    pub path: PathBuf,
    pub summary: String,
    pub compatibility: Vec<String>,
    pub warnings: Vec<String>,
    pub source_kind: SourceKind,
    pub source_url: Option<String>,
    pub update_status: String,
}

#[derive(Default)]
struct ResourceMetadata {
    name: Option<String>,
    summary: Option<String>,
    source_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreview {
    pub source: String,
    pub source_path: Option<PathBuf>,
    pub host: HostKind,
    pub kind: ResourceKind,
    pub name: String,
    pub target_path: PathBuf,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubSourceMatch {
    pub resource_id: String,
    pub source_url: String,
    pub confidence: String,
    pub matched_by: String,
}

#[derive(Clone, Debug)]
struct GitHubIndexEntry {
    name: String,
    kind: ResourceKind,
    summary: Option<String>,
    source_url: String,
    skill_sha256: Option<String>,
}

// --- Route C: Built-in / Remote Index support ---

/// Top-level structure of a market index JSON file (built-in or remote).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketIndexFile {
    #[allow(dead_code)]
    version: String,
    generated_at: String,
    #[serde(default)]
    #[allow(dead_code)]
    total_count: u32,
    skills: Vec<MarketIndexEntry>,
}

/// A single skill entry inside a market index file.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketIndexEntry {
    id: String,
    name: String,
    kind: String,
    summary: Option<String>,
    description: Option<String>,
    source_url: String,
    repo: String,
    #[allow(dead_code)]
    path: String,
    #[serde(default)]
    stars: u64,
    updated_at: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    hotness: f64,
    #[allow(dead_code)]
    author: Option<String>,
    #[allow(dead_code)]
    license: Option<String>,
    #[allow(dead_code)]
    version: Option<String>,
}

impl MarketIndexEntry {
    fn to_candidate(&self) -> MarketCandidate {
        let kind = match self.kind.as_str() {
            "plugin" => ResourceKind::Plugin,
            _ => ResourceKind::Skill,
        };
        MarketCandidate {
            name: self.name.clone(),
            kind,
            summary: self.summary.clone(),
            source_url: self.source_url.clone(),
            skill_sha256: None,
            repo: Some(self.repo.clone()),
            stars: Some(self.stars),
            origin: "index".to_string(),
            categories: if self.categories.is_empty() {
                None
            } else {
                Some(self.categories.clone())
            },
            hotness: Some(self.hotness),
            description: self.description.clone(),
            updated_at: self.updated_at.clone(),
            index_id: Some(self.id.clone()),
        }
    }
}

const REMOTE_INDEX_CACHE_FILENAME: &str = "remote-market-index.json";
const REMOTE_INDEX_TTL_SECS: u64 = 24 * 60 * 60; // 24 hours

/// Load the built-in index embedded at compile time via `include_str!`.
/// This is the L1 data source: zero network requests, instant first paint.
fn load_builtin_index() -> Vec<MarketCandidate> {
    let json = include_str!("../resources/built-in-index.json");
    match serde_json::from_str::<MarketIndexFile>(json) {
        Ok(index) => index.skills.iter().map(|e| e.to_candidate()).collect(),
        Err(_) => {
            // Degrade to the hardcoded curated list if the JSON is malformed.
            curated_official_candidates()
        }
    }
}

/// Parse an ISO 8601 timestamp into a SystemTime for cache-TTL comparisons.
fn parse_iso8601(timestamp: &str) -> HubResult<std::time::SystemTime> {
    use std::time::SystemTime;
    // Simple approach: parse "2026-06-23T06:00:00Z" manually.
    // We only need the date portion for a rough TTL check.
    let parts: Vec<&str> = timestamp.split('T').collect();
    if parts.len() < 2 {
        return Err(SkillHubError::Io(format!("Invalid timestamp: {timestamp}")));
    }
    let date_parts: Vec<u64> = parts[0].split('-').filter_map(|s| s.parse().ok()).collect();
    if date_parts.len() != 3 {
        return Err(SkillHubError::Io(format!(
            "Invalid date in timestamp: {timestamp}"
        )));
    }
    let (year, month, day) = (date_parts[0], date_parts[1], date_parts[2]);
    // Approximate: convert to days since epoch (1970-01-01).
    let days = (year - 1970) * 365 + (month * 30) + day;
    Ok(SystemTime::UNIX_EPOCH + Duration::from_secs(days * 86400))
}

/// Fetch the remote index JSON from a URL, with local file caching (24h TTL).
/// This is the L2 data source: fetched in the background, merged into L1.
fn fetch_remote_index(url: &str, cache_dir: &Path) -> HubResult<Vec<MarketCandidate>> {
    let cache_path = cache_dir.join(REMOTE_INDEX_CACHE_FILENAME);

    // Check local cache first.
    if let Ok(cached) = fs::read_to_string(&cache_path) {
        if let Ok(index) = serde_json::from_str::<MarketIndexFile>(&cached) {
            if let Ok(generated) = parse_iso8601(&index.generated_at) {
                if let Ok(elapsed) = generated.elapsed() {
                    if elapsed.as_secs() < REMOTE_INDEX_TTL_SECS {
                        return Ok(index.skills.iter().map(|e| e.to_candidate()).collect());
                    }
                }
            }
        }
    }

    // Cache miss or expired: fetch from remote.
    let client = market_discovery_http_client()?;
    let response = client
        .get(url)
        .send()
        .map_err(|e| SkillHubError::Io(format!("Failed to fetch remote index: {e}")))?;
    let body = response
        .text()
        .map_err(|e| SkillHubError::Io(format!("Failed to read remote index body: {e}")))?;

    // Persist to cache (best-effort).
    let _ = fs::create_dir_all(cache_dir);
    let _ = fs::write(&cache_path, &body);

    let index: MarketIndexFile = serde_json::from_str(&body)
        .map_err(|e| SkillHubError::Io(format!("Failed to parse remote index: {e}")))?;
    Ok(index.skills.iter().map(|e| e.to_candidate()).collect())
}

// --- End Route C ---

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketEntry {
    pub name: String,
    pub kind: ResourceKind,
    pub summary: Option<String>,
    pub source_url: String,
    pub skill_sha256: Option<String>,
    pub installed: bool,
    pub installed_id: Option<String>,
    /// `owner/repo` the skill lives in, for grouping and display.
    pub repo: Option<String>,
    /// Stargazers of the source repo. GitHub has no per-skill metric, so every
    /// skill from the same repo shares this number (surfaced as the leaderboard).
    pub stars: Option<u64>,
    /// `official` (curated), `community` (discovered), or `index` (legacy JSON).
    pub origin: String,
    /// Category tags from the index file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,
    /// Hotness score from the index file, used for sorting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hotness: Option<f64>,
    /// Full description from the index file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Repo last updated time (ISO 8601) from the index file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Unique ID from the index file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketResult {
    pub entries: Vec<MarketEntry>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub status: String,
    pub source_url: String,
    pub local_sha256: Option<String>,
    pub remote_sha256: Option<String>,
    pub detail: Option<String>,
}

/// Parsed GitHub source URL: owner/repo plus an optional pinned branch and
/// in-repo subpath (from `/tree/<branch>/<subpath>` style links).
#[derive(Clone, Debug, Eq, PartialEq)]
struct GitHubRef {
    owner: String,
    repo: String,
    branch: Option<String>,
    subpath: Option<String>,
}

#[derive(Debug)]
pub enum SkillHubError {
    Io(String),
    OutsideRoot(String),
    UnsupportedSource(String),
    NameConflict(String),
    InvalidResource(String),
    TrashFailed(String),
}

impl fmt::Display for SkillHubError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SkillHubError::Io(message)
            | SkillHubError::OutsideRoot(message)
            | SkillHubError::UnsupportedSource(message)
            | SkillHubError::NameConflict(message)
            | SkillHubError::InvalidResource(message)
            | SkillHubError::TrashFailed(message) => formatter.write_str(message),
        }
    }
}

impl From<std::io::Error> for SkillHubError {
    fn from(error: std::io::Error) -> Self {
        SkillHubError::Io(error.to_string())
    }
}

type HubResult<T> = Result<T, SkillHubError>;

#[tauri::command]
fn scan_inventory(
    codex_root: Option<String>,
    claude_root: Option<String>,
    extra_skill_paths: Option<Vec<String>>,
) -> Result<Vec<SkillResource>, String> {
    let mut resources = Vec::new();
    let roots = configured_roots(codex_root, claude_root);
    for root in roots {
        match scan_host(&root) {
            Ok(scanned) => resources.extend(scanned),
            Err(SkillHubError::Io(message)) if message.contains("No such file") => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    for path in extra_skill_paths.unwrap_or_default() {
        let path = expand_home(PathBuf::from(path));
        if path.as_os_str().is_empty() {
            continue;
        }
        match scan_extra_skill_path(&path) {
            Ok(scanned) => resources.extend(scanned),
            Err(SkillHubError::Io(message)) if message.contains("No such file") => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    dedupe_resources(&mut resources);
    Ok(resources)
}

#[tauri::command]
fn preview_source(
    source: String,
    host: HostKind,
    root: String,
    kind: ResourceKind,
    name: String,
) -> Result<InstallPreview, String> {
    preview_install(
        &source,
        &HostRoot::new(host, expand_home(PathBuf::from(root))),
        kind,
        &name,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn install_resource(preview: InstallPreview) -> Result<(), String> {
    install_from_preview(&preview).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_resource(path: String, root: String) -> Result<(), String> {
    let mut trash = SystemTrash;
    let expanded_path = expand_home(PathBuf::from(path));
    let expanded_root = expand_home(PathBuf::from(root));
    delete_resource_with_trash(&expanded_path, &expanded_root, &mut trash)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn match_github_sources(
    index_urls: Vec<String>,
    resources: Vec<SkillResource>,
) -> Result<Vec<GitHubSourceMatch>, String> {
    match_resources_with_github_indexes(&index_urls, &resources).map_err(|error| error.to_string())
}

#[tauri::command]
fn browse_market(
    index_urls: Vec<String>,
    resources: Vec<SkillResource>,
) -> Result<Vec<MarketEntry>, String> {
    browse_market_entries(&index_urls, &resources).map_err(|error| error.to_string())
}

#[tauri::command]
async fn discover_market(
    sources: Vec<String>,
    token: Option<String>,
    include_curated: Option<bool>,
    resources: Vec<SkillResource>,
    remote_index_url: Option<String>,
    app_data_dir: Option<String>,
) -> Result<MarketResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache_dir = app_data_dir.as_ref().map(PathBuf::from);
        let (entries, warnings) = browse_market_v2(
            &sources,
            token.as_deref(),
            include_curated.unwrap_or(true),
            &resources,
            remote_index_url.as_deref(),
            cache_dir.as_deref(),
        );
        Ok(MarketResult { entries, warnings })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn discover_repo(
    source: String,
    token: Option<String>,
    resources: Vec<SkillResource>,
) -> Result<MarketResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Discover a single pasted repo/skill URL (no curated catalog mixed in).
        let (entries, warnings) = browse_market_v2(
            std::slice::from_ref(&source),
            token.as_deref(),
            false,
            &resources,
            None,
            None,
        );
        Ok(MarketResult { entries, warnings })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn install_github_skill(
    source: String,
    host: HostKind,
    root: Option<String>,
    kind: ResourceKind,
    name: String,
) -> Result<(), String> {
    let root = root
        .filter(|root| !root.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| default_host_root(host))
        .ok_or_else(|| format!("No default {host} root is available"))?;
    install_github_resource(
        &source,
        &HostRoot::new(host, expand_home(root)),
        kind,
        &name,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn discover_market_source(
    source: String,
    token: Option<String>,
    resources: Vec<SkillResource>,
) -> Result<MarketResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (entries, warnings) =
            browse_market_v2(&[source], token.as_deref(), false, &resources, None, None);
        Ok(MarketResult { entries, warnings })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn discover_curated_catalog(resources: Vec<SkillResource>) -> Result<MarketResult, String> {
    let (entries, warnings) = browse_market_v2(&[], None, true, &resources, None, None);
    Ok(MarketResult { entries, warnings })
}

/// L1: Return the built-in index instantly — zero network requests.
/// Used for first-paint so the market is never empty.
#[tauri::command]
fn discover_builtin_index(resources: Vec<SkillResource>) -> Result<MarketResult, String> {
    let candidates = load_builtin_index();
    let entries = assemble_market(candidates, &resources);
    Ok(MarketResult {
        entries,
        warnings: vec![],
    })
}

/// L2: Fetch the remote index JSON (with 24h local cache) and return entries.
/// Called in the background after L1 is rendered.
#[tauri::command]
async fn refresh_remote_index(
    app_handle: tauri::AppHandle,
    url: Option<String>,
    resources: Vec<SkillResource>,
) -> Result<MarketResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let default_url =
            "https://raw.githubusercontent.com/JerryLiu-uestc/skill-hub/gh-pages/index.json";
        let url = url.as_deref().unwrap_or(default_url);
        let cache_dir = app_handle
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir());
        match fetch_remote_index(url, &cache_dir) {
            Ok(candidates) => {
                let entries = assemble_market(candidates, &resources);
                Ok(MarketResult {
                    entries,
                    warnings: vec![],
                })
            }
            Err(error) => Ok(MarketResult {
                entries: vec![],
                warnings: vec![error.to_string()],
            }),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn check_skill_update(source: String, path: String) -> Result<UpdateCheck, String> {
    check_github_update(&source, &expand_home(PathBuf::from(path)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_github_skill(
    source: String,
    host: HostKind,
    root: String,
    kind: ResourceKind,
    name: String,
    path: String,
) -> Result<(), String> {
    let mut trash = SystemTrash;
    update_github_resource(
        &source,
        &HostRoot::new(host, expand_home(PathBuf::from(root))),
        kind,
        &name,
        &expand_home(PathBuf::from(path)),
        &mut trash,
    )
    .map_err(|error| error.to_string())
}

fn configured_roots(codex_root: Option<String>, claude_root: Option<String>) -> Vec<HostRoot> {
    let mut roots = Vec::new();
    roots.extend(configured_host_roots(HostKind::Codex, codex_root));
    roots.extend(configured_host_roots(HostKind::Claude, claude_root));
    roots
}

fn configured_host_roots(host: HostKind, explicit_root: Option<String>) -> Vec<HostRoot> {
    if let Some(root) = explicit_root.filter(|root| !root.trim().is_empty()) {
        return vec![HostRoot::new(host, expand_home(PathBuf::from(root)))];
    }

    let env_name = match host {
        HostKind::Codex => "CODEX_HOME",
        HostKind::Claude => "CLAUDE_HOME",
    };
    if let Ok(root) = std::env::var(env_name) {
        if !root.trim().is_empty() {
            return vec![HostRoot::new(host, expand_home(PathBuf::from(root)))];
        }
    }

    default_host_root_candidates(host)
        .into_iter()
        .map(|root| HostRoot::new(host, root))
        .collect()
}

fn default_host_root(host: HostKind) -> Option<PathBuf> {
    let env_name = match host {
        HostKind::Codex => "CODEX_HOME",
        HostKind::Claude => "CLAUDE_HOME",
    };
    if let Ok(root) = std::env::var(env_name) {
        if !root.trim().is_empty() {
            return Some(expand_home(PathBuf::from(root)));
        }
    }
    default_host_root_candidates(host).into_iter().next()
}

fn default_host_root_candidates(host: HostKind) -> Vec<PathBuf> {
    let (dot_dir, app_names): (&str, &[&str]) = match host {
        HostKind::Codex => (".codex", &["Codex", "codex"]),
        HostKind::Claude => (".claude", &["Claude", "claude"]),
    };
    let mut candidates = Vec::new();
    if let Some(home) = user_home_dir() {
        candidates.push(home.join(dot_dir));
        #[cfg(target_os = "macos")]
        {
            for app_name in app_names {
                candidates.push(
                    home.join("Library")
                        .join("Application Support")
                        .join(app_name),
                );
            }
        }
        #[cfg(any(target_os = "linux", target_os = "freebsd"))]
        {
            for app_name in app_names {
                candidates.push(home.join(".config").join(app_name));
            }
        }
    }

    #[cfg(windows)]
    {
        for env_name in ["APPDATA", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(env_name) {
                for app_name in app_names {
                    candidates.push(PathBuf::from(&base).join(app_name));
                }
            }
        }
    }

    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    {
        if let Ok(base) = std::env::var("XDG_CONFIG_HOME") {
            for app_name in app_names {
                candidates.push(PathBuf::from(&base).join(app_name));
            }
        }
    }

    dedupe_paths(candidates)
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for path in paths {
        let key = path.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            unique.push(path);
        }
    }
    unique
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .map(PathBuf::from)
}

fn expand_home(path: PathBuf) -> PathBuf {
    let Some(raw) = path.to_str() else {
        return path;
    };
    if raw == "~" {
        return user_home_dir().unwrap_or(path);
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = user_home_dir() {
            return home.join(rest);
        }
    }
    if let Some(rest) = raw.strip_prefix("~\\") {
        if let Some(home) = user_home_dir() {
            return home.join(rest);
        }
    }
    path
}

pub fn scan_host(host_root: &HostRoot) -> HubResult<Vec<SkillResource>> {
    let root = canonical_existing(&host_root.root)?;
    let mut resources = Vec::new();
    scan_kind(&root, host_root.host, ResourceKind::Skill, &mut resources)?;
    scan_kind(&root, host_root.host, ResourceKind::Plugin, &mut resources)?;
    resources.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.kind.to_string().cmp(&right.kind.to_string()))
    });
    Ok(resources)
}

pub fn scan_extra_skill_path(path: &Path) -> HubResult<Vec<SkillResource>> {
    let root = canonical_existing(path)?;
    let mut resources = Vec::new();
    scan_kind_dir(
        &root,
        &root,
        HostKind::Codex,
        ResourceKind::Skill,
        0,
        &mut resources,
    )?;
    resources.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(resources)
}

fn dedupe_resources(resources: &mut Vec<SkillResource>) {
    let mut seen = HashSet::new();
    resources.retain(|resource| {
        let key = format!("{}:{}:{}", resource.host, resource.kind, resource.name);
        seen.insert(key)
    });
}

fn scan_kind(
    root: &Path,
    host: HostKind,
    kind: ResourceKind,
    resources: &mut Vec<SkillResource>,
) -> HubResult<()> {
    let dir = match kind {
        ResourceKind::Skill => root.join("skills"),
        ResourceKind::Plugin => root.join("plugins"),
        ResourceKind::Unknown => return Ok(()),
    };
    if !dir.exists() {
        return Ok(());
    }
    scan_kind_dir(root, &dir, host, kind, 0, resources)
}

fn scan_kind_dir(
    root: &Path,
    dir: &Path,
    host: HostKind,
    kind: ResourceKind,
    depth: usize,
    resources: &mut Vec<SkillResource>,
) -> HubResult<()> {
    if depth > 6 || is_sensitive_path(dir) {
        return Ok(());
    }

    if is_supported_resource(dir, host, kind) {
        push_resource(root, dir, host, kind, resources)?;
        return Ok(());
    }

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            scan_kind_dir(root, &path, host, kind, depth + 1, resources)?;
        }
    }
    Ok(())
}

fn push_resource(
    root: &Path,
    path: &Path,
    host: HostKind,
    kind: ResourceKind,
    resources: &mut Vec<SkillResource>,
) -> HubResult<()> {
    let lexical_path = absolutize(path)?;
    let real_path = canonical_existing(path)?;
    let mut warnings = scan_warnings_without_sensitive_names(&real_path)?;
    let metadata = resource_metadata(&real_path, kind);
    let Some(name) = metadata.name.clone().or_else(|| {
        path.file_name()
            .and_then(|value| value.to_str())
            .map(str::to_owned)
    }) else {
        return Ok(());
    };
    let git_url = find_github_remote(&real_path);
    let source_url = git_url.or(metadata.source_url);
    let source_kind = source_kind_for(root, &real_path, &source_url);

    if !real_path.starts_with(root) {
        warnings.push(format!("Linked to {}", real_path.display()));
    }

    resources.push(SkillResource {
        id: format!("{host}-{kind}-{name}"),
        name: name.clone(),
        kind,
        host,
        status: if warnings.is_empty() {
            "ready"
        } else {
            "warning"
        }
        .to_string(),
        path: lexical_path,
        summary: metadata
            .summary
            .unwrap_or_else(|| fallback_summary_for(kind)),
        compatibility: compatibility_for(host, kind),
        warnings,
        source_kind,
        source_url,
        update_status: update_status_for(source_kind).to_string(),
    });
    Ok(())
}

fn is_supported_resource(path: &Path, host: HostKind, kind: ResourceKind) -> bool {
    match (host, kind) {
        (_, ResourceKind::Skill) => path.join("SKILL.md").is_file(),
        (HostKind::Codex, ResourceKind::Plugin) => {
            path.join(".codex-plugin/plugin.json").is_file()
                || path.join(".claude-plugin/plugin.json").is_file()
                || path.join("plugin.json").is_file()
        }
        (HostKind::Claude, ResourceKind::Plugin) => {
            path.join(".claude-plugin/plugin.json").is_file() || path.join("plugin.json").is_file()
        }
        (_, ResourceKind::Unknown) => false,
    }
}

fn resource_metadata(path: &Path, kind: ResourceKind) -> ResourceMetadata {
    match kind {
        ResourceKind::Skill => fs::read_to_string(path.join("SKILL.md"))
            .map(|contents| parse_skill_metadata(&contents))
            .unwrap_or_default(),
        ResourceKind::Plugin => parse_plugin_metadata(path),
        ResourceKind::Unknown => ResourceMetadata::default(),
    }
}

fn parse_plugin_metadata(path: &Path) -> ResourceMetadata {
    let manifest_path = if path.join(".codex-plugin/plugin.json").is_file() {
        path.join(".codex-plugin/plugin.json")
    } else if path.join(".claude-plugin/plugin.json").is_file() {
        path.join(".claude-plugin/plugin.json")
    } else {
        path.join("plugin.json")
    };
    let Ok(contents) = fs::read_to_string(manifest_path) else {
        return ResourceMetadata::default();
    };
    parse_plugin_manifest_metadata(&contents)
}

fn parse_plugin_manifest_metadata(contents: &str) -> ResourceMetadata {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return ResourceMetadata::default();
    };
    let name = value
        .pointer("/interface/displayName")
        .and_then(|value| value.as_str())
        .or_else(|| value.get("name").and_then(|value| value.as_str()))
        .map(str::to_string);
    let summary = value
        .pointer("/interface/shortDescription")
        .and_then(|value| value.as_str())
        .or_else(|| value.get("description").and_then(|value| value.as_str()))
        .map(str::to_string);
    let source_url = value
        .get("repository")
        .and_then(|value| value.as_str())
        .or_else(|| value.get("homepage").and_then(|value| value.as_str()))
        .filter(|value| value.contains("github.com"))
        .map(normalize_github_url);

    ResourceMetadata {
        name,
        summary,
        source_url,
    }
}

fn parse_skill_metadata(contents: &str) -> ResourceMetadata {
    let mut metadata = ResourceMetadata {
        source_url: extract_github_url(contents),
        ..ResourceMetadata::default()
    };
    let mut body_start = 0;

    if let Some(rest) = contents.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            let frontmatter = &rest[..end];
            body_start = 4 + end + 4;
            for line in frontmatter.lines() {
                let Some((key, value)) = line.split_once(':') else {
                    continue;
                };
                let key = key.trim();
                let value = value.trim().trim_matches('"').trim_matches('\'');
                if key == "description" && !value.is_empty() {
                    metadata.summary = Some(value.to_string());
                }
                if matches!(key, "homepage" | "repository" | "repo" | "url")
                    && value.contains("github.com")
                {
                    metadata.source_url = Some(normalize_github_url(value));
                }
            }
        }
    }

    if metadata.summary.is_none() {
        metadata.summary = contents[body_start..]
            .lines()
            .map(str::trim)
            .find(|line| {
                !line.is_empty()
                    && !line.starts_with('#')
                    && !line.starts_with('>')
                    && *line != "---"
            })
            .map(|line| line.trim_start_matches("- ").to_string());
    }

    metadata
}

fn fallback_summary_for(kind: ResourceKind) -> String {
    match kind {
        ResourceKind::Skill => "Skill resource".to_string(),
        ResourceKind::Plugin => "Plugin resource".to_string(),
        ResourceKind::Unknown => "Unknown resource".to_string(),
    }
}

fn source_kind_for(root: &Path, path: &Path, source_url: &Option<String>) -> SourceKind {
    if is_native_resource(path) {
        SourceKind::Native
    } else if is_registry_resource(path) {
        SourceKind::Registry
    } else if source_url
        .as_ref()
        .is_some_and(|url| url.contains("github.com"))
    {
        SourceKind::GitHub
    } else if !path.starts_with(root) {
        SourceKind::Linked
    } else {
        SourceKind::Local
    }
}

fn update_status_for(source_kind: SourceKind) -> &'static str {
    match source_kind {
        SourceKind::GitHub => "Trackable",
        SourceKind::Native => "Managed",
        SourceKind::Registry => "Registry",
        SourceKind::Linked => "Linked",
        SourceKind::Local => "Manual",
    }
}

fn is_native_resource(path: &Path) -> bool {
    path_has_component_window(path, &["skills", ".system"])
        || path_has_component(path, "openai-bundled")
        || path_has_component(path, "openai-primary-runtime")
}

fn is_registry_resource(path: &Path) -> bool {
    path_has_component(path, "openai-curated") || path_has_component(path, "openai-curated-remote")
}

fn path_has_component(path: &Path, expected: &str) -> bool {
    path.components()
        .any(|component| component.as_os_str().to_string_lossy() == expected)
}

fn path_has_component_window(path: &Path, expected: &[&str]) -> bool {
    let components = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>();
    components.windows(expected.len()).any(|window| {
        window
            .iter()
            .zip(expected.iter())
            .all(|(left, right)| left.as_ref() == *right)
    })
}

fn find_github_remote(path: &Path) -> Option<String> {
    for ancestor in path.ancestors().take(8) {
        let config = ancestor.join(".git/config");
        if !config.is_file() {
            continue;
        }
        let contents = fs::read_to_string(config).ok()?;
        for line in contents.lines() {
            let line = line.trim();
            if let Some(url) = line.strip_prefix("url = ") {
                if url.contains("github.com") {
                    return Some(normalize_github_url(url));
                }
            }
        }
    }
    None
}

fn extract_github_url(contents: &str) -> Option<String> {
    let start = contents.find("https://github.com/")?;
    let tail = &contents[start..];
    let raw = tail
        .split(|character: char| {
            character.is_whitespace()
                || matches!(character, ')' | ']' | '>' | '|' | '，' | '。' | '、')
        })
        .next()?;
    Some(normalize_github_url(raw))
}

fn normalize_github_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches(".git");
    if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        format!("https://github.com/{}", rest.trim_end_matches(".git"))
    } else {
        trimmed.to_string()
    }
}

pub fn match_resources_with_github_indexes(
    index_urls: &[String],
    resources: &[SkillResource],
) -> HubResult<Vec<GitHubSourceMatch>> {
    let mut entries = Vec::new();
    for url in index_urls
        .iter()
        .map(|url| url.trim())
        .filter(|url| !url.is_empty())
    {
        entries.extend(fetch_github_index(url)?);
    }

    Ok(match_resources_with_entries(resources, &entries))
}

fn match_resources_with_entries(
    resources: &[SkillResource],
    entries: &[GitHubIndexEntry],
) -> Vec<GitHubSourceMatch> {
    let mut matches = Vec::new();
    for resource in resources {
        if resource.kind != ResourceKind::Skill {
            continue;
        }
        let skill_hash = file_sha256(&resource.path.join("SKILL.md")).ok();
        let resource_summary = normalize_text(&resource.summary);
        let resource_name = resource.name.to_ascii_lowercase();

        let mut best: Option<GitHubSourceMatch> = None;
        for entry in entries {
            if let (Some(left), Some(right)) = (&skill_hash, &entry.skill_sha256) {
                if left.eq_ignore_ascii_case(right) {
                    best = Some(GitHubSourceMatch {
                        resource_id: resource.id.clone(),
                        source_url: entry.source_url.clone(),
                        confidence: "verified".to_string(),
                        matched_by: "skill_sha256".to_string(),
                    });
                    break;
                }
            }

            if entry.name.to_ascii_lowercase() == resource_name {
                let summary_matches = entry.summary.as_ref().is_some_and(|summary| {
                    let index_summary = normalize_text(summary);
                    !index_summary.is_empty()
                        && (index_summary == resource_summary
                            || index_summary.contains(&resource_summary)
                            || resource_summary.contains(&index_summary))
                });
                if summary_matches {
                    best = Some(GitHubSourceMatch {
                        resource_id: resource.id.clone(),
                        source_url: entry.source_url.clone(),
                        confidence: "probable".to_string(),
                        matched_by: "name_summary".to_string(),
                    });
                }
            }
        }

        if let Some(match_result) = best {
            matches.push(match_result);
        }
    }

    matches
}

pub fn browse_market_entries(
    index_urls: &[String],
    resources: &[SkillResource],
) -> HubResult<Vec<MarketEntry>> {
    let mut candidates = Vec::new();
    for url in index_urls
        .iter()
        .map(|url| url.trim())
        .filter(|url| !url.is_empty())
    {
        for entry in fetch_github_index(url)? {
            candidates.push(MarketCandidate::from_index_entry(entry));
        }
    }
    Ok(assemble_market(candidates, resources))
}

/// An un-deduped, un-marked market item produced by any source: the curated
/// catalog, live repo discovery, or a legacy index JSON.
#[derive(Clone, Debug)]
struct MarketCandidate {
    name: String,
    kind: ResourceKind,
    summary: Option<String>,
    source_url: String,
    skill_sha256: Option<String>,
    repo: Option<String>,
    stars: Option<u64>,
    origin: String,
    categories: Option<Vec<String>>,
    hotness: Option<f64>,
    description: Option<String>,
    updated_at: Option<String>,
    index_id: Option<String>,
}

impl MarketCandidate {
    fn from_index_entry(entry: GitHubIndexEntry) -> Self {
        let repo = parse_github_ref(&entry.source_url)
            .ok()
            .map(|github_ref| format!("{}/{}", github_ref.owner, github_ref.repo));
        Self {
            name: entry.name,
            kind: entry.kind,
            summary: entry.summary,
            source_url: entry.source_url,
            skill_sha256: entry.skill_sha256,
            repo,
            stars: None,
            origin: "index".to_string(),
            categories: None,
            hotness: None,
            description: None,
            updated_at: None,
            index_id: None,
        }
    }
}

/// Dedupe candidates by source URL, mark which are already installed, and sort
/// by stars (desc) then name. Pure (only reads already-installed resources) so
/// it is unit-testable without any network.
fn assemble_market(
    candidates: Vec<MarketCandidate>,
    resources: &[SkillResource],
) -> Vec<MarketEntry> {
    let installed_resources: Vec<&SkillResource> = resources
        .iter()
        .filter(|resource| matches!(resource.kind, ResourceKind::Skill | ResourceKind::Plugin))
        .collect();

    let mut seen = HashSet::new();
    let mut market = Vec::new();
    for candidate in candidates {
        if !seen.insert(candidate.source_url.clone()) {
            continue;
        }
        let entry_name = candidate.name.to_ascii_lowercase();
        let entry_hash = candidate
            .skill_sha256
            .as_ref()
            .map(|hash| hash.to_ascii_lowercase());
        let installed = installed_resources.iter().find(|resource| {
            if resource.kind != candidate.kind {
                return false;
            }
            if resource.source_url.as_deref() == Some(candidate.source_url.as_str()) {
                return true;
            }
            if candidate.kind == ResourceKind::Skill {
                if let Some(hash) = &entry_hash {
                    if let Ok(local) = file_sha256(&resource.path.join("SKILL.md")) {
                        if local.eq_ignore_ascii_case(hash) {
                            return true;
                        }
                    }
                }
            }
            resource.name.to_ascii_lowercase() == entry_name
        });

        market.push(MarketEntry {
            name: candidate.name,
            kind: candidate.kind,
            summary: candidate.summary,
            source_url: candidate.source_url,
            skill_sha256: candidate.skill_sha256,
            installed: installed.is_some(),
            installed_id: installed.map(|resource| resource.id.clone()),
            repo: candidate.repo,
            stars: candidate.stars,
            origin: candidate.origin,
            categories: candidate.categories,
            hotness: candidate.hotness,
            description: candidate.description,
            updated_at: candidate.updated_at,
            index_id: candidate.index_id,
        });
    }
    sort_market(&mut market);
    market
}

/// Leaderboard ordering: higher stars first, then name. Entries without a star
/// count sort after those with one.
/// Leaderboard ordering: higher hotness first (if available), then stars (desc),
/// then name. Entries without a hotness or star count sort after those with one.
fn sort_market(market: &mut [MarketEntry]) {
    market.sort_by(|left, right| {
        // Prefer hotness score when both sides have it.
        let left_hot = left.hotness.unwrap_or(0.0);
        let right_hot = right.hotness.unwrap_or(0.0);
        if right_hot != left_hot {
            return right_hot
                .partial_cmp(&left_hot)
                .unwrap_or(std::cmp::Ordering::Equal);
        }
        // Fall back to stars.
        right
            .stars
            .unwrap_or(0)
            .cmp(&left.stars.unwrap_or(0))
            .then_with(|| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
    });
}

/// Curated, offline-safe catalog of the official anthropics/skills set. Names
/// and one-line summaries are baked in so the Market shows real content on first
/// open even when the GitHub API is rate-limited. Paths are stable and verified.
const CURATED_OFFICIAL: &[(&str, &str)] = &[
    (
        "algorithmic-art",
        "Create algorithmic art with p5.js, seeded randomness, and interactive parameters.",
    ),
    (
        "brand-guidelines",
        "Apply Anthropic's official brand colors and typography to artifacts.",
    ),
    (
        "canvas-design",
        "Create visual art in .png and .pdf documents using a design philosophy.",
    ),
    (
        "claude-api",
        "Guidance and helpers for working with the Claude API.",
    ),
    (
        "doc-coauthoring",
        "Guide users through a structured workflow for co-authoring documentation.",
    ),
    (
        "docx",
        "Create, read, edit, and manipulate Word documents (.docx files).",
    ),
    (
        "frontend-design",
        "Guidance for distinctive, intentional visual design when building UI.",
    ),
    (
        "internal-comms",
        "Resources to help write all kinds of internal communications.",
    ),
    (
        "mcp-builder",
        "Build high-quality MCP servers that let LLMs interact with external services.",
    ),
    (
        "pdf",
        "Read, extract, merge, split, fill, encrypt, and OCR PDF files.",
    ),
    (
        "pptx",
        "Create, read, and edit PowerPoint presentations (.pptx files).",
    ),
    (
        "skill-creator",
        "Create new skills, improve existing ones, and measure skill performance.",
    ),
    (
        "slack-gif-creator",
        "Create animated GIFs optimized for Slack.",
    ),
    (
        "theme-factory",
        "Toolkit for styling artifacts with a theme.",
    ),
    (
        "web-artifacts-builder",
        "Build elaborate, multi-component claude.ai HTML artifacts.",
    ),
    (
        "webapp-testing",
        "Interact with and test local web applications using Playwright.",
    ),
    ("xlsx", "Create, read, and edit spreadsheet files (.xlsx)."),
];

const OFFICIAL_REPO: &str = "anthropics/skills";
const MARKET_DISCOVERY_HTTP_TIMEOUT_SECS: u64 = 8;

fn curated_official_candidates() -> Vec<MarketCandidate> {
    CURATED_OFFICIAL
        .iter()
        .map(|(name, summary)| MarketCandidate {
            name: name.to_string(),
            kind: ResourceKind::Skill,
            summary: Some(summary.to_string()),
            source_url: format!("https://github.com/{OFFICIAL_REPO}/tree/main/skills/{name}"),
            skill_sha256: None,
            repo: Some(OFFICIAL_REPO.to_string()),
            stars: None,
            origin: "official".to_string(),
            categories: None,
            hotness: None,
            description: None,
            updated_at: None,
            index_id: None,
        })
        .collect()
}

/// Unified market browse: built-in index (always) + remote index (if configured)
/// + every configured source. A source is discovered as a repo unless it ends
/// in `.json` (legacy index). Network/rate-limit failures on a single source
/// are collected as warnings rather than failing the whole market, so the
/// built-in index still shows.
pub fn browse_market_v2(
    sources: &[String],
    token: Option<&str>,
    include_curated: bool,
    resources: &[SkillResource],
    remote_index_url: Option<&str>,
    cache_dir: Option<&Path>,
) -> (Vec<MarketEntry>, Vec<String>) {
    let mut candidates = Vec::new();
    let mut warnings = Vec::new();

    // L1: Built-in index (replaces the old hardcoded curated list).
    if include_curated {
        candidates.extend(load_builtin_index());
    }

    // L2: Remote index (background refresh, failure is non-fatal).
    if let Some(url) = remote_index_url {
        if let Some(dir) = cache_dir {
            match fetch_remote_index(url, dir) {
                Ok(found) => candidates.extend(found),
                Err(error) => warnings.push(format!("remote-index: {error}")),
            }
        }
    }

    // L3: User-configured sources (GitHub repos or legacy JSON indexes).
    for source in sources
        .iter()
        .map(|source| source.trim())
        .filter(|source| !source.is_empty())
    {
        let result = if source.to_ascii_lowercase().ends_with(".json") {
            fetch_github_index(source).map(|entries| {
                entries
                    .into_iter()
                    .map(MarketCandidate::from_index_entry)
                    .collect()
            })
        } else {
            discover_repo_skill_candidates(source, token)
        };
        match result {
            Ok(found) => candidates.extend(found),
            Err(error) => warnings.push(format!("{source}: {error}")),
        }
    }

    (assemble_market(candidates, resources), warnings)
}

/// Discover skills inside a public GitHub repo: one `git/trees?recursive=1`
/// call locates every `SKILL.md`, frontmatter is read over un-rate-limited raw,
/// and one repo-metadata call attaches the star count (leaderboard signal).
fn discover_repo_skill_candidates(
    source: &str,
    token: Option<&str>,
) -> HubResult<Vec<MarketCandidate>> {
    validate_github_source(source)?;
    let github_ref = parse_github_ref(source)?;
    let client = market_discovery_http_client()?;

    let branch = github_ref
        .branch
        .clone()
        .unwrap_or_else(|| "main".to_string());

    let stars = token
        .filter(|token| !token.trim().is_empty())
        .and_then(|token| repo_stars(&client, &github_ref, Some(token)));
    let repo = format!("{}/{}", github_ref.owner, github_ref.repo);

    let market_paths = match list_market_paths(&client, &github_ref, &branch, token) {
        Ok(paths) => paths,
        Err(api_error) => {
            return discover_repo_skill_candidates_from_archive(source, &github_ref, &branch, stars)
                .map_err(|archive_error| {
                    SkillHubError::Io(format!(
                        "GitHub API discovery failed ({api_error}); archive fallback failed ({archive_error})"
                    ))
                });
        }
    };
    let plugin_dirs: Vec<String> = market_paths
        .plugin_manifests
        .iter()
        .filter_map(|path| plugin_manifest_resource_dir(path))
        .collect();
    // If the URL pinned a subpath, only keep skills under it.
    let scoped_skills: Vec<String> = match &github_ref.subpath {
        Some(prefix) => market_paths
            .skills
            .into_iter()
            .filter(|path| {
                path.starts_with(&format!("{prefix}/")) || path == &format!("{prefix}/SKILL.md")
            })
            .collect(),
        None => market_paths.skills,
    }
    .into_iter()
    .filter(|path| !is_path_under_any_dir(path, &plugin_dirs))
    .collect();
    let scoped_plugins: Vec<String> = match &github_ref.subpath {
        Some(prefix) => market_paths
            .plugin_manifests
            .into_iter()
            .filter(|path| path.starts_with(&format!("{prefix}/")) || path == prefix)
            .collect(),
        None => market_paths.plugin_manifests,
    };

    let mut candidates = Vec::new();
    // Cap raw frontmatter fetches to keep discovery responsive on large repos.
    const MAX_DESC_FETCH: usize = 18;
    for (index, skill_md) in scoped_skills.iter().enumerate() {
        let subpath = skill_md
            .trim_end_matches("/SKILL.md")
            .trim_end_matches("SKILL.md");
        let subpath = subpath.trim_end_matches('/');
        let dir_name = subpath
            .rsplit('/')
            .next()
            .filter(|segment| !segment.is_empty())
            .unwrap_or(&github_ref.repo)
            .to_string();

        let (name, summary) = if index < MAX_DESC_FETCH {
            let raw_url = if subpath.is_empty() {
                format!(
                    "https://raw.githubusercontent.com/{}/{}/{}/SKILL.md",
                    github_ref.owner, github_ref.repo, branch
                )
            } else {
                format!(
                    "https://raw.githubusercontent.com/{}/{}/{}/{}/SKILL.md",
                    github_ref.owner, github_ref.repo, branch, subpath
                )
            };
            match fetch_raw_text(&client, &raw_url) {
                Ok(body) => {
                    let meta = parse_skill_metadata(&body);
                    (meta.name.unwrap_or_else(|| dir_name.clone()), meta.summary)
                }
                Err(_) => (dir_name.clone(), None),
            }
        } else {
            (dir_name.clone(), None)
        };

        let source_url = if subpath.is_empty() {
            format!(
                "https://github.com/{}/{}",
                github_ref.owner, github_ref.repo
            )
        } else {
            format!(
                "https://github.com/{}/{}/tree/{}/{}",
                github_ref.owner, github_ref.repo, branch, subpath
            )
        };

        candidates.push(MarketCandidate {
            name,
            kind: ResourceKind::Skill,
            summary,
            source_url,
            skill_sha256: None,
            repo: Some(repo.clone()),
            stars,
            origin: if repo == OFFICIAL_REPO {
                "official".to_string()
            } else {
                "community".to_string()
            },
            categories: None,
            hotness: None,
            description: None,
            updated_at: None,
            index_id: None,
        });
    }

    for plugin_manifest in scoped_plugins {
        let Some(subpath) = plugin_manifest_resource_dir(&plugin_manifest) else {
            continue;
        };
        let dir_name = subpath
            .rsplit('/')
            .next()
            .filter(|segment| !segment.is_empty())
            .unwrap_or(&github_ref.repo)
            .to_string();
        let raw_url = if plugin_manifest.is_empty() {
            format!(
                "https://raw.githubusercontent.com/{}/{}/{}/plugin.json",
                github_ref.owner, github_ref.repo, branch
            )
        } else {
            format!(
                "https://raw.githubusercontent.com/{}/{}/{}/{}",
                github_ref.owner, github_ref.repo, branch, plugin_manifest
            )
        };
        let (name, summary) = match fetch_raw_text(&client, &raw_url) {
            Ok(body) => {
                let meta = parse_plugin_manifest_metadata(&body);
                (meta.name.unwrap_or_else(|| dir_name.clone()), meta.summary)
            }
            Err(_) => (dir_name.clone(), None),
        };
        let source_url = if subpath.is_empty() {
            format!(
                "https://github.com/{}/{}",
                github_ref.owner, github_ref.repo
            )
        } else {
            format!(
                "https://github.com/{}/{}/tree/{}/{}",
                github_ref.owner, github_ref.repo, branch, subpath
            )
        };

        candidates.push(MarketCandidate {
            name,
            kind: ResourceKind::Plugin,
            summary,
            source_url,
            skill_sha256: None,
            repo: Some(repo.clone()),
            stars,
            origin: if repo == OFFICIAL_REPO {
                "official".to_string()
            } else {
                "community".to_string()
            },
            categories: None,
            hotness: None,
            description: None,
            updated_at: None,
            index_id: None,
        });
    }

    Ok(candidates)
}

fn discover_repo_skill_candidates_from_archive(
    source: &str,
    github_ref: &GitHubRef,
    _fallback_branch: &str,
    stars: Option<u64>,
) -> HubResult<Vec<MarketCandidate>> {
    let staging = staging_dir("market-discovery")?;
    let result = (|| {
        let (extracted_root, branch) = download_and_extract_repo(github_ref, &staging)?;
        discover_repo_skill_candidates_from_dir(github_ref, &extracted_root, &branch, stars)
    })();
    let _ = fs::remove_dir_all(&staging);
    result
        .map_err(|error| SkillHubError::Io(format!("{}: {}", normalize_github_url(source), error)))
}

fn discover_repo_skill_candidates_from_dir(
    github_ref: &GitHubRef,
    extracted_root: &Path,
    branch: &str,
    stars: Option<u64>,
) -> HubResult<Vec<MarketCandidate>> {
    let source_dir = resolve_source_dir(extracted_root, github_ref)?;
    let mut plugin_manifest_files = Vec::new();
    collect_plugin_manifest_files(&source_dir, &mut plugin_manifest_files)?;
    plugin_manifest_files.sort();
    let plugin_dirs: Vec<PathBuf> = plugin_manifest_files
        .iter()
        .filter_map(|path| plugin_manifest_resource_path(path))
        .collect();

    let mut skill_files = Vec::new();
    collect_skill_md_files(&source_dir, &mut skill_files)?;
    skill_files.retain(|path| {
        !plugin_dirs.iter().any(|plugin_dir| {
            path.parent()
                .is_some_and(|parent| parent.starts_with(plugin_dir))
        })
    });
    skill_files.sort();

    let repo = format!("{}/{}", github_ref.owner, github_ref.repo);
    let mut candidates = Vec::new();
    for manifest_file in plugin_manifest_files {
        let Some(plugin_dir) = plugin_manifest_resource_path(&manifest_file) else {
            continue;
        };
        let relative_dir = plugin_dir
            .strip_prefix(extracted_root)
            .unwrap_or(&plugin_dir)
            .to_string_lossy()
            .replace('\\', "/");
        let source_relative = plugin_dir
            .strip_prefix(&source_dir)
            .unwrap_or(&plugin_dir)
            .to_string_lossy()
            .replace('\\', "/");
        let dir_name = source_relative
            .rsplit('/')
            .next()
            .filter(|segment| !segment.is_empty())
            .unwrap_or(&github_ref.repo)
            .to_string();
        let meta = fs::read_to_string(&manifest_file)
            .map(|body| parse_plugin_manifest_metadata(&body))
            .unwrap_or_default();
        let source_url = if relative_dir.is_empty() {
            format!(
                "https://github.com/{}/{}",
                github_ref.owner, github_ref.repo
            )
        } else {
            format!(
                "https://github.com/{}/{}/tree/{}/{}",
                github_ref.owner, github_ref.repo, branch, relative_dir
            )
        };

        candidates.push(MarketCandidate {
            name: meta.name.unwrap_or(dir_name),
            kind: ResourceKind::Plugin,
            summary: meta.summary,
            source_url,
            skill_sha256: None,
            repo: Some(repo.clone()),
            stars,
            origin: if repo == OFFICIAL_REPO {
                "official".to_string()
            } else {
                "community".to_string()
            },
            categories: None,
            hotness: None,
            description: None,
            updated_at: None,
            index_id: None,
        });
    }

    for skill_file in skill_files {
        let skill_dir = skill_file.parent().unwrap_or(&source_dir);
        let relative_dir = skill_dir
            .strip_prefix(extracted_root)
            .unwrap_or(skill_dir)
            .to_string_lossy()
            .replace('\\', "/");
        let source_relative = skill_dir
            .strip_prefix(&source_dir)
            .unwrap_or(skill_dir)
            .to_string_lossy()
            .replace('\\', "/");
        let dir_name = source_relative
            .rsplit('/')
            .next()
            .filter(|segment| !segment.is_empty())
            .unwrap_or(&github_ref.repo)
            .to_string();
        let meta = fs::read_to_string(&skill_file)
            .map(|body| parse_skill_metadata(&body))
            .unwrap_or_default();
        let source_url = if relative_dir.is_empty() {
            format!(
                "https://github.com/{}/{}",
                github_ref.owner, github_ref.repo
            )
        } else {
            format!(
                "https://github.com/{}/{}/tree/{}/{}",
                github_ref.owner, github_ref.repo, branch, relative_dir
            )
        };

        candidates.push(MarketCandidate {
            name: meta.name.unwrap_or(dir_name),
            kind: ResourceKind::Skill,
            summary: meta.summary,
            source_url,
            skill_sha256: None,
            repo: Some(repo.clone()),
            stars,
            origin: if repo == OFFICIAL_REPO {
                "official".to_string()
            } else {
                "community".to_string()
            },
            categories: None,
            hotness: None,
            description: None,
            updated_at: None,
            index_id: None,
        });
    }

    Ok(candidates)
}

fn collect_skill_md_files(dir: &Path, out: &mut Vec<PathBuf>) -> HubResult<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_skill_md_files(&path, out)?;
        } else if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
            out.push(path);
        }
    }
    Ok(())
}

fn collect_plugin_manifest_files(dir: &Path, out: &mut Vec<PathBuf>) -> HubResult<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_plugin_manifest_files(&path, out)?;
        } else if path.file_name().and_then(|name| name.to_str()) == Some("plugin.json")
            && plugin_manifest_resource_path(&path).is_some()
        {
            out.push(path);
        }
    }
    Ok(())
}

fn plugin_manifest_resource_path(path: &Path) -> Option<PathBuf> {
    if path.file_name().and_then(|name| name.to_str()) != Some("plugin.json") {
        return None;
    }
    let parent = path.parent()?;
    match parent.file_name().and_then(|name| name.to_str()) {
        Some(".claude-plugin" | ".codex-plugin") => parent.parent().map(Path::to_path_buf),
        _ => Some(parent.to_path_buf()),
    }
}

fn github_api_get(
    client: &reqwest::blocking::Client,
    url: &str,
    token: Option<&str>,
) -> HubResult<reqwest::blocking::Response> {
    let mut request = client
        .get(url)
        .header("Accept", "application/vnd.github+json");
    if let Some(token) = token.filter(|token| !token.trim().is_empty()) {
        request = request.header("Authorization", format!("Bearer {}", token.trim()));
    }
    let response = request
        .send()
        .map_err(|error| SkillHubError::Io(error.to_string()))?;
    if response.status().as_u16() == 403 || response.status().as_u16() == 429 {
        return Err(SkillHubError::Io(
            "GitHub API rate limit reached. Add a token in Settings or try later.".to_string(),
        ));
    }
    if !response.status().is_success() {
        return Err(SkillHubError::Io(format!(
            "GitHub API error: {}",
            response.status()
        )));
    }
    Ok(response)
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct MarketPaths {
    skills: Vec<String>,
    plugin_manifests: Vec<String>,
}

fn list_market_paths(
    client: &reqwest::blocking::Client,
    github_ref: &GitHubRef,
    branch: &str,
    token: Option<&str>,
) -> HubResult<MarketPaths> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
        github_ref.owner, github_ref.repo, branch
    );
    let response = github_api_get(client, &url, token)?;
    let body = response
        .text()
        .map_err(|error| SkillHubError::Io(error.to_string()))?;
    let value = serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|error| SkillHubError::InvalidResource(error.to_string()))?;
    Ok(extract_market_paths(&value))
}

/// Pull every `*/SKILL.md` (or root `SKILL.md`) path out of a git trees reply.
#[cfg(test)]
fn extract_skill_md_paths(value: &serde_json::Value) -> Vec<String> {
    extract_market_paths(value).skills
}

fn extract_market_paths(value: &serde_json::Value) -> MarketPaths {
    let mut paths = Vec::new();
    let mut plugin_manifests = Vec::new();
    if let Some(tree) = value.get("tree").and_then(|tree| tree.as_array()) {
        for node in tree {
            let Some(path) = node.get("path").and_then(|path| path.as_str()) else {
                continue;
            };
            if path == "SKILL.md" || path.ends_with("/SKILL.md") {
                paths.push(path.to_string());
            }
            if plugin_manifest_resource_dir(path).is_some() {
                plugin_manifests.push(path.to_string());
            }
        }
    }
    paths.sort();
    plugin_manifests.sort();
    MarketPaths {
        skills: paths,
        plugin_manifests,
    }
}

fn plugin_manifest_resource_dir(path: &str) -> Option<String> {
    if matches!(
        path,
        ".claude-plugin/plugin.json" | ".codex-plugin/plugin.json" | "plugin.json"
    ) {
        return Some(String::new());
    }
    for suffix in [
        "/.claude-plugin/plugin.json",
        "/.codex-plugin/plugin.json",
        "/plugin.json",
    ] {
        if let Some(dir) = path.strip_suffix(suffix) {
            return Some(dir.to_string());
        }
    }
    None
}

fn is_path_under_any_dir(path: &str, dirs: &[String]) -> bool {
    dirs.iter().any(|dir| {
        if dir.is_empty() {
            return true;
        }
        path == dir || path.starts_with(&format!("{dir}/"))
    })
}

fn repo_stars(
    client: &reqwest::blocking::Client,
    github_ref: &GitHubRef,
    token: Option<&str>,
) -> Option<u64> {
    let value = repo_metadata(client, github_ref, token)?;
    value
        .get("stargazers_count")
        .and_then(|stars| stars.as_u64())
}

fn repo_metadata(
    client: &reqwest::blocking::Client,
    github_ref: &GitHubRef,
    token: Option<&str>,
) -> Option<serde_json::Value> {
    let url = format!(
        "https://api.github.com/repos/{}/{}",
        github_ref.owner, github_ref.repo
    );
    let response = github_api_get(client, &url, token).ok()?;
    let body = response.text().ok()?;
    serde_json::from_str::<serde_json::Value>(&body).ok()
}

fn fetch_raw_text(client: &reqwest::blocking::Client, url: &str) -> HubResult<String> {
    let response = client
        .get(url)
        .send()
        .map_err(|error| SkillHubError::Io(error.to_string()))?;
    if !response.status().is_success() {
        return Err(SkillHubError::Io(format!(
            "raw fetch failed: {}",
            response.status()
        )));
    }
    response
        .text()
        .map_err(|error| SkillHubError::Io(error.to_string()))
}

/// Parse a public GitHub URL into owner/repo plus an optional branch + subpath.
/// Accepts `https://github.com/owner/repo`, `.../tree/<branch>/<sub/path>`,
/// and `git@github.com:owner/repo` forms. Rejects non-GitHub URLs.
fn parse_github_ref(source: &str) -> HubResult<GitHubRef> {
    let normalized = normalize_github_url(source);
    let remainder = normalized
        .strip_prefix("https://github.com/")
        .or_else(|| normalized.strip_prefix("git@github.com:"))
        .ok_or_else(|| {
            SkillHubError::UnsupportedSource("only public GitHub URLs are supported".to_string())
        })?;
    let parts: Vec<&str> = remainder
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 2 {
        return Err(SkillHubError::UnsupportedSource(
            "GitHub source must include owner and repository".to_string(),
        ));
    }
    let owner = parts[0].to_string();
    let repo = parts[1].trim_end_matches(".git").to_string();

    let (branch, subpath) = if parts.len() > 2 && (parts[2] == "tree" || parts[2] == "blob") {
        let branch = parts.get(3).map(|value| value.to_string());
        let sub = parts
            .get(4..)
            .map(|rest| rest.join("/"))
            .filter(|s| !s.is_empty());
        (branch, sub)
    } else {
        (None, None)
    };

    Ok(GitHubRef {
        owner,
        repo,
        branch,
        subpath,
    })
}

/// raw.githubusercontent.com URL for the skill's SKILL.md given a parsed ref.
fn raw_skill_md_url(github_ref: &GitHubRef, branch: &str) -> String {
    let mut url = format!(
        "https://raw.githubusercontent.com/{}/{}/{}",
        github_ref.owner, github_ref.repo, branch
    );
    if let Some(subpath) = &github_ref.subpath {
        url.push('/');
        url.push_str(subpath);
    }
    url.push_str("/SKILL.md");
    url
}

fn candidate_branches(github_ref: &GitHubRef) -> Vec<String> {
    match &github_ref.branch {
        Some(branch) => vec![branch.clone()],
        None => vec!["main".to_string(), "master".to_string()],
    }
}

fn http_client() -> HubResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("SkillHub/0.1")
        .build()
        .map_err(|error| SkillHubError::Io(error.to_string()))
}

fn market_discovery_http_client() -> HubResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(MARKET_DISCOVERY_HTTP_TIMEOUT_SECS))
        .user_agent("SkillHub/0.1")
        .build()
        .map_err(|error| SkillHubError::Io(error.to_string()))
}

/// Download a GitHub repo tarball over HTTPS and extract it into `dest`.
/// Returns the directory the archive expanded into (codeload prefixes a
/// `<repo>-<branch>` folder). Trying configured branch, else main then master.
fn download_and_extract_repo(github_ref: &GitHubRef, dest: &Path) -> HubResult<(PathBuf, String)> {
    let client = http_client()?;
    let mut last_error = SkillHubError::Io("no branch could be downloaded".to_string());
    for branch in candidate_branches(github_ref) {
        let url = format!(
            "https://codeload.github.com/{}/{}/tar.gz/refs/heads/{}",
            github_ref.owner, github_ref.repo, branch
        );
        let response = match client.get(&url).send() {
            Ok(response) => response,
            Err(error) => {
                last_error = SkillHubError::Io(error.to_string());
                continue;
            }
        };
        if !response.status().is_success() {
            last_error = SkillHubError::Io(format!(
                "failed to download {}/{} ({branch}): {}",
                github_ref.owner,
                github_ref.repo,
                response.status()
            ));
            continue;
        }
        let bytes = response
            .bytes()
            .map_err(|error| SkillHubError::Io(error.to_string()))?;
        let branch_dest = dest.join(&branch);
        fs::create_dir_all(&branch_dest)?;
        let decoder = flate2::read::GzDecoder::new(&bytes[..]);
        let mut archive = tar::Archive::new(decoder);
        archive
            .unpack(&branch_dest)
            .map_err(|error| SkillHubError::Io(error.to_string()))?;
        let extracted_root = first_subdirectory(&branch_dest)?;
        return Ok((extracted_root, branch));
    }
    Err(last_error)
}

fn first_subdirectory(dir: &Path) -> HubResult<PathBuf> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.path().is_dir() {
            return Ok(entry.path());
        }
    }
    Err(SkillHubError::InvalidResource(
        "downloaded archive contained no directory".to_string(),
    ))
}

/// Resolve the source directory inside an extracted repo: the subpath if the
/// URL pinned one, otherwise the repo root.
fn resolve_source_dir(extracted_root: &Path, github_ref: &GitHubRef) -> HubResult<PathBuf> {
    let candidate = match &github_ref.subpath {
        Some(subpath) => extracted_root.join(subpath),
        None => extracted_root.to_path_buf(),
    };
    let canonical = canonical_existing(&candidate)?;
    // Containment guard: the resolved path must stay inside the extracted repo.
    assert_inside(&canonical, &canonical_existing(extracted_root)?)?;
    Ok(canonical)
}

pub fn install_github_resource(
    source: &str,
    host_root: &HostRoot,
    kind: ResourceKind,
    name: &str,
) -> HubResult<()> {
    validate_github_source(source)?;
    let github_ref = parse_github_ref(source)?;
    // Fail fast on name/conflict/containment before doing any network IO.
    let preview = preview_install_common(source.to_string(), None, host_root, kind, name)?;

    let staging = staging_dir(name)?;
    let result = (|| {
        let (extracted_root, _branch) = download_and_extract_repo(&github_ref, &staging)?;
        let source_dir = resolve_source_dir(&extracted_root, &github_ref)?;
        validate_resource_shape(&source_dir, kind)?;
        if preview.target_path.exists() {
            return Err(SkillHubError::NameConflict(format!(
                "{} already exists",
                preview.target_path.display()
            )));
        }
        copy_dir_filtered(&source_dir, &preview.target_path)
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

pub fn check_github_update(source: &str, local_path: &Path) -> HubResult<UpdateCheck> {
    validate_github_source(source)?;
    let github_ref = parse_github_ref(source)?;
    let local_sha = file_sha256(&local_path.join("SKILL.md")).ok();

    let client = http_client()?;
    let mut remote_sha = None;
    let mut detail = None;
    for branch in candidate_branches(&github_ref) {
        let url = raw_skill_md_url(&github_ref, &branch);
        match client.get(&url).send() {
            Ok(response) if response.status().is_success() => {
                if let Ok(body) = response.bytes() {
                    remote_sha = Some(sha256_bytes(&body));
                    break;
                }
            }
            Ok(response) => {
                detail = Some(format!("{}", response.status()));
            }
            Err(error) => {
                detail = Some(error.to_string());
            }
        }
    }

    let status = compare_update_status(local_sha.as_deref(), remote_sha.as_deref());
    Ok(UpdateCheck {
        status: status.to_string(),
        source_url: normalize_github_url(source),
        local_sha256: local_sha,
        remote_sha256: remote_sha,
        detail,
    })
}

/// Pure comparison of local vs remote SKILL.md hashes.
fn compare_update_status(local: Option<&str>, remote: Option<&str>) -> &'static str {
    match (local, remote) {
        (Some(local), Some(remote)) if local.eq_ignore_ascii_case(remote) => "up-to-date",
        (Some(_), Some(_)) => "update-available",
        _ => "unknown",
    }
}

pub fn update_github_resource(
    source: &str,
    host_root: &HostRoot,
    kind: ResourceKind,
    name: &str,
    existing_path: &Path,
    trash: &mut dyn Trash,
) -> HubResult<()> {
    validate_github_source(source)?;
    let github_ref = parse_github_ref(source)?;
    let root = canonical_or_create(&host_root.root)?;
    let existing = canonical_existing(existing_path)?;
    assert_inside(&existing, &root)?;

    // Download + validate into staging BEFORE touching the installed copy, so a
    // network or validation failure leaves the existing skill untouched.
    let staging = staging_dir(name)?;
    let staged_source = (|| {
        let (extracted_root, _branch) = download_and_extract_repo(&github_ref, &staging)?;
        let source_dir = resolve_source_dir(&extracted_root, &github_ref)?;
        validate_resource_shape(&source_dir, kind)?;
        Ok::<PathBuf, SkillHubError>(source_dir)
    })();

    let result = (|| {
        let source_dir = staged_source?;
        let target_path = target_path_for(&root, kind, name);
        assert_inside_nonexistent(&target_path, &root)?;
        // Move the existing copy to trash, then install fresh. No permanent delete.
        trash.trash(&existing)?;
        copy_dir_filtered(&source_dir, &target_path)
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

fn staging_dir(name: &str) -> HubResult<PathBuf> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let safe_name: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let dir = std::env::temp_dir().join(format!("skill-hub-dl-{safe_name}-{nonce}"));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn fetch_github_index(url: &str) -> HubResult<Vec<GitHubIndexEntry>> {
    if !url.starts_with("https://") {
        return Err(SkillHubError::UnsupportedSource(
            "GitHub index URL must use https://".to_string(),
        ));
    }
    let client = market_discovery_http_client()?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| SkillHubError::Io(error.to_string()))?;
    if !response.status().is_success() {
        return Err(SkillHubError::Io(format!(
            "failed to fetch index {url}: {}",
            response.status()
        )));
    }
    let body = response
        .text()
        .map_err(|error| SkillHubError::Io(error.to_string()))?;
    let value = serde_json::from_str::<serde_json::Value>(&body)
        .map_err(|error| SkillHubError::InvalidResource(error.to_string()))?;
    Ok(parse_github_index_value(&value))
}

fn parse_github_index_value(value: &serde_json::Value) -> Vec<GitHubIndexEntry> {
    let items = value
        .as_array()
        .or_else(|| value.get("skills").and_then(|value| value.as_array()))
        .or_else(|| value.get("resources").and_then(|value| value.as_array()))
        .into_iter()
        .flatten();

    items.filter_map(parse_github_index_entry).collect()
}

fn parse_github_index_entry(value: &serde_json::Value) -> Option<GitHubIndexEntry> {
    let name = string_field(value, &["name", "skill", "id"])?;
    let kind = match string_field(value, &["kind", "type", "resourceKind"])
        .unwrap_or("skill")
        .to_ascii_lowercase()
        .as_str()
    {
        "plugin" => ResourceKind::Plugin,
        _ => ResourceKind::Skill,
    };
    let source_url = string_field(
        value,
        &[
            "repository",
            "repo",
            "url",
            "sourceUrl",
            "source_url",
            "homepage",
        ],
    )
    .filter(|url| url.contains("github.com"))
    .map(normalize_github_url)?;
    let summary = string_field(value, &["description", "summary"]);
    let skill_sha256 = string_field(
        value,
        &["skillSha256", "skill_sha256", "sha256", "hash", "skillHash"],
    )
    .map(|hash| hash.to_ascii_lowercase());

    Some(GitHubIndexEntry {
        name: name.to_string(),
        kind,
        summary: summary.map(str::to_string),
        source_url,
        skill_sha256,
    })
}

fn string_field<'a>(value: &'a serde_json::Value, names: &[&str]) -> Option<&'a str> {
    names.iter().find_map(|name| value.get(name)?.as_str())
}

fn normalize_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn file_sha256(path: &Path) -> HubResult<String> {
    let bytes = fs::read(path)?;
    Ok(sha256_bytes(&bytes))
}

fn compatibility_for(host: HostKind, kind: ResourceKind) -> Vec<String> {
    match kind {
        ResourceKind::Skill => vec![host.to_string(), opposite_host(host).to_string()],
        ResourceKind::Plugin => vec![host.to_string()],
        ResourceKind::Unknown => vec![host.to_string()],
    }
}

fn opposite_host(host: HostKind) -> HostKind {
    match host {
        HostKind::Codex => HostKind::Claude,
        HostKind::Claude => HostKind::Codex,
    }
}

fn scan_warnings_without_sensitive_names(path: &Path) -> HubResult<Vec<String>> {
    let mut warnings = Vec::new();
    if !path.join("README.md").exists() {
        warnings.push("README not found".to_string());
    }
    warnings.sort();
    warnings.dedup();
    Ok(warnings)
}

pub fn preview_install(
    source: &str,
    host_root: &HostRoot,
    kind: ResourceKind,
    name: &str,
) -> HubResult<InstallPreview> {
    validate_github_source(source)?;
    preview_install_common(source.to_string(), None, host_root, kind, name)
}

#[cfg(test)]
pub fn preview_local_install_for_tests(
    source_path: &Path,
    host_root: &HostRoot,
    kind: ResourceKind,
    name: &str,
) -> HubResult<InstallPreview> {
    let source_path = canonical_existing(source_path)?;
    if !source_path.is_dir() {
        return Err(SkillHubError::InvalidResource(
            "source must be a directory".to_string(),
        ));
    }
    preview_install_common(
        source_path.display().to_string(),
        Some(source_path),
        host_root,
        kind,
        name,
    )
}

fn preview_install_common(
    source: String,
    source_path: Option<PathBuf>,
    host_root: &HostRoot,
    kind: ResourceKind,
    name: &str,
) -> HubResult<InstallPreview> {
    if name.trim().is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name == "."
        || name == ".."
    {
        return Err(SkillHubError::InvalidResource(
            "resource name must be a single path segment".to_string(),
        ));
    }
    let root = canonical_or_create(&host_root.root)?;
    let target_path = target_path_for(&root, kind, name);
    assert_inside_nonexistent(&target_path, &root)?;
    if target_path.exists() {
        return Err(SkillHubError::NameConflict(format!(
            "{name} already exists at {}",
            target_path.display()
        )));
    }
    Ok(InstallPreview {
        source,
        source_path,
        host: host_root.host,
        kind,
        name: name.to_string(),
        target_path,
        warnings: Vec::new(),
    })
}

fn validate_github_source(source: &str) -> HubResult<()> {
    let lower = source.to_ascii_lowercase();
    if lower.starts_with("file:") || lower.starts_with('/') || lower.starts_with("..") {
        return Err(SkillHubError::UnsupportedSource(
            "local file sources are not supported".to_string(),
        ));
    }
    let github_prefixes = ["https://github.com/", "git@github.com:"];
    if !github_prefixes
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        return Err(SkillHubError::UnsupportedSource(
            "only public GitHub repository URLs are supported".to_string(),
        ));
    }
    let remainder = lower
        .trim_start_matches("https://github.com/")
        .trim_start_matches("git@github.com:");
    let parts: Vec<&str> = remainder
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 2 {
        return Err(SkillHubError::UnsupportedSource(
            "GitHub source must include owner and repository".to_string(),
        ));
    }
    Ok(())
}

pub fn install_from_preview(preview: &InstallPreview) -> HubResult<()> {
    let Some(source_path) = &preview.source_path else {
        return Err(SkillHubError::UnsupportedSource(
            "network GitHub installation is preview-only in this MVP".to_string(),
        ));
    };
    if preview.target_path.exists() {
        return Err(SkillHubError::NameConflict(format!(
            "{} already exists",
            preview.target_path.display()
        )));
    }
    validate_resource_shape(source_path, preview.kind)?;
    copy_dir_filtered(source_path, &preview.target_path)
}

fn validate_resource_shape(path: &Path, kind: ResourceKind) -> HubResult<()> {
    let valid = match kind {
        ResourceKind::Skill => path.join("SKILL.md").is_file(),
        ResourceKind::Plugin => {
            path.join("plugin.json").is_file()
                || path.join(".codex-plugin/plugin.json").is_file()
                || path.join(".claude-plugin/plugin.json").is_file()
        }
        ResourceKind::Unknown => false,
    };
    if valid {
        Ok(())
    } else {
        Err(SkillHubError::InvalidResource(format!(
            "{} does not match {kind} shape",
            path.display()
        )))
    }
}

fn copy_dir_filtered(source: &Path, target: &Path) -> HubResult<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        if is_sensitive_path(&source_path) {
            continue;
        }
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_filtered(&source_path, &target_path)?;
        } else if source_path.is_file() {
            fs::copy(&source_path, &target_path)?;
        }
    }
    Ok(())
}

pub trait Trash {
    fn trash(&mut self, path: &Path) -> HubResult<()>;
}

pub struct SystemTrash;

impl Trash for SystemTrash {
    fn trash(&mut self, path: &Path) -> HubResult<()> {
        let trash_dir = system_trash_dir()?;
        fs::create_dir_all(&trash_dir)
            .map_err(|error| SkillHubError::TrashFailed(error.to_string()))?;
        if !trash_dir.is_dir() {
            return Err(SkillHubError::TrashFailed(
                "system trash directory is unavailable".to_string(),
            ));
        }
        let file_name = path.file_name().ok_or_else(|| {
            SkillHubError::TrashFailed("resource path has no file name".to_string())
        })?;
        let mut target = trash_dir.join(file_name);
        let mut suffix = 1;
        while target.exists() {
            target = trash_dir.join(format!("{}-{suffix}", file_name.to_string_lossy()));
            suffix += 1;
        }
        fs::rename(path, target).map_err(|error| SkillHubError::TrashFailed(error.to_string()))
    }
}

fn system_trash_dir() -> HubResult<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = user_home_dir().ok_or_else(|| {
            SkillHubError::TrashFailed("HOME is required to use the system trash".to_string())
        })?;
        Ok(home.join(".Trash"))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = user_home_dir().ok_or_else(|| {
            SkillHubError::TrashFailed("HOME is required to use the system trash".to_string())
        })?;
        if let Ok(data_home) = std::env::var("XDG_DATA_HOME") {
            return Ok(PathBuf::from(data_home).join("Trash").join("files"));
        }
        Ok(home.join(".local/share/Trash/files"))
    }

    #[cfg(windows)]
    {
        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            return Ok(PathBuf::from(base).join("Skill Hub").join("Trash"));
        }
        let home = user_home_dir().ok_or_else(|| {
            SkillHubError::TrashFailed("USERPROFILE is required to use the app trash".to_string())
        })?;
        Ok(home.join("AppData/Local/Skill Hub/Trash"))
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct RecordingTrash {
    pub paths: Vec<PathBuf>,
    pub permanent_delete_attempted: Option<PathBuf>,
}

#[cfg(test)]
impl Trash for RecordingTrash {
    fn trash(&mut self, path: &Path) -> HubResult<()> {
        self.paths.push(path.to_path_buf());
        Ok(())
    }
}

pub fn delete_resource_with_trash(
    path: &Path,
    root: &Path,
    trash: &mut dyn Trash,
) -> HubResult<()> {
    let root = canonical_existing(root)?;
    let path = canonical_existing(path)?;
    assert_inside(&path, &root)?;
    trash.trash(&path)
}

fn target_path_for(root: &Path, kind: ResourceKind, name: &str) -> PathBuf {
    match kind {
        ResourceKind::Skill => root.join("skills").join(name),
        ResourceKind::Plugin => root.join("plugins").join(name),
        ResourceKind::Unknown => root.join("unknown").join(name),
    }
}

fn canonical_existing(path: &Path) -> HubResult<PathBuf> {
    path.canonicalize().map_err(SkillHubError::from)
}

fn canonical_or_create(path: &Path) -> HubResult<PathBuf> {
    fs::create_dir_all(path)?;
    canonical_existing(path)
}

fn absolutize(path: &Path) -> HubResult<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn assert_inside(path: &Path, root: &Path) -> HubResult<()> {
    if path.starts_with(root) {
        Ok(())
    } else {
        Err(SkillHubError::OutsideRoot(format!(
            "{} is outside {}",
            path.display(),
            root.display()
        )))
    }
}

fn assert_inside_nonexistent(path: &Path, root: &Path) -> HubResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| SkillHubError::OutsideRoot("target has no parent".to_string()))?;
    fs::create_dir_all(parent)?;
    let parent = canonical_existing(parent)?;
    assert_inside(&parent, root)
}

fn is_sensitive_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    lower == ".env"
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("credential")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            scan_inventory,
            match_github_sources,
            browse_market,
            discover_market,
            discover_market_source,
            discover_curated_catalog,
            discover_builtin_index,
            refresh_remote_index,
            discover_repo,
            install_github_skill,
            check_skill_update,
            update_github_skill,
            preview_source,
            install_resource,
            delete_resource
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("skill-hub-{name}-{nonce}"));
        fs::create_dir_all(&root).expect("temp root");
        root.canonicalize().expect("canonical temp root")
    }

    fn write_file(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
        fs::write(path, contents).expect("write file");
    }

    #[test]
    fn codex_adapter_scans_absolute_children_and_skips_sensitive_files() {
        let root = temp_root("codex-scan");
        write_file(
            &root.join("skills/reviewer/SKILL.md"),
            "# Reviewer\nReview code.",
        );
        write_file(&root.join("skills/reviewer/.env"), "TOKEN=secret");
        write_file(
            &root.join("plugins/deploy/.codex-plugin/plugin.json"),
            "{\"name\":\"deploy\"}",
        );
        write_file(&root.join("plugins/deploy/github-token.txt"), "secret");

        let resources = scan_host(&HostRoot::new(HostKind::Codex, root.clone())).expect("scan");

        assert_eq!(resources.len(), 2);
        assert!(resources.iter().all(|resource| resource.path.is_absolute()));
        assert!(resources
            .iter()
            .all(|resource| resource.path.starts_with(&root)));
        assert!(resources
            .iter()
            .any(|resource| resource.kind == ResourceKind::Skill));
        assert!(resources
            .iter()
            .any(|resource| resource.kind == ResourceKind::Plugin));
        assert!(resources
            .iter()
            .flat_map(|resource| resource.warnings.iter())
            .all(|warning| !warning.contains(".env") && !warning.contains("token")));
    }

    #[cfg(unix)]
    #[test]
    fn adapter_scans_nested_and_linked_skills_without_failing_root_containment() {
        let root = temp_root("linked-scan-root");
        let external = temp_root("linked-scan-external");
        write_file(
            &root.join("skills/.system/openai-docs/SKILL.md"),
            "# OpenAI Docs",
        );
        write_file(&external.join("pptx/SKILL.md"), "# PPTX");
        std::os::unix::fs::symlink(external.join("pptx"), root.join("skills/pptx"))
            .expect("skill symlink");

        let resources = scan_host(&HostRoot::new(HostKind::Codex, root.clone())).expect("scan");

        assert!(resources
            .iter()
            .any(|resource| resource.name == "openai-docs"));
        let linked = resources
            .iter()
            .find(|resource| resource.name == "pptx")
            .expect("linked skill");
        assert!(linked.path.starts_with(root.join("skills")));
        assert!(linked
            .warnings
            .iter()
            .any(|warning| warning.contains("Linked to")));
    }

    #[test]
    fn adapter_marks_github_skills_with_source_url_and_trackable_status() {
        let root = temp_root("github-origin");
        write_file(
            &root.join("skills/create-ex/SKILL.md"),
            "---\nname: create-ex\ndescription: Create executable tools\n---\n",
        );
        write_file(
            &root.join("skills/create-ex/.git/config"),
            "[remote \"origin\"]\n\turl = https://github.com/perkfly/ex-skill.git\n",
        );

        let resources = scan_host(&HostRoot::new(HostKind::Claude, root)).expect("scan");
        let resource = resources
            .iter()
            .find(|resource| resource.name == "create-ex")
            .expect("github skill");

        assert_eq!(resource.source_kind, SourceKind::GitHub);
        assert_eq!(
            resource.source_url.as_deref(),
            Some("https://github.com/perkfly/ex-skill")
        );
        assert_eq!(resource.update_status, "Trackable");
        assert_eq!(resource.summary, "Create executable tools");
    }

    #[test]
    fn github_index_matches_skills_by_hash_and_name_summary() {
        let root = temp_root("github-index-match");
        write_file(
            &root.join("skills/ppt-master/SKILL.md"),
            "---\nname: ppt-master\ndescription: Make presentations\n---\n",
        );
        write_file(
            &root.join("skills/other/SKILL.md"),
            "---\nname: other\ndescription: Other skill\n---\n",
        );
        let resources = scan_host(&HostRoot::new(HostKind::Codex, root.clone())).expect("scan");
        let ppt = resources
            .iter()
            .find(|resource| resource.name == "ppt-master")
            .expect("ppt");
        let ppt_hash = file_sha256(&ppt.path.join("SKILL.md")).expect("hash");
        let index = serde_json::json!([
          {
            "name": "ppt-master",
            "repository": "https://github.com/acme/ppt-master",
            "description": "different",
            "skillSha256": ppt_hash
          },
          {
            "name": "other",
            "repository": "https://github.com/acme/other",
            "description": "Other skill"
          }
        ]);
        let entries = parse_github_index_value(&index);
        let matches = match_resources_with_entries(&resources, &entries);

        assert_eq!(entries.len(), 2);
        let verified = matches
            .iter()
            .find(|item| item.source_url == "https://github.com/acme/ppt-master")
            .expect("verified match");
        assert_eq!(verified.confidence, "verified");
        assert_eq!(verified.matched_by, "skill_sha256");
        let probable = matches
            .iter()
            .find(|item| item.source_url == "https://github.com/acme/other")
            .expect("probable match");
        assert_eq!(probable.confidence, "probable");
        assert_eq!(probable.matched_by, "name_summary");
    }

    #[test]
    fn extra_skill_path_scans_direct_skill_and_container_directory() {
        let direct = temp_root("extra-direct");
        write_file(&direct.join("SKILL.md"), "# Direct");
        let container = temp_root("extra-container");
        write_file(&container.join("alpha/SKILL.md"), "# Alpha");
        write_file(&container.join("nested/beta/SKILL.md"), "# Beta");

        let mut resources = scan_extra_skill_path(&direct).expect("direct scan");
        resources.extend(scan_extra_skill_path(&container).expect("container scan"));

        let direct_name = direct
            .file_name()
            .and_then(|name| name.to_str())
            .expect("name");
        assert!(resources
            .iter()
            .any(|resource| resource.name == direct_name));
        assert!(resources.iter().any(|resource| resource.name == "alpha"));
        assert!(resources.iter().any(|resource| resource.name == "beta"));
        assert!(resources
            .iter()
            .all(|resource| resource.kind == ResourceKind::Skill));
    }

    #[test]
    fn claude_adapter_identifies_skill_and_plugin_fixtures() {
        let root = temp_root("claude-scan");
        write_file(&root.join("skills/refactor/SKILL.md"), "# Refactor");
        write_file(
            &root.join("plugins/search/plugin.json"),
            "{\"name\":\"search\"}",
        );

        let resources = scan_host(&HostRoot::new(HostKind::Claude, root.clone())).expect("scan");

        assert_eq!(resources.len(), 2);
        assert!(resources
            .iter()
            .any(|resource| resource.host == HostKind::Claude
                && resource.kind == ResourceKind::Skill
                && resource.name == "refactor"));
        assert!(resources
            .iter()
            .any(|resource| resource.host == HostKind::Claude
                && resource.kind == ResourceKind::Plugin
                && resource.name == "search"));
    }

    #[test]
    fn plugin_adapter_prefers_manifest_display_name_over_version_directory() {
        let root = temp_root("plugin-name-scan");
        write_file(
            &root.join("plugins/browser/26.616.51431/.codex-plugin/plugin.json"),
            r#"{
              "name": "browser",
              "description": "Browser plugin",
              "repository": "https://github.com/openai/openai/tree/main/browser",
              "interface": {
                "displayName": "Browser",
                "shortDescription": "Control the in-app browser"
              }
            }"#,
        );

        let resources = scan_host(&HostRoot::new(HostKind::Codex, root)).expect("scan");
        let plugin = resources
            .iter()
            .find(|resource| resource.kind == ResourceKind::Plugin)
            .expect("plugin");

        assert_eq!(plugin.name, "Browser");
        assert_eq!(plugin.summary, "Control the in-app browser");
        assert_eq!(
            plugin.source_url.as_deref(),
            Some("https://github.com/openai/openai/tree/main/browser")
        );
    }

    #[test]
    fn bundled_runtime_plugins_stay_native_even_when_manifest_has_repository() {
        let root = temp_root("runtime-plugin-source");
        write_file(
            &root.join("plugins/cache/openai-primary-runtime/presentations/26.619.11828/.codex-plugin/plugin.json"),
            r#"{
              "name": "presentations",
              "repository": "https://github.com/openai/openai/tree/main/lib/presentations/plugin",
              "interface": {
                "displayName": "Presentations",
                "shortDescription": "Create or edit PowerPoint decks"
              }
            }"#,
        );

        let resources = scan_host(&HostRoot::new(HostKind::Codex, root)).expect("scan");
        let plugin = resources
            .iter()
            .find(|resource| resource.name == "Presentations")
            .expect("plugin");

        assert_eq!(plugin.source_kind, SourceKind::Native);
        assert_eq!(plugin.update_status, "Managed");
        assert_eq!(
            plugin.source_url.as_deref(),
            Some("https://github.com/openai/openai/tree/main/lib/presentations/plugin")
        );
    }

    #[test]
    fn install_preview_accepts_github_sources_and_rejects_local_urls_and_conflicts() {
        let root = temp_root("preview");
        write_file(&root.join("skills/existing/SKILL.md"), "# Existing");

        let accepted = preview_install(
            "https://github.com/acme/tools/tree/main/skills/new-skill",
            &HostRoot::new(HostKind::Codex, root.clone()),
            ResourceKind::Skill,
            "new-skill",
        )
        .expect("preview");

        assert_eq!(accepted.name, "new-skill");
        assert!(accepted.target_path.starts_with(&root));

        let rejected = preview_install(
            "file:///tmp/local",
            &HostRoot::new(HostKind::Codex, root.clone()),
            ResourceKind::Skill,
            "local",
        );
        assert!(matches!(rejected, Err(SkillHubError::UnsupportedSource(_))));

        let conflict = preview_install(
            "https://github.com/acme/tools",
            &HostRoot::new(HostKind::Codex, root),
            ResourceKind::Skill,
            "existing",
        );
        assert!(matches!(conflict, Err(SkillHubError::NameConflict(_))));
    }

    #[test]
    fn install_copies_validated_resources_once_inside_root() {
        let root = temp_root("install-root");
        let source = temp_root("install-source").join("copy-me");
        write_file(&source.join("SKILL.md"), "# Copy Me");
        write_file(&source.join("README.md"), "readme");

        let preview = preview_local_install_for_tests(
            &source,
            &HostRoot::new(HostKind::Codex, root.clone()),
            ResourceKind::Skill,
            "copy-me",
        )
        .expect("preview");

        install_from_preview(&preview).expect("install");
        assert!(root.join("skills/copy-me/SKILL.md").exists());

        let second = install_from_preview(&preview);
        assert!(matches!(second, Err(SkillHubError::NameConflict(_))));
    }

    #[test]
    fn delete_uses_trash_abstraction_without_permanent_fallback() {
        let root = temp_root("trash-root");
        let resource = root.join("skills/remove-me");
        write_file(&resource.join("SKILL.md"), "# Remove Me");
        let mut trash = RecordingTrash::default();
        let canonical_resource = resource.canonicalize().expect("canonical");

        delete_resource_with_trash(&resource, &root, &mut trash).expect("delete");

        assert_eq!(trash.paths, vec![canonical_resource]);
        assert!(trash.permanent_delete_attempted.is_none());
    }

    #[test]
    fn parses_github_ref_with_and_without_tree_subpath() {
        let plain = parse_github_ref("https://github.com/acme/tools").expect("plain");
        assert_eq!(plain.owner, "acme");
        assert_eq!(plain.repo, "tools");
        assert_eq!(plain.branch, None);
        assert_eq!(plain.subpath, None);

        let nested = parse_github_ref("https://github.com/openai/openai/tree/main/skills/browser")
            .expect("nested");
        assert_eq!(nested.owner, "openai");
        assert_eq!(nested.repo, "openai");
        assert_eq!(nested.branch.as_deref(), Some("main"));
        assert_eq!(nested.subpath.as_deref(), Some("skills/browser"));

        let ssh = parse_github_ref("git@github.com:acme/tools.git").expect("ssh");
        assert_eq!(ssh.owner, "acme");
        assert_eq!(ssh.repo, "tools");

        assert!(matches!(
            parse_github_ref("https://gitlab.com/acme/tools"),
            Err(SkillHubError::UnsupportedSource(_))
        ));
    }

    #[test]
    fn archive_market_discovery_scans_local_skill_files() {
        let extracted = temp_root("archive-market");
        write_file(
            &extracted.join("skills/alpha/SKILL.md"),
            "---\ndescription: Alpha summary\n---\n# Alpha",
        );
        write_file(
            &extracted.join("skills/nested/beta/SKILL.md"),
            "# Beta\nBeta summary",
        );
        write_file(&extracted.join("README.md"), "not a skill");

        let github_ref = parse_github_ref("https://github.com/acme/tools").expect("github ref");
        let candidates =
            discover_repo_skill_candidates_from_dir(&github_ref, &extracted, "main", Some(42))
                .expect("archive candidates");

        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].name, "alpha");
        assert_eq!(candidates[0].summary.as_deref(), Some("Alpha summary"));
        assert_eq!(
            candidates[0].source_url,
            "https://github.com/acme/tools/tree/main/skills/alpha"
        );
        assert_eq!(candidates[0].stars, Some(42));
        assert_eq!(candidates[1].name, "beta");
        assert_eq!(
            candidates[1].source_url,
            "https://github.com/acme/tools/tree/main/skills/nested/beta"
        );
    }

    #[test]
    fn derives_raw_skill_md_url_for_branch_and_subpath() {
        let nested = parse_github_ref("https://github.com/openai/openai/tree/main/skills/browser")
            .expect("nested");
        assert_eq!(
            raw_skill_md_url(&nested, "main"),
            "https://raw.githubusercontent.com/openai/openai/main/skills/browser/SKILL.md"
        );

        let plain = parse_github_ref("https://github.com/acme/tools").expect("plain");
        assert_eq!(
            raw_skill_md_url(&plain, "master"),
            "https://raw.githubusercontent.com/acme/tools/master/SKILL.md"
        );
        assert_eq!(candidate_branches(&plain), vec!["main", "master"]);
        assert_eq!(candidate_branches(&nested), vec!["main"]);
    }

    #[test]
    fn compares_update_status_from_local_and_remote_hashes() {
        assert_eq!(
            compare_update_status(Some("ABC"), Some("abc")),
            "up-to-date"
        );
        assert_eq!(
            compare_update_status(Some("abc"), Some("def")),
            "update-available"
        );
        assert_eq!(compare_update_status(None, Some("abc")), "unknown");
        assert_eq!(compare_update_status(Some("abc"), None), "unknown");
    }

    #[test]
    fn market_entries_dedupe_and_flag_installed_resources() {
        let root = temp_root("market-mark");
        write_file(
            &root.join("skills/ppt-master/SKILL.md"),
            "---\nname: ppt-master\ndescription: Make presentations\n---\n",
        );
        let resources = scan_host(&HostRoot::new(HostKind::Codex, root)).expect("scan");
        let candidates = vec![
            MarketCandidate::from_index_entry(GitHubIndexEntry {
                name: "ppt-master".to_string(),
                kind: ResourceKind::Skill,
                summary: Some("Make presentations".to_string()),
                source_url: "https://github.com/acme/ppt-master".to_string(),
                skill_sha256: None,
            }),
            // Duplicate source_url should be deduped.
            MarketCandidate::from_index_entry(GitHubIndexEntry {
                name: "ppt-master".to_string(),
                kind: ResourceKind::Skill,
                summary: None,
                source_url: "https://github.com/acme/ppt-master".to_string(),
                skill_sha256: None,
            }),
            MarketCandidate::from_index_entry(GitHubIndexEntry {
                name: "not-installed".to_string(),
                kind: ResourceKind::Skill,
                summary: Some("Another tool".to_string()),
                source_url: "https://github.com/acme/other".to_string(),
                skill_sha256: None,
            }),
        ];

        let market = assemble_market(candidates, &resources);

        assert_eq!(market.len(), 2);
        let ppt = market
            .iter()
            .find(|entry| entry.name == "ppt-master")
            .expect("ppt market entry");
        assert!(ppt.installed);
        assert!(ppt.installed_id.is_some());
        assert_eq!(ppt.repo.as_deref(), Some("acme/ppt-master"));
        let other = market
            .iter()
            .find(|entry| entry.name == "not-installed")
            .expect("other market entry");
        assert!(!other.installed);
        assert!(other.installed_id.is_none());
    }

    #[test]
    fn extracts_skill_md_paths_from_trees_response() {
        let trees = serde_json::json!({
            "tree": [
                { "path": "README.md", "type": "blob" },
                { "path": "skills", "type": "tree" },
                { "path": "skills/pdf/SKILL.md", "type": "blob" },
                { "path": "skills/pdf/scripts/run.py", "type": "blob" },
                { "path": "skills/docx/SKILL.md", "type": "blob" },
                { "path": "plugins/github/.claude-plugin/plugin.json", "type": "blob" },
                { "path": "plugins/github/skills/internal/SKILL.md", "type": "blob" },
                { "path": "SKILL.md", "type": "blob" }
            ]
        });
        let paths = extract_skill_md_paths(&trees);
        assert_eq!(
            paths,
            vec![
                "SKILL.md".to_string(),
                "plugins/github/skills/internal/SKILL.md".to_string(),
                "skills/docx/SKILL.md".to_string(),
                "skills/pdf/SKILL.md".to_string(),
            ]
        );
        let market_paths = extract_market_paths(&trees);
        assert_eq!(
            market_paths.plugin_manifests,
            vec!["plugins/github/.claude-plugin/plugin.json".to_string()]
        );
    }

    #[test]
    fn curated_official_catalog_is_complete_and_well_formed() {
        let candidates = curated_official_candidates();
        assert_eq!(candidates.len(), 17);
        assert!(candidates.iter().all(|candidate| {
            candidate.origin == "official"
                && candidate.summary.is_some()
                && candidate
                    .source_url
                    .starts_with("https://github.com/anthropics/skills/tree/main/skills/")
                && candidate.repo.as_deref() == Some("anthropics/skills")
        }));
        let pdf = candidates
            .iter()
            .find(|candidate| candidate.name == "pdf")
            .expect("pdf in catalog");
        assert_eq!(
            pdf.source_url,
            "https://github.com/anthropics/skills/tree/main/skills/pdf"
        );
    }

    #[test]
    fn market_sorts_by_stars_then_name_as_leaderboard() {
        let candidates = vec![
            MarketCandidate {
                name: "zeta".to_string(),
                kind: ResourceKind::Skill,
                summary: None,
                source_url: "https://github.com/a/zeta".to_string(),
                skill_sha256: None,
                repo: Some("a/zeta".to_string()),
                stars: Some(10),
                origin: "community".to_string(),
                categories: None,
                hotness: None,
                description: None,
                updated_at: None,
                index_id: None,
            },
            MarketCandidate {
                name: "alpha".to_string(),
                kind: ResourceKind::Skill,
                summary: None,
                source_url: "https://github.com/a/alpha".to_string(),
                skill_sha256: None,
                repo: Some("a/alpha".to_string()),
                stars: Some(500),
                origin: "community".to_string(),
                categories: None,
                hotness: None,
                description: None,
                updated_at: None,
                index_id: None,
            },
            MarketCandidate {
                name: "beta".to_string(),
                kind: ResourceKind::Skill,
                summary: None,
                source_url: "https://github.com/a/beta".to_string(),
                skill_sha256: None,
                repo: Some("a/beta".to_string()),
                stars: None,
                origin: "community".to_string(),
                categories: None,
                hotness: None,
                description: None,
                updated_at: None,
                index_id: None,
            },
        ];
        let market = assemble_market(candidates, &[]);
        let order: Vec<&str> = market.iter().map(|entry| entry.name.as_str()).collect();
        // Highest stars first; the star-less entry sorts last.
        assert_eq!(order, vec!["alpha", "zeta", "beta"]);
    }

    #[test]
    fn browse_market_v2_includes_curated_catalog_offline() {
        // No sources, curated on: must return the 17 built-in index skills with
        // no network access at all. The built-in index replaced the old
        // hardcoded curated list, so origin is "index" (not "official").
        let (entries, warnings) = browse_market_v2(&[], None, true, &[], None, None);
        assert_eq!(entries.len(), 17);
        assert!(warnings.is_empty());
        assert!(entries.iter().all(|entry| entry.origin == "index"));
        assert!(entries
            .iter()
            .all(|entry| entry.kind == ResourceKind::Skill));
        assert!(entries.iter().any(|entry| entry.name == "pdf"));
    }

    #[test]
    fn discover_builtin_index_returns_all_skills() {
        // L1: discover_builtin_index must return all 17 built-in skills
        // immediately with no warnings, even when no resources are installed.
        let result = discover_builtin_index(vec![]).expect("builtin index should load");
        assert_eq!(result.entries.len(), 17);
        assert!(result.warnings.is_empty());
        assert!(result
            .entries
            .iter()
            .all(|entry| entry.kind == ResourceKind::Skill));
        assert!(result.entries.iter().all(|entry| !entry.installed));
        assert!(result.entries.iter().all(|entry| entry.origin == "index"));
        // Hotness and stars should be populated from the index file.
        assert!(result.entries.iter().all(|entry| entry.hotness.is_some()));
        assert!(result.entries.iter().all(|entry| entry.stars.is_some()));
    }

    #[test]
    fn archive_market_discovery_separates_plugins_from_skills() {
        let extracted = temp_root("market-plugin-discovery");
        write_file(
            &extracted.join("plugins/github/.claude-plugin/plugin.json"),
            r#"{"name":"github-plugin","description":"GitHub integration"}"#,
        );
        write_file(
            &extracted.join("plugins/github/skills/internal/SKILL.md"),
            "---\nname: internal-plugin-skill\ndescription: Should stay inside plugin\n---\n",
        );
        write_file(
            &extracted.join("skills/pdf/SKILL.md"),
            "---\nname: pdf\ndescription: PDF skill\n---\n",
        );
        let github_ref = GitHubRef {
            owner: "acme".to_string(),
            repo: "catalog".to_string(),
            branch: None,
            subpath: None,
        };

        let candidates =
            discover_repo_skill_candidates_from_dir(&github_ref, &extracted, "main", Some(42))
                .expect("discover from dir");

        assert!(candidates.iter().any(|candidate| {
            candidate.name == "github-plugin" && candidate.kind == ResourceKind::Plugin
        }));
        assert!(candidates
            .iter()
            .any(|candidate| { candidate.name == "pdf" && candidate.kind == ResourceKind::Skill }));
        assert!(!candidates
            .iter()
            .any(|candidate| candidate.name == "internal-plugin-skill"));
    }

    #[test]
    fn resolve_source_dir_honors_subpath_and_stays_inside_repo() {
        let extracted = temp_root("extract-root");
        write_file(&extracted.join("skills/browser/SKILL.md"), "# Browser");

        let nested = parse_github_ref("https://github.com/openai/openai/tree/main/skills/browser")
            .expect("nested");
        let resolved = resolve_source_dir(&extracted, &nested).expect("resolve");
        assert!(resolved.ends_with("skills/browser"));
        assert!(resolved.join("SKILL.md").is_file());

        let plain = parse_github_ref("https://github.com/openai/openai").expect("plain");
        let root_resolved = resolve_source_dir(&extracted, &plain).expect("resolve root");
        assert_eq!(
            root_resolved,
            extracted.canonicalize().expect("canonical extract")
        );
    }

    #[test]
    fn install_github_skill_copies_extracted_tarball_into_root() {
        // Build a real .tar.gz fixture and extract it, exercising the offline
        // half of the install path (download is the only networked step).
        let repo = temp_root("tar-src").join("ppt-master-main");
        write_file(&repo.join("SKILL.md"), "# PPT Master\nMake decks.");
        write_file(&repo.join("README.md"), "readme");
        write_file(&repo.join(".env"), "TOKEN=secret");

        let staging = temp_root("tar-staging");
        let tar_path = staging.join("repo.tar.gz");
        {
            let tar_gz = fs::File::create(&tar_path).expect("create tar");
            let encoder = flate2::write::GzEncoder::new(tar_gz, flate2::Compression::default());
            let mut builder = tar::Builder::new(encoder);
            builder
                .append_dir_all("ppt-master-main", &repo)
                .expect("append");
            builder
                .into_inner()
                .expect("finish tar")
                .finish()
                .expect("gz finish");
        }

        let extract_into = staging.join("extracted");
        fs::create_dir_all(&extract_into).expect("extract dir");
        let bytes = fs::read(&tar_path).expect("read tar");
        let decoder = flate2::read::GzDecoder::new(&bytes[..]);
        tar::Archive::new(decoder)
            .unpack(&extract_into)
            .expect("unpack");
        let extracted_root = first_subdirectory(&extract_into).expect("subdir");

        // Now install via the existing filtered copy + guards.
        let root = temp_root("tar-install");
        let preview = preview_local_install_for_tests(
            &extracted_root,
            &HostRoot::new(HostKind::Codex, root.clone()),
            ResourceKind::Skill,
            "ppt-master",
        )
        .expect("preview");
        install_from_preview(&preview).expect("install");

        assert!(root.join("skills/ppt-master/SKILL.md").is_file());
        assert!(root.join("skills/ppt-master/README.md").is_file());
        // Sensitive files must never be copied in.
        assert!(!root.join("skills/ppt-master/.env").exists());
    }
}
