> Archivált vizsgálat / Archived review: 2026-10-10, head `0b1b66b482a24928244ef6621492acefcb54860e`. Ez a jegyzet az akkori állapotot rögzíti; a későbbi commitokat nem értékeli. This document does not assess later commits.
> Kapcsolódó PR / Related PR: [mp3pintyo/Crucix #15](https://github.com/mp3pintyo/Crucix/pull/15). [Másik jegyzőkönyv / Companion report](pr15-review-2026-10-10.md).

# Security Review: Crucix

## Scope

Updated fork PR #15 at immutable head 0b1b66b482a24928244ef6621492acefcb54860e against be1beeee49ed2f73adff7fd557f240955f89578e; v2.37.0/master integration compatibility separately tested.

- Scan mode: branch_diff
- Target kind: git_diff
- Target ID: target_sha256_54b06c4fa9813b619b2efcd352ccf87c647b973ce52c68c46a799b56e26dd8d6
- Revision range: be1beeee49ed2f73adff7fd557f240955f89578e...0b1b66b482a24928244ef6621492acefcb54860e
- Snapshot digest: codex-security-snapshot/v1:sha256:ee1b66899ca8a7da82205c9809a2ac568e531eca600d9aae650235bb68327152
- Inventory strategy: diff
- Included paths: .
- Excluded paths: none

Limitations and exclusions:
- Real compiled SEA/postject and Cursor tool runtime not executed.
- External feed/provider availability not verified; no operator secrets used.
- 28 byte-identical prior-review files reused; all 12 added/updated files inspected. Static JSON catalog parsed, URL shape checked.
- Excluded Live external RSS/providers and Cursor agent execution: No operator keys, live feed verification or Cursor authority execution.
- Excluded Compiled SEA executable / postject supply-chain runtime: Unpinned npx postject not installed/executed. Launcher template/resolver reproduced safely instead.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 2 |
| Severity mix | medium: 2 |
| Confidence mix | high: 2 |
| Coverage | partial |
| Validation mode | Full head tests in isolated checkout/empty runtime, syntax/locale/dependency audit; source-extracted harmless security probes; static source and supporting-flow review. |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

# Crucix threat model
Scope: repository runtime; changed-file review PR #15.
Node/Express OSINT collection reads external RSS/XML and renders a browser dashboard. Feed publishers control headlines, links, dates and text. Protect operator credentials, local files, authenticated API actions, process availability and truthful freshness labels. server.mjs and lib/http-security.mjs own authentication/origin boundaries; lib/world-rss-runner.mjs owns feed requests and disk cache; dashboard/public/jarvis.html owns HTML rendering; lib/llm/cursor.mjs owns subprocess invocation with inherited operator environment/filesystem. Operators may configure destinations; publishers and web callers cannot inherit operator authority. Review response limits, concurrency, restored-cache freshness, URLs, HTML escaping and Windows command construction. Public reachability depends on operator binding/authentication settings. SECURITY.md prioritizes XSS, secrets, injection, traversal and exploitable dependencies. Cursor read/tool access is a hypothesis until validated.
Updated scope includes CLI readers/collector lifecycle and SEA launcher. Protect operator filesystem/execution authority when executable discovers runtime scripts, snapshot atomicity across concurrent collector/server processes, bounded requests and authentic freshness; CLI arguments are operator inputs, feed strings remain untrusted. SEA builder invokes npm tools; release artifacts should bind immutable dependencies and application code.

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [Unbounded country RSS response bodies and request amplification remain exploitable in the updated PR](#finding-1) | medium | high | inline below |
| [SEA launcher imports application code from an untrusted current working directory before its own installation](#finding-2) | medium | high | inline below |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] Unbounded country RSS response bodies and request amplification remain exploitable in the updated PR

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Exact handler reproduced 20 calls and uncapped 40 MiB reads across five requests. |
| Category | resource-exhaustion |
| CWE | CWE-400 |
| Affected lines | server.mjs:455-456 |

#### Summary

Pinned 0b1b66b head source-extracted proof: five concurrent live requests with four 2 MiB synthetic feeds read 41943040 bytes and made 20 fetch calls. No bounded reader/single-flight protection; no real network/OOM execution.

#### Validation

Validation outcomes are recorded below.

Validation method: Pinned-head source-extracted route with synthetic feeds/fetch, no network.

- **Disposition:** reportable

Evidence:
- Five concurrent requests × four 2 MiB feeds consumed 41943040 bytes; default shared 1 MiB cap is bypassed.

#### Dataflow

live country GET -\> feeds.map(fetch) -\> response.text -\> parseFeed -\> accumulated arrays

#### Reachability

Authorized caller, or remote unauthenticated caller when operator publishes without auth; feed controls response body.

#### Severity

**Medium** — The scan assigned medium severity; no separate canonical severity rationale was recorded.

Additional runtime or deployment evidence could raise or lower this severity.

**Impact assessment:** medium

**Likelihood assessment:** medium

#### Remediation

Withhold the PR. Use readBoundedText/shared bounded RSS fetching; cap per-feed records; share in-flight country work and cap total concurrency with a cooldown.

Tests:
- Oversized feed bodies are cancelled within the cap; concurrent same-country callers share one fetch set.

<a id="finding-2"></a>

### [2] SEA launcher imports application code from an untrusted current working directory before its own installation

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The unchanged generated launcher executed the planted module; path resolver selected it even when legitimate adjacent CLI exists. |
| Category | untrusted-search-path |
| CWE | CWE-427 |
| Affected lines | scripts/build-exe.mjs:36-46, scripts/build-exe.mjs:69-70 |

#### Summary

scripts/build-exe.mjs:36-46 searches process.cwd() first and accepts any scripts/cli.mjs; line 70 imports it. Harmless exact-launcher proof executed a planted CWD module; resolver selected it even with legitimate CLI beside simulated installed executable.

#### Validation

Validation outcomes are recorded below.

Validation method: Read exact launcher template; execute that template with a harmless planted CWD module under regular Node; independently run exact resolver with simulated installed executable path and a legitimate adjacent CLI.

- **Disposition:** reportable

Evidence:
- SYNTHETIC_UNTRUSTED_CWD_EXECUTED
- Resolver returned untrusted/scripts/cli.mjs with legitimate trusted/scripts/cli.mjs present.

#### Dataflow

Planted CWD/scripts/cli.mjs -\> findCliPath first existing match -\> process.argv\[1\] rewrite -\> import(file URL) -\> operator-level module execution.

#### Reachability

Requires operator launch from an attacker-writable/populated working directory. No network-only or privilege escalation claim.

#### Severity

**Medium** — The scan assigned medium severity; no separate canonical severity rationale was recorded.

Additional runtime or deployment evidence could raise or lower this severity.

**Impact assessment:** high

**Likelihood assessment:** low

#### Remediation

Bundle application code/assets into the SEA, or bind loading to a verified installation root. Remove implicit CWD/parent search. Pin/integrity-lock build dependencies and test actual binary from an untrusted CWD and from outside the repository.

Tests:
- A planted CWD/scripts/cli.mjs is never selected or executed when the trusted app is launched.
- The actual binary functions outside source checkout with its declared packaged dependencies.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| SEA launcher trust and executable packaging | not recorded | Reported | Exact generated launcher/resolver tested. Real compiled SEA/postject was not run. Evidence: artifacts/sea-cwd-proof.mjs, artifacts/sea-cwd-proof.log |
| Live country RSS endpoint | not recorded | Reported | Prior exhaustion finding persists unchanged at updated head. Evidence: artifacts/rss-resource-cache-proof.mjs, artifacts/rss-resource-cache-proof.log |
| CLI readers, formatting, filters and collector | not recorded | Needs follow-up | All 1650+ lines read. Two cold-checkout test failures, synchronous parseFeed treated as Promise, ISO2 risk code mismatch, JSON stdout chatter and collector overlap/derived-data omissions noted as correctness risks. Evidence: artifacts/full-tests.log, artifacts/syntax-locales.log |
| RSS cache, catalog and dashboard selectors | not recorded | Needs follow-up | 2020 restored cache still returned; undated-\>now and inferred source-country placement persist. 28 files byte-unchanged from prior reviewed head; 12 updated/new files inspected. Registry JSON parsed with 2865 URL strings, no credential/missing-host URLs. No live verification of external feeds. Evidence: artifacts/rss-resource-cache-proof.mjs, artifacts/rss-resource-cache-proof.log |
| Cursor inherited authority | not recorded | Needs follow-up | Unchanged prior --trust/CWD/environment concerns remain. No Cursor CLI/tool-chain exploit claimed. |
| Headless browser suppression and server integration | not recorded | No issue found | Headless suppresses auto-open only; merge test has jarvis.html conflict; no interface/access-control removal. Evidence: artifacts/full-tests.log, artifacts/syntax-locales.log |

## Open Questions And Follow Up

- Inherited agent authority and Windows command construction unvalidated; entire feature withheld.
  - Follow-up prompt: Review deferred unit cursor-runtime-proof and close its stated proof gap.
- Build/import mechanism and operation outside source checkout need a pinned-dependency actual-binary test.
  - Follow-up prompt: Review deferred unit actual-sea-binary and close its stated proof gap.
