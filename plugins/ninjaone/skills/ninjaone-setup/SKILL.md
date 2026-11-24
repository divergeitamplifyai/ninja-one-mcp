---
name: ninjaone-setup
description: Set up or troubleshoot the NinjaOne connection - creating the API client, choosing scopes and region, supplying credentials, and proving the connection. Use when the NinjaOne tools report missing configuration, a token error, a 401 or 403, or when the user asks how to connect NinjaOne.
---

# Connect NinjaOne

Work through these steps in order. Stop at the first step that fails and fix it.

## 1. Check what the server sees

Call `ninjaone_status_server`. It makes no API call. Read `missing_env_vars`, `config_problems`, `region`, `scopes` and `env_file`.

## 2. Create the API client (in NinjaOne, by the user)

Have the user do this in the NinjaOne console:

1. Go to Administration > Apps > API > Client App IDs, then Add.
2. Set Application Platform to API Services (machine-to-machine).
3. Set Allowed Grant Types to Client Credentials.
4. Choose scopes:
   - `monitoring` to read.
   - `management` to make changes.
   - `control` to run scripts and remote actions.
   - Grant only what is needed.
5. Save. Copy the client id and the client secret (the secret is shown once).

The client lives in one regional instance. The region is the host the user signs in to:

| Region | Host |
|---|---|
| `us` | app.ninjarmm.com |
| `us2` | us2.ninjarmm.com |
| `eu` | eu.ninjarmm.com |
| `ca` | ca.ninjarmm.com |
| `oc` | oc.ninjarmm.com |

## 3. Supply the credentials (never in chat)

Use whichever the host supports:

- Plugin prompt: some plugin hosts ask for the client id, secret and region on install.
- MCP client configuration: set `NINJAONE_CLIENT_ID`, `NINJAONE_CLIENT_SECRET` and `NINJAONE_REGION` in the server's `env`.
- Credentials file: for hosts that do not pass environment variables. Create `~/.config/ninja-one-mcp/.env` with those three `KEY=VALUE` lines, then run `chmod 600 ~/.config/ninja-one-mcp/.env`. The server ignores the file if others can read it.

Ask for the secret to be entered in one of those places, never pasted into the conversation. Restart the client after changing configuration.

## 4. Prove it

Call `ninjaone_test_connection`.

- `invalid client credentials`: the id or secret is wrong, or the app is not using Client Credentials.
- `scope not allowed`: `NINJAONE_SCOPES` asks for a scope the app was not granted.
- A 403 on a tool: that tool needs a scope the app lacks. Writes need management; scripts and remote actions need control.
- Could not reach the token endpoint: the region is wrong.

## 5. Optional hardening

- Keep the server read-only (the default) unless changes are needed.
- `NINJAONE_ALLOWED_ORG_IDS=12,15` holds every call inside those clients.
- `NINJAONE_WRITE_ALLOWLIST` limits which write tools may run at all.
- `NINJAONE_TOOLSETS` trims the tool list for clients that cap tools.
