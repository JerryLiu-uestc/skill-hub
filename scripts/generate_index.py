#!/usr/bin/env python3
"""
市场索引生成器
遍历已知 skill 仓库列表，通过 GitHub API 获取元数据和 SKILL.md 文件，
解析 frontmatter，计算热度评分，生成统一的 index.json。
"""

import json
import os
import sys
import time
import re
from datetime import datetime, timezone
from pathlib import Path

import requests
import yaml

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

REPOS_FILE = Path(__file__).parent / "skill-repos.json"
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "dist-index")).resolve()
OUTPUT_FILE = OUTPUT_DIR / "index.json"

GH_TOKEN = os.environ.get("GH_TOKEN", "")
GH_API_BASE = "https://api.github.com"
GH_RAW_BASE = "https://raw.githubusercontent.com"

HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "skill-market-index-generator/1.0",
}
if GH_TOKEN:
    HEADERS["Authorization"] = f"Bearer {GH_TOKEN}"


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def log(msg):
    """日志输出到 stdout。"""
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{timestamp}] {msg}", flush=True)


def warn(msg):
    """警告输出到 stderr。"""
    print(f"WARNING: {msg}", file=sys.stderr, flush=True)


def api_get(url, **kwargs):
    """带速率限制处理的 GitHub API GET 请求。"""
    resp = requests.get(url, headers=HEADERS, timeout=30, **kwargs)
    remaining = resp.headers.get("X-RateLimit-Remaining")
    if remaining is not None and int(remaining) < 10:
        reset_time = int(resp.headers.get("X-RateLimit-Reset", 0))
        wait = max(reset_time - time.time(), 0) + 5
        log(f"速率限制接近上限，等待 {wait:.0f} 秒...")
        time.sleep(wait)
    resp.raise_for_status()
    return resp


def slugify(text):
    """将文本转换为 URL 友好的 slug。"""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[-\s]+", "-", text)
    return text.strip("-")


def dirname_to_name(path):
    """
    从路径推断可读名称：
      skills/pdf-extract  ->  Pdf Extract
      .                   ->  根目录（回退）
    """
    parent = Path(path).parent
    if str(parent) == "." or str(parent) == "":
        return None
    # 取最后一段目录名
    dirname = parent.name
    name = dirname.replace("-", " ").replace("_", " ")
    return name.title()


def extract_frontmatter(content):
    """
    从 Markdown 内容中提取 YAML frontmatter（位于开头的 --- 之间）。
    返回 (frontmatter_dict, body_text)。
    如果没有 frontmatter，返回 (None, content)。
    """
    if not content.startswith("---"):
        return None, content

    # 找到第二个 ---
    end = content.find("---", 3)
    if end == -1:
        return None, content

    fm_text = content[3:end].strip()
    body = content[end + 3 :].strip()

    if not fm_text:
        return None, body

    try:
        fm = yaml.safe_load(fm_text)
        if isinstance(fm, dict):
            return fm, body
        return None, body
    except yaml.YAMLError:
        return None, body


def infer_categories(path, fm_categories):
    """从 frontmatter 或路径推断分类。"""
    # 优先使用 frontmatter 中的 categories/tags
    if fm_categories:
        cats = fm_categories
        if isinstance(cats, str):
            return [c.strip() for c in cats.split(",") if c.strip()]
        if isinstance(cats, list):
            return [str(c).strip() for c in cats if str(c).strip()]
        return []

    # 从路径推断
    parts = Path(path).parent.parts
    categories = []
    for part in parts:
        if part in (".", ""):
            continue
        cat = part.replace("-", " ").replace("_", " ").lower()
        if cat and cat not in categories:
            categories.append(cat)
    return categories if categories else ["general"]


def calc_hotness(stars, updated_at_str):
    """
    计算热度评分：
      hotness = stars * 1.0 + recency_bonus
      recency_bonus:
        - 7天内更新: +100
        - 30天内更新: +50
        - 90天内更新: +20
        - 更久: +0
    """
    stars = stars or 0
    try:
        updated_at = datetime.fromisoformat(updated_at_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        delta = now - updated_at
        days = delta.days

        if days <= 7:
            recency = 100
        elif days <= 30:
            recency = 50
        elif days <= 90:
            recency = 20
        else:
            recency = 0
    except (ValueError, TypeError):
        recency = 0

    return stars * 1.0 + recency


def generate_skill_id(repo_owner, path):
    """生成唯一 skill ID：skill-{owner}-{slug}"""
    # 根据 SKILL.md 路径生成 slug
    parent = Path(path).parent
    slug = slugify(parent.name) if str(parent) != "." else slugify(Path(path).stem)
    return f"skill-{repo_owner}-{slug}"


# ---------------------------------------------------------------------------
# 核心逻辑
# ---------------------------------------------------------------------------

def process_repo(repo_entry):
    """
    处理单个仓库，返回该仓库下所有 skill 条目的列表。
    repo_entry: { "repo": "owner/name", "branch": "main", "skillPath": "skills" }
    """
    full_repo = repo_entry["repo"]
    branch = repo_entry.get("branch", "main")
    skill_base = repo_entry.get("skillPath", ".")
    owner, name = full_repo.split("/", 1)

    log(f"处理仓库: {full_repo} (branch={branch}, path={skill_base})")

    # --- 获取仓库元数据 ---
    repo_info = {}
    try:
        r = api_get(f"{GH_API_BASE}/repos/{full_repo}")
        data = r.json()
        repo_info = {
            "stars": data.get("stargazers_count", 0),
            "updated_at": data.get("updated_at", ""),
            "description": data.get("description", ""),
            "license": data.get("license", {}).get("spdx_id") if data.get("license") else None,
        }
        log(f"  stars={repo_info['stars']}, updated={repo_info['updated_at']}")
    except Exception as e:
        warn(f"获取仓库信息失败 {full_repo}: {e}")
        return []

    # --- 获取目录树 ---
    tree_items = []
    try:
        r = api_get(f"{GH_API_BASE}/repos/{full_repo}/git/trees/{branch}?recursive=1")
        data = r.json()
        tree_items = data.get("tree", [])
        if data.get("truncated"):
            warn(f"  目录树被截断: {full_repo}")
    except Exception as e:
        warn(f"获取目录树失败 {full_repo}: {e}")
        return []

    # --- 查找所有 SKILL.md 和 PLUGIN.md ---
    skill_files = []
    skill_base_norm = skill_base.rstrip("/")
    if skill_base_norm == ".":
        skill_base_norm = ""

    for item in tree_items:
        if item.get("type") != "blob":
            continue
        filepath = item.get("path", "")
        filename = Path(filepath).name

        # 检查是否是 SKILL.md 或 PLUGIN.md
        if filename not in ("SKILL.md", "PLUGIN.md"):
            continue

        # 如果指定了 skillPath，只处理该路径下的文件
        if skill_base_norm and not filepath.startswith(skill_base_norm + "/") and filepath != skill_base_norm:
            continue

        kind = "skill" if filename == "SKILL.md" else "plugin"
        skill_files.append((filepath, kind))

    if not skill_files:
        log(f"  未找到 SKILL.md 或 PLUGIN.md 文件")
        return []

    log(f"  找到 {len(skill_files)} 个文件")

    # --- 处理每个 SKILL.md/PLUGIN.md ---
    entries = []
    for filepath, kind in skill_files:
        try:
            entry = build_entry(
                owner=owner,
                repo_name=name,
                full_repo=full_repo,
                branch=branch,
                filepath=filepath,
                kind=kind,
                repo_info=repo_info,
            )
            if entry:
                entries.append(entry)
        except Exception as e:
            warn(f"  处理文件失败 {full_repo}/{filepath}: {e}")

    return entries


def build_entry(owner, repo_name, full_repo, branch, filepath, kind, repo_info):
    """为单个 SKILL.md 或 PLUGIN.md 构建条目。"""
    raw_url = f"{GH_RAW_BASE}/{full_repo}/{branch}/{filepath}"
    source_url = f"https://github.com/{full_repo}/tree/{branch}/{Path(filepath).parent}"

    # 获取文件内容
    try:
        r = api_get(raw_url)
        content = r.text
    except Exception as e:
        warn(f"  获取内容失败 {raw_url}: {e}")
        content = ""

    # 解析 frontmatter
    fm, _ = extract_frontmatter(content)

    # 提取字段
    if fm:
        name = fm.get("name") or dirname_to_name(filepath) or Path(filepath).parent.name.replace("-", " ").title()
        description = fm.get("description", "")
        fm_categories = fm.get("categories") or fm.get("tags")
        version = fm.get("version", "1.0.0")
    else:
        name = dirname_to_name(filepath) or Path(filepath).parent.name.replace("-", " ").title()
        description = repo_info.get("description", "")
        fm_categories = None
        version = "1.0.0"

    # summary 取 description 的第一行
    summary = description.split("\n")[0].strip() if description else repo_info.get("description", "")

    # 分类
    categories = infer_categories(filepath, fm_categories)

    # 热度
    hotness = calc_hotness(repo_info.get("stars", 0), repo_info.get("updated_at", ""))

    # ID
    skill_id = generate_skill_id(owner, filepath)

    entry = {
        "id": skill_id,
        "name": name,
        "kind": kind,
        "summary": summary,
        "description": description,
        "sourceUrl": source_url,
        "repo": full_repo,
        "path": filepath,
        "stars": repo_info.get("stars", 0),
        "updatedAt": repo_info.get("updated_at"),
        "categories": categories,
        "hotness": hotness,
        "author": owner,
        "license": repo_info.get("license"),
        "version": str(version),
    }

    log(f"    ✓ {name} ({kind})")
    return entry


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    log("=== 市场索引生成开始 ===")

    # 读取仓库列表
    if not REPOS_FILE.exists():
        warn(f"仓库配置文件不存在: {REPOS_FILE}")
        sys.exit(1)

    with open(REPOS_FILE, "r", encoding="utf-8") as f:
        repos = json.load(f)

    log(f"读取到 {len(repos)} 个仓库")

    # 处理所有仓库
    all_entries = []
    for repo_entry in repos:
        try:
            entries = process_repo(repo_entry)
            all_entries.extend(entries)
        except Exception as e:
            warn(f"处理仓库失败 {repo_entry.get('repo', 'unknown')}: {e}")

    # 按热度降序排列
    all_entries.sort(key=lambda x: x.get("hotness", 0), reverse=True)

    # 生成顶层结构
    index = {
        "version": "1.0.0",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "totalCount": len(all_entries),
        "skills": all_entries,
    }

    # 写入文件
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    log(f"=== 索引生成完成: {OUTPUT_FILE} ({len(all_entries)} 个条目) ===")


if __name__ == "__main__":
    main()
