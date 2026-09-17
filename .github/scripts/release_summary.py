#!/usr/bin/env python3
"""Shared parser for preview -> main release summaries.

The pull_request_target workflow checks out only the trusted base commit before
loading this module. PR body/title values are always treated as untrusted data.
"""

from __future__ import annotations

import argparse
import os
import re

SECTION_HEADING = "## このリリースで変わること"
SECTION_HEADING_TEXT = SECTION_HEADING.removeprefix("## ").strip()
MEANINGFUL_TEXT_RE = re.compile(r"[0-9A-Za-zぁ-んァ-ヶ一-龠]")


def h2_text(line: str) -> str | None:
    match = re.fullmatch(r"##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*", line.strip())
    return match.group(1).strip() if match else None


def sanitize_html_comments(body: str) -> str:
    """Drop complete comments without letting a stray opener consume EOF."""
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    return body.replace("<!--", "")


def extract_release_section(body: str) -> str:
    lines = sanitize_html_comments(body).splitlines()
    start = None
    for index, line in enumerate(lines):
        if h2_text(line) == SECTION_HEADING_TEXT:
            start = index + 1
            break

    release_lines: list[str] = []
    fence_char: str | None = None
    fence_len = 0
    if start is not None:
        for line in lines[start:]:
            stripped = line.lstrip()
            fence_match = re.match(r"^(`{3,}|~{3,})", stripped)
            if fence_match:
                marker = fence_match.group(1)
                if fence_char is None:
                    fence_char = marker[0]
                    fence_len = len(marker)
                elif (
                    marker[0] == fence_char
                    and len(marker) >= fence_len
                    and stripped[len(marker) :].strip() == ""
                ):
                    fence_char = None
                    fence_len = 0
                release_lines.append(line)
                continue
            if fence_char is None and h2_text(line) is not None:
                break
            release_lines.append(line)

    return "\n".join(release_lines).strip()


def strip_markdown_links(value: str) -> str:
    value = re.sub(r"!\[([^]]*)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"\[([^]]+)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"<https?://[^>\n]+>", "", value)
    value = re.sub(r"(?is)<a\b[^>]*>(.*?)</a>", r"\1", value)
    value = re.sub(
        r"(?i)</?(?:!doctype|a|abbr|b|br|code|div|em|i|img|li|ol|p|pre|s|small|span|strong|sub|sup|table|tbody|td|th|thead|tr|u|ul|h[1-6]|hr)(?:\s[^>\n]*)?/?>",
        "",
        value,
    )
    value = re.sub(
        r"(?i)(?<![\w@])(?:https?://|www\.|discord\.gg/)[^\s<>()]+",
        "",
        value,
    )
    return value


def extract_release_text(body: str) -> str:
    return strip_markdown_links(extract_release_section(body)).strip()


def has_meaningful_text(value: str) -> bool:
    return bool(value and MEANINGFUL_TEXT_RE.search(value))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--validate",
        action="store_true",
        help="fail when PR_BODY has no meaningful release summary",
    )
    args = parser.parse_args()

    release_text = extract_release_text(os.environ.get("PR_BODY", ""))
    if args.validate and not has_meaningful_text(release_text):
        raise SystemExit(
            "Promotion PR must include meaningful user-facing summary text"
        )
    if not args.validate:
        print(release_text, end="")


if __name__ == "__main__":
    main()
