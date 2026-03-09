# lanx

`lanx` is a small CLI for local development domains on macOS. It can:

- generate local TLS certificates
- manage domain entries (`add`, `edit`, `remove`, `list`)
- run a local HTTPS reverse proxy
- apply trusted cert changes

## Requirements

- Node.js 18+
- `openssl`
- macOS

## Install

Install from npm:

```bash
npm install -g @danecando/lanx
```

## Quick Start

1. Initialize lanx state and certificates:

```bash
lanx install
```

2. Add a proxied domain:

```bash
lanx add app --target http://127.0.0.1:3000
```

3. Update it later if needed:

```bash
lanx edit app --target http://127.0.0.1:4000
```

4. Start the runtime:

```bash
lanx start
```

5. On a phone, open the built-in CA helper page:

```bash
https://lanx.local/
```

## Common Commands

```bash
lanx list
lanx add <name> [--port <n> | --target <url>]
lanx edit <name> [--target <url> | --port <n>]
lanx remove <name>
lanx uninstall
```

## Data Location

By default:

- config: `$XDG_CONFIG_HOME/lanx/config.json` or `~/.config/lanx/config.json`
- state: `$XDG_STATE_HOME/lanx` or `~/.local/state/lanx`

You can override them with standard XDG environment variables such as `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.
