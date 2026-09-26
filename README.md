<p align="center">
  <img src="assets/images/logo.png" alt="AI Window Manager logo" width="140">
</p>

<h1 align="center">AI Window Manager</h1>

<p align="center">
  Self-hosted quota monitoring and strategic window scheduling for OpenAI Codex and Google Antigravity.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-24-417E38?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24">
  <img src="https://img.shields.io/badge/Docker-2496ED?logo=docker&amp;logoColor=white" alt="Docker">
</p>

<p align="center">
  <a href="#why-ai-window-manager">Why AWM?</a> ·
  <a href="#features">Features</a> ·
  <a href="#supported-providers">Providers</a> ·
  <a href="#scheduling-policies">Scheduling</a> ·
  <a href="#quick-start-with-docker">Quick Start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#documentation">Documentation</a>
</p>

---

**AI Window Manager (AWM)** is a self-hosted daemon and web dashboard that understands AI provider usage windows. It continuously tracks your quota allowances, visualizes reset horizons, and strategically schedules minimal, provider-compliant requests to start quota windows early—ensuring your resets occur right when you need them.

Deploy a single Docker container, connect your accounts via the web interface, and stop leaving token quota on the table.

## Why AI Window Manager?

### The Sliding Window Dilemma: Leaving Quota on the Table

AI providers like OpenAI Codex and Google Antigravity enforce rolling usage allowances—typically **5-hour windows** or weekly caps. Crucially, these windows **do not start automatically on a fixed calendar schedule**.

Instead, a rolling quota window remains completely dormant until you send your first prompt. Once triggered, the window countdown starts, and your reset time is fixed for 5 hours in the future. If you do not use the provider, the window stays idle, and your next reset opportunity is pushed continuously further into the future. Every hour of delay is effectively an hour of quota lost—or **left on the table**.

```text
Without AWM (Reactive):
09:00 (Start work) ──[ First prompt @ 09:05 ]──────────────────────> 14:05 (Reset occurs AFTER work)
                      └── Only 1 window allocation during your 09:00–12:00 work block ──┘

With AWM (Strategic Pre-positioning):
06:00 (AWM Pre-starts) ─────────────> 11:00 (Reset occurs DURING work!)
      └── 09:00 (Work begins) ─────────┴── 12:00 (Work ends)
          ├── Allocation 1 ────────────┤ Allocation 2 ─────────┤
          └── 2 FULL quota allocations inside the exact same 3-hour work block! ──┘
```

### The Solution: Strategic Window Positioning

Consider a developer sitting down for a focused 3-hour coding session from **09:00 to 12:00**:

- **Without AWM (Reactive Usage)**: You send your first prompt at 09:05. Your 5-hour window opens and will not reset until **14:05**—long after your morning session is over. You are constrained to a single quota allocation for your entire morning sprint.
- **With AWM (Strategic Pre-positioning)**: AWM initiates a minimal request early at **06:00**. By the time you start coding at 09:00, you use your initial quota, and at **11:00**, the window **resets in the middle of your work session**.

You effectively unlock **two full quota allocations (double token throughput)** within the exact same 3-hour working block, without waking up early to send manual dummy prompts or micromanaging timers.

### Product Boundaries

AWM operates strictly within your existing account allowances. It is:

- **Not** an LLM router, proxy, or prompt manager.
- **Not** an agent orchestrator or task scheduler.
- **Not** an account rotator or rate-limit circumvention tool.
- **Not** a multi-user SaaS application (designed for a single operator / private homelab).

## Features

- **Real-Time Quota Tracking:** Monitor five-hour and weekly usage, remaining allowances, reset times, connection health, and observation freshness across providers.
- **Strategic Window Scheduling:** Choose from five distinct policies (`Whenever possible`, `At specific times`, `On a repeating cycle`, `Within active hours`, `Only when I ask`) or trigger windows manually.
- **Independent Antigravity Model Families:** Configure independent schedules and targets for **Gemini Models** and **Claude and GPT Models**, backed by serialized provider dispatch.
- **Rich Analytics & Activity Logs:** Explore an annual daily-use heatmap, per-window time-series charts (`1h` to `30d`), and filterable activity logs (`trigger`, `reset`, `sync`, `config`, `alert`, `manual`).
- **Browser-Native Provider Onboarding:** Secure, guided sign-in for OpenAI Codex and Google Antigravity directly in the web UI using official provider clients—no manual container CLI intervention required.
- **Durable & Safe Execution:** Atomic SQLite claims, persistent action deduplication, explicit uncertain outcome handling without blind retries, and automatic cleanup of disposable trigger conversations.
- **Operator-Grade Security:** Native single-operator authentication with Argon2id bootstrap credentials, ephemeral in-memory sessions, CSRF/Origin defenses, non-root execution, and a read-only root container filesystem.
- **Provider-Client Lifecycle:** Automated version checks, checksum verification, atomic updates, and rollback support for pinned official client binaries.
- **Observability:** Prometheus metrics (`/metrics`) and health checks (`/healthz`) served directly by the daemon.

## How It Works

```text
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Observe Quota  │ ──> │ Validate & Store │ ──> │  Evaluate Policy │
│  via CLI / API  │     │ Normalized State │     │  & Dedupe Rules  │
└─────────────────┘     └──────────────────┘     └──────────────────┘
                                                           │
┌─────────────────┐     ┌──────────────────┐               ▼
│ Display UI/Logs │ <── │ Confirm with New │ <── ┌──────────────────┐
│ & Cleanup Chat  │     │   Observation    │     │ Dispatch Minimal │
└─────────────────┘     └──────────────────┘     │ Provider Request │
                                                 └──────────────────┘
```

The daemon reconciles provider state periodically (every 30 seconds by default), completely independent of web UI visits. It preserves the last-known-good state on transient errors and only schedules actions when fresh, high-confidence evidence indicates a window is inactive and eligible.

> [!IMPORTANT]
> Starting a window sends a real, minimal provider request—currently `Hi!`—through the official provider client and **can consume quota**. It is a normal provider request, not an undocumented or magic reset API. A request may count against both 5-hour and weekly provider allowances.

Before dispatching an action, AWM persists an `ActionIntent` with a unique deduplication key. If the post-dispatch outcome is ambiguous or times out, AWM classifies it as `uncertain` and **never blindly retries**. Any conversation thread created solely to trigger a window is marked as disposable and deleted by an independent cleanup worker.

## Supported Providers

| Provider               | Usage Monitoring                                | Window Start                                    | Policy Model                                   | Sign-In Flow                                   |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| **OpenAI Codex**       | Official Codex app-server rate-limit reads      | Minimal app-server turn (`Hi!`)                 | Single policy targeting one reported window    | OpenAI device code flow, guided by AWM         |
| **Google Antigravity** | Official `agy` CLI headless `/usage` inspection | Minimal prompt (`Hi!`) via family trigger model | Independent policies for Gemini and Claude/GPT | Google sign-in via official CLI, guided by AWM |

A deterministic `FakeProvider` is available for local development and testing, but remains disabled in standard production deployments.

> [!NOTE]
> Antigravity window positioning is based on observed CLI behavior and requires an active model request. Account accounting rules and official client surfaces can evolve over time. See [provider support and evidence](docs/providers.md).

## Scheduling Policies

In AWM, a **policy** dictates _when_ a window should start, while a **target window** specifies _which_ exact quota window (e.g., 5-hour or weekly) is being managed. Configure both on the **Schedule** page.

| Policy Name (UI)         | Internal Kind     | Description                                                                                                       | Practical Example                                                                        |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Whenever possible**    | `auto`            | Starts as soon as the target window is inactive, evidence is fresh, and no conflicting action is pending.         | Keep an eligible five-hour window rolling continuously.                                  |
| **At specific times**    | `custom_schedule` | Considers starting a window at designated local clock times, within an allowed tolerance window.                  | Target starts at `08:00` and `18:00` daily.                                              |
| **On a repeating cycle** | `fixed`           | Uses a local daily anchor and the window's observed duration to calculate repeating start opportunities.          | A 5h window anchored at `08:00` produces opportunities at `08:00`, `13:00`, and `18:00`. |
| **Within active hours**  | `active_hours`    | Starts windows within configured daily working intervals as long as at least one hour of the period remains.      | Active during `08:00–18:00` work hours.                                                  |
| **Only when I ask**      | `manual`          | Continues monitoring without automatic starts. Start windows on demand via **Start this window now** on Overview. | Manual control when ready to code.                                                       |

> [!TIP]
> **A scheduled time is an opportunity, not an unconditional timer.** AWM verifies window eligibility, freshness, provider capabilities, and pending actions before executing. Expired opportunities resulting from host downtime are skipped rather than blindly executed late. All schedules honor your configured IANA timezone, including daylight saving transitions.

### Codex Scheduling

Codex supports one active policy at a time, scoped to an exact reported window—typically the **5-hour window** or **Weekly window**. Note that provider accounting is shared: a request triggered for a 5-hour window may also consume weekly allowance.

### Antigravity Scheduling

Antigravity features two completely independent model families:

1. **Gemini Models**
2. **Claude and GPT Models**

Each family has its own policy, enabled state, target window (5-hour or weekly), and schedule. For example:

```text
Gemini Models         →  5-hour window  →  At specific times: 08:00, 18:00
Claude and GPT Models →  Weekly window  →  Only when I ask
```

Editing one family never alters the other. However, **actions are serialized provider-wide**: AWM will never dispatch two Antigravity trigger prompts concurrently, and an unresolved action in one family safely pauses triggers for the other until confirmed.

## Quick Start with Docker

### 1. Prerequisites

- A Linux host with **Docker Engine** (or Docker Desktop) and **Docker Compose**.
- **Node.js 24+** and **pnpm 10+** on the host (used to run `pnpm auth:hash` to generate your operator password credential).
- Supported architectures: `amd64` and `arm64`.

### 2. Clone the Repository

```bash
git clone https://github.com/Nerver-zip/ai-window-manager.git
cd ai-window-manager
```

### 3. Install Setup Tooling

Install the host-side dependencies required for generating credentials:

```bash
corepack enable
pnpm install --frozen-lockfile
```

### 4. Create Configuration & Generate Operator Password

```bash
cp .env.example .env
chmod 600 .env
pnpm auth:hash
```

The interactive prompt will ask you to enter and confirm your password. Password input is masked, and the utility outputs an Argon2id PHC string.

Edit `.env` and set your username and the printed hash (enclosed in single quotes to protect `$` characters from shell expansion):

```dotenv
AWM_AUTH_USERNAME=operator
AWM_AUTH_PASSWORD_HASH='$argon2id$v=19$m=65536,t=3,p=4$...'
```

### 5. Review Deployment Environment Options

Key settings in `.env.example`:

| Environment Variable                       | Default Value          | Description                                                                    |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------ |
| `AWM_HOST_BIND`                            | `0.0.0.0`              | IP to bind on the host (`127.0.0.1` for local-only, `0.0.0.0` for LAN access). |
| `AWM_HOST_PORT`                            | `8878`                 | Host port exposed for the web interface.                                       |
| `AWM_TIMEZONE`                             | `America/Sao_Paulo`    | Default IANA timezone for schedules and dashboard display.                     |
| `AWM_CODEX_ENABLED`                        | `true`                 | Enable the OpenAI Codex integration.                                           |
| `AWM_CODEX_TRIGGER_ENABLED`                | `true`                 | Allow Codex window start capability (`false` for monitor-only).                |
| `AWM_ANTIGRAVITY_ENABLED`                  | `true`                 | Enable the Google Antigravity integration.                                     |
| `AWM_ANTIGRAVITY_TRIGGER_ENABLED`          | `true`                 | Allow Antigravity window start capability (`false` for monitor-only).          |
| `AWM_ANTIGRAVITY_GEMINI_TRIGGER_MODEL`     | `gemini-3.8-flash-low` | Model used for Gemini-family triggers.                                         |
| `AWM_ANTIGRAVITY_CLAUDE_GPT_TRIGGER_MODEL` | `claude-sonnet-4-6`    | Model used for Claude/GPT-family triggers.                                     |

> [!WARNING]
> Binding to `0.0.0.0` exposes AWM to your local network. While access requires AWM operator authentication, plain HTTP does **not** encrypt credentials or session cookies in transit. Never port-forward AWM directly to the public internet without a TLS reverse proxy or VPN.

### 6. Validate and Launch

```bash
# Validate compose configuration
docker compose config --quiet

# Build and start container in the background
docker compose up --build -d --wait --wait-timeout 180

# Verify container health
docker compose ps
curl --fail http://127.0.0.1:8878/healthz
```

### 7. Sign In to AWM

Open your browser:

- **Local Host:** [http://127.0.0.1:8878](http://127.0.0.1:8878)
- **LAN Device:** `http://<your-server-ip>:8878`

Log in using `AWM_AUTH_USERNAME` and the **original plain-text password** entered during `pnpm auth:hash`.

### 8. Connect Providers from the Web UI

You do not need to run manual login commands inside the container. Use AWM's in-app flows:

1. In **Overview**, click **Connect Codex** or **Connect Antigravity** (or visit **Settings**).
2. Follow the on-screen instructions:
   - **Codex:** Open the OpenAI verification link and confirm the displayed 8-character device code.
   - **Antigravity:** Open the Google OAuth link, complete authorization, and paste the authorization code into the AWM modal.
3. Wait for the status badge to switch to **Connected**. Quota observations will begin populating the dashboard automatically without consuming quota.

### 9. Configure Your Schedule

1. Open **Settings** and confirm your local **Time Zone**.
2. Open **Schedule**:
   - For Codex: select the exact reported quota window (e.g. 5-hour), choose a policy (such as `Whenever possible` or `At specific times`), and save.
   - For Antigravity: select **Gemini Models** or **Claude and GPT Models**, choose its target window, configure its policy, and save.
3. Review upcoming start opportunities and policy explanations directly on the page.

## Using the App

| Page         | Primary Purpose                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview** | Real-time status cards, active window allowances, countdown to next resets, and manual **Start this window now** buttons.                |
| **Usage**    | Analytical dashboard with an annual daily-usage heatmap and independent per-window charts (`1h`, `3h`, `6h`, `12h`, `24h`, `7d`, `30d`). |
| **Schedule** | Target window selection, policy configuration (`Whenever possible`, `At specific times`, etc.), and decision explanations.               |
| **Logs**     | Filterable, paginated audit trail of all starts, resets, synchronization events, configuration changes, and alerts.                      |
| **Settings** | Provider connection status, monitoring switches, automatic start toggles, timezone selection, and client update management.              |

## Operating the Container

Standard Docker Compose operations:

```bash
docker compose ps                         # Check service and healthcheck status
docker compose logs -f ai-window-manager  # Tail application logs
docker compose restart                   # Restart daemon (invalidates web sessions)
docker compose up --build -d              # Rebuild container after pull or update
docker compose down                      # Stop and remove containers (preserves volumes)
```

### Persistent Volumes

State is safely isolated in named Docker volumes:

| Compose Volume            | Container Path         | Purpose                                                        |
| ------------------------- | ---------------------- | -------------------------------------------------------------- |
| `awm-data`                | `/data`                | SQLite database (settings, observations, history, intents).    |
| `awm-codex-state`         | `/codex-state`         | Official Codex client configuration and authentication tokens. |
| `awm-antigravity-state`   | `/antigravity-state`   | Official Antigravity CLI configuration state.                  |
| `awm-antigravity-keyring` | `/antigravity-keyring` | Isolated credential keyring storage for Antigravity.           |
| `awm-provider-clients`    | `/provider-clients`    | Downloaded and validated runtime client binaries.              |

> [!WARNING]
> Standard `docker compose down` preserves named volumes. Do **not** run `docker compose down -v` unless you explicitly intend to wipe all persistent database records and provider credentials.

## Provider Client Updates

AWM pins official provider clients in [`provider-clients.lock.json`](provider-clients.lock.json):

- **OpenAI Codex:** `0.157.0`
- **Google Antigravity:** `1.2.11`

The immutable image binaries serve as guaranteed fallbacks. In **Settings**, AWM displays the active, packaged, and latest available stable releases. Operators can check for updates, perform atomic in-place updates, or roll back:

```text
Official Stable Release ──> SHA-256 Digest Verification ──> Read-Only Compatibility Probes
                                                                      │
Active Version Switched <── Atomic Symlink Switch <── Safe State Verification
```

Update probes never consume quota. Automatic client updates are **disabled by default** and operate independently from quota window scheduling. See [provider client operations](docs/deployment.md#provider-client-updates).

## Architecture

AWM is intentionally designed as a lean, self-contained single-container service:

```text
[ Browser ] ── HTTP (Session Cookie + CSRF)
     │
     ▼
┌────────────────────────────────────────────────────────┐
│ Fastify Web Server + Server-Side Rendered UI           │
│                                                        │
│ ┌────────────────────────────────────────────────────┐ │
│ │ Scheduler & Reconciler Loop (Ticks every 30s)      │ │
│ │                                                    │ │
│ │  ├── Pure Policy Decision Engine (planWindowAction)│ │
│ │  ├── Codex Adapter ──> Official Codex App-Server   │ │
│ │  └── Antigravity Adapter ──> Official agy CLI      │ │
│ │                                                    │ │
│ │  └── Durable Action Intent Executor                │ │
│ └────────────────────────────────────────────────────┘ │
│                                                        │
│ SQLite (WAL mode)  ·  Prometheus (/metrics)            │
└────────────────────────────────────────────────────────┘
```

- **Single Process:** No Redis, Postgres, background task queues, or external microservices.
- **Controlled Subprocesses:** Provider clients run as strictly supervised child processes inside the container.
- **Zero-Quota Reads:** Web dashboard queries read from local SQLite observations; opening a page never triggers a provider check.
- Learn more in [architecture documentation](docs/architecture.md).

## Security and Data Lifecycle

### Security Invariants

- **Mandatory Single-Operator Auth:** Protected by default-deny routing. All routes (except `/healthz`, `/login`, and static assets) require an authenticated session.
- **Argon2id Hashing:** Password hashes are computed using memory-hard Argon2id. Raw passwords are never stored in files, environment variables, or databases.
- **Ephemeral Sessions:** High-entropy session tokens are kept exclusively in memory and automatically invalidated on restart.
- **CSRF & Origin Defenses:** Mutation requests require matching Origin and CSRF validation tokens.
- **Container Hardening:** Runs as unprivileged user (`uid 10001`), with `read_only` root filesystem, `cap_drop: ALL`, `no-new-privileges`, and no access to the host Docker socket.
- Learn more in [security documentation](docs/security.md).

### Bounded Data Retention

A daily maintenance worker automatically purges historical records in bounded batches:

| Data Class                             | Default Retention | Behavior                                          |
| -------------------------------------- | ----------------- | ------------------------------------------------- |
| Raw samples & ordinary events          | 90 days           | Pruned automatically in batches.                  |
| Derived hourly/daily usage intervals   | 400 days          | Retained for annual heatmap and trend analytics.  |
| Action audit trail & security events   | 365 days          | Kept for historical accountability.               |
| Current settings & open action intents | Indefinite        | Never purged while pending, uncertain, or active. |

Trigger conversation artifacts are deleted immediately after action confirmation and are never stored as AWM history. See [persistence documentation](docs/persistence.md).

## Development

Prerequisites: Node.js 24+, pnpm 10+.

```bash
# Install dependencies
pnpm install --frozen-lockfile

# Start local dev server with FakeProvider enabled
export AWM_AUTH_USERNAME=operator
export AWM_AUTH_PASSWORD_HASH='<argon2id PHC hash from pnpm auth:hash>'
export AWM_BIND=127.0.0.1
export AWM_FAKE_PROVIDER_ENABLED=true
export AWM_CODEX_ENABLED=false
export AWM_ANTIGRAVITY_ENABLED=false

pnpm dev
```

Visit `http://127.0.0.1:8787` to inspect the UI and test simulated window behavior.

### Canonical Validation Gate

Before submitting changes, run the project validation suite:

```bash
pnpm validate
```

This enforces:

- Code formatting (`prettier`) and linting (`eslint`).
- Strict TypeScript typechecking (`tsc --noEmit`).
- Automated test suite with **≥90% code coverage** across lines, statements, functions, and branches.
- Production build compilation.
- Secret scanning (`gitleaks`).

See [development](docs/development.md) and [testing guidelines](docs/testing.md).

## Documentation

Comprehensive architecture, operational runbooks, and specifications are located in [`docs/`](docs/):

| Guide                                  | Description                                                          |
| -------------------------------------- | -------------------------------------------------------------------- |
| [Architecture](docs/architecture.md)   | Component responsibilities, process model, and boundaries.           |
| [Deployment](docs/deployment.md)       | Docker Compose setup, networking, volumes, and troubleshooting.      |
| [Scheduling](docs/scheduling.md)       | Decision logic, policy specifications, deduplication, and recovery.  |
| [Providers](docs/providers.md)         | Provider integration contracts, CLI requirements, and evidence.      |
| [Configuration](docs/configuration.md) | Full environment variable reference and SQLite settings ownership.   |
| [Security](docs/security.md)           | Threat model, authentication architecture, and container isolation.  |
| [Persistence](docs/persistence.md)     | Database schema migrations, retention schedules, and backup runbook. |
| [UI & Design](docs/ui.md)              | Page design, accessibility standards, and state presentation.        |
| [API Reference](docs/api.md)           | Authenticated HTTP endpoints and command payloads.                   |

## Current Limitations

- **Evolving Provider Contracts:** Official client interfaces (such as Codex app-server commands or Antigravity CLI flags) may change between upstream releases.
- **Assisted Initial Login:** Initial provider sign-in requires an operator in the browser to complete OAuth / device authorization.
- **Single-Operator Scope:** AWM is designed for private homelab or single-developer environments; multi-user tenancy and organization management are out of scope.
