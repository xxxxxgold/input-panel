#!/usr/bin/env python3
"""Generate an auditable, history-based GitHub Release description.

The script deliberately performs no network writes. It resolves a Git range,
classifies commit subjects, and emits Markdown plus a machine-readable JSON
context that a release workflow can review before publishing.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote


class ReleaseToolError(RuntimeError):
    """Represent a deterministic input or release-boundary failure."""


@dataclass(frozen=True)
class SemVer:
    raw: str
    major: int
    minor: int
    patch: int
    prerelease: str | None

    @property
    def sort_key(self) -> tuple[Any, ...]:
        # Stable versions sort after prereleases. Prefix each prerelease
        # component with a type marker so Python never compares int and str.
        if not self.prerelease:
            pre_key: tuple[Any, ...] = ((2, ""),)
        else:
            parts: list[tuple[int, Any]] = []
            for part in self.prerelease.split("."):
                if part.isdigit():
                    parts.append((0, int(part)))
                else:
                    parts.append((1, part))
            pre_key = tuple(parts)
        return (self.major, self.minor, self.patch, pre_key)


@dataclass(frozen=True)
class TagInfo:
    name: str
    commit: str
    version: SemVer


CONVENTIONAL_RE = re.compile(
    r"^(?P<type>[A-Za-z][A-Za-z0-9_-]*)(?:\((?P<scope>[^)]+)\))?(?P<breaking>!)?:\s*(?P<description>.+)$"
)
SEMVER_RE = re.compile(
    r"^v?(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<pre>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)

CATEGORY_LABELS_ZH = {
    "feat": "新增功能",
    "fix": "修复与稳定性",
    "perf": "性能优化",
    "refactor": "重构",
    "docs": "文档",
    "build": "构建与维护",
    "ci": "构建与维护",
    "chore": "构建与维护",
    "test": "测试",
    "revert": "回退",
    "other": "其他提交",
}
CATEGORY_LABELS_EN = {
    "feat": "Features",
    "fix": "Fixes and stability",
    "perf": "Performance",
    "refactor": "Refactoring",
    "docs": "Documentation",
    "build": "Build and maintenance",
    "ci": "Build and maintenance",
    "chore": "Build and maintenance",
    "test": "Tests",
    "revert": "Reverts",
    "other": "Other changes",
}
CATEGORY_ORDER = ["feat", "fix", "perf", "refactor", "docs", "build", "test", "revert", "other"]


def git(repo: Path, args: list[str], *, check: bool = True) -> str:
    """Run Git with UTF-8 output and a stable error surface."""

    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown git error"
        raise ReleaseToolError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout


def resolve_commit(repo: Path, ref: str) -> str:
    try:
        return git(repo, ["rev-parse", "--verify", f"{ref}^{{commit}}"]).strip()
    except ReleaseToolError as exc:
        raise ReleaseToolError(f"BLOCKED: 无法解析 head/base ref `{ref}`。{exc}") from exc


def is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repo), "merge-base", "--is-ancestor", ancestor, descendant],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def parse_semver(tag: str) -> SemVer | None:
    match = SEMVER_RE.fullmatch(tag)
    if not match:
        return None
    return SemVer(
        raw=tag,
        major=int(match.group("major")),
        minor=int(match.group("minor")),
        patch=int(match.group("patch")),
        prerelease=match.group("pre"),
    )


def list_semver_tags(repo: Path) -> list[TagInfo]:
    raw = git(repo, ["for-each-ref", "refs/tags", "--format=%(refname:short)"])
    candidates: list[TagInfo] = []
    for name in sorted({line.strip() for line in raw.splitlines() if line.strip()}):
        version = parse_semver(name)
        if version is None:
            continue
        try:
            commit = resolve_commit(repo, name)
        except ReleaseToolError:
            continue
        candidates.append(TagInfo(name=name, commit=commit, version=version))

    return candidates


def list_reachable_semver_tags(repo: Path, head_sha: str) -> list[TagInfo]:
    candidates = [
        item
        for item in list_semver_tags(repo)
        if item.commit != head_sha and is_ancestor(repo, item.commit, head_sha)
    ]

    # Two different commits carrying the exact same version make the base
    # ambiguous. Tags on the same commit are harmless and are resolved
    # deterministically by name.
    by_version: dict[tuple[Any, ...], list[TagInfo]] = {}
    for item in candidates:
        by_version.setdefault(item.version.sort_key, []).append(item)
    for same_version in by_version.values():
        if len({item.commit for item in same_version}) > 1:
            names = ", ".join(item.name for item in same_version)
            raise ReleaseToolError(
                f"BLOCKED: 同一 SemVer 存在指向不同提交的 Tag，无法确定更新日志基线：{names}"
            )
    return candidates


def root_commits(repo: Path, head_sha: str) -> list[str]:
    roots = git(repo, ["rev-list", "--max-parents=0", "--reverse", head_sha]).splitlines()
    return [root.strip() for root in roots if root.strip()]


def detect_head_tag(repo: Path, head_sha: str) -> str | None:
    raw = git(repo, ["for-each-ref", "refs/tags", "--points-at", head_sha, "--format=%(refname:short)"])
    tags = sorted(line.strip() for line in raw.splitlines() if line.strip())
    semver_tags = [tag for tag in tags if parse_semver(tag)]
    return semver_tags[0] if semver_tags else (tags[0] if tags else None)


def remote_url(repo: Path) -> str | None:
    names = [line.strip() for line in git(repo, ["remote"], check=False).splitlines() if line.strip()]
    ordered = ["origin", *[name for name in names if name != "origin"]]
    for name in ordered:
        if name not in names:
            continue
        value = git(repo, ["remote", "get-url", name], check=False).strip()
        if value:
            return value
    return None


def github_base_url(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    match = re.match(r"^(?:https?://|ssh://git@|git@)github\.com[/:](.+?)(?:\.git)?/?$", value)
    if not match:
        return None
    path = match.group(1).strip("/")
    if path.count("/") != 1:
        return None
    owner, repo = path.split("/", 1)
    return f"https://github.com/{owner}/{repo}"


def parse_commit_record(raw: str) -> dict[str, Any]:
    fields = raw.split("\x00", 4)
    if len(fields) != 5:
        raise ReleaseToolError("无法解析 Git 提交记录")
    sha, author, authored_at, subject, body = fields
    conventional = CONVENTIONAL_RE.match(subject.strip())
    if conventional:
        commit_type = conventional.group("type").lower()
        scope = conventional.group("scope")
        breaking = bool(conventional.group("breaking"))
        description = conventional.group("description").strip()
    else:
        commit_type = "other"
        scope = None
        breaking = False
        description = subject.strip()
    if re.search(r"(?im)^BREAKING CHANGE(?:S)?\s*:", body):
        breaking = True
    category = commit_type if commit_type in CATEGORY_LABELS_ZH else "other"
    return {
        "sha": sha,
        "shortSha": sha[:12],
        "author": author,
        "date": authored_at,
        "subject": subject.strip(),
        "type": commit_type,
        "scope": scope,
        "description": description,
        "category": category,
        "breaking": breaking,
        "body": body.strip(),
    }


def commit_paths(repo: Path, sha: str) -> list[str]:
    output = git(repo, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "--format=", sha], check=False)
    return sorted({line.strip() for line in output.splitlines() if line.strip()})


def collect_commits(repo: Path, base_sha: str | None, head_sha: str, first_release: bool) -> list[dict[str, Any]]:
    revision = head_sha if first_release else f"{base_sha}..{head_sha}"
    output = git(
        repo,
        ["log", "--reverse", "--no-decorate", "--no-show-signature", "--format=%H%x00%an%x00%aI%x00%s%x00%b%x1e", revision],
    )
    records: list[dict[str, Any]] = []
    for raw in output.split("\x1e"):
        raw = raw.strip("\r\n")
        if not raw.strip():
            continue
        record = parse_commit_record(raw)
        record["paths"] = commit_paths(repo, record["sha"])
        records.append(record)
    return records


def ref_label(ref: str, sha: str) -> str:
    return sha if ref in {"HEAD", "head", ""} else ref


def compare_url(base: str, head: str, repo: Path) -> str | None:
    root = github_base_url(remote_url(repo))
    if not root:
        return None
    encoded_base = quote(base, safe="._/-")
    encoded_head = quote(head, safe="._/-")
    return f"{root}/compare/{encoded_base}...{encoded_head}"


def choose_base(
    repo: Path,
    head_sha: str,
    explicit_base: str | None,
    published_without_tag: bool,
) -> tuple[str, str, bool, list[str]]:
    warnings: list[str] = []
    if explicit_base:
        base_sha = resolve_commit(repo, explicit_base)
        if base_sha == head_sha:
            raise ReleaseToolError("BLOCKED: base ref 与 head ref 指向同一个提交，更新范围为空。")
        if not is_ancestor(repo, base_sha, head_sha):
            raise ReleaseToolError("BLOCKED: base ref 不是 head 的祖先，无法形成线性可审计范围。")
        return explicit_base, base_sha, False, warnings

    all_semver_tags = list_semver_tags(repo)
    candidates = list_reachable_semver_tags(repo, head_sha)
    if candidates:
        chosen = max(candidates, key=lambda item: (item.version.sort_key, item.name))
        if len({item.version.sort_key for item in candidates}) < len(candidates):
            warnings.append("存在多个同版本 Tag，已按名称稳定选择基线。")
        return chosen.name, chosen.commit, False, warnings

    if all_semver_tags:
        names = ", ".join(item.name for item in all_semver_tags)
        raise ReleaseToolError(
            "BLOCKED: 仓库存在 SemVer Tag，但没有一个是当前 head 的祖先；"
            f"请显式提供 --base-ref。现有 Tag：{names}"
        )
    if published_without_tag:
        raise ReleaseToolError(
            "BLOCKED: 远端已有发布事实但没有可识别的历史 SemVer Tag；请显式提供 --base-ref。"
        )
    roots = root_commits(repo, head_sha)
    if len(roots) != 1:
        raise ReleaseToolError(
            "BLOCKED: 仓库存在多个 root commit，无法安全推断首次发布基线；请显式提供 --base-ref。"
        )
    warnings.append("没有可识别的历史 SemVer Tag，按首次发布从 root commit 汇总。")
    return roots[0], roots[0], True, warnings


def build_context(args: argparse.Namespace) -> tuple[dict[str, Any], str]:
    repo = Path(args.repo_root).resolve()
    if not (repo / ".git").exists() and not (repo / "HEAD").exists():
        raise ReleaseToolError(f"BLOCKED: 不是 Git 仓库：{repo}")

    if args.version and parse_semver(args.version) is None:
        raise ReleaseToolError(f"BLOCKED: --version 不是合法 SemVer：{args.version}")
    head_ref = args.head_ref or "HEAD"
    head_sha = resolve_commit(repo, head_ref)
    head_tag = detect_head_tag(repo, head_sha)
    base_ref, base_sha, first_release, warnings = choose_base(
        repo, head_sha, args.base_ref, args.published_without_tag
    )
    commits = collect_commits(repo, base_sha, head_sha, first_release)
    if not commits:
        raise ReleaseToolError("BLOCKED: 比较范围没有提交，拒绝生成空的版本更新日志。")

    version = args.version or (parse_semver(head_tag).raw if head_tag and parse_semver(head_tag) else None)
    if not version:
        version = "待发布版本"
        warnings.append("未提供 --version，当前输出只能作为候选更新日志，不能直接创建 Release。")
    if not head_tag:
        warnings.append("当前 head 尚未绑定 SemVer Tag；创建 Release 前必须先在最终提交上创建 annotated Tag。")
    unknown_count = sum(1 for commit in commits if commit["category"] == "other")
    if unknown_count:
        warnings.append(f"有 {unknown_count} 条提交无法按 Conventional Commits 可靠分类，已保留原始 subject。")
    base_display = ref_label(base_ref, base_sha)
    head_display = ref_label(head_ref, head_sha)
    compare = compare_url(base_display, head_display, repo)
    language = args.language
    labels = CATEGORY_LABELS_EN if language == "en" else CATEGORY_LABELS_ZH
    categories: dict[str, list[dict[str, Any]]] = {key: [] for key in CATEGORY_ORDER}
    for commit in commits:
        categories.setdefault(commit["category"], []).append(commit)
    categories = {key: value for key, value in categories.items() if value}

    expression = head_sha if first_release else f"{base_sha}..{head_sha}"
    context: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "PASS",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "version": version,
        "language": language,
        "firstRelease": first_release,
        "base": {"ref": base_ref, "sha": base_sha},
        "head": {"ref": head_ref, "sha": head_sha, "tag": head_tag},
        "range": {"expression": expression, "commitCount": len(commits)},
        "compareUrl": compare,
        "categories": categories,
        "commits": commits,
        "warnings": warnings,
    }
    return context, render_markdown(context, labels)


def render_commit(commit: dict[str, Any]) -> str:
    scope = f"({commit['scope']})" if commit.get("scope") else ""
    marker = " [BREAKING]" if commit.get("breaking") else ""
    description = str(commit["description"]).replace("`", "\\`").replace("\r", " ").replace("\n", " ")
    return f"- `{commit['shortSha']}` `{commit['type']}{scope}:` {description}{marker}"


def render_markdown(context: dict[str, Any], labels: dict[str, str]) -> str:
    base = context["base"]
    head = context["head"]
    range_info = context["range"]
    lines = [
        f"# {context['version']}",
        "",
        "## 发布范围",
        "",
        f"- 基线：`{base['ref']}` (`{base['sha'][:12]}`)",
        f"- 当前提交：`{head['ref']}` (`{head['sha'][:12]}`)",
        f"- 提交数量：{range_info['commitCount']}",
    ]
    if context["firstRelease"]:
        lines.append("- 类型：首次发布（没有可识别的历史 SemVer Tag，统计从 root commit 开始）")
    if context.get("compareUrl"):
        lines.append(f"- GitHub Compare：{context['compareUrl']}")
    lines.extend(["", "## 更新内容", ""])
    for category in CATEGORY_ORDER:
        commits = context["categories"].get(category, [])
        if not commits:
            continue
        lines.append(f"### {labels.get(category, category)} (`{category}`)")
        lines.append("")
        lines.extend(render_commit(commit) for commit in commits)
        lines.append("")
    lines.extend(
        [
            "## 兼容性与发布说明",
            "",
            "- 本文由 Git 提交历史自动生成；未能可靠分类的提交保留原始 subject，不推断未被提交记录证明的产品行为。",
            "- Windows、macOS、Linux 的实际可用性以对应 Runner 构建和 smoke test 结果为准。",
            "- 签名、notarization、运行时依赖和免安装包内容应以本次 Release 的资产清单为准。",
        ]
    )
    if context["warnings"]:
        lines.extend(["", "## 自动检查提示", ""])
        lines.extend(f"- {warning}" for warning in context["warnings"])
    return "\n".join(lines).rstrip() + "\n"


def write_text(path_value: str | None, content: str) -> None:
    if not path_value:
        return
    path = Path(path_value).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".", help="Git repository root")
    parser.add_argument("--base-ref", help="Explicit previous release ref")
    parser.add_argument("--head-ref", default="HEAD", help="Candidate release ref")
    parser.add_argument("--version", help="Candidate version, for example 0.2.0")
    parser.add_argument("--language", choices=("zh-CN", "en"), default="zh-CN")
    parser.add_argument("--published-without-tag", action="store_true", help="Block if no historical SemVer Tag exists")
    parser.add_argument("--output", help="Markdown output path")
    parser.add_argument("--json-output", help="JSON context output path")
    return parser.parse_args(list(argv))


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        context, markdown = build_context(args)
    except ReleaseToolError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    write_text(args.output, markdown)
    write_text(args.json_output, json.dumps(context, ensure_ascii=False, indent=2) + "\n")
    if args.output or args.json_output:
        print(
            f"PASS: {context['range']['commitCount']} commits; "
            f"base={context['base']['ref']} head={context['head']['sha'][:12]}"
        )
    else:
        print(markdown, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
