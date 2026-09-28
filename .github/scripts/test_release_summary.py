#!/usr/bin/env python3
"""Focused contract tests for the shared preview -> main release parser."""

from __future__ import annotations

import unittest

import release_summary


class ReleaseSummaryContractTest(unittest.TestCase):
    def test_extracts_visible_section_after_comments_and_stray_opener(self) -> None:
        body = "\n".join(
            [
                "<!--",
                release_summary.SECTION_HEADING,
                "hidden guidance",
                "-->",
                "<!-- literal opener used in explanatory text",
                "  ## このリリースで変わること ###  ",
                "公開内容 [詳細](https://example.com/release)",
                "## 対象PRと固定SHA",
                "ignored next section",
            ]
        )

        self.assertEqual(release_summary.extract_release_text(body), "公開内容 詳細")

    def test_ignores_h2_inside_fenced_code_block(self) -> None:
        body = "\n".join(
            [
                release_summary.SECTION_HEADING,
                "```markdown",
                "## fenced heading",
                "```",
                "visible release text",
                "## 対象PRと固定SHA",
                "ignored next section",
            ]
        )

        self.assertEqual(
            release_summary.extract_release_text(body),
            "```markdown\n## fenced heading\n```\nvisible release text",
        )

    def test_utf16_truncation_rolls_back_before_unclosed_fence(self) -> None:
        value = "before😀\n```text\ninside😀\n```\nafter"
        limit = release_summary.utf16_length("before😀\n```text\ninside😀\n")

        truncated = release_summary.truncate_markdown_utf16(value, limit)

        self.assertEqual(truncated, "before😀")
        self.assertLessEqual(release_summary.utf16_length(truncated), limit)


if __name__ == "__main__":
    unittest.main()
