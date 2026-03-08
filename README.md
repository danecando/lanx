`lanx` is a downloadable CLI for managing local development domains and TLS certificates across macOS and Linux.

The initial design is intentionally simple: `add`, `edit`, `remove`, and `list` manage saved configuration, while `start` runs a foreground runtime that reads that configuration at startup.

It covers the workflow from the original brief, including two domain types:

1. Install: local root CA, state directory, and optional system trust.
2. Add, remove, or edit a domain as either `proxy` or `domain-only`.
3. Apply published domains to local registration and optional mDNS advertisement.

## What ships

- A dependency-free Node CLI exposed as `lanx`.
- Root CA generation with `openssl`.
- Per-domain leaf certificate generation.
- Config stored in the platform-appropriate config directory, with generated state stored in the platform-appropriate state directory.
- Top-level domain lifecycle commands: `add`, `edit`, `remove`, `list`.
- `install` and `uninstall` for applying and removing lanx-managed system changes.
- A built-in local runtime exposed as `lanx start`.
- Runtime/proxy split: runtime orchestration in `lib/runtime.js`, proxy engine in `lib/proxy.js`.
- Discovery component: mDNS publication in `lib/discovery.js` while runtime is running.
- Published-state management in `edit` with platform-specific system action guidance and optional `/etc/hosts` application.
- Proxy hardening: structured request/error logs, upstream timeout handling, WebSocket upgrade support, and graceful shutdown hooks.
- Tests for the main CLI flows.

## Install

From this repo:

```bash
npm link
```

## Usage

Initialize the tool:

```bash
lanx install
```

Add a proxied domain:

```bash
lanx add app.local http://127.0.0.1:3000 --mode proxy
```

Publish it:

```bash
lanx edit app.local --published true
```

Add a domain-only entry:

```bash
lanx add myapp.local --mode domain-only --type http --port 3000
```

Inspect state:

```bash
lanx list
lanx start
```

Edit or remove a domain:

```bash
lanx edit app.local --target http://127.0.0.1:4000 --mode proxy --published false
lanx remove app.local
```

## Notes

- Default storage locations:
- macOS config: `~/Library/Application Support/lanx/config.json`
- macOS state: `~/Library/Application Support/lanx/state`
- Linux config: `$XDG_CONFIG_HOME/lanx/config.json` or `~/.config/lanx/config.json`
- Linux state: `$XDG_STATE_HOME/lanx` or `~/.local/state/lanx`
- `LANX_HOME` overrides both config and state directories with a single root for development and testing.
- `install --apply` trusts the lanx CA in the system store. `uninstall --apply` removes that trust and clears the lanx-managed `/etc/hosts` block.
- `edit <domain> --published true --apply` and `edit <domain> --published false --apply` update `/etc/hosts` by rewriting only the lanx-managed block.
- `proxy` mode terminates HTTPS at `lanx` and forwards to a target URL.
- `domain-only` mode does not proxy traffic; it only manages publication metadata (hosts + optional mDNS guidance), so clients must use the service port directly.
- `start` runs the built-in proxy on `127.0.0.1:8088` and `127.0.0.1:8443`.
- While `start` is running, all published domains are actively announced via mDNS (`dns-sd` on macOS, `avahi-publish-service` on Linux).
- Config changes are persisted immediately, but the foreground proxy only loads them when `start` begins. Restart `lanx start` after `add`, `edit`, or `remove`.
- On macOS, published-domain output includes a `dns-sd` command for optional mDNS advertisement. On Linux, it includes an `avahi-publish-service` example.

## Development

```bash
npm test
```
