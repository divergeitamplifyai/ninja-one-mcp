/**
 * MCP prompts: the plugin's workflows, offered to every client. Hosts show
 * them as slash commands or prompt pickers, so clients without the plugin
 * (Cursor, VS Code, any MCP client) get the same guided workflows.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOL_PREFIX } from '../constants.js';

const P = TOOL_PREFIX;

function user(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'fleet_triage',
    {
      title: 'NinjaOne fleet triage',
      description: 'A ranked list of what needs a technician today, across every client or one.',
      argsSchema: { org: z.string().optional().describe('Limit to one organization (id or name). Omit for every client.') },
    },
    ({ org }) =>
      user(
        [
          `Triage my NinjaOne fleet${org ? ` for the organization "${org}"` : ' across every client'}. Read only: change nothing.`,
          `1. Call ${P}_report_fleet_health${org ? ` with org "${org}"` : ''}. Note any organization that failed to read.`,
          '2. Rank organizations by offline servers, then failed patches, AV threats, active alerts and offline share.',
          `3. For the top three, list offline devices with ${P}_list_devices (df "org = <id> AND offline", fields id, systemName, nodeClass, lastContact) and alerts with ${P}_list_alerts.`,
          '4. Answer with a one-line headline, then a table: Client, Issue, Devices, Since, Suggested action. End with anything you could not check.',
          'Offer reboots, alert resets or scripts only as next steps for me to approve.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'patch_review',
    {
      title: 'NinjaOne patch review',
      description: 'Failed, pending and rejected patches, grouped by patch and by device, with likely causes.',
      argsSchema: { org: z.string().optional().describe('Limit to one organization (id or name). Omit for the whole estate.') },
    },
    ({ org }) =>
      user(
        [
          `Review NinjaOne patch status${org ? ` for "${org}"` : ' across the estate'}. Read only.`,
          `${org ? `Resolve the organization with ${P}_find_organization and use df "org = <id>". ` : ''}Call ${P}_report_os_patches with status FAILED, then PENDING, and ${P}_report_software_patches. Follow next_cursor until has_more is false, or say the numbers are partial.`,
          'Group failures by patch and by device. A patch failing widely points at the patch; one device failing many points at the device (check volumes and reboot state).',
          'Answer with totals, the top failing patches with device counts, the worst devices with likely causes, and recommended actions. Do not apply patches.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'device_triage',
    {
      title: 'NinjaOne device triage',
      description: 'Everything about one device and what to do next.',
      argsSchema: { device: z.string().describe('Device id, or a name, user or IP to search for.') },
    },
    ({ device }) =>
      user(
        [
          `Triage the NinjaOne device "${device}". Read only.`,
          `If it is not a numeric id, find it with ${P}_search_devices and confirm which device with me if there are several.`,
          `Then call ${P}_get_device_profile and summarize: status, last contact, OS, last user, disk space, open alerts and patch counts.`,
          `Check recent history with ${P}_list_device_activities (limit 20). End with the likely problem and next steps, marking any that need write access.`,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'setup_check',
    {
      title: 'NinjaOne connection check',
      description: 'Diagnose the NinjaOne connection: configuration, credentials, region and scopes.',
    },
    () =>
      user(
        `Check my NinjaOne connection. Call ${P}_status_server and explain any missing variables or problems, then ${P}_test_connection. If it fails, tell me exactly what to change (client id, secret, region or scopes) without asking me to paste a secret here.`,
      ),
  );
}
