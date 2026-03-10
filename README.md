# lanx

`lanx` is a macOS CLI for serving local apps on custom `.local` domains over HTTPS. It can:

- generate and trust local TLS certificates
- map domains to local apps
- run a local HTTPS reverse proxy

It's a free CLI alternative to the [LocalCan](https://localcan.com) app.

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

Start the lanx runtime:

```bash
lanx start
```

This starts the local proxy, publishes `lanx.local`, and serves the certificate helper page there.

For the simplest setup, start it with elevated permissions so it can bind to ports 80 and 443:

```bash
sudo lanx start
```

When lanx can use ports 80 and 443, your apps are available directly at addresses like `https://app.local`.

Without elevated permissions, lanx falls back to ports 8088 and 8443, so you will need to include the port, for example `https://app.local:8443`.

The certificate helper page is available at [https://lanx.local](https://lanx.local). That page includes instructions for downloading and trusting your certificate on other devices on your local network.

## Commands

```bash
lanx install
lanx uninstall
lanx add <name> [--port <n> | --target <url>]
lanx edit <name> [--target <url> | --port <n>]
lanx remove <name>
lanx list
lanx start
```

## Data Location

By default:

- config: `$XDG_CONFIG_HOME/lanx/config.json` or `~/.config/lanx/config.json`
- state: `$XDG_STATE_HOME/lanx` or `~/.local/state/lanx`

You can override them with standard XDG environment variables such as `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.
