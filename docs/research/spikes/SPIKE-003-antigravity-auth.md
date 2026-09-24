# SPIKE-003 — Antigravity auth persistence in a Linux container

Status: completed historical research. Its implementation recommendation is
superseded by the later Provider Onboarding milestone's explicit project-level
decision; the evidence and original conclusion below are preserved unchanged.

Conclusion: **NO_SUPPORTED_CONTAINER_PATH**

## Scope and safety boundary

This spike investigated the authentication persistence contract of the official
`agy` CLI only. No login was started, no OAuth code was entered, no token or
credential was read, copied, extracted, replayed, or added to the repository,
and no real provider request was intentionally made.

The conclusion is about the account-based Antigravity login. A Gemini API key
mode documented by Google is a different credential model and is not a
substitute for proving safe persistence of the official Antigravity login.

## Evidence gathered

### Official documentation

The official installation/auth documentation says that:

- local silent authentication reads a saved profile from the operating
  system's native secure keyring;
- on Linux this is Secret Service over D-Bus;
- a headless/SSH login requires an active D-Bus session and a keyring service;
- the documented remote flow is SSH OAuth, where the user completes the flow
  in a browser and pastes the resulting code into the remote terminal;
- `/logout` removes saved authentication profiles from the operating-system
  keyring.

Sources:

- [Antigravity Installation & Auth](https://antigravity.google/docs/cli-install)
- [Antigravity CLI troubleshooting](https://antigravity.google/docs/cli/troubleshooting/)
- [Official antigravity-cli repository](https://github.com/google-antigravity/antigravity-cli)

The troubleshooting documentation explicitly requires the system keyring to
be unlocked and accessible. It does not document a container-specific
credential directory, a supported `XDG_*` override for the auth profile, a
portable keyring export, or a supported environment-variable token for the
Antigravity account login.

### Local official CLI inspection

The available binary is an ELF Linux executable, `agy 1.2.7`. The observed
`agy --help` exposes print/TUI, installation and remote-control options but no
`auth` or profile-selection subcommand. `agy auth --help` and `agy usage
--help` are treated as the generic help invocation rather than documented
authentication or usage subcommands.

The binary's documented/runtime strings confirm the following implementation
dependencies and behavior:

- `go_keyring` Secret Service support;
- `org.freedesktop.secrets` and D-Bus session access;
- a keyring marker/timeout mechanism under the user home;
- a file-storage fallback in container/keyring-unavailable cases;
- configuration under `~/.gemini/antigravity-cli`.

These strings are implementation evidence only, not a supported public
integration contract. In particular, they do not establish that the fallback
file is a stable or sufficient account-auth persistence API.

The current user state shows ordinary CLI state under
`~/.gemini/antigravity-cli` (cache, settings-related state, logs and local
metadata), but no auth value was opened or inspected. The directory is not
treated as an auth export boundary.

### Linux runtime probe

The host has `dbus-run-session`, `secret-tool`, and `agy`, but no running
`gnome-keyring`, KWallet, or other Secret Service daemon was found in the
process list. A lookup with `secret-tool` outside a session bus failed. A
lookup inside an isolated `dbus-run-session` caused D-Bus to attempt activation
of `org.freedesktop.secrets`, but there was no unlocked persistent keyring
available. This demonstrates that a D-Bus session alone is insufficient.

The minimum runtime dependency set for account-login reuse is therefore:

1. the same non-root user identity across invocations;
2. an active D-Bus session bus;
3. a Secret Service implementation such as GNOME Keyring or KWallet;
4. an unlocked keyring collection readable by `agy`;
5. persistent storage for that keyring's encrypted backing data; and
6. the runtime socket/environment needed to reach the service, normally
   including `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR`.

Initial authentication additionally requires the documented local browser or
SSH OAuth flow. A headless container cannot silently bootstrap an account
profile without an operator-mediated login step.

## Container persistence analysis

### What is not sufficient

Persisting only `~/.gemini/antigravity-cli` is not proven to persist the
account session. The official documentation places the saved login in the OS
keyring, not in that directory. Persisting a CLI cache/config directory while
discarding the Secret Service collection would leave a new container without
the login profile.

Mounting the host's entire `$HOME` is explicitly rejected by project policy and
would not be a safe or minimal boundary.

### Smallest boundary that would be needed in principle

The smallest plausible self-contained boundary would be a dedicated provider
state volume containing only the keyring backend's data, owned by the service
user, together with a keyring daemon and D-Bus session running inside the
container. The service would also need a safe way to unlock the collection at
startup without placing a keyring password or token in the image, Compose
file, logs, environment dump, or application database.

This is not a proven supported `agy` deployment procedure. The official docs
require an unlocked system keyring but do not define a containerized keyring
layout, initialization protocol, or restart contract. Sharing a host D-Bus
socket/keyring instead would make the container depend on host login-session
state and is not a bounded provider mount.

The CLI's observed file-fallback strings do not change this conclusion. They
are not documented as a supported account-auth persistence interface, and an
upstream issue reports fresh-process failures when a container file-storage
path is written but not accepted as the next process's auth source:

- [official issue #479 — file-based token storage in Linux containers](https://github.com/google-antigravity/antigravity-cli/issues/479)

That issue is version-sensitive and is evidence of uncertainty, not a claim
that every current release has exactly the same defect. It is enough to reject
the fallback as a safe contract for this project without a controlled,
version-pinned, official procedure.

## Restart semantics

An authenticated restart test could not be performed safely without an
operator-provided Antigravity login. The unauthenticated runtime probes show:

- a fresh process can find the CLI's ordinary local state directory;
- a fresh process cannot obtain account credentials merely from that directory;
- a D-Bus session without a Secret Service/keyring backend does not establish
  persistence.

Therefore the only restart behavior that can currently be stated with
confidence is conditional: a restart may reuse auth only if the same keyring
collection, keyring daemon, D-Bus session/runtime and user identity are all
available after restart. The project has not proven that condition in a
container, and it would be host-session coupling if supplied from outside.

## Rejected approaches

- Mounting the complete host `$HOME`: violates the security boundary and leaks
  unrelated user state.
- Copying files such as OAuth/token caches: extraction/replay of credentials is
  prohibited and the official CLI does not document such a portable auth API.
- Calling Antigravity backend endpoints directly: unofficial auth replay and
  outside the provider-adapter boundary.
- Supplying a guessed token environment variable or plaintext fallback: not an
  official account-login contract and unsafe for this product.
- Treating `~/.gemini/antigravity-cli` as the credential volume: it is not the
  documented keyring store.

## Decision and implementation consequence

**NO_SUPPORTED_CONTAINER_PATH**

Do not implement `ANT-001` account authentication or add an Antigravity
credential mount to the base Compose deployment on the basis of this spike.
Keep Antigravity `AUTH_REQUIRED`/`UNAVAILABLE` or disabled until Google
documents a supported headless/container auth persistence boundary, or the
project accepts and separately reviews a narrowly scoped in-container Secret
Service design with a real authenticated restart test.

This spike does not decide quota parsing (`SPIKE-002`) or trigger semantics.

## Remaining uncertainties

- Whether a future `agy` release will document a stable container auth mode or
  fix the file-storage fresh-process behavior.
- The exact keyring collection/service label used by each current CLI release.
- Whether a self-contained GNOME Keyring/Secret Service process with a
  dedicated encrypted volume can be supported by Google without host-session
  coupling.
- Whether the documented Gemini API-key mode is appropriate for any future
  separate provider integration; it is not Antigravity account auth and was
  not evaluated here.
