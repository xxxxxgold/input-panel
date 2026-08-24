#!/usr/bin/env python3
"""Run focused, network-free tests for the bundled release helpers."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterable


SCRIPT_DIR = Path(__file__).resolve().parent
NOTES = SCRIPT_DIR / "generate_release_notes.py"
AUDIT = SCRIPT_DIR / "audit_release_assets.py"


def run(command: list[str], cwd: Path, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1"},
    )
    if check and result.returncode != 0:
        raise AssertionError(f"command failed: {command}\nstdout={result.stdout}\nstderr={result.stderr}")
    return result


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["git", *args], repo, check=check)


def commit(repo: Path, subject: str) -> str:
    with (repo / "history.txt").open("a", encoding="utf-8") as handle:
        handle.write(subject + "\n")
    git(repo, "add", "history.txt")
    git(repo, "commit", "-m", subject)
    return git(repo, "rev-parse", "HEAD").stdout.strip()


def init_repo(path: Path) -> None:
    path.mkdir()
    git(path, "init", "--quiet")
    git(path, "config", "user.name", "Release Test")
    git(path, "config", "user.email", "release-test@example.invalid")


def notes(repo: Path, *extra: str, expect: int = 0) -> tuple[dict, str]:
    output = repo / "notes.md"
    context = repo / "context.json"
    result = run(
        [sys.executable, str(NOTES), "--repo-root", str(repo), "--output", str(output), "--json-output", str(context), *extra],
        repo,
        check=False,
    )
    if result.returncode != expect:
        raise AssertionError(f"notes exit {result.returncode}, expected {expect}: {result.stderr}")
    if expect:
        return {}, result.stderr
    return json.loads(context.read_text(encoding="utf-8")), output.read_text(encoding="utf-8")


def test_first_release(repo: Path) -> None:
    init_repo(repo)
    commit(repo, "feat(shell): 初始工作台")
    commit(repo, "fix(runtime): 修复启动顺序")
    context, markdown = notes(repo, "--version", "0.1.0")
    assert context["firstRelease"] is True
    assert context["range"]["commitCount"] == 2
    assert "首次发布" in markdown
    assert "feat(shell):" in markdown


def test_tagged_range_with_untagged_middle(repo: Path) -> None:
    init_repo(repo)
    commit(repo, "feat(core): 第一版")
    git(repo, "tag", "-a", "v0.1.0", "-m", "v0.1.0")
    commit(repo, "feat(panel): 增加面板")
    commit(repo, "fix(panel): 修复面板关闭")
    head = commit(repo, "perf(panel): 优化渲染")
    git(repo, "tag", "-a", "v0.2.0", "-m", "v0.2.0")
    context, markdown = notes(repo, "--head-ref", "v0.2.0", "--version", "0.2.0")
    assert context["base"]["ref"] == "v0.1.0"
    assert context["head"]["sha"] == head
    assert context["range"]["commitCount"] == 3
    assert "增加面板" in markdown and "优化渲染" in markdown


def test_untagged_head(repo: Path) -> None:
    init_repo(repo)
    commit(repo, "feat(core): 第一版")
    git(repo, "tag", "v0.1.0")
    head = commit(repo, "fix(core): 未打标签的修复")
    context, _ = notes(repo, "--version", "0.1.1")
    assert context["base"]["ref"] == "v0.1.0"
    assert context["head"]["sha"] == head
    assert any("尚未绑定" in warning for warning in context["warnings"])


def test_explicit_range_and_remote(repo: Path) -> None:
    init_repo(repo)
    first = commit(repo, "feat(core): 第一版")
    second = commit(repo, "fix(core): 指定范围")
    git(repo, "remote", "add", "origin", "git@github.com:example/input-panel.git")
    context, markdown = notes(repo, "--base-ref", first, "--head-ref", second, "--version", "9.9.9")
    assert context["base"]["sha"] == first
    assert context["head"]["sha"] == second
    assert context["compareUrl"].endswith(f"/{first}...{second}")
    assert "GitHub Compare" in markdown


def test_blocked_published_without_tag(repo: Path) -> None:
    init_repo(repo)
    commit(repo, "feat(core): 未打标签版本")
    _, error = notes(repo, "--published-without-tag", expect=2)
    assert "BLOCKED" in error


def test_blocked_invalid_ranges(repo: Path) -> None:
    init_repo(repo)
    head = commit(repo, "feat(core): 唯一提交")
    _, same_error = notes(repo, "--base-ref", head, "--head-ref", head, expect=2)
    assert "BLOCKED" in same_error
    _, missing_error = notes(repo, "--base-ref", "not-a-real-ref", expect=2)
    assert "BLOCKED" in missing_error


def test_blocked_duplicate_semver(repo: Path) -> None:
    init_repo(repo)
    commit(repo, "feat(core): 第一提交")
    git(repo, "tag", "v1.0.0")
    commit(repo, "fix(core): 第二提交")
    git(repo, "tag", "1.0.0")
    commit(repo, "feat(core): 当前提交")
    _, error = notes(repo, "--version", "1.1.0", expect=2)
    assert "BLOCKED" in error


def test_blocked_unreachable_release_history(repo: Path) -> None:
    init_repo(repo)
    commit(repo, "feat(main): 主分支提交")
    git(repo, "checkout", "-b", "release-history", "--quiet")
    commit(repo, "feat(release): 另一条历史")
    git(repo, "tag", "v2.0.0")
    git(repo, "checkout", "-", "--quiet")
    _, error = notes(repo, "--version", "2.1.0", expect=2)
    assert "BLOCKED" in error


def test_blocked_invalid_version(repo: Path) -> None:
    init_repo(repo)
    commit(repo, "feat(core): 版本校验")
    _, error = notes(repo, "--version", "not-semver", expect=2)
    assert "BLOCKED" in error


def test_audit_clean_and_secret(temp_root: Path) -> None:
    temp_root.mkdir(parents=True, exist_ok=True)
    clean = temp_root / "clean"
    clean.mkdir()
    (clean / "app.exe").write_bytes(b"binary-app\x00\x01")
    clean_out = temp_root / "clean-out"
    clean_result = run(
        [sys.executable, str(AUDIT), "--root", str(clean), "--output-dir", str(clean_out), "--platform", "windows", "--arch", "x64"],
        temp_root,
        check=False,
    )
    assert clean_result.returncode == 0, clean_result.stderr
    clean_manifest = json.loads((clean_out / "release-manifest.json").read_text(encoding="utf-8"))
    assert clean_manifest["status"] == "PASS"
    assert len((clean_out / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines()) == 1

    unsafe = temp_root / "unsafe"
    unsafe.mkdir()
    fake_token = "ghp_" + "abcdefghijklmnopqrstuvwxyz" + "1234567890"
    (unsafe / ".env").write_text(f"TOKEN={fake_token}\n", encoding="utf-8")
    unsafe_out = temp_root / "unsafe-out"
    unsafe_result = run(
        [sys.executable, str(AUDIT), "--root", str(unsafe), "--output-dir", str(unsafe_out)],
        temp_root,
        check=False,
    )
    assert unsafe_result.returncode == 2
    unsafe_manifest = json.loads((unsafe_out / "release-manifest.json").read_text(encoding="utf-8"))
    assert unsafe_manifest["status"] == "BLOCKED"
    assert all("ghp" + "_" not in json.dumps(item) for item in unsafe_manifest["findings"])


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="release-tool-tests-") as raw:
        root = Path(raw)
        cases: list[tuple[str, callable]] = [
            ("first release", lambda: test_first_release(root / "first")),
            ("tagged range", lambda: test_tagged_range_with_untagged_middle(root / "tagged")),
            ("untagged head", lambda: test_untagged_head(root / "head")),
            ("explicit range", lambda: test_explicit_range_and_remote(root / "explicit")),
            ("published without tag", lambda: test_blocked_published_without_tag(root / "blocked")),
            ("invalid ranges", lambda: test_blocked_invalid_ranges(root / "invalid")),
            ("duplicate semver", lambda: test_blocked_duplicate_semver(root / "duplicate")),
            ("unreachable history", lambda: test_blocked_unreachable_release_history(root / "unreachable")),
            ("invalid version", lambda: test_blocked_invalid_version(root / "version")),
        ]
        for name, test in cases:
            test()
            print(f"PASS {name}")
        test_audit_clean_and_secret(root / "audit")
        print("PASS asset audit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
