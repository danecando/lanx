# lanx

`lanx` is a small CLI for local development domains on macOS. It can:

- generate local TLS certificates
- manage domain entries (`add`, `edit`, `remove`, `list`)
- run a local HTTPS reverse proxy
- apply trusted cert changes

It's a free CLI based alternative to the [LocalCan](https://localcan.com) app.

## Requirements

- Node.js 18+
- `openssl`
- macOS

## Install

Install from npm:

```bash
npm install -g @danecando/lanx
```

## Setup

Initialize lanx state and certificates:

```bash
lanx install
```

Add a proxied domain:

```bash
lanx add app --target http://127.0.0.1:3000
```

Update it later if needed:

```bash
lanx edit app --target http://127.0.0.1:4000
```

## Usage

`lanx start` always starts the runtime, publishes `lanx.local`, and serves the CA helper page there. You will probably want to start it with elevated permissions so that lanx can listen on ports 80 and 443. If lanx doesn't have permission to listen on those ports it will fall back to 8088 and 8443.

If it is bound to 80 and 443 you can access your apps directly: `https://app.local` otherwise you will need to append the port number `https://app.local:8443`.

```bash
lanx start
```

With elevated permissions:

```bash
sudo lanx start
```

Instructions for downloading and trusting your certificate on your mobile device are available at [https://lanx.local](https://lanx.local). Access your configured domains/apps on your local network [https://app.local](https://app.local).

## Commands

```bash
lanx install
lanx uninstall
lanx add <name> [--port <n> | --target <url>]
lanx edit <name> [--target <url> | --port <n>]
lanx remove <name>
lanx list
```

## Data Location

By default:

- config: `$XDG_CONFIG_HOME/lanx/config.json` or `~/.config/lanx/config.json`
- state: `$XDG_STATE_HOME/lanx` or `~/.local/state/lanx`

You can override them with standard XDG environment variables such as `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.
