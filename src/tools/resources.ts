/**
 * MCP resources: reference material an agent can read without a tool call.
 *
 *  - ninjaone://docs/llms.txt         NinjaOne public docs index (llms.txt, inlined at build time)
 *  - ninjaone://docs/device-filters   the df syntax, condensed
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LLMS_TXT } from '../generated/llms.js';

export const DEVICE_FILTERS = `# NinjaOne device filters (df)

Terms are joined with AND (also "and" or "&&"). There is no OR and no grouping.

- org / organization: = 1, != 1, in (1,2), nin (1,2)
- loc / location: = 1, in (1,2), nin (1,2)
- role: = 1, in (1,10), nin (1,10)
- id: = 1, in (1,2)
- class: = WINDOWS_SERVER, in (WINDOWS_SERVER,MAC_SERVER). Classes include WINDOWS_SERVER, WINDOWS_WORKSTATION, LINUX_SERVER, LINUX_WORKSTATION, MAC, MAC_SERVER, VMWARE_VM_HOST, VMWARE_VM_GUEST, HYPERV_VMM_HOST, HYPERV_VMM_GUEST, CLOUD_MONITOR_TARGET, ANDROID, APPLE_IOS and NMS_* types.
- status: = APPROVED, = PENDING
- online, offline (bare keywords)
- created: = 2026-01-01, before 2026-01-01, after 2026-01-01 (yyyyMMdd, yyyy-MM-dd or ISO-8601)
- group: = 5 (saved search id)

Examples:
- "org = 12 AND offline"
- "class = WINDOWS_SERVER AND status = APPROVED"
- "created after 2026-07-01 AND created before 2026-09-30"

When NINJAONE_ALLOWED_ORG_IDS is set this server appends "AND org in (...)" to every filter, which can only narrow it.

Source: https://app.ninjarmm.com/apidocs-beta/articles/devices/device-filters.md
`;

export function registerResources(server: McpServer): void {
  server.registerResource(
    'ninjaone_docs_index',
    'ninjaone://docs/llms.txt',
    { description: 'Index of NinjaOne public API and help documentation (llms.txt format).', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: LLMS_TXT }] }),
  );
  server.registerResource(
    'ninjaone_device_filters',
    'ninjaone://docs/device-filters',
    { description: 'NinjaOne device filter (df) syntax with examples.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: DEVICE_FILTERS }] }),
  );
}
