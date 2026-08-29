# Agent Gateway Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Agent Gateway across authorization, configuration, runtime/file handling, architecture, and verification without changing its user-facing purpose.

**Architecture:** Move environment loading and validation behind a central configuration module. Introduce explicit authorization/session-ownership seams and small router helpers so message and callback paths share the same policy. Keep Telegram and Instagram as concrete adapters behind their existing channel seam, while keeping OpenCode as the current engine implementation.

**Tech Stack:** Node.js ESM, built-in `node:test`, `@opencode-ai/sdk`, PowerShell on Windows.

**Spec:** User-approved improvement categories from the conversation: security; configuration/operation; files/UX; architecture/tests.

## Global Constraints

- Preserve the current Telegram-first gateway behavior and Instagram isolation.
- Do not expose or persist credentials, tokens, or secret values.
- Keep changes local to this workspace; no external service calls are required for tests.
- Use failing tests before production changes for each behavior change.
- Do not require a Git repository or destructive cleanup.

---

### Task 1: Configuration and authorization policy

**Files:**
- Create: `src/config.mjs`
- Create: `src/auth.mjs`
- Modify: `src/gateway.mjs`
- Modify: `src/opencode.mjs`
- Modify: `src/logger.mjs`
- Modify: `src/sessionStore.mjs`
- Test: `tests/config.test.mjs`
- Test: `tests/auth.test.mjs`

- [x] Write failing tests for `.env` loading, explicit admin IDs, command permission checks, and session ownership.
- [x] Run the focused tests and verify the expected failures.
- [x] Implement centralized configuration and shared auth/session policy.
- [x] Apply the policy to messages, callbacks, `/resume`, `/sessions`, and permission actions.
- [x] Run focused tests and verify they pass.

### Task 2: Runtime and file handling

**Files:**
- Modify: `src/opencode.mjs`
- Modify: `src/adapters/telegram.mjs`
- Modify: `src/gateway.mjs`
- Modify: `scripts/start-agent.ps1`
- Modify: `gateway.vbs`
- Test: `tests/fallback.test.mjs`
- Test: `tests/adapters.test.mjs`

- [x] Write failing tests for MIME-preserving attachments, configurable server endpoint, and update-offset persistence behavior.
- [x] Run focused tests and verify the expected failures.
- [x] Implement endpoint parsing, serialized server startup/restart, MIME-aware files, and safe temporary-file cleanup.
- [x] Persist Telegram offsets after processing updates.
- [x] Run focused tests and verify they pass.

### Task 3: Router seams and maintainability

**Files:**
- Create: `src/router.mjs`
- Create: `src/dedup.mjs`
- Modify: `src/gateway.mjs`
- Test: `tests/router.test.mjs`
- Test: `tests/dedup.test.mjs`

- [x] Write failing tests for command parsing and callback parsing/authorization decisions.
- [x] Run focused tests and verify the expected failures.
- [x] Extract pure message/callback routing helpers and use them from the gateway.
- [x] Keep side effects in injected handlers/adapters.
- [x] Run focused tests and verify they pass.

### Task 4: Regression coverage and documentation

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Test: existing test files plus new focused suites.

- [x] Add regression tests for all security fixes and configuration mismatches.
- [x] Run the full test suite and syntax checks.
- [x] Update operational setup, admin configuration, test count, and known runtime limitations.
- [x] Confirm no secrets or generated runtime state were added.
