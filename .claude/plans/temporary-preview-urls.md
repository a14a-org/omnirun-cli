# Plan: Temporary Preview URLs for Sandbox Ports

## Overview

Add first-class temporary HTTP(S) preview URLs for sandbox services so users can expose a port on a running sandbox and access it through a human-friendly hostname.

Example UX:

```bash
omni sandbox expose sbx_123 3000 --open
```

Output:

```text
url=https://brisk-lotus-a4f2.omnirun-preview.dev
port=3000
expires_at=2026-03-12T18:40:00Z
close=omni sandbox close sbx_123 exp_abc
```

The preview URL should route traffic to the selected sandbox port, support modern web app behavior (HTTP, SSE, WebSockets, HMR), and automatically stop working when the exposure expires or the sandbox stops.

## Product Goals

- Let users preview websites, dashboards, agents, and APIs running inside sandboxes without manual port-forwarding.
- Make the feature temporary by default and tightly coupled to sandbox lifecycle.
- Keep the UX simple enough for "show me my app" workflows.
- Avoid putting untrusted user content on the same cookie/domain boundary as the main OmniRun product.

## Non-Goals for V1

- Raw TCP forwarding.
- Arbitrary custom domains.
- Permanent public hosting.
- Automatic auth gates for every framework.
- Multi-region edge routing.
- Team-shared exposure management policies beyond basic ownership and quota checks.

## Recommended Naming

Use "preview URL" in the product and "exposure" in the API.

- User-facing: "Preview URL", "Expose port", "Share preview"
- API-facing: `Exposure`, `CreateExposureRequest`, `ExposureInfo`

This keeps the UX understandable while preserving a clean backend model.

## Core Design Decisions

### 1. Use a Separate Registrable Preview Domain

Do not serve user-controlled previews on `*.omnirun.io`.

Use a dedicated registrable domain such as:

- `*.omnirun-preview.dev`
- or `*.omnirunpreview.net`

Do not use `*.preview.omnirun.io` unless that parent domain is added to the Public Suffix List.

Reason:

- Keeps cookies and auth surfaces isolated from the main app.
- Reduces risk from user-hosted content, service workers, and browser storage collisions.
- Gives legal/abuse handling a cleaner boundary.

### 2. Model Preview URLs as Explicit Resources

A preview URL should not be an implicit string formula alone. It should be a persisted resource owned by a sandbox.

Each exposure should store:

- `id`
- `sandboxId`
- `port`
- `hostname`
- `url`
- `visibility` (`public` in v1; `private` later)
- `status` (`pending`, `ready`, `revoked`, `expired`, `sandbox_stopped`, `error`)
- `createdAt`
- `expiresAt`
- `revokedAt` (optional)
- `lastAccessedAt`
- `openPath` (optional)
- `preserveHost` (bool)
- `createdBy`

### 3. Preview Lifetime Must Be Temporary

Base rule:

- Exposure lifetime is always bounded by sandbox lifetime.

Recommended policy:

- Non-permanent sandbox: exposure defaults to sandbox expiry.
- Permanent sandbox: exposure defaults to 24 hours and must be renewed explicitly.

Reason:

- The user asked for something temporary.
- Permanent sandboxes would otherwise create permanent public endpoints by accident.
- A short renewable TTL is safer operationally and still good UX.

Effective expiry formula:

```text
effective_expires_at = min(
  requested_expires_at,
  sandbox_expires_at if sandbox is non-permanent,
  platform_max_exposure_ttl
)
retention_until = max(expires_at, revoked_at, sandbox_stopped_at) + retention_window
```

For permanent sandboxes:

- `sandbox_expires_at` is absent
- use `requested_expires_at` capped by `platform_max_exposure_ttl`

### 4. V1 Should Be HTTP(S)-Only

Support:

- HTTP/1.1
- HTTP/2 at edge
- SSE
- WebSockets

Do not support:

- raw TCP tunnels
- UDP

This keeps the feature aligned with website/app previews and dramatically simplifies security and ingress.

### 5. Reuse Existing Canonical Host Routing Where Possible

The platform already has a canonical host pattern for sandbox ports. Keep that as the internal routing primitive if it already works reliably, but layer friendly preview aliases on top of it.

That means the edge can resolve:

```text
brisk-lotus-a4f2.omnirun-preview.dev -> sandbox sbx_123 port 3000
```

without forcing the user to see the lower-level canonical URL.

### 6. Public First, Private Second

For v1, ship public preview URLs with explicit user opt-in.

Do not block launch on "private preview" unless there is already a simple browser-friendly auth pattern.

Private previews can be phase 2:

- signed preview links
- edge-issued session cookie
- optional time-limited access grants

## Repos and Dependency Order

1. `omnirun` — backend API, sandbox lifecycle integration, exposure persistence
2. `omnirun-edge` or ingress stack — wildcard DNS, TLS, host routing, proxy behavior
3. `omnirun/sdk/typescript` — exposure models and client methods
4. `omnirun-cli` — `sandbox expose` UX and beamup integration
5. website/app repo — docs, sandbox detail UI, exposure management UI, marketing updates

If edge lives inside `omnirun`, treat steps 1 and 2 as one deployable unit.

## User Stories

### Primary

- As a user running `npm run dev` inside a sandbox, I want a URL I can open in a browser.
- As a user running a demo app in a permanent sandbox, I want a temporary link I can renew without rebuilding the app.
- As a user sharing a preview with someone else, I want a short link I can copy and send.

### Secondary

- As a user debugging why my app is not reachable, I want status hints instead of a dead link.
- As an operator, I want to revoke exposures immediately when abuse is detected.

## API Design

### New Resource

Add exposure endpoints under sandboxes:

```text
POST   /sandboxes/:sandboxId/exposures
GET    /sandboxes/:sandboxId/exposures
GET    /sandboxes/:sandboxId/exposures/:exposureId
DELETE /sandboxes/:sandboxId/exposures/:exposureId
POST   /sandboxes/:sandboxId/exposures/:exposureId/refresh
```

Optional global admin endpoint:

```text
GET /exposures?state=ready&hostname=...
```

### Create Exposure Request

```json
{
  "port": 3000,
  "visibility": "public",
  "requestedTtlSeconds": 3600,
  "slug": "brisk-lotus-a4f2",
  "openPath": "/",
  "preserveHost": true,
  "waitForReady": true
}
```

Behavior:

- `port` required
- `visibility` defaults to `public`
- `requestedTtlSeconds` optional
- `slug` optional; if omitted, server generates
- `openPath` optional; appended when displaying URL
- `preserveHost` defaults to `true`
- `waitForReady` is advisory only; the server should record readiness state and return immediately
- readiness waiting happens client-side via polling, not by holding the create request open

### Exposure Response

```json
{
  "id": "exp_abc123",
  "sandboxId": "sbx_123",
  "port": 3000,
  "hostname": "brisk-lotus-a4f2.omnirun-preview.dev",
  "url": "https://brisk-lotus-a4f2.omnirun-preview.dev/",
  "visibility": "public",
  "status": "ready",
  "createdAt": "2026-03-12T17:00:00Z",
  "expiresAt": "2026-03-12T18:00:00Z",
  "revokedAt": null,
  "preserveHost": true,
  "openPath": "/"
}
```

### Validation Rules

- Sandbox must exist and belong to caller.
- Sandbox must be `running` or `paused` depending on product policy.
- Port must be `1-65535`.
- Exposed port must be HTTP(S)-capable from the ingress perspective.
- `requestedTtlSeconds` must be `> 0` and `<= platform max`.
- Slug must match safe hostname format and reserved word rules.
- Maximum active exposures per sandbox and per account must be enforced.

### Errors

Return structured errors for:

- `sandbox_not_found`
- `sandbox_not_running`
- `port_not_listening`
- `port_blocked`
- `slug_unavailable`
- `exposure_limit_reached`
- `ttl_too_long`
- `preview_domain_unavailable`

## Persistence and Data Model

Add an `exposures` table or equivalent store.

Persistence is required for v1.

Do not use an in-memory map as the system of record unless the team explicitly accepts:

- exposure loss on server restart
- single-node assumptions
- routing inconsistencies during deployment

Recommended approach:

- durable storage for exposure records
- TTL-driven cleanup for expired and revoked records
- short retention window so stale records do not linger forever

Suggested fields:

```text
id                 string primary key
sandbox_id         string indexed
account_id         string indexed
port               int
hostname           string unique indexed
visibility         string
status             string indexed
requested_ttl_sec  int
created_at         timestamp
expires_at         timestamp indexed
revoked_at         timestamp nullable
sandbox_stopped_at timestamp nullable
retention_until    timestamp indexed
last_accessed_at   timestamp nullable
open_path          string nullable
preserve_host      boolean
created_by         string nullable
```

Optional audit table:

```text
exposure_events(id, exposure_id, event_type, payload, created_at)
```

## Lifecycle Rules

### Sandbox Create

No automatic exposure unless explicitly requested by the user.

### Sandbox Kill

Immediately revoke all active exposures and set `status=revoked` or `status=sandbox_stopped` based on the chosen audit model.

### Sandbox Expiry

Immediately mark all active exposures `status=sandbox_stopped` and stop routing.

### Sandbox Pause

Recommended v1 behavior:

- Leave exposure resource in place.
- Edge returns `503 sandbox paused`.
- Resuming the sandbox restores traffic automatically.

Alternative behavior:

- revoke on pause

Do not choose revoke-on-pause unless pause is effectively treated as kill everywhere, because it will feel surprising.

### Exposure Expiry

- Mark `status=expired`
- Stop routing immediately
- Keep record visible for history for a short retention window
- Delete or archive after `retention_until`

### Exposure Revocation

- Mark `status=revoked`
- Set `revokedAt`
- Stop routing immediately
- Keep record for audit/history until `retention_until`

### Renewal

Expose a refresh endpoint for active or recently expired exposures, subject to sandbox state and TTL policy.

Recommended UX behavior:

- if the same sandbox/port is exposed again and there is a single matching active exposure, renew/extend it instead of erroring
- if multiple matching exposures exist, require explicit exposure ID to refresh

## Edge / Ingress Architecture

### Requirements

- Wildcard DNS for preview domain
- Wildcard TLS certificate
- Hostname lookup to exposure record
- Reverse proxy to sandbox target
- Request path bounded strictly to the selected sandbox and port
- Support for:
  - large responses
  - chunked streaming
  - SSE
  - WebSockets
  - gzip/br compression passthrough or re-compression policy

Architecture recommendation for v1:

- extend the existing Go port proxy middleware rather than introducing a separate proxy service
- add WebSocket upgrade support there explicitly
- use the existing edge provider or Cloudflare wildcard routing for DNS/TLS termination if that is already part of operations

### Request Flow

1. Request arrives for `brisk-lotus-a4f2.omnirun-preview.dev`
2. Edge resolves hostname to exposure
3. Edge validates:
   - exposure exists
   - exposure active
   - exposure not expired
   - sandbox allowed
4. Edge selects target:
   - sandbox canonical host and port
   - or internal service endpoint
5. Edge proxies request and injects:
   - `X-Forwarded-Host`
   - `X-Forwarded-Proto`
   - `X-Forwarded-For`
   - `X-Omnirun-Sandbox-Id`
   - `X-Omnirun-Exposure-Id`

The proxy must not allow the request to escape to arbitrary internal destinations. Hostname lookup should resolve to a precomputed `(sandboxId, port)` tuple and proxy only there.

### Host Header Handling

Many frameworks care about hostnames.

Recommended v1 default:

- Preserve original preview host
- Inject `X-Forwarded-*` headers

Optional advanced mode:

- `preserveHost=false` to rewrite `Host` to the internal canonical target if specific frameworks require it

This should be configurable per exposure, not global.

### Readiness

The edge and API should distinguish:

- exposure exists but app not listening
- exposure ready
- sandbox paused/stopped

Suggested response behavior:

- `502` or `503` with OmniRun-branded error page for public browser hits
- CLI and website polling should use structured API status instead of scraping HTTP

`waitForReady` semantics:

- create exposure returns quickly with `status=pending` if the app is not yet reachable
- CLI and website poll `GET /sandboxes/:sandboxId/exposures/:exposureId`
- do not hold open the create request waiting for the app to start

## Slug Generation

The requested example is `{randomword}{randomword}.omnirun.io`. Use a safer variation:

```text
word-word-8char.omnirun-preview.dev
```

Examples:

- `brisk-lotus-a4f2c9e1.omnirun-preview.dev`
- `silver-meadow-k9p2d7f4.omnirun-preview.dev`

Why not just two words:

- collision risk rises fast
- profanity/brand collision risk
- predictable names are easier to scrape

Generation rules:

- lowercase only
- `[a-z0-9-]`
- reserved word blocklist
- profanity blocklist
- add a longer random suffix
- enforce rate limiting on the preview domain to slow hostname probing

Allow user override with `--slug`, but keep server-side uniqueness checks.

## Security Model

### V1

- Public previews only
- Explicit opt-in by the creator
- Clear warning that URL is internet-accessible

### V2

Add private preview mode using browser-friendly auth:

- signed share link
- edge sets `HttpOnly` cookie
- cookie scoped to preview domain only

Avoid browser flows that require users to manually add headers.

### Abuse Controls

Minimum controls before GA:

- per-account exposure quota
- per-sandbox exposure quota
- bandwidth and request rate limits
- request body size limit
- outbound proxy timeout caps
- moderation/takedown tooling
- access logs by hostname and account
- reserved hostname list

### Domain Isolation

Do not share session cookies with preview domains.

Website auth cookies must never be valid for the preview wildcard.

### Headers and Proxy Safety

Set or enforce:

- `X-Forwarded-*`
- `X-Content-Type-Options: nosniff`
- conservative default CSP on OmniRun-generated error pages
- strip hop-by-hop headers properly
- sanitize or strip response headers that can create cross-preview leakage, including unsafe `Set-Cookie` domain/path combinations where needed
- review and normalize `Access-Control-*` and framing headers for proxy safety

Do not inject product cookies into proxied preview traffic.

## Backend Implementation Detail

### New Internal Package Areas

Likely server files or modules:

- `internal/exposure/exposure.go`
- `internal/exposure/store.go`
- `internal/exposure/service.go`
- `internal/api/handlers_exposure.go`
- `internal/edge/router.go` or ingress integration

### Sandbox Model Updates

Add lightweight exposure metadata to sandbox info responses:

- `activeExposureCount`
- maybe `previewUrls` only in detailed responses

Do not overload existing `endAt` or `trafficToken` fields for this feature.

### Cleanup Jobs

Add scheduled cleanup for:

- expired exposures
- revoked exposures past retention
- orphaned exposures
- stale pending exposures

### Metrics

Add:

- exposures created
- exposures active
- exposure request count
- exposure bytes in/out
- readiness failures
- 4xx/5xx by exposure
- websocket upgrade count

## SDK Plan (`@omnirun/sdk`)

### New Types

Add to `models.ts`:

```ts
export interface ExposureInfo {
  id: string;
  sandboxId: string;
  port: number;
  hostname: string;
  url: string;
  visibility: "public" | "private";
  status: "pending" | "ready" | "revoked" | "expired" | "sandbox_stopped" | "error";
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastAccessedAt?: string;
  openPath?: string;
  preserveHost?: boolean;
}

export interface CreateExposureOptions {
  port: number;
  visibility?: "public" | "private";
  requestedTtlSeconds?: number;
  slug?: string;
  openPath?: string;
  preserveHost?: boolean;
  waitForReady?: boolean;
}
```

### New Namespace

Add an `Exposures` namespace on `Sandbox`:

```ts
sandbox.exposures.create(...)
sandbox.exposures.list()
sandbox.exposures.get(id)
sandbox.exposures.delete(id)
sandbox.exposures.refresh(id, ttlSeconds?)
```

This is preferable to putting every method directly on `Sandbox`.

### Backward Compatibility

Keep `getHost(port)` as an internal/canonical helper for now.

Do not present it as the preferred user-facing preview URL once exposures exist.

Later:

- deprecate or rename it to `getCanonicalHost(port)` if the team wants the API surface to be clearer

### SDK Tests

Add tests for:

- create/list/delete exposure
- parsing exposure status and timestamps
- refresh semantics
- public vs private visibility
- error propagation for blocked port and slug collision

## CLI Plan (`omnirun-cli`)

### New Commands

Add a new `sandbox expose` command group:

```text
omni sandbox expose <sandboxId> <port>
omni sandbox exposures <sandboxId>
omni sandbox close <sandboxId> <exposureId>
omni sandbox unexpose <sandboxId> <exposureId>
omni sandbox refresh-exposure <sandboxId> <exposureId>
```

Recommended flags for `sandbox expose`:

- `--ttl <seconds>`
- `--slug <slug>`
- `--path <path>`
- `--private` (phase 2; hidden or omitted in v1)
- `--rewrite-host`
- `--wait`
- `--no-wait`
- `--open`
- `--copy`
- `--json`

### Example UX

```bash
omni sandbox expose sbx_123 3000 --open
```

CLI should:

1. Call create exposure
2. Poll until ready by default
3. Print URL and expiry
4. Optionally open browser

Default waiting behavior:

- `--wait` should be the default behavior
- `--no-wait` skips polling and prints the pending exposure immediately

### Smart Hints

If preview is not reachable yet, print actionable hints:

- "Make sure your app listens on `0.0.0.0`, not `127.0.0.1`."
- "Framework may be rejecting the preview host; retry with `--rewrite-host` if needed."
- "The selected port is not listening yet."
- "This preview URL will expire soon; run `omni sandbox refresh-exposure ...` to extend it."

### Beamup Integration

Once generic `sandbox expose` exists, add optional sugar to beamup commands:

- `omni beamup claude --expose 3000`
- `omni beamup codex --expose 3000`
- `omni beamup gemini --expose 3000`
- `omni beamup openclaw --expose 4767`

Flags:

- `--expose <port>` repeatable
- `--open-preview` optional convenience
- `--preview-ttl <seconds>`

For `beamup openclaw`, this should replace ad hoc printing of a raw host URL and instead create a managed exposure record.

### CLI Output

Human output:

```text
preview_url=https://brisk-lotus-a4f2c9e1.omnirun-preview.dev
port=3000
status=ready
expires_at=2026-03-12T18:00:00Z
close=omni sandbox close sbx_123 exp_abc123
```

JSON output:

```json
{
  "sandboxId": "sbx_123",
  "exposure": {
    "id": "exp_abc123",
    "url": "https://brisk-lotus-a4f2c9e1.omnirun-preview.dev",
    "port": 3000,
    "status": "ready",
    "expiresAt": "2026-03-12T18:00:00Z"
  }
}
```

### CLI Tests

Add tests for:

- `sandbox expose` calls SDK with correct options
- `--wait` behavior
- `--no-wait` behavior
- `--open` output path
- `--copy` output path
- slug override
- rewrite-host flag
- list and delete commands
- beamup integration paths

## Website / App Plan

This feature needs both documentation and product UI.

### Documentation

Add a docs page:

- "Preview URLs"

Cover:

- exposing a port
- public preview caveats
- how expiry works
- troubleshooting common framework issues
- how to revoke a preview

### Sandbox Detail UI

On the sandbox detail page add:

- "Preview URLs" section
- create exposure form
- list of active exposures
- copy URL button
- open in browser button
- close button
- expiry countdown
- expiry warning state
- status badge (`pending`, `ready`, `revoked`, `expired`) plus derived sandbox state indicator (`running`, `paused`, `stopped`)

### Website UX

The create form should ask for:

- port
- TTL
- optional custom slug
- advanced toggle for host rewrite behavior

Suggested defaults:

- port empty until user types it
- TTL default `1h`
- random slug generated server-side
- preserve host default on
- wait for readiness default on

### Warning Copy

For public previews:

- "Anyone with the URL can access this preview until it expires."

For permanent sandboxes:

- "This sandbox is permanent, but preview URLs are temporary and expire automatically."

Expiry warning UX:

- show "expiring soon" state at a configurable threshold such as 10 minutes remaining
- provide one-click renew/extend action in UI

### Marketing / Landing Page

Update product copy to mention:

- one-click preview URLs
- browser-based app previews from sandboxes
- temporary share links for demos

Do not market this as static hosting.

### Future UI

Phase 2 UI:

- private previews
- renew expiry
- analytics or request count

## Troubleshooting Experience

The best UX here is not only "here is a URL" but also "here is why it might not work."

Common failure cases:

- app not started
- wrong port
- app bound to localhost only
- framework rejects unknown host
- sandbox paused
- exposure expired

Recommended product responses:

- CLI: direct hint text
- website UI: inline status and suggested fixes
- edge error page: simple OmniRun-branded explanation

This should include explicit expiry messaging before a preview dies, not only after it has expired.

## Operational Caveats

### 1. Abuse Surface

Public previews can host:

- phishing pages
- malware payloads
- copyright infringement
- bot dashboards

Mitigations:

- quotas
- logging
- rapid revoke tooling
- abuse reporting path
- domain separation

### 2. Cost Surface

Previews add:

- egress bandwidth
- long-lived websocket connections
- edge CPU/memory
- log storage

Pricing and usage reporting must account for this eventually.

### 3. Browser Cache and Service Workers

Do not aggressively recycle hostnames.

Reason:

- cookies and service workers may persist across sessions
- users can get confusing stale behavior

### 4. Framework Compatibility

Some dev servers require:

- `--host 0.0.0.0`
- allowed host configuration
- trusted origin config

The product should document this explicitly.

### 5. SSRF and Internal Routing Safety

The preview proxy must never become a generic SSRF primitive.

Requirements:

- requests route only to the sandbox/port bound to the exposure record
- no user-controlled upstream URL selection
- no fallback to arbitrary internal hosts
- strict validation around upgrade and CONNECT-like behavior

### 6. Permanent Sandboxes

Temporary previews on permanent sandboxes are operationally different from previews on expiring sandboxes.

Recommendation:

- keep previews temporary even if sandbox is permanent
- let users renew or recreate them

## Rollout Plan

### Phase 0: Design and Policy

1. Choose preview domain
2. Confirm edge architecture owner
3. Define max TTL and quota policy
4. Decide pause behavior
5. Decide whether private previews are in v1 or v2
6. Decide retention window for expired/revoked exposure records

### Phase 1: Backend and Edge

1. Add exposure model/store
2. Add create/list/delete/refresh APIs
3. Add wildcard DNS and TLS
4. Extend existing port proxy middleware with host lookup and WebSocket support
5. Add lifecycle hooks for sandbox kill/expiry
6. Add cleanup jobs for expired/revoked records
7. Add request logging, metrics, and preview-domain rate limiting

### Phase 2: SDK

1. Add exposure models
2. Add exposures namespace
3. Add tests
4. Publish SDK

### Phase 3: CLI

1. Add `sandbox expose`
2. Add `sandbox exposures`
3. Add `sandbox close`
4. Keep `sandbox unexpose` as a compatibility alias if desired
5. Add `sandbox refresh-exposure`
6. Integrate optional `--expose` into beamup commands
7. Add tests
8. Publish CLI

### Phase 4: Website / App

1. Add docs page
2. Add sandbox detail UI for preview URLs
3. Add create/revoke UX
4. Add status and troubleshooting messaging
5. Update marketing copy

### Phase 5: Hardening

1. Add private previews
2. Add analytics or access counts
3. Add abuse controls and quotas in UI
4. Add hostname renewal flow

## Phase Wrap-Up Notes

Use these sections to record implementation notes as each phase is completed.

### Phase 0 Wrap-Up Notes

- Decisions locked: preview URLs ship as explicit persisted exposure resources; client-side waiting only; separate preview domain; temporary TTL even for permanent sandboxes; `close` preferred over `unexpose` in UX.
- Final preview domain: `omnirun-preview.dev` in the current implementation/config surface.
- Final TTL policy: exposure TTL is capped server-side; for non-permanent sandboxes the effective expiry is bounded by sandbox expiry; create/refresh reject non-positive TTLs.
- Final retention window: 24 hours after expiry/revocation/sandbox stop in the current backend implementation.
- Open issues carried forward: production DNS/TLS provisioning and any external edge-provider rollout still need infra coordination.
- Notes: the workspace implementation follows the panel guidance around domain isolation, explicit statuses, and client-side readiness polling.

### Phase 1 Wrap-Up Notes

- Backend API shipped: `POST/GET/DELETE /sandboxes/{id}/exposures`, `GET /sandboxes/{id}/exposures/{exposureId}`, and `POST /sandboxes/{id}/exposures/{exposureId}/refresh`.
- Proxy/WebSocket support shipped: preview host routing was added to `internal/api/port_proxy.go` on top of the existing reverse proxy path; the implementation preserves streaming behavior and host rewrite control.
- Storage/migration shipped: SQLite migration `005_exposures.sql` plus `internal/auth/exposure.go` store methods and lifecycle status handling.
- Cleanup jobs shipped: janitor loop deletes records after `retention_until`; sandbox kill marks related exposures `sandbox_stopped`; access timestamps are recorded.
- Operational caveats discovered: infra still needs wildcard DNS/TLS for the separate preview domain; the current repo only implements application routing and persistence, not provider-side tunnel/DNS setup.
- Follow-up fixes: add quota/rate-limit policy around exposure creation if platform abuse posture requires stricter defaults; consider richer exposure-event audit rows if support workflows need them.
- Notes: proxy hardening includes private preview token validation, cookie domain stripping, basic framing/CORS cleanup, and bounded target routing to the selected sandbox port.

### Phase 2 Wrap-Up Notes

- SDK version published: not published from this workspace, but the TypeScript SDK source/build/tests are updated.
- Final exposure API surface: `sandbox.exposures.create/list/get/refresh/close` plus `sandbox.expose(port, opts)` convenience wrapper.
- Breaking changes or compatibility notes: no removals; `getHost(port)` remains available as the canonical host helper.
- Test coverage notes: added unit coverage for create/list/close flows and verified package build/tests pass.
- Notes: exposure types are exported from `models.ts` and `index.ts`, including status/visibility enums and create/refresh option shapes.

### Phase 3 Wrap-Up Notes

- CLI version published: not published from this workspace, but the CLI source/build/tests are updated.
- Commands shipped: `omni sandbox expose`, `omni sandbox exposures`, `omni sandbox close` (with `unexpose` alias), and `omni sandbox refresh-exposure`.
- Beamup integration shipped: `--expose`, `--preview-ttl`, `--preview-path`, `--private-preview`, and `--rewrite-preview-host` added to all current `beamup` launchers.
- UX changes from plan: dedicated `sandbox expose` waits by default and supports `--no-wait`, `--copy`, and `--open`; `beamup --expose` intentionally creates previews without blocking because launcher sessions often start the app only after attach.
- Platform-specific issues: clipboard/browser-open helpers are best-effort and depend on `pbcopy`, `clip`, `wl-copy`, `xclip`, `xsel`, `open`, or `xdg-open` being present.
- Notes: CLI tests were extended for preview URL create/list/close and beamup preview creation; existing beamup timeout/permanent coverage still passes.

### Phase 4 Wrap-Up Notes

- Docs page published: source updated in `omnirun/website` and website build passes in this workspace.
- UI shipped: docs/examples/product copy only in this repo set; no authenticated dashboard UI was added because that surface is not present in the workspace.
- Marketing copy updated: hero terminal copy, feature card copy, code examples, and docs now describe preview URLs and the CLI flow.
- Support/troubleshooting additions: docs call out `0.0.0.0` binding, host-header rewrite behavior, and temporary-lifetime semantics.
- Notes: the CLI README was updated alongside website docs so the local developer surface matches the public docs.

### Phase 5 Wrap-Up Notes

- Hardening work shipped: persisted status model, revocation/expiry handling, sandbox-stop cleanup, cookie/header sanitization, and fixed-port routing boundaries are in place.
- Private preview status: implemented in the backend/API/SDK/CLI path with tokenized access URLs and cookie-based browser handoff.
- Abuse-control status: foundational lifecycle controls are present, but production quotas/rate limits and operational abuse workflows still depend on deployment policy.
- Remaining launch blockers: wildcard DNS/TLS and any external edge configuration must be deployed; if a separate control-plane or dashboard repo exists, preview management UI there still needs implementation.
- Notes: from the repos available in this workspace, the feature is functionally complete; remaining work is infra rollout and any product surfaces that live outside these repos.

## Verification Plan

### Backend

- create exposure on running sandbox
- create exposure on paused sandbox
- exposure expires at expected time
- exposure marked `revoked` when manually closed
- exposure marked `sandbox_stopped` when sandbox is killed
- exposure marked `sandbox_stopped` when sandbox expires
- refresh fails when sandbox stopped
- slug collision returns proper error
- old revoked/expired records cleaned after retention window

### Edge

- HTTP requests proxy correctly
- WebSocket upgrade succeeds
- SSE streams correctly
- `X-Forwarded-*` headers are correct
- response header sanitization works as intended
- requests cannot escape to unintended internal targets
- paused sandbox returns expected error page
- expired preview returns expected error page

### SDK

- exposure create/list/delete/refresh methods work against fake transport
- models parse correctly

### CLI

- human output format
- JSON output format
- `--wait` polling
- `--no-wait` skip path
- `--open` path
- `--copy` path
- beamup exposure creation

### Website

- preview URL card renders
- create modal/form validation
- revoke action updates UI
- expiry countdown correct
- copy/open actions work

## Recommended File Areas to Change

### `omnirun` repo

- `internal/api/handlers_exposure.go`
- `internal/exposure/*.go`
- sandbox lifecycle manager files
- ingress/edge config or service
- migration files for `exposures`

### `@omnirun/sdk`

- `src/models.ts`
- `src/exposures.ts`
- `src/sandbox.ts`
- tests for new namespace

### `omnirun-cli`

- `src/cli.ts`
- `tests/cli.test.mjs`
- `README.md`
- `CHANGELOG.md`

### website/app repo

- sandbox detail route/page
- docs page
- API client/hooks
- marketing landing page copy

## Open Questions

These should be resolved before implementation starts:

1. Will the team use a separate registrable preview domain immediately, or pursue PSL registration for a subdomain later?
2. Does the current canonical host routing already support all required HTTP/WebSocket behavior, or only a subset?
3. Is the existing `secure`/traffic-token model intended to back private previews, or should preview auth be a separate mechanism?
4. Where does edge routing live today: same service, reverse proxy layer, or separate edge worker?
5. What is the allowed maximum exposure TTL for permanent sandboxes?
6. Should one sandbox port allow multiple simultaneous preview URLs in v1?
7. Should preview creation fail if the port is not listening yet, or create a pending exposure and let the app come up afterward?
8. What retention window should apply to expired and revoked exposure records?

## Recommendation

Ship this in two steps:

### V1

- public preview URLs
- separate preview domain
- explicit exposure resource
- sandbox-scoped temporary lifetime
- CLI + SDK + website management

### V2

- private previews
- renew/share flows
- analytics
- more advanced policy controls

That split gets the core user value quickly without entangling the first release with complicated browser auth.

## Condensed Execution Checklist

Use this as the implementation approval checklist.

### Pre-Implementation Decisions

- Choose a separate registrable preview domain.
- Confirm wildcard DNS/TLS ownership and edge/proxy owner.
- Confirm persistent storage for exposures with TTL-based cleanup.
- Set platform limits:
  - max exposure TTL
  - max active exposures per sandbox
  - max active exposures per account
  - retention window for expired/revoked records
- Confirm v1 scope:
  - public previews only
  - HTTP/SSE/WebSockets only
  - wait-by-default UX
  - `close` as primary CLI verb, `unexpose` optional alias

### Backend / Edge

- Add `exposures` persistence model and migration.
- Add exposure statuses: `pending`, `ready`, `revoked`, `expired`, `sandbox_stopped`, `error`.
- Add API endpoints:
  - create
  - list
  - get
  - close/delete
  - refresh
- Couple exposures to sandbox lifecycle:
  - sandbox kill -> mark `sandbox_stopped` and stop routing
  - sandbox expiry -> mark `sandbox_stopped` and stop routing
  - manual close -> mark `revoked`
- Extend existing port proxy middleware:
  - hostname lookup
  - HTTP proxying
  - SSE support
  - WebSocket upgrade support
- Enforce strict upstream binding to `(sandboxId, port)` to avoid SSRF.
- Add response-header sanitization:
  - `Set-Cookie`
  - `Access-Control-*`
  - framing-related headers as needed
- Add preview-domain rate limiting and request logging.
- Add cleanup job for expired/revoked records after retention window.

### SDK

- Add `ExposureInfo` and `CreateExposureOptions`.
- Add `sandbox.exposures` namespace with:
  - `create`
  - `list`
  - `get`
  - `delete/close`
  - `refresh`
- Keep existing canonical host helper only as internal/backward-compatible API.
- Add SDK tests for CRUD, refresh, status parsing, and error propagation.

### CLI

- Add commands:
  - `omni sandbox expose`
  - `omni sandbox exposures`
  - `omni sandbox close`
  - optional `omni sandbox unexpose` alias
  - `omni sandbox refresh-exposure`
- Make readiness waiting the default.
- Add `--no-wait`, `--open`, `--copy`, `--ttl`, `--slug`, `--path`, `--rewrite-host`.
- Print:
  - preview URL
  - status
  - expiry
  - close command
- Add beamup integration via `--expose` and `--preview-ttl`.
- Replace any ad hoc raw host printing in beamup flows with managed exposure creation.
- Add CLI tests for wait/no-wait, close, refresh, copy/open, and beamup integration.

### Website / App

- Add docs page for preview URLs.
- Add sandbox detail UI:
  - create preview
  - list previews
  - copy/open
  - close
  - renew
  - expiry warning
- Show both exposure status and derived sandbox state.
- Add troubleshooting guidance for:
  - wrong port
  - localhost bind
  - rejected host
  - paused sandbox
  - expired preview

### Launch Gates

- Separate registrable preview domain is live.
- WebSockets work through the preview proxy.
- Readiness polling is client-side only.
- Persistent exposure records survive server restart.
- Expired/revoked previews stop routing immediately.
- Header sanitization and SSRF protections are verified.
- CLI and website both expose the same core operations.
- Abuse/rate-limit controls are enabled before public rollout.

### Deferred to V2

- Private previews
- share-auth flows
- analytics/dashboarding
- custom domains
- non-HTTP protocols

## Repo-by-Repo Task Breakdown

This section converts the design into an execution sequence with likely owners.

Owner labels are suggestions:

- `Backend` = API/server engineer
- `Edge` = networking/infra engineer
- `SDK` = TypeScript SDK maintainer
- `CLI` = CLI maintainer
- `Web` = website/app engineer
- `Ops` = platform/infrastructure owner

### Execution Order Summary

Recommended implementation order:

1. Domain and edge decisions
2. Backend data model and API
3. Proxy/routing support including WebSockets
4. SDK surface
5. CLI commands
6. Website UI and docs
7. Beamup integration
8. rollout hardening and launch checks

Critical path:

- preview domain
- persistent exposure store
- proxy/edge routing
- WebSocket support
- SDK support for exposures

### `omnirun` Repo

Primary owner:

- `Backend`
- `Edge`

Secondary owner:

- `Ops`

Tasks:

1. Finalize exposure schema and status model.
2. Add DB migration for `exposures`.
3. Implement exposure store/service layer.
4. Add API handlers:
   - create exposure
   - list exposures
   - get exposure
   - close exposure
   - refresh exposure
5. Add validation rules:
   - sandbox ownership
   - sandbox state
   - valid port
   - TTL cap
   - slug format and uniqueness
   - quota checks
6. Add lifecycle hooks:
   - sandbox kill
   - sandbox expiry
   - sandbox pause semantics
7. Extend existing port proxy middleware:
   - host lookup
   - HTTP proxying
   - SSE passthrough
   - WebSocket upgrade support
8. Add proxy hardening:
   - strict upstream binding
   - SSRF prevention
   - response header sanitization
   - preview-domain rate limiting
9. Add cleanup worker for expired/revoked records.
10. Add metrics, logs, and audit events.
11. Add integration tests for exposure lifecycle and proxy behavior.

Suggested deliverables:

- merged migration
- merged API handlers
- merged proxy support
- passing backend/integration test suite
- deployable preview-domain routing

Dependencies:

- preview domain selected
- wildcard DNS/TLS available

Risk notes:

- WebSocket support is mandatory for dev-server UX.
- Header handling and SSRF boundaries need explicit test coverage.

Wrap-up notes to capture:

- migration and schema decisions
- proxy behavior changes
- lifecycle edge cases discovered
- production incidents or rollback notes

### Edge / Infra Stack

If edge logic is separate from `omnirun`, break it out as its own workstream.

Primary owner:

- `Edge`
- `Ops`

Tasks:

1. Provision separate registrable preview domain.
2. Configure wildcard DNS.
3. Configure wildcard TLS.
4. Route preview hostnames to the existing Go proxy/service.
5. Confirm HTTP and WebSocket traffic behavior through the edge provider.
6. Add rate limiting at the preview domain layer if easier there than in app code.
7. Add logs/metrics export for preview traffic.
8. Validate cache/CDN behavior does not break dynamic preview traffic.

Suggested deliverables:

- live wildcard preview domain
- validated TLS
- validated websocket/HMR behavior through edge

Dependencies:

- domain ownership
- deployment path for Go proxy

Risk notes:

- CDN caching must not accidentally cache dynamic preview responses.
- Compression and upgrade behavior can differ between providers.

Wrap-up notes to capture:

- final DNS/TLS provider setup
- caching and websocket observations
- provider-specific caveats

### `@omnirun/sdk`

Primary owner:

- `SDK`

Tasks:

1. Add `ExposureInfo` and related types.
2. Add `CreateExposureOptions`.
3. Implement `Exposures` namespace.
4. Attach exposures namespace to `Sandbox`.
5. Add request methods for:
   - create
   - list
   - get
   - close/delete
   - refresh
6. Add test coverage around response parsing and error handling.
7. Publish a new SDK version after backend API is stable.

Suggested deliverables:

- tagged SDK release with exposure API

Dependencies:

- backend API contract frozen enough to implement against

Risk notes:

- avoid baking in server-side wait semantics; keep readiness polling client-side

Wrap-up notes to capture:

- final SDK method names
- any compatibility shims kept
- release notes and migration notes

### `omnirun-cli`

Primary owner:

- `CLI`

Tasks:

1. Add exposure commands:
   - `sandbox expose`
   - `sandbox exposures`
   - `sandbox close`
   - optional `sandbox unexpose` alias
   - `sandbox refresh-exposure`
2. Add flags:
   - `--ttl`
   - `--slug`
   - `--path`
   - `--rewrite-host`
   - `--open`
   - `--copy`
   - `--no-wait`
3. Implement default wait behavior using client-side polling.
4. Add human and JSON output formats.
5. Add readiness and troubleshooting messaging.
6. Add beamup integration for `--expose` and `--preview-ttl`.
7. Replace raw host printing in existing flows with managed exposure creation.
8. Add unit/integration tests using fake SDK responses.
9. Update README and changelog.
10. Cut a release after SDK publish.

Suggested deliverables:

- CLI release with exposure commands
- beamup integration release

Dependencies:

- SDK exposure namespace published

Risk notes:

- `--wait` should be default; do not make users discover it.
- clipboard support may differ by platform; keep it best-effort.

Wrap-up notes to capture:

- final command/flag names
- output changes from plan
- platform-specific behavior differences

### Website / App Repo

Primary owner:

- `Web`

Secondary owner:

- `Backend` for API coordination

Tasks:

1. Add API client/hooks for exposures.
2. Add sandbox detail page exposure section.
3. Add create-preview form.
4. Add list and status display.
5. Add copy/open/close/renew actions.
6. Add expiry warning UI.
7. Add troubleshooting copy and empty/error states.
8. Add docs page for preview URLs.
9. Update product/marketing copy where relevant.

Suggested deliverables:

- preview URL management UI
- published docs page

Dependencies:

- backend exposure endpoints

Risk notes:

- make sure status and sandbox state are visually distinct
- make expiry and public visibility obvious

Wrap-up notes to capture:

- final UX copy
- support issues discovered in QA
- docs links and screenshots to preserve

### Cross-Repo Coordination Tasks

Suggested owner:

- `Backend` or product/tech lead

Tasks:

1. Freeze API contract for v1.
2. Choose final status vocabulary:
   - `revoked`
   - `sandbox_stopped`
   - `expired`
3. Set default TTL and max TTL values.
4. Set retention window.
5. Decide whether re-expose renews automatically in all clients.
6. Decide whether `close` fully replaces `unexpose` in docs/UI.
7. Define rollout sequence:
   - internal testing
   - beta users
   - public launch
8. Define abuse response and escalation path.

## Suggested Milestones

### Milestone 1: Backend Preview Plumbing

Owners:

- `Backend`
- `Edge`
- `Ops`

Exit criteria:

- separate preview domain live
- exposure records persisted
- create/list/get/close/refresh APIs work
- HTTP + SSE + WebSocket proxying works

### Milestone 2: Developer Surface

Owners:

- `SDK`
- `CLI`

Exit criteria:

- SDK published with exposure support
- CLI published with `sandbox expose` flow
- wait-by-default UX works
- close/refresh flow works

### Milestone 3: Product Surface

Owners:

- `Web`
- `CLI`

Exit criteria:

- website exposure UI shipped
- docs published
- beamup integration shipped

### Milestone 4: Launch Readiness

Owners:

- `Backend`
- `Edge`
- `Ops`
- `Web`

Exit criteria:

- abuse controls enabled
- logging/metrics reviewed
- retention cleanup verified
- launch checklist complete

## Suggested Ticket Breakdown

This is a reasonable first-pass ticket split.

### Backend / Edge Tickets

- `BE-1`: exposure schema and migration
- `BE-2`: exposure CRUD API
- `BE-3`: lifecycle integration with sandbox kill/expiry
- `BE-4`: proxy host lookup and HTTP routing
- `BE-5`: WebSocket upgrade support
- `BE-6`: header sanitization and SSRF protections
- `BE-7`: cleanup worker and retention policy
- `BE-8`: logs, metrics, and rate limiting

### SDK Tickets

- `SDK-1`: exposure models
- `SDK-2`: exposures namespace
- `SDK-3`: tests and release

### CLI Tickets

- `CLI-1`: `sandbox expose` command
- `CLI-2`: list/close/refresh commands
- `CLI-3`: wait/no-wait polling UX
- `CLI-4`: beamup integration
- `CLI-5`: tests, docs, release

### Web Tickets

- `WEB-1`: exposure API hooks/client
- `WEB-2`: sandbox detail exposure panel
- `WEB-3`: create/close/renew actions
- `WEB-4`: docs page
- `WEB-5`: launch copy updates

## Suggested Staffing Model

If one engineer per track is available:

- Track 1: `Backend + Edge`
- Track 2: `SDK + CLI`
- Track 3: `Web`

If staffing is tighter, sequence it as:

1. `Backend + Edge`
2. `SDK`
3. `CLI`
4. `Web`

because backend/edge is the true dependency path.
