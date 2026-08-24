#!/usr/bin/env python3
"""Audit release assets and emit stable hashes plus a machine-readable manifest."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


MAX_TEXT_SAMPLE = 4 * 1024 * 1024

SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("private-key", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")),
    ("github-token", re.compile(r"\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("openai-style-key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    (
        "credential-assignment",
        re.compile(
            r"(?i)\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret[_-]?key)\b"
            r"\s*[:=]\s*[\"']?[A-Za-z0-9_./+=-]{16,}"
        ),
    ),
)

PATH_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("windows-absolute-path", re.compile(r"\b[A-Za-z]:\\(?:[^\r\n\\]+\\){1,}[^\r\n\\]*")),
    ("unix-user-path", re.compile(r"(?:/Users/|/home/|/runner/|/workspace/)[^\s\"']+")),
)

SENSITIVE_NAME_RE = re.compile(
    r"(?i)(?:^|[._-])(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?|secrets?|tokens?|private[-_]?key)(?:$|[._-])"
)
DEBUG_NAME_RE = re.compile(r"(?i)(?:\.pdb$|\.dSYM(?:$|/)|\.debug$|\.dwarf$|\.map$)")
TEMP_NAME_RE = re.compile(r"(?i)(?:\.tmp$|\.part$|\.partial$|\.bak$|\.old$|\.swp$|~$|\.log$)")


def relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def is_probably_text(sample: bytes) -> bool:
    if not sample:
        return True
    if b"\x00" in sample[:8192]:
        return False
    control_count = sum(1 for byte in sample[:8192] if byte < 9 or 13 < byte < 32)
    return control_count / max(1, min(len(sample), 8192)) < 0.02


def read_text_sample(path: Path) -> str | None:
    try:
        with path.open("rb") as handle:
            sample = handle.read(MAX_TEXT_SAMPLE)
    except OSError:
        return None
    if not is_probably_text(sample):
        return None
    return sample.decode("utf-8", errors="replace")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def add_finding(findings: list[dict[str, Any]], path: str, kind: str, severity: str, detail: str) -> None:
    findings.append(
        {
            "path": path,
            "kind": kind,
            "severity": severity,
            # Never include matched text. This field is safe to show in CI logs.
            "detail": detail,
        }
    )


def scan_content(path: Path, relative_path: str, text: str, findings: list[dict[str, Any]]) -> None:
    for kind, pattern in SECRET_PATTERNS:
        if pattern.search(text):
            add_finding(findings, relative_path, kind, "error", "credential-like content detected")
    for kind, pattern in PATH_PATTERNS:
        if pattern.search(text):
            add_finding(findings, relative_path, kind, "warning", "absolute build path detected")

    local_users = {value.lower() for value in (getpass.getuser(), os.environ.get("USERNAME", ""), os.environ.get("USER", "")) if value}
    lowered = text.lower()
    for username in sorted(local_users):
        if len(username) >= 3 and re.search(rf"(?<![A-Za-z0-9_-]){re.escape(username)}(?![A-Za-z0-9_-])", lowered):
            add_finding(findings, relative_path, "build-user-name", "warning", "local build user name detected")
            break


def scan_name(path: Path, relative_path: str, findings: list[dict[str, Any]]) -> None:
    name = path.name
    if SENSITIVE_NAME_RE.search(name) or name.lower().endswith((".pem", ".key", ".p12", ".pfx", ".jks")):
        add_finding(findings, relative_path, "sensitive-filename", "error", "credential-like filename detected")
    if DEBUG_NAME_RE.search(name):
        add_finding(findings, relative_path, "debug-artifact", "warning", "debug symbol or source map detected")
    if TEMP_NAME_RE.search(name):
        add_finding(findings, relative_path, "temporary-artifact", "warning", "temporary or diagnostic file detected")


def iter_assets(root: Path, output_dir: Path) -> Iterable[Path]:
    output_dir = output_dir.resolve()
    for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        dirs[:] = [name for name in dirs if (current_path / name).resolve() != output_dir]
        for name in sorted(files):
            path = current_path / name
            if path.resolve() == output_dir:
                continue
            if path.is_symlink():
                # Symlinks are metadata, not independently downloadable assets.
                continue
            yield path


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, help="Directory containing final release assets")
    parser.add_argument("--output-dir", required=True, help="Directory for SHA256SUMS.txt and manifest")
    parser.add_argument("--platform", default="unknown")
    parser.add_argument("--arch", default="unknown")
    parser.add_argument("--version", default="unknown")
    parser.add_argument("--commit", default="unknown", dest="build_commit")
    parser.add_argument("--signature-status", default="unknown")
    return parser.parse_args(list(argv))


def audit(args: argparse.Namespace) -> tuple[dict[str, Any], str]:
    root = Path(args.root).resolve()
    output_dir = Path(args.output_dir).resolve()
    if not root.is_dir():
        raise ValueError(f"BLOCKED: asset root does not exist: {root}")
    if output_dir == root:
        raise ValueError("BLOCKED: output directory must be separate from the asset root")
    output_dir.mkdir(parents=True, exist_ok=True)
    findings: list[dict[str, Any]] = []
    assets: list[dict[str, Any]] = []
    for path in iter_assets(root, output_dir):
        rel = relative(path, root)
        scan_name(path, rel, findings)
        try:
            digest = sha256(path)
            size = path.stat().st_size
        except OSError as exc:
            add_finding(findings, rel, "unreadable-asset", "error", "asset could not be read")
            continue
        text = read_text_sample(path)
        if text is not None:
            scan_content(path, rel, text, findings)
        assets.append(
            {
                "name": rel,
                "size": size,
                "sha256": digest,
                "platform": args.platform,
                "arch": args.arch,
                "format": path.suffix.lower().lstrip(".") or "file",
                "signatureStatus": args.signature_status,
            }
        )
    assets.sort(key=lambda item: item["name"])
    if not assets:
        add_finding(findings, ".", "empty-asset-set", "error", "no release assets found")
    findings.sort(key=lambda item: (item["path"], item["kind"], item["severity"]))
    errors = [finding for finding in findings if finding["severity"] == "error"]
    status = "BLOCKED" if errors else ("PASS_WITH_WARNINGS" if findings else "PASS")
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "status": status,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "version": args.version,
        "buildCommit": args.build_commit,
        "assetRoot": "[REDACTED]",
        "signatureStatus": args.signature_status,
        "assetCount": len(assets),
        "assets": assets,
        "findings": findings,
    }
    sums = "".join(f"{asset['sha256']}  {asset['name']}\n" for asset in assets)
    (output_dir / "SHA256SUMS.txt").write_text(sums, encoding="utf-8", newline="\n")
    (output_dir / "release-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return manifest, sums


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        manifest, _ = audit(args)
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(f"{manifest['status']}: {manifest['assetCount']} assets; {len(manifest['findings'])} findings")
    return 2 if manifest["status"] == "BLOCKED" else 0


if __name__ == "__main__":
    raise SystemExit(main())
