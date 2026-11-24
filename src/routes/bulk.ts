/**
 * Bulk operations whose body is a bare array of ids. All run as dry runs by
 * default, and none can be held inside an organization boundary by id alone,
 * so they refuse while NINJAONE_ALLOWED_ORG_IDS is set (except the one with an
 * organization in its path).
 */

import type { Route, Scope } from './types.js';

const P = 'ninjaone';
const BY_ID: Scope = { kind: 'unscoped', reason: 'records are addressed by id without an organization check' };

function bulk(tool: string, kind: 'write' | 'destructive', path: string, op: string, description: string, scope: Scope = BY_ID): Route {
  return {
    tool,
    kind,
    method: 'POST',
    path,
    ops: [op],
    description,
    scope,
    body: { shape: 'ids', op, note: 'Example: [101, 102].' },
    dryRun: true,
    idempotent: true,
  };
}

export const BULK_ROUTES: readonly Route[] = [
  bulk('archive_documents', 'write', '/v2/organization/documents/archive', 'archiveMultiPageClientDocuments', `Archive several organization documents by id. Archived documents can be brought back with ${P}_restore_documents.`),
  bulk('restore_documents', 'write', '/v2/organization/documents/restore', 'restoreMultiPageClientDocuments', 'Restore several archived organization documents by id.'),
  bulk('archive_document_templates', 'write', '/v2/document-templates/archive', 'archiveDocumentTemplates', `Archive several document templates by id. Undo with ${P}_restore_document_templates.`),
  bulk('restore_document_templates', 'write', '/v2/document-templates/restore', 'restoreDocumentTemplates', 'Restore several archived document templates by id.'),
  bulk('delete_checklist_templates', 'destructive', '/v2/checklist/templates/delete', 'deleteChecklistTemplates', 'Permanently delete several checklist templates by id.'),
  bulk('delete_checklists', 'destructive', '/v2/organization/checklists/delete', 'deleteClientChecklists', 'Permanently delete several organization checklists by id.'),
  bulk('create_templates_from_checklist_ids', 'write', '/v2/organization/checklists/promote', 'promoteClientChecklists_1', `Turn organization checklists into reusable checklist templates, keeping their names. To rename while promoting use ${P}_create_templates_from_checklists.`),
  bulk(
    'create_checklists_from_templates',
    'write',
    '/v2/organization/{organizationId}/checklists-from-templates',
    'createOrganizationChecklistsFromTemplates',
    `Create checklists in one organization from checklist templates (find ids with ${P}_list_checklist_templates).`,
    { kind: 'org', param: 'organizationId' },
  ),
  bulk('delete_asset_tags', 'destructive', '/v2/tag/delete', 'deleteTags', 'Permanently delete several asset tags by id. Tagged assets lose the tag.'),
  bulk('archive_kb_articles', 'write', '/v2/knowledgebase/articles/archive', 'archiveKnowledgeBaseArticles', `Archive knowledge base articles by id. Undo with ${P}_restore_kb_articles.`),
  bulk('restore_kb_articles', 'write', '/v2/knowledgebase/articles/restore', 'restoreKnowledgeBaseArticles', 'Restore archived knowledge base articles by id.'),
  bulk('delete_kb_articles', 'destructive', '/v2/knowledgebase/articles/delete', 'deleteKnowledgeBaseArticles', 'Permanently delete knowledge base articles by id.'),
  bulk('archive_kb_folders', 'write', '/v2/knowledgebase/folders/archive', 'archiveKnowledgeBaseFolders', `Archive knowledge base folders (and their contents) by id. Undo with ${P}_restore_kb_folders.`),
  bulk('restore_kb_folders', 'write', '/v2/knowledgebase/folders/restore', 'restoreKnowledgeBaseFolders', 'Restore archived knowledge base folders by id.'),
  bulk('delete_kb_folders', 'destructive', '/v2/knowledgebase/folders/delete', 'deleteKnowledgeBaseFolders', 'Permanently delete knowledge base folders and their contents by id.'),
];
