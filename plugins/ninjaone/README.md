# NinjaOne plugin

The NinjaOne plugin connects Claude Code and Codex to the NinjaOne RMM Public API v2. It bundles the [ninja-one-mcp](https://github.com/divergeitamplifyai/ninja-one-mcp) server as one self-contained file, so there is nothing else to install. It also ships four skills:

- `ninjaone`: how to work with the tools.
- `ninjaone-setup`: connecting and troubleshooting.
- `fleet-triage`: the daily check across clients.
- `patch-review`: patch compliance and failures.

It is read-only by default. Writes need write mode, and destructive actions need a second switch. Every change takes `confirm: true`.

## Install

Claude Code:

```bash
/plugin marketplace add divergeitamplifyai/ninja-one-mcp
/plugin install ninjaone@ninja-one-mcp
```

Claude Code asks for the client id, client secret, region, mode and toolsets. The secret goes to your system keychain.

Codex:

```bash
codex plugin marketplace add divergeitamplifyai/ninja-one-mcp
```

Then install NinjaOne from the plugin directory. Codex does not prompt for settings, so put the credentials in `~/.config/ninja-one-mcp/.env`:

```bash
mkdir -p ~/.config/ninja-one-mcp && printf 'NINJAONE_CLIENT_ID=...\nNINJAONE_CLIENT_SECRET=...\nNINJAONE_REGION=us\n' > ~/.config/ninja-one-mcp/.env && chmod 600 ~/.config/ninja-one-mcp/.env
```

Then ask: "Use NinjaOne to show fleet health across every client."

## Before you start

Create an API client in NinjaOne under Administration > Apps > API:

- Platform: API Services (machine-to-machine).
- Grant: Client Credentials.
- Scopes: grant only what you need. `monitoring` reads, `management` makes changes, `control` runs scripts and remote actions.

The full setup guide, configuration reference and tool catalog are at https://divergeitamplifyai.github.io/ninja-one-mcp/.

Independent open-source project by Patrick King, MIT licensed. Not affiliated with or endorsed by NinjaOne.
