# Discord release summary behavior

Temporary implementation note for PR review:

- Discord main-merge notifications reuse the `## このリリースで変わること` section from the merged promotion PR.
- Component PR discovery and related GitHub API calls are intentionally removed.
- Missing sections fall back to the promotion PR title without exposing internal error states.
