# lanx

`lanx` is a small CLI for local development domains on macOS and Linux. It can:

- generate local TLS certificates
- manage domain entries (`add`, `edit`, `remove`, `list`)
- run a local HTTPS reverse proxy
- apply trusted cert changes

## Requirements

- Node.js 18+
- `openssl`
- macOS or Linux

## Install

From this repository:

```bash
npm link
```

That exposes the `lanx` command globally.

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

## Common Commands

```bash
lanx --help
lanx list
lanx add <name> [--port <n> | --target <url>]
lanx edit <name> [--target <url> | --port <n>]
lanx remove <name>
lanx uninstall
```

## Notes

- `--target` creates or updates a proxied domain.
- `--port` creates or updates a domain entry without a proxy target.
- `.local` is implied, so `lanx add app` creates `app.local`.
- `lanx` is HTTPS-only.
- `install` and `uninstall` always apply system trust changes.

## Data Location

By default:

- config: `$XDG_CONFIG_HOME/lanx/config.json` or `~/.config/lanx/config.json`
- state: `$XDG_STATE_HOME/lanx` or `~/.local/state/lanx`

You can override them with standard XDG environment variables such as `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.

## Development

```bash
npm test
```
