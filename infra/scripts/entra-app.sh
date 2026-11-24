#!/usr/bin/env bash
# Creates the Microsoft Entra app registration that protects the MCP endpoint,
# and saves its client id in the current azd environment.
#
#   - Single tenant, no client secret (the server only validates tokens).
#   - Application ID URI api://<client-id>, delegated scope mcp.access.
#   - v2 access tokens.
#   - Visual Studio Code pre-authorized, so Copilot users can sign in without
#     an admin consent prompt. Add other clients the same way (see docs/AZURE.md).
#
# Usage: infra/scripts/entra-app.sh [display-name]
# Needs: az login with rights to create app registrations, and azd.
set -euo pipefail

NAME="${1:-NinjaOne MCP}"
VSCODE_CLIENT_ID="aebc6443-996d-45c2-90f0-388ff96faa56"
SCOPE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

echo "Creating app registration \"$NAME\"..."
APP_ID="$(az ad app create --display-name "$NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)"
OBJECT_ID="$(az ad app show --id "$APP_ID" --query id -o tsv)"

az ad app update --id "$APP_ID" --identifier-uris "api://$APP_ID"

# Expose the delegated scope and request v2 tokens.
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$OBJECT_ID" \
  --headers 'Content-Type=application/json' \
  --body "{
    \"api\": {
      \"requestedAccessTokenVersion\": 2,
      \"oauth2PermissionScopes\": [{
        \"id\": \"$SCOPE_ID\",
        \"value\": \"mcp.access\",
        \"type\": \"User\",
        \"isEnabled\": true,
        \"adminConsentDisplayName\": \"Use the NinjaOne MCP server\",
        \"adminConsentDescription\": \"Allows the app to call the NinjaOne MCP server as the signed-in user.\",
        \"userConsentDisplayName\": \"Use the NinjaOne MCP server\",
        \"userConsentDescription\": \"Allows the app to call the NinjaOne MCP server for you.\"
      }]
    }
  }"

# Pre-authorize VS Code for that scope (a second PATCH: the scope must exist first).
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$OBJECT_ID" \
  --headers 'Content-Type=application/json' \
  --body "{\"api\": {\"preAuthorizedApplications\": [{\"appId\": \"$VSCODE_CLIENT_ID\", \"delegatedPermissionIds\": [\"$SCOPE_ID\"]}]}}"

# A service principal lets you require assignment (Enterprise applications > Properties).
az ad sp create --id "$APP_ID" >/dev/null

azd env set MCP_INBOUND_AUTH entra
azd env set MCP_ENTRA_CLIENT_ID "$APP_ID"

echo
echo "Done. Client id: $APP_ID"
echo "Scope: api://$APP_ID/mcp.access"
echo "Optional: require user assignment so only assigned users and groups can sign in:"
echo "  az ad sp update --id $APP_ID --set appRoleAssignmentRequired=true"
