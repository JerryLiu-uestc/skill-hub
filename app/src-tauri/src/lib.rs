use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

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
    summary: Option<String>,
    source_url: String,
    skill_sha256: Option<String>,
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

fn configured_roots(codex_root: Option<String>, claude_root: Option<String>) -> Vec<HostRoot> {
    let mut roots = Vec::new();
    if let Some(root) = codex_root
        .or_else(|| std::env::var("CODEX_HOME").ok())
        .or_else(|| home_relative(".codex"))
    {
        roots.push(HostRoot::new(
            HostKind::Codex,
            expand_home(PathBuf::from(root)),
        ));
    }
    if let Some(root) = claude_root
        .or_else(|| std::env::var("CLAUDE_HOME").ok())
        .or_else(|| home_relative(".claude"))
    {
        roots.push(HostRoot::new(
            HostKind::Claude,
            expand_home(PathBuf::from(root)),
        ));
    }
    roots
}

fn home_relative(child: &str) -> Option<String> {
    std::env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join(child).display().to_string())
}

fn expand_home(path: PathBuf) -> PathBuf {
    let Some(raw) = path.to_str() else {
        return path;
    };
    if raw == "~" {
        return std::env::var("HOME").map(PathBuf::from).unwrap_or(path);
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
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
        (HostKind::Codex, ResourceKind::Plugin) => path.join(".codex-plugin/plugin.json").is_file(),
        (HostKind::Claude, ResourceKind::Plugin) => path.join("plugin.json").is_file(),
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
    } else {
        path.join("plugin.json")
    };
    let Ok(contents) = fs::read_to_string(manifest_path) else {
        return ResourceMetadata::default();
    };
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
    if source_url
        .as_ref()
        .is_some_and(|url| url.contains("github.com"))
    {
        SourceKind::GitHub
    } else if is_native_resource(path) {
        SourceKind::Native
    } else if is_registry_resource(path) {
        SourceKind::Registry
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
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .windows(2)
        .any(|window| window[0] == "skills" && window[1] == ".system")
        || path.to_string_lossy().contains("/openai-bundled/")
}

fn is_registry_resource(path: &Path) -> bool {
    let raw = path.to_string_lossy();
    raw.contains("/openai-curated/") || raw.contains("/openai-curated-remote/")
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

fn fetch_github_index(url: &str) -> HubResult<Vec<GitHubIndexEntry>> {
    if !url.starts_with("https://") {
        return Err(SkillHubError::UnsupportedSource(
            "GitHub index URL must use https://".to_string(),
        ));
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("SkillHub/0.1")
        .build()
        .map_err(|error| SkillHubError::Io(error.to_string()))?;
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
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
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
            path.join("plugin.json").is_file() || path.join(".codex-plugin/plugin.json").is_file()
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
        let home = std::env::var("HOME").map_err(|_| {
            SkillHubError::TrashFailed("HOME is required to use the system trash".to_string())
        })?;
        let trash_dir = PathBuf::from(home).join(".Trash");
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
        .invoke_handler(tauri::generate_handler![
            scan_inventory,
            match_github_sources,
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
}
