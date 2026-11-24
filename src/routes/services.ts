/**
 * Service routes: ticketing, billing, backup, vulnerability scan groups, users
 * and technicians, contacts, webhook, custom tabs, node roles, notification channels.
 */

import type { Route, Scope } from './types.js';

const ACCOUNT: Scope = { kind: 'account' };
const unscoped = (reason: string): Scope => ({ kind: 'unscoped', reason });
const WRITE_BY_ID = unscoped('the record is addressed by id and carries no organization to re-check');
const BODY_NAMES_ORG = unscoped('the body names the organization or devices; refused under a boundary');

const idParam = (desc: string) => ({ in: 'path' as const, type: 'int' as const, desc, required: true, wire: 'id' });

export const SERVICE_ROUTES: readonly Route[] = [
  // ------------------------------------------------------------ ticketing
  {
    tool: 'list_ticket_boards', kind: 'read', method: 'GET', path: '/v2/ticketing/trigger/boards', ops: ['getBoards'],
    description: 'Lists ticket boards (saved ticket views) with id, name and ticket count. Use it to find a board id; read the tickets on a board with ninjaone_list_board_tickets.',
    scope: ACCOUNT, list: { paging: { style: 'local' }, compact: ['id', 'uid', 'name', 'description', 'system', 'ticketCount'] },
  },
  {
    tool: 'get_ticket', kind: 'read', method: 'GET', path: '/v2/ticketing/ticket/{ticketId}', ops: ['getTicketById'],
    description: 'Returns one ticket: subject, status, type, priority, client, assignee, tags and attribute values. Use ninjaone_list_ticket_log_entries for its comments and history.',
    scope: { kind: 'rows', field: 'clientId' },
    params: { ticket_id: { in: 'path', type: 'int', desc: 'Ticket id.', required: true, wire: 'ticketId' } },
  },
  {
    tool: 'list_ticket_log_entries', kind: 'read', method: 'GET', path: '/v2/ticketing/ticket/{ticketId}/log-entry', ops: ['getTicketLogEntriesByTicketId'],
    description: 'Lists a ticket\'s log entries (description, comments, saves, products), newest paging by anchor id. Add a comment with ninjaone_add_ticket_comment.',
    scope: unscoped('log entries carry no organization field to re-check'),
    params: {
      ticket_id: { in: 'path', type: 'int', desc: 'Ticket id.', required: true, wire: 'ticketId' },
      type: { in: 'query', type: { enumList: ['DESCRIPTION', 'COMMENT', 'CONDITION', 'SAVE', 'DELETE', 'PRODUCT', 'INFO'] }, desc: 'Only these entry types.' },
      create_time: { in: 'query', type: 'string', desc: 'Only entries created after this time, as NinjaOne documents createTime (epoch seconds).', wire: 'createTime' },
    },
    list: { paging: { style: 'id', cursorParam: 'anchorId' }, maxPage: 500, compact: ['id', 'type', 'body', 'publicEntry', 'system', 'createTime', 'appUserContactId', 'appUserContactType', 'timeTracked'] },
  },
  {
    tool: 'list_ticket_forms', kind: 'read', method: 'GET', path: '/v2/ticketing/ticket-form', ops: ['getTicketForms'],
    description: 'Lists ticket forms (templates that define ticket fields). Use a form id as ticketFormId when creating a ticket; inspect one with ninjaone_get_ticket_form.',
    scope: ACCOUNT, list: { paging: { style: 'local' }, compact: ['id', 'name', 'description', 'active', 'default'] },
  },
  {
    tool: 'get_ticket_form', kind: 'read', method: 'GET', path: '/v2/ticketing/ticket-form/{id}', ops: ['getTicketFormById'],
    description: 'Returns one ticket form with its fields. Use it to see which attributes a ticket created from the form needs.',
    scope: ACCOUNT, params: { form_id: idParam('Ticket form id.') },
  },
  {
    tool: 'list_ticket_attributes', kind: 'read', method: 'GET', path: '/v2/ticketing/attributes', ops: ['getTicketAttributes'],
    description: 'Lists ticket attributes (custom ticket fields) with type and options. Attribute ids are used in the attributes array when creating or updating a ticket.',
    scope: ACCOUNT, list: { paging: { style: 'local' }, compact: ['id', 'attributeType', 'name', 'description', 'active', 'system'] },
  },
  {
    tool: 'list_ticket_statuses', kind: 'read', method: 'GET', path: '/v2/ticketing/statuses', ops: ['getAllStatuses'],
    description: 'Lists ticket statuses with name, display name and id. Use a status name when creating or updating a ticket.',
    scope: ACCOUNT, list: { paging: { style: 'local' } },
  },
  {
    tool: 'list_ticket_contacts', kind: 'read', method: 'GET', path: '/v2/ticketing/contact/contacts', ops: ['getContacts_1'],
    description: 'Lists ticketing contacts with client, name, email and job title. Use ninjaone_list_ticket_users to search technicians, end users and contacts together.',
    scope: { kind: 'rows', field: 'clientId' },
    list: { paging: { style: 'local' }, compact: ['id', 'uid', 'clientId', 'clientName', 'displayName', 'email', 'phone', 'jobTitle'] },
  },
  {
    tool: 'list_ticket_users', kind: 'read', method: 'GET', path: '/v2/ticketing/app-user-contact', ops: ['getAllUserAndContacts'],
    description: 'Searches technicians, end users and contacts that can be set on a ticket (requester, assignee, cc). Returns uid and id to use in ninjaone_create_ticket.',
    scope: { kind: 'orgFilter', param: 'clientId', list: false, rowField: 'clientId' },
    params: {
      search_criteria: { in: 'query', type: 'string', desc: 'Free-text match on name or email.', wire: 'searchCriteria' },
      user_type: { in: 'query', type: { enum: ['TECHNICIAN', 'END_USER', 'CONTACT'] }, desc: 'Restrict to one kind of user.', wire: 'userType' },
    },
    list: { paging: { style: 'id', cursorParam: 'anchorNaturalId', idField: 'naturalId' }, compact: ['uid', 'id', 'naturalId', 'clientId', 'firstName', 'lastName', 'email', 'userType'] },
  },
  {
    tool: 'create_ticket', kind: 'write', method: 'POST', path: '/v2/ticketing/ticket', ops: ['create_2'],
    description: 'Creates a ticket. Requires clientId, ticketFormId, subject and status; find them with ninjaone_list_organizations, ninjaone_list_ticket_forms and ninjaone_list_ticket_statuses. Returns the new ticket; read it with ninjaone_get_ticket.',
    scope: unscoped('the body names clientId; refused under a boundary'),
    body: { shape: 'object', op: 'create_2' }, idempotent: false,
  },
  {
    tool: 'update_ticket', kind: 'write', method: 'PUT', path: '/v2/ticketing/ticket/{ticketId}', ops: ['update_2'],
    description: 'Updates a ticket (status, assignee, priority, tags, attributes). Returns the ticket before and after the change.',
    scope: WRITE_BY_ID, params: { ticket_id: { in: 'path', type: 'int', desc: 'Ticket id.', required: true, wire: 'ticketId' } },
    body: { shape: 'object', op: 'update_2' }, readBack: '/v2/ticketing/ticket/{ticketId}', idempotent: true,
  },

  // ------------------------------------------------------------ billing accounts
  {
    tool: 'list_billing_accounts', kind: 'read', method: 'GET', path: '/v2/billing/accounts', ops: ['getAllAccounts'],
    description: 'Lists billing (ledger) accounts with code and name. Account ids are used when creating products.',
    scope: ACCOUNT, list: { paging: { style: 'local' }, compact: ['id', 'code', 'name', 'description', 'system'] },
  },
  {
    tool: 'get_billing_account', kind: 'read', method: 'GET', path: '/v2/billing/accounts/{id}', ops: ['getAccountById'],
    description: 'Returns one billing account.', scope: ACCOUNT, params: { account_id: idParam('Billing account id.') },
  },
  {
    tool: 'create_billing_account', kind: 'write', method: 'POST', path: '/v2/billing/accounts', ops: ['createAccount'],
    description: 'Creates a billing account. Requires a code and a name. Returns the new account.',
    scope: ACCOUNT, body: { shape: 'object', op: 'createAccount' }, idempotent: false,
  },
  {
    tool: 'update_billing_account', kind: 'write', method: 'PUT', path: '/v2/billing/accounts/{id}', ops: ['updateAccount'],
    description: 'Replaces a billing account\'s code, name and description. Returns the account before and after.',
    scope: ACCOUNT, params: { account_id: idParam('Billing account id.') },
    body: { shape: 'object', op: 'updateAccount' }, readBack: '/v2/billing/accounts/{id}', idempotent: true,
  },
  {
    tool: 'delete_billing_account', kind: 'destructive', method: 'DELETE', path: '/v2/billing/accounts/{id}', ops: ['deleteAccount'],
    description: 'Deletes a billing account. Products that use it may block the delete. Check ninjaone_list_products first.',
    scope: ACCOUNT, params: { account_id: idParam('Billing account id.') }, idempotent: true,
  },

  // ------------------------------------------------------------ agreements
  {
    tool: 'list_agreements', kind: 'read', method: 'GET', path: '/v2/billing/agreements', ops: ['findAgreements'],
    description: 'Lists billing agreements with client, billing dates and active state. Read one in full with ninjaone_get_agreement.',
    scope: { kind: 'orgFilter', param: 'clientId', list: false },
    params: {
      name: { in: 'query', type: 'string', desc: 'Agreement name to match.' },
      is_default: { in: 'query', type: 'bool', desc: 'Only the default time agreement.', wire: 'isDefault' },
      product_id: { in: 'query', type: 'int', desc: 'Only agreements that include this product id.', wire: 'productId' },
    },
    list: { paging: { style: 'local' }, compact: ['id', 'name', 'client', 'invoiceGenerationType', 'nextBillDate', 'lastBillDate', 'active', 'archived'] },
  },
  {
    tool: 'get_agreement', kind: 'read', method: 'GET', path: '/v2/billing/agreements/{id}', ops: ['findAgreementById'],
    description: 'Returns one agreement with its products, billing settings and client.',
    scope: unscoped('the client is a nested object, not a field that can be re-checked'), params: { agreement_id: idParam('Agreement id.') },
  },
  {
    tool: 'create_agreement', kind: 'write', method: 'POST', path: '/v2/billing/agreements', ops: ['create_1'],
    description: 'Creates an agreement with its properties and products. Returns the new agreement; check it with ninjaone_get_agreement.',
    scope: BODY_NAMES_ORG, body: { shape: 'object', op: 'create_1' }, idempotent: false,
  },
  {
    tool: 'update_agreement', kind: 'write', method: 'PUT', path: '/v2/billing/agreements/{id}', ops: ['update_1'],
    description: 'Replaces an agreement\'s properties and products. Send the whole agreement (read it first with ninjaone_get_agreement). Returns it before and after.',
    scope: WRITE_BY_ID, params: { agreement_id: idParam('Agreement id.') },
    body: { shape: 'object', op: 'update_1' }, readBack: '/v2/billing/agreements/{id}', idempotent: true,
  },
  {
    tool: 'disable_agreement', kind: 'write', method: 'PATCH', path: '/v2/billing/agreements/{id}/deactivate', ops: ['deactivateAgreement'],
    description: 'Deactivates an agreement so it stops generating invoices. Returns the agreement before and after.',
    scope: WRITE_BY_ID, params: { agreement_id: idParam('Agreement id.') }, readBack: '/v2/billing/agreements/{id}', idempotent: true,
  },

  // ------------------------------------------------------------ invoices
  {
    tool: 'list_invoices', kind: 'read', method: 'GET', path: '/v2/billing/invoices', ops: ['getInvoices'],
    description: 'Lists invoices with client, status, totals and billing period. Filter by agreement or date range. Read one with ninjaone_get_invoice.',
    scope: { kind: 'orgFilter', param: 'clientId', list: false },
    params: {
      agreement_id: { in: 'query', type: 'int', desc: 'Only invoices for this agreement id.', wire: 'agreementId' },
      created_date_from: { in: 'query', type: 'date', desc: 'Created on or after this date.', wire: 'createdDateFrom' },
      created_date_to: { in: 'query', type: 'date', desc: 'Created on or before this date.', wire: 'createdDateTo' },
      period_from: { in: 'query', type: 'date', desc: 'Billing period starts on or after this date.', wire: 'periodFrom' },
      period_to: { in: 'query', type: 'date', desc: 'Billing period ends on or before this date.', wire: 'periodTo' },
    },
    list: { paging: { style: 'local' }, compact: ['id', 'invoiceNumber', 'agreementName', 'client', 'status', 'subTotal', 'totalTax', 'total', 'currency', 'billingPeriodStartDate', 'billingPeriodEndDate', 'dueDate'] },
  },
  {
    tool: 'get_invoice', kind: 'read', method: 'GET', path: '/v2/billing/invoices/{id}', ops: ['getInvoiceById'],
    description: 'Returns one invoice with its line items, tax and notes.',
    scope: unscoped('the client is a nested object, not a field that can be re-checked'), params: { invoice_id: idParam('Invoice id.') },
  },
  {
    tool: 'create_invoice', kind: 'write', method: 'POST', path: '/v2/billing/invoices', ops: ['createInvoice'],
    description: 'Creates an invoice from an agreement (body: agreementId). Returns the new invoice; review it with ninjaone_get_invoice before approving.',
    scope: BODY_NAMES_ORG, body: { shape: 'object', op: 'createInvoice' }, idempotent: false,
  },
  {
    tool: 'update_invoice', kind: 'write', method: 'PUT', path: '/v2/billing/invoices/{id}', ops: ['updateInvoice'],
    description: 'Replaces an invoice\'s editable fields and line items. Read it first with ninjaone_get_invoice. Returns it before and after.',
    scope: WRITE_BY_ID, params: { invoice_id: idParam('Invoice id.') },
    body: { shape: 'object', op: 'updateInvoice' }, readBack: '/v2/billing/invoices/{id}', idempotent: true,
  },
  {
    tool: 'set_invoice_note', kind: 'write', method: 'PATCH', path: '/v2/billing/invoices/{id}/note', ops: ['updateInvoiceNote'],
    description: 'Sets the note printed on an invoice. Returns the invoice before and after.',
    scope: WRITE_BY_ID, params: { invoice_id: idParam('Invoice id.') },
    body: { shape: 'object', op: 'updateInvoiceNote' }, readBack: '/v2/billing/invoices/{id}', idempotent: true,
  },
  {
    tool: 'approve_invoices', kind: 'destructive', method: 'POST', path: '/v2/billing/invoices/approve', ops: ['approveInvoices'],
    description: 'Approves invoices by id (body: invoiceIds). Approval cannot be undone through the API. Review each with ninjaone_get_invoice first.',
    scope: BODY_NAMES_ORG, body: { shape: 'object', op: 'approveInvoices' }, dryRun: true, idempotent: true,
  },
  {
    tool: 'archive_invoices', kind: 'write', method: 'POST', path: '/v2/billing/invoices/archive', ops: ['archiveInvoices'],
    description: 'Archives invoices by id (body: invoiceIds). Reverse with ninjaone_restore_invoices.',
    scope: BODY_NAMES_ORG, body: { shape: 'object', op: 'archiveInvoices' }, dryRun: true, idempotent: true,
  },
  {
    tool: 'restore_invoices', kind: 'write', method: 'POST', path: '/v2/billing/invoices/unarchive', ops: ['unarchiveInvoices'],
    description: 'Restores archived invoices by id (body: invoiceIds). Undoes ninjaone_archive_invoices.',
    scope: BODY_NAMES_ORG, body: { shape: 'object', op: 'unarchiveInvoices' }, dryRun: true, idempotent: true,
  },
  {
    tool: 'download_invoices', kind: 'destructive', method: 'POST', path: '/v2/billing/invoices/export', ops: ['exportInvoices'],
    description: 'Exports invoices (body per NinjaOne). The response may carry download links, so it needs reveal: true. List candidates with ninjaone_list_invoices.',
    scope: BODY_NAMES_ORG, body: { shape: 'object', op: 'exportInvoices' }, secret: true, idempotent: true,
  },

  // ------------------------------------------------------------ products
  {
    tool: 'list_products', kind: 'read', method: 'GET', path: '/v2/billing/products', ops: ['getProducts'],
    description: 'Lists billing products (catalog items) with quantity type and active state. Product ids are used by agreements and ticket products.',
    scope: ACCOUNT,
    params: {
      name: { in: 'query', type: 'string', desc: 'Product name to match.' },
      quantity_type: { in: 'query', type: { enum: ['MANUAL', 'DEVICE_COUNTS', 'TIME_ENTRIES', 'END_USER_COUNTS', 'BACKUP_STORAGE_COUNTS', 'SOFTWARE_LICENSE'] }, desc: 'Only products with this quantity type.', wire: 'quantityType' },
      account_code: { in: 'query', type: 'string', desc: 'Only products on this billing account code.', wire: 'accountCode' },
    },
    list: { paging: { style: 'local' }, compact: ['id', 'name', 'description', 'quantityType', 'accountId', 'group', 'active'] },
  },
  {
    tool: 'get_product', kind: 'read', method: 'GET', path: '/v2/billing/products/{id}', ops: ['getProductById'],
    description: 'Returns one billing product.', scope: ACCOUNT, params: { product_id: idParam('Product id.') },
  },
  {
    tool: 'create_product', kind: 'write', method: 'POST', path: '/v2/billing/products', ops: ['createProduct'],
    description: 'Creates a billing product. Needs an account id from ninjaone_list_billing_accounts. Returns the new product.',
    scope: ACCOUNT, body: { shape: 'object', op: 'createProduct' }, idempotent: false,
  },
  {
    tool: 'update_product', kind: 'write', method: 'PUT', path: '/v2/billing/products/{id}', ops: ['updateProduct'],
    description: 'Replaces a billing product\'s fields. Read it first with ninjaone_get_product. Returns it before and after.',
    scope: ACCOUNT, params: { product_id: idParam('Product id.') },
    body: { shape: 'object', op: 'updateProduct' }, readBack: '/v2/billing/products/{id}', idempotent: true,
  },
  {
    tool: 'enable_product', kind: 'write', method: 'PATCH', path: '/v2/billing/products/{id}/activate', ops: ['activateProduct'],
    description: 'Activates a billing product so it can be used again. Returns the product before and after.',
    scope: ACCOUNT, params: { product_id: idParam('Product id.') }, readBack: '/v2/billing/products/{id}', idempotent: true,
  },
  {
    tool: 'disable_product', kind: 'write', method: 'PATCH', path: '/v2/billing/products/{id}/deactivate', ops: ['deactivateProduct'],
    description: 'Deactivates a billing product. Reverse with ninjaone_enable_product. Returns the product before and after.',
    scope: ACCOUNT, params: { product_id: idParam('Product id.') }, readBack: '/v2/billing/products/{id}', idempotent: true,
  },

  // ------------------------------------------------------------ ticket products
  {
    tool: 'list_ticket_products', kind: 'read', method: 'GET', path: '/v2/billing/ticket-products/ticket/{id}', ops: ['getByTicketId'],
    description: 'Lists the billable products added to a ticket, with billing status. Add more with ninjaone_add_ticket_products.',
    scope: unscoped('ticket products carry no organization field to re-check'), params: { ticket_id: idParam('Ticket id.') },
    list: { paging: { style: 'local' }, compact: ['id', 'name', 'description', 'billingStatus', 'quantityType', 'productId', 'technician'] },
  },
  {
    tool: 'add_ticket_products', kind: 'write', method: 'POST', path: '/v2/billing/ticket-products/adhoc', ops: ['createAdhocTicketProducts'],
    description: 'Adds an ad hoc (one-off) product to a ticket. For a catalog product use ninjaone_add_catalog_ticket_products. Read back with ninjaone_list_ticket_products.',
    scope: BODY_NAMES_ORG, body: { shape: 'object', op: 'createAdhocTicketProducts' }, idempotent: false,
  },
  {
    tool: 'add_catalog_ticket_products', kind: 'write', method: 'POST', path: '/v2/billing/ticket-products/catalog', ops: ['createCatalogTicketProducts'],
    description: 'Adds a catalog product (from ninjaone_list_products) to a ticket. Read back with ninjaone_list_ticket_products.',
    scope: BODY_NAMES_ORG, body: { shape: 'object', op: 'createCatalogTicketProducts' }, idempotent: false,
  },
  {
    tool: 'update_ticket_product', kind: 'write', method: 'PUT', path: '/v2/billing/ticket-products/{ticketProductId}', ops: ['updateTicketProducts'],
    description: 'Replaces the fields of one product on a ticket. Find ids with ninjaone_list_ticket_products.',
    scope: WRITE_BY_ID, params: { ticket_product_id: { in: 'path', type: 'int', desc: 'Ticket product id.', required: true, wire: 'ticketProductId' } },
    body: { shape: 'object', op: 'updateTicketProducts' }, idempotent: true,
  },
  {
    tool: 'remove_ticket_products', kind: 'destructive', method: 'POST', path: '/v2/billing/ticket-products/delete', ops: ['removeTicketProducts'],
    description: 'Removes products from a ticket (body names the ticket product ids). Find ids with ninjaone_list_ticket_products.',
    scope: WRITE_BY_ID, body: { shape: 'object', op: 'removeTicketProducts' }, dryRun: true, idempotent: true,
  },
  {
    tool: 'set_time_entry_billing', kind: 'write', method: 'PUT', path: '/v2/billing/ticket-time-entry/{timeEntryId}', ops: ['updatePsaProperties'],
    description: 'Sets the billing properties (billable, product) of a ticket time entry.',
    scope: WRITE_BY_ID, params: { time_entry_id: { in: 'path', type: 'int', desc: 'Ticket time entry id.', required: true, wire: 'timeEntryId' } },
    body: { shape: 'object', op: 'updatePsaProperties' }, idempotent: true,
  },

  // ------------------------------------------------------------ backup
  {
    tool: 'list_backup_jobs', kind: 'read', method: 'GET', path: '/v2/backup/jobs', ops: ['getBackupJobs'],
    description: 'Lists backup jobs with status, plan, size and device. Narrow with a device filter. Pair with ninjaone_list_integrity_check_jobs.',
    scope: { kind: 'df', rowField: 'organizationId' },
    params: {
      df: { in: 'query', type: 'string', desc: 'Device filter expression, for example org = 12.' },
      ddf: { in: 'query', type: 'string', desc: 'Device filter on the device display name or attributes, as NinjaOne documents ddf.' },
      sf: { in: 'query', type: 'string', desc: 'Job status filter, for example status = FAILED.' },
      ptf: { in: 'query', type: 'string', desc: 'Plan type filter.' },
      stf: { in: 'query', type: 'string', desc: 'Start time filter.' },
      include: { in: 'query', type: 'string', desc: 'Extra data to include, as NinjaOne documents include.' },
    },
    list: { paging: { style: 'cursor' }, items: 'results', compact: ['jobId', 'jobStartTime', 'jobEndTime', 'jobStatus', 'planName', 'planType', 'destination', 'totalStoredBytes', 'filesUploaded', 'organizationId', 'deviceId'] },
  },
  {
    tool: 'list_integrity_check_jobs', kind: 'read', method: 'GET', path: '/v2/backup/integrity-check-jobs', ops: ['getIntegrityCheckJobs'],
    description: 'Lists backup integrity check jobs with status and bytes checked. Start one with ninjaone_run_integrity_check.',
    scope: { kind: 'df' },
    params: {
      df: { in: 'query', type: 'string', desc: 'Device filter expression, for example org = 12.' },
      ddf: { in: 'query', type: 'string', desc: 'Device filter on the device display name or attributes, as NinjaOne documents ddf.' },
      sf: { in: 'query', type: 'string', desc: 'Job status filter.' },
      ptf: { in: 'query', type: 'string', desc: 'Plan type filter.' },
      stf: { in: 'query', type: 'string', desc: 'Start time filter.' },
      include: { in: 'query', type: 'string', desc: 'Extra data to include, as NinjaOne documents include.' },
    },
    list: { paging: { style: 'cursor' }, items: 'results', compact: ['deviceId', 'jobId', 'jobStartTime', 'jobEndTime', 'jobStatus', 'planName', 'planType', 'actualBytesChecked', 'actualFilesChecked'] },
  },
  {
    tool: 'run_integrity_check', kind: 'write', method: 'POST', path: '/v2/backup/integrity-check-jobs', ops: ['submitIntegrityCheckJob'],
    description: 'Submits a backup integrity check job for a device. Read results later with ninjaone_list_integrity_check_jobs.',
    scope: BODY_NAMES_ORG, body: { shape: 'object', op: 'submitIntegrityCheckJob' }, idempotent: false,
  },
  {
    tool: 'set_backup_throttle', kind: 'write', method: 'POST', path: '/v2/backup/bandwidth-throttle', ops: ['setBandwidthThrottleForDevice'],
    description: 'Sets the backup bandwidth throttle for a device. Replaces the device\'s current throttle settings.',
    scope: BODY_NAMES_ORG, body: { shape: 'object', op: 'setBandwidthThrottleForDevice' }, idempotent: true,
  },

  // ------------------------------------------------------------ vulnerability
  {
    tool: 'list_scan_groups', kind: 'read', method: 'GET', path: '/v2/vulnerability/scan-groups', ops: ['fetchAllScanGroups'],
    description: 'Lists vulnerability scan groups (third-party scan imports) with status and last upload date. Read one with ninjaone_get_scan_group.',
    scope: ACCOUNT, list: { paging: { style: 'local' }, compact: ['id', 'groupName', 'fileName', 'status', 'vendor', 'lastFileUploadDate', 'recordsProcessed'] },
  },
  {
    tool: 'get_scan_group', kind: 'read', method: 'GET', path: '/v2/vulnerability/scan-groups/{scan-group-id}', ops: ['fetchScanGroupById'],
    description: 'Returns one vulnerability scan group with its column mappings.',
    scope: ACCOUNT, params: { scan_group_id: { in: 'path', type: 'int', desc: 'Scan group id.', required: true, wire: 'scan-group-id' } },
  },

  // ------------------------------------------------------------ contacts
  {
    tool: 'list_contacts', kind: 'read', method: 'GET', path: '/v2/contacts', ops: ['getContacts'],
    description: 'Lists contacts across organizations with name, email, phone and organization id. Read one with ninjaone_get_contact.',
    scope: { kind: 'rows', field: 'organizationId' },
    list: { paging: { style: 'local' }, compact: ['id', 'uid', 'organizationId', 'firstName', 'lastName', 'email', 'phone', 'jobTitle'] },
  },
  {
    tool: 'get_contact', kind: 'read', method: 'GET', path: '/v2/contact/{id}', ops: ['getContactById'],
    description: 'Get one contact: name, email, phone, job title and organization. Then ninjaone_update_contact to change it.', scope: { kind: 'rows', field: 'organizationId' }, params: { contact_id: idParam('Contact id.') },
  },
  {
    tool: 'create_contact', kind: 'write', method: 'POST', path: '/v2/contacts', ops: ['createContact'],
    description: 'Creates a contact (email required, organizationId optional). Returns the new contact.',
    scope: BODY_NAMES_ORG, body: { shape: 'object', op: 'createContact' }, idempotent: false,
  },
  {
    tool: 'update_contact', kind: 'write', method: 'PATCH', path: '/v2/contact/{id}', ops: ['updateContact'],
    description: 'Updates fields of a contact. Returns the contact before and after.',
    scope: WRITE_BY_ID, params: { contact_id: idParam('Contact id.') },
    body: { shape: 'object', op: 'updateContact' }, readBack: '/v2/contact/{id}', idempotent: true,
  },
  {
    tool: 'delete_contact', kind: 'destructive', method: 'DELETE', path: '/v2/contact/{id}', ops: ['deleteContact'],
    description: 'Deletes a contact. Read it first with ninjaone_get_contact.',
    scope: WRITE_BY_ID, params: { contact_id: idParam('Contact id.') }, idempotent: true,
  },

  // ------------------------------------------------------------ end users
  {
    tool: 'list_end_users', kind: 'read', method: 'GET', path: '/v2/user/end-users', ops: ['getEndUsers_1'],
    description: 'Lists end users with name, email, organization and portal access. Read one with ninjaone_get_end_user.',
    scope: { kind: 'rows', field: 'organizationId' },
    list: { paging: { style: 'local' }, compact: ['id', 'uid', 'organizationId', 'firstName', 'lastName', 'email', 'enabled', 'fullPortalAccess', 'invitationStatus'] },
  },
  {
    tool: 'get_end_user', kind: 'read', method: 'GET', path: '/v2/user/end-user/{id}', ops: ['getEndUser'],
    description: 'Returns one end user with roles and device access.', scope: { kind: 'rows', field: 'organizationId' }, params: { end_user_id: idParam('End user id.') },
  },
  {
    tool: 'create_end_user', kind: 'write', method: 'POST', path: '/v2/user/end-users', ops: ['createEndUser'],
    description: 'Creates an end user (first name, last name, email required). Optionally sends the invitation email. Returns the new user.',
    scope: BODY_NAMES_ORG, params: { send_invitation: { in: 'query', type: 'bool', desc: 'Send the invitation email on creation. Default false.', wire: 'sendInvitation' } },
    body: { shape: 'object', op: 'createEndUser' }, idempotent: false,
  },
  {
    tool: 'update_end_user', kind: 'write', method: 'PATCH', path: '/v2/user/end-user/{id}', ops: ['patchEndUser'],
    description: 'Updates fields of an end user. Returns the user before and after.',
    scope: WRITE_BY_ID, params: { end_user_id: idParam('End user id.') },
    body: { shape: 'object', op: 'patchEndUser' }, readBack: '/v2/user/end-user/{id}', idempotent: true,
  },
  {
    tool: 'delete_end_user', kind: 'destructive', method: 'DELETE', path: '/v2/user/end-user/{id}', ops: ['deleteEndUser'],
    description: 'Deletes an end user. Read it first with ninjaone_get_end_user.',
    scope: WRITE_BY_ID, params: { end_user_id: idParam('End user id.') }, idempotent: true,
  },
  {
    tool: 'set_end_user_device_access', kind: 'destructive', method: 'PATCH', path: '/v2/user/end-user/{id}/device-access', ops: ['patchEndUserDeviceAccess'],
    description: 'Replaces the devices an end user can access. Read the current access with ninjaone_get_end_user first. Returns it before and after.',
    scope: WRITE_BY_ID, params: { end_user_id: idParam('End user id.') },
    body: { shape: 'object', op: 'patchEndUserDeviceAccess' }, readBack: '/v2/user/end-user/{id}', idempotent: true,
  },
  {
    tool: 'get_end_user_custom_fields', kind: 'read', method: 'GET', path: '/v2/user/end-user/{id}/custom-fields', ops: ['getNodeCustomFields_3'],
    description: 'Returns the custom field values of an end user as a field-name map.',
    scope: unscoped('custom field values carry no organization field to re-check'), params: { end_user_id: idParam('End user id.') },
  },
  {
    tool: 'update_end_user_custom_fields', kind: 'write', method: 'PATCH', path: '/v2/user/end-user/{id}/custom-fields', ops: ['updateNodeAttributeValues_3'],
    description: 'Sets custom field values on an end user (body: map of field name to value). Returns the values before and after.',
    scope: WRITE_BY_ID, params: { end_user_id: idParam('End user id.') },
    body: { shape: 'object', op: 'updateNodeAttributeValues_3' }, readBack: '/v2/user/end-user/{id}/custom-fields', idempotent: true,
  },

  // ------------------------------------------------------------ technicians
  {
    tool: 'list_technicians', kind: 'read', method: 'GET', path: '/v2/user/technicians', ops: ['getTechnicians'],
    description: 'Lists technicians with name, email, roles and administrator flag. Read one with ninjaone_get_technician.',
    scope: ACCOUNT,
    list: { paging: { style: 'local' }, compact: ['id', 'uid', 'firstName', 'lastName', 'email', 'enabled', 'administrator', 'userType', 'invitationStatus', 'roles'] },
  },
  {
    tool: 'get_technician', kind: 'read', method: 'GET', path: '/v2/user/technician/{id}', ops: ['getTechnician'],
    description: 'Returns one technician with roles and assigned devices.', scope: ACCOUNT, params: { technician_id: idParam('Technician id.') },
  },
  {
    tool: 'create_technician', kind: 'write', method: 'POST', path: '/v2/user/technicians', ops: ['createTechnician'],
    description: 'Creates a technician. Role ids come from ninjaone_list_user_roles. Returns the new technician.',
    scope: ACCOUNT, body: { shape: 'object', op: 'createTechnician' }, idempotent: false,
  },
  {
    tool: 'update_technician', kind: 'write', method: 'PATCH', path: '/v2/user/technician/{id}', ops: ['updateTechnician'],
    description: 'Updates fields of a technician. Returns the technician before and after.',
    scope: ACCOUNT, params: { technician_id: idParam('Technician id.') },
    body: { shape: 'object', op: 'updateTechnician' }, readBack: '/v2/user/technician/{id}', idempotent: true,
  },
  {
    tool: 'delete_technician', kind: 'destructive', method: 'DELETE', path: '/v2/user/technician/{id}', ops: ['deleteTechnician'],
    description: 'Deletes a technician. Read it first with ninjaone_get_technician.',
    scope: ACCOUNT, params: { technician_id: idParam('Technician id.') }, idempotent: true,
  },

  // ------------------------------------------------------------ roles, users, channels
  {
    tool: 'list_user_roles', kind: 'read', method: 'GET', path: '/v2/user/roles', ops: ['getUserRoles'],
    description: 'Lists technician or end user roles with their members. Role ids are used when creating users and changing role permissions.',
    scope: ACCOUNT,
    params: { role_type: { in: 'query', type: { enum: ['TECHNICIAN', 'END_USER'] }, desc: 'Only roles of this type.', wire: 'roleType' } },
    list: { paging: { style: 'local' }, compact: ['id', 'name', 'type', 'description', 'members'] },
  },
  {
    tool: 'set_role_org_permissions', kind: 'destructive', method: 'PATCH', path: '/v2/user/role/{roleId}/permissions/organizations', ops: ['setOrganizationPermissions'],
    description: 'Replaces which organizations a role can access (body: array of organization permission items). Review the role with ninjaone_list_user_roles first.',
    scope: ACCOUNT, params: { role_id: { in: 'path', type: 'int', desc: 'Role id.', required: true, wire: 'roleId' } },
    body: { shape: 'array', op: 'setOrganizationPermissions' }, dryRun: true, idempotent: true,
  },
  {
    tool: 'list_users', kind: 'read', method: 'GET', path: '/v2/users', ops: ['getUsers'],
    description: 'Lists technicians and end users together, optionally with their roles. For full records use ninjaone_list_technicians or ninjaone_list_end_users.',
    scope: ACCOUNT,
    params: {
      user_type: { in: 'query', type: { enum: ['TECHNICIAN', 'END_USER'] }, desc: 'Only this kind of user.', wire: 'userType' },
      include_roles: { in: 'query', type: 'bool', desc: 'Include each user\'s roles.', wire: 'includeRoles' },
    },
    list: { paging: { style: 'local' } },
  },
  {
    tool: 'list_notification_channels', kind: 'read', method: 'GET', path: '/v2/notification-channels', ops: ['getNotificationChannels'],
    description: 'Lists all notification channels with type and enabled state. Only the enabled ones: ninjaone_list_enabled_notification_channels.',
    scope: ACCOUNT, list: { paging: { style: 'local' }, compact: ['id', 'name', 'description', 'type', 'enabled'] },
  },
  {
    tool: 'list_enabled_notification_channels', kind: 'read', method: 'GET', path: '/v2/notification-channels/enabled', ops: ['getEnabledNotificationChannels'],
    description: 'Lists enabled notification channels. Channel ids are used in alert and policy settings.',
    scope: ACCOUNT, list: { paging: { style: 'local' }, compact: ['id', 'name', 'description', 'type', 'enabled'] },
  },

  // ------------------------------------------------------------ webhook
  {
    tool: 'set_webhook', kind: 'destructive', method: 'PUT', path: '/v2/webhook', ops: ['configureWebhook'],
    description: 'Replaces the account webhook configuration (URL, activity types, headers). NinjaOne will post events to that URL, so confirm the destination. Remove it with ninjaone_delete_webhook.',
    scope: ACCOUNT, body: { shape: 'object', op: 'configureWebhook' }, openWorld: true, idempotent: true,
  },
  {
    tool: 'delete_webhook', kind: 'destructive', method: 'DELETE', path: '/v2/webhook', ops: ['disableWebhook'],
    description: 'Removes the account webhook configuration so no events are posted. Reconfigure with ninjaone_set_webhook.',
    scope: ACCOUNT, idempotent: true,
  },

  // ------------------------------------------------------------ custom tabs
  {
    tool: 'list_global_custom_tabs', kind: 'read', method: 'GET', path: '/v2/tab/summary/global', ops: ['getTabSummaryForGlobal'],
    description: 'Lists custom tabs at global scope with order and visibility. Read one with ninjaone_get_custom_tab.',
    scope: ACCOUNT, list: { paging: { style: 'local' } },
  },
  {
    tool: 'list_org_custom_tabs', kind: 'read', method: 'GET', path: '/v2/tab/summary/organization', ops: ['getTabSummaryForOrganization'],
    description: 'Lists custom tabs at organization scope. Read one with ninjaone_get_org_custom_tab.',
    scope: ACCOUNT, list: { paging: { style: 'local' } },
  },
  {
    tool: 'list_end_user_custom_tabs', kind: 'read', method: 'GET', path: '/v2/tab/summary/end-user', ops: ['getTabSummaryForEndUser'],
    description: 'Lists custom tabs at end user scope. Read one with ninjaone_get_end_user_custom_tab.',
    scope: ACCOUNT, list: { paging: { style: 'local' } },
  },
  {
    tool: 'list_role_custom_tabs', kind: 'read', method: 'GET', path: '/v2/tab/summary/role/{roleId}', ops: ['getTabSummaryForRole'],
    description: 'Lists custom tabs for a device role. Role ids come from ninjaone_list_node_roles. Read one with ninjaone_get_role_custom_tab.',
    scope: ACCOUNT, params: { role_id: { in: 'path', type: 'int', desc: 'Device (node) role id.', required: true, wire: 'roleId' } },
    list: { paging: { style: 'local' } },
  },
  {
    tool: 'get_custom_tab', kind: 'read', method: 'GET', path: '/v2/tab/{tabId}', ops: ['getCustomTabPublicApi'],
    description: 'Returns one custom tab definition with its items. Ids come from the list_*_custom_tabs tools.',
    scope: ACCOUNT, params: { tab_id: { in: 'path', type: 'int', desc: 'Custom tab id.', required: true, wire: 'tabId' } },
  },
  {
    tool: 'get_org_custom_tab', kind: 'read', method: 'GET', path: '/v2/tab/{tabId}/organization', ops: ['getTabHierarchyForOrganization'],
    description: 'Returns a custom tab as it appears at organization scope, with its field hierarchy.',
    scope: ACCOUNT, params: { tab_id: { in: 'path', type: 'int', desc: 'Custom tab id.', required: true, wire: 'tabId' } },
  },
  {
    tool: 'get_end_user_custom_tab', kind: 'read', method: 'GET', path: '/v2/tab/{tabId}/end-user', ops: ['getTabHierarchyForEndUser'],
    description: 'Returns a custom tab as it appears at end user scope, with its field hierarchy.',
    scope: ACCOUNT, params: { tab_id: { in: 'path', type: 'int', desc: 'Custom tab id.', required: true, wire: 'tabId' } },
  },
  {
    tool: 'get_role_custom_tab', kind: 'read', method: 'GET', path: '/v2/tab/{tabId}/role/{roleId}', ops: ['getTabHierarchyForRole'],
    description: 'Returns a custom tab as it appears for a device role, with its field hierarchy.',
    scope: ACCOUNT,
    params: {
      tab_id: { in: 'path', type: 'int', desc: 'Custom tab id.', required: true, wire: 'tabId' },
      role_id: { in: 'path', type: 'int', desc: 'Device (node) role id.', required: true, wire: 'roleId' },
    },
  },
  {
    tool: 'create_custom_tab', kind: 'write', method: 'POST', path: '/v2/tab', ops: ['createCustomTabPublicApi'],
    description: 'Creates a custom tab (name required) for a scope and entity. Returns the new tab; read it with ninjaone_get_custom_tab.',
    scope: ACCOUNT, body: { shape: 'object', op: 'createCustomTabPublicApi' }, idempotent: false,
  },
  {
    tool: 'update_custom_tab', kind: 'write', method: 'PATCH', path: '/v2/tab/{tabId}', ops: ['updateCustomTabPublicApi'],
    description: 'Updates a custom tab\'s fields. Returns the tab before and after.',
    scope: ACCOUNT, params: { tab_id: { in: 'path', type: 'int', desc: 'Custom tab id.', required: true, wire: 'tabId' } },
    body: { shape: 'object', op: 'updateCustomTabPublicApi' }, readBack: '/v2/tab/{tabId}', idempotent: true,
  },
  {
    tool: 'delete_custom_tab', kind: 'destructive', method: 'DELETE', path: '/v2/tab/{tabId}', ops: ['deleteCustomTabPublicApi'],
    description: 'Deletes a custom tab. Read it first with ninjaone_get_custom_tab.',
    scope: ACCOUNT, params: { tab_id: { in: 'path', type: 'int', desc: 'Custom tab id.', required: true, wire: 'tabId' } }, idempotent: true,
  },

  // ------------------------------------------------------------ node roles
  {
    tool: 'list_node_roles', kind: 'read', method: 'GET', path: '/v2/noderole/list', ops: ['getNodeRoles'],
    description: 'Lists device (node) roles with class and parent. Role ids are used in policies and custom tabs.',
    scope: ACCOUNT,
    params: { is_assignable: { in: 'query', type: 'bool', desc: 'Only roles a device can be assigned to.', wire: 'isAssignable' } },
    list: { paging: { style: 'local' }, compact: ['id', 'name', 'description', 'nodeClass', 'custom', 'chassisType', 'nodeRoleParentId'] },
  },
];

// HANDWRITTEN: getTicketsByBoard (POST used as a read; the lead writes list_board_tickets)
// PASSTHROUGH_ONLY: updateScanGroup: multipart upload
// HANDWRITTEN: createComment (multipart; src/tools/workflows.ts add_ticket_comment)
// PASSTHROUGH_ONLY: updateEndUserCustomTabsOrder: UI configuration, reachable through ninjaone_api_write
// PASSTHROUGH_ONLY: updateGlobalCustomTabsOrder: UI configuration, reachable through ninjaone_api_write
// PASSTHROUGH_ONLY: updateOrganizationCustomTabsOrder: UI configuration, reachable through ninjaone_api_write
// PASSTHROUGH_ONLY: updateRoleCustomTabsOrder: UI configuration, reachable through ninjaone_api_write
// PASSTHROUGH_ONLY: updateCustomTabsDisplay: UI configuration, reachable through ninjaone_api_write
// PASSTHROUGH_ONLY: renameCustomTabPublicApi: UI configuration, reachable through ninjaone_api_write
// PASSTHROUGH_ONLY: createNodeRoles: UI configuration, reachable through ninjaone_api_write
// PASSTHROUGH_ONLY: updateNodeRoles: UI configuration, reachable through ninjaone_api_write
// PASSTHROUGH_ONLY: deleteNodeRoles: UI configuration, reachable through ninjaone_api_write
