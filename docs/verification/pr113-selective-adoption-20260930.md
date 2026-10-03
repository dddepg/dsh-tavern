# PR #113 selective adoption

Reviewed upstream head `f06922239a7f73ad2e1634522e08ffcf99fed283`.

Adopted the SHA-256 fallback for card display and executor frames over HTTP. Native SubtleCrypto is preserved, unsupported algorithms and invalid inputs reject, and random-number APIs remain native. The fallback is included before card scripts/dependencies and is not installed on the host page.

Adapted the repeated-settlement-failure idea into a stale-commit progress guard. Three stale results with the same operation, branch, story revision, lifecycle revision and phase use the existing serialized interruption path. Recovery rechecks those identities against current state; a newer branch or completed task is not overwritten. Explicit retry remains available; request-id idempotency is unchanged. Both successful-but-stale and failed-but-stale commits are covered.

Current main already has script-name error reporting, deduplication, a copy action in the error center, and the legacy `#chat` / `.mes_text` compatibility mount. These were retained rather than duplicated. SQLite, physical deletion, server-side MVU and automatic script relocation were not imported.

Validation:

- 44 focused tests passed: crypto digest, background coordinator/progress guard and settlement job lifecycle.
- 75 existing regression tests passed: legacy composer, module error UI, frame diagnostics, rollback surface/projection and story timeline.
- Client build/check and server syntax check passed.
- Playwright Chromium, intercepted `http://tavern-compat.test/`: `isSecureContext === false`, native `crypto.subtle` initially absent. After installing the fallback, SHA-256(`abc`) returned `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`. Native `getRandomValues` remained present. This is a browser capability check, not a full live-game E2E run.

The initial worktree contained unrelated guide, panel and styling changes. They are excluded from this task's commit.
