// One-shot generator for docs/api/openapi.yaml + the embedded spec in index.html.
// Source of truth: the Aegis controllers + Joi validators (hand-transcribed here).
// Run: node docs/api/.generate-openapi.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));

// ---- shared schema refs ------------------------------------------------------
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const paramRef = (n) => ({ $ref: `#/components/parameters/${n}` });
const uuid = { type: 'string', format: 'uuid' };
const isoDate = { type: 'string', format: 'date-time', description: 'ISO-8601 date/time string' };

// id path param factory
const idParam = (name = 'id', desc = 'Resource id (UUID).') => ({
  name, in: 'path', required: true, schema: uuid, description: desc,
});
const strPathParam = (name, desc) => ({
  name, in: 'path', required: true, schema: { type: 'string' }, description: desc,
});

// pagination query params (page/pageSize)
const pageParams = [
  { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 }, description: '1-based page number.' },
  { name: 'pageSize', in: 'query', required: false, schema: { type: 'integer', minimum: 1 }, description: 'Rows per page (bounded server-side).' },
];

// record-annotation scope filters reused by the finance list endpoints
const annotationFilterParams = [
  { name: 'assignedToMe', in: 'query', required: false, schema: { type: 'boolean' }, description: 'Record-annotation scope filter (gated by feature flag).' },
  { name: 'teamId', in: 'query', required: false, schema: uuid, description: 'Record-annotation scope filter (gated by feature flag).' },
  { name: 'tagId', in: 'query', required: false, schema: uuid, description: 'Record-annotation scope filter (gated by feature flag).' },
];

// standard response factories
const r200 = (desc = 'Success — single-entity envelope `{ data }`.') => ({
  description: desc,
  content: { 'application/json': { schema: ref('SuccessEnvelope') } },
});
const r200List = (desc = 'Success — paged list envelope `{ data, meta }`.') => ({
  description: desc,
  content: { 'application/json': { schema: ref('PaginatedEnvelope') } },
});
const r201 = (desc = 'Created — single-entity envelope `{ data }`.') => ({
  description: desc,
  content: { 'application/json': { schema: ref('SuccessEnvelope') } },
});
const r202 = (desc = 'Accepted — work enqueued.') => ({
  description: desc,
  content: { 'application/json': { schema: ref('SuccessEnvelope') } },
});
const errResp = (desc) => ({ description: desc, content: { 'application/json': { schema: ref('ErrorEnvelope') } } });

const commonErrors = (opts = {}) => {
  const e = {};
  if (opts.validation !== false) e['400'] = errResp('Validation error — request body/params/query failed the Joi schema.');
  e['401'] = errResp('Unauthenticated — missing or invalid Bearer JWT.');
  if (opts.forbidden !== false) e['403'] = errResp('Forbidden — the principal lacks the required permission (or an ABAC policy denied).');
  if (opts.notFound) e['404'] = errResp('Not found — the resource is absent or RLS-invisible in the caller tenant.');
  if (opts.conflict) e['409'] = errResp('Conflict — illegal state transition or duplicate.');
  return e;
};

// requestBody factory
const body = (schemaName, required = true) => ({
  required,
  content: { 'application/json': { schema: ref(schemaName) } },
});

// op factory
function op({ tags, summary, description, security, parameters, requestBody, responses }) {
  const o = { tags, summary };
  if (description) o.description = description;
  if (security) o.security = security;
  if (parameters && parameters.length) o.parameters = parameters;
  if (requestBody) o.requestBody = requestBody;
  o.responses = responses;
  return o;
}

const P = '/v1'; // public prefix

// ---- paths -------------------------------------------------------------------
const paths = {};
const add = (path, method, operation) => {
  paths[path] = paths[path] || {};
  paths[path][method] = operation;
};

// ===== health (gateway) =====
add('/health', 'get', op({
  tags: ['health'],
  summary: 'Liveness / readiness probe',
  description: 'Gateway liveness/readiness. Bypasses auth + context middleware. `?details=true` additionally pings the DB and cache (returns 503 degraded if either is down). Each downstream service exposes the same probe on its own port.',
  security: [],
  parameters: [{ name: 'details', in: 'query', required: false, schema: { type: 'string', enum: ['true'] }, description: 'When `true`, include DB + cache health (may return 503).' }],
  responses: {
    '200': { description: 'Healthy.', content: { 'application/json': { schema: ref('HealthStatus') } } },
    '503': { description: 'Degraded — a dependency (DB or cache) is down.', content: { 'application/json': { schema: ref('HealthStatus') } } },
  },
}));

// ===== auth =====
add(`/user-management${P}/auth/register`, 'post', op({
  tags: ['auth'],
  summary: 'Register a tenant + owner user',
  description: 'Public. Bootstraps a new tenant and its first (owner) user, returning the session token bundle.',
  security: [],
  requestBody: body('RegisterRequest'),
  responses: { '201': r201('Created — auth/session bundle.'), ...commonErrors({ forbidden: false, conflict: true }) },
}));
add(`/user-management${P}/auth/login`, 'post', op({
  tags: ['auth'],
  summary: 'Log in (issue a JWT)',
  description: 'Public. Exchanges email + password for a signed JWT and session.',
  security: [],
  requestBody: body('LoginRequest'),
  responses: { '200': r200('Auth/session bundle with the bearer token.'), ...commonErrors({ forbidden: false }) },
}));
add(`/user-management${P}/auth/me`, 'get', op({
  tags: ['auth'],
  summary: 'Current principal',
  description: 'The authenticated user, their tenant, roles and effective permissions.',
  responses: { '200': r200('The current principal.'), ...commonErrors({ validation: false }) },
}));

// ===== user-management: roles / permissions / policies =====
add(`/user-management${P}/roles`, 'get', op({
  tags: ['user-management'], summary: 'List roles',
  responses: { '200': r200('Roles for the tenant.'), ...commonErrors({ validation: false }) },
}));
add(`/user-management${P}/roles`, 'post', op({
  tags: ['user-management'], summary: 'Create a role',
  requestBody: body('CreateRoleRequest'),
  responses: { '201': r201('The created role.'), ...commonErrors({ conflict: true }) },
}));
add(`/user-management${P}/users/{userId}/role`, 'post', op({
  tags: ['user-management'], summary: 'Assign a role to a user',
  parameters: [strPathParam('userId', 'Target user id (UUID).')],
  requestBody: body('AssignRoleRequest'),
  responses: { '200': r200('The updated assignment.'), ...commonErrors({ notFound: true }) },
}));
add(`/user-management${P}/permissions`, 'get', op({
  tags: ['user-management'], summary: 'List the permission catalog',
  responses: { '200': r200('Global permission catalog.'), ...commonErrors({ validation: false }) },
}));
add(`/user-management${P}/policies`, 'get', op({
  tags: ['user-management'], summary: 'List ABAC policies',
  responses: { '200': r200('ABAC policies for the tenant.'), ...commonErrors({ validation: false }) },
}));
add(`/user-management${P}/policies`, 'post', op({
  tags: ['user-management'], summary: 'Create an ABAC policy',
  requestBody: body('CreatePolicyRequest'),
  responses: { '201': r201('The created policy.'), ...commonErrors() },
}));
add(`/user-management${P}/policies/{id}`, 'patch', op({
  tags: ['user-management'], summary: 'Update an ABAC policy',
  parameters: [idParam('id', 'Policy id (UUID).')],
  requestBody: body('UpdatePolicyRequest'),
  responses: { '200': r200('The updated policy.'), ...commonErrors({ notFound: true }) },
}));
add(`/user-management${P}/policies/{id}`, 'delete', op({
  tags: ['user-management'], summary: 'Delete an ABAC policy',
  parameters: [idParam('id', 'Policy id (UUID).')],
  responses: { '200': r200('Deletion result.'), ...commonErrors({ notFound: true }) },
}));

// ===== user-management: tenant + users =====
add(`/user-management${P}/tenants/current`, 'get', op({
  tags: ['user-management'], summary: 'Current tenant',
  responses: { '200': r200('The caller tenant.'), ...commonErrors({ validation: false }) },
}));
add(`/user-management${P}/users`, 'get', op({
  tags: ['user-management'], summary: 'List users',
  responses: { '200': r200('Users in the tenant.'), ...commonErrors({ validation: false }) },
}));
add(`/user-management${P}/users/{id}`, 'get', op({
  tags: ['user-management'], summary: 'Get a user',
  parameters: [idParam('id', 'User id (UUID).')],
  responses: { '200': r200('The user.'), ...commonErrors({ notFound: true }) },
}));

// ===== user-management: invites =====
add(`/user-management${P}/invites`, 'get', op({
  tags: ['user-management'], summary: 'List invitations',
  responses: { '200': r200('Pending/used invitations.'), ...commonErrors({ validation: false }) },
}));
add(`/user-management${P}/invites`, 'post', op({
  tags: ['user-management'], summary: 'Create an invitation',
  requestBody: body('CreateInviteRequest'),
  responses: { '201': r201('The created invite.'), ...commonErrors({ conflict: true }) },
}));
add(`/user-management${P}/invites/{id}/revoke`, 'post', op({
  tags: ['user-management'], summary: 'Revoke an invitation',
  parameters: [idParam('id', 'Invite id (UUID).')],
  responses: { '200': r200('The revoked invite.'), ...commonErrors({ notFound: true }) },
}));

// ===== user-management: sessions =====
add(`/user-management${P}/sessions`, 'get', op({
  tags: ['user-management'], summary: 'List active sessions',
  responses: { '200': r200('Active sessions for the principal/tenant.'), ...commonErrors({ validation: false }) },
}));
add(`/user-management${P}/sessions/{id}`, 'delete', op({
  tags: ['user-management'], summary: 'Revoke a session',
  parameters: [idParam('id', 'Session id (UUID).')],
  responses: { '200': r200('The revoked session.'), ...commonErrors({ notFound: true }) },
}));

// ===== user-management: tenant config + feature flags =====
add(`/user-management${P}/tenant/config`, 'get', op({
  tags: ['user-management'], summary: 'List tenant config',
  responses: { '200': r200('Tenant config key/values.'), ...commonErrors({ validation: false }) },
}));
add(`/user-management${P}/tenant/config/{key}`, 'put', op({
  tags: ['user-management'], summary: 'Set a tenant config value',
  parameters: [strPathParam('key', 'Config key.')],
  requestBody: body('SetConfigRequest'),
  responses: { '200': r200('The updated config entry.'), ...commonErrors() },
}));
add(`/user-management${P}/tenant/features`, 'get', op({
  tags: ['user-management'], summary: 'List feature flags',
  responses: { '200': r200('Feature flag states.'), ...commonErrors({ validation: false }) },
}));
add(`/user-management${P}/tenant/features/{flag}`, 'put', op({
  tags: ['user-management'], summary: 'Toggle a feature flag',
  parameters: [strPathParam('flag', 'Feature flag name.')],
  requestBody: body('SetFlagRequest'),
  responses: { '200': r200('The updated flag.'), ...commonErrors() },
}));

// ===== user-management: internal recipient directory (service-to-service) =====
add('/user-management/internal/users/{id}/contact', 'get', op({
  tags: ['user-management'], summary: 'Internal: user contact lookup',
  description: 'Service-to-service only — guarded by the signed internal-call auth (`X-Caller` + service signature), NOT a user JWT. Consumed by notification fan-out.',
  security: [],
  parameters: [idParam('id', 'User id (UUID).')],
  responses: { '200': r200('The user contact record.'), '401': errResp('Missing/invalid internal-call signature.'), '404': errResp('User not found.') },
}));
add('/user-management/internal/recipients', 'get', op({
  tags: ['user-management'], summary: 'Internal: recipient directory',
  description: 'Service-to-service only — signed internal-call auth. Exactly one of `role`, `groupId`, or `tenantAdmins` must be supplied.',
  security: [],
  parameters: [
    { name: 'role', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by role (mutually exclusive with groupId/tenantAdmins).' },
    { name: 'groupId', in: 'query', required: false, schema: uuid, description: 'Filter by group/team id (mutually exclusive).' },
    { name: 'tenantAdmins', in: 'query', required: false, schema: { type: 'boolean' }, description: 'Return tenant admins (mutually exclusive).' },
  ],
  responses: { '200': r200('Matching recipients.'), '400': errResp('Exactly one filter must be supplied.'), '401': errResp('Missing/invalid internal-call signature.') },
}));

// ===== annotation-governance: teams =====
add(`/user-management${P}/teams`, 'get', op({
  tags: ['annotation-governance'], summary: 'List teams',
  responses: { '200': r200('Teams in the tenant.'), ...commonErrors({ validation: false }) },
}));
add(`/user-management${P}/teams`, 'post', op({
  tags: ['annotation-governance'], summary: 'Create a team',
  requestBody: body('CreateTeamRequest'),
  responses: { '201': r201('The created team.'), ...commonErrors({ conflict: true }) },
}));
add(`/user-management${P}/teams/{teamId}`, 'patch', op({
  tags: ['annotation-governance'], summary: 'Update a team',
  parameters: [strPathParam('teamId', 'Team id (UUID).')],
  requestBody: body('UpdateTeamRequest'),
  responses: { '200': r200('The updated team.'), ...commonErrors({ notFound: true }) },
}));
add(`/user-management${P}/teams/{teamId}`, 'delete', op({
  tags: ['annotation-governance'], summary: 'Delete a team',
  parameters: [strPathParam('teamId', 'Team id (UUID).')],
  responses: { '200': r200('Deletion result.'), ...commonErrors({ notFound: true, validation: false }) },
}));
add(`/user-management${P}/teams/{teamId}/members`, 'get', op({
  tags: ['annotation-governance'], summary: 'List team members',
  parameters: [strPathParam('teamId', 'Team id (UUID).')],
  responses: { '200': r200('Members of the team.'), ...commonErrors({ notFound: true, validation: false }) },
}));
add(`/user-management${P}/teams/{teamId}/members`, 'post', op({
  tags: ['annotation-governance'], summary: 'Add a team member',
  parameters: [strPathParam('teamId', 'Team id (UUID).')],
  requestBody: body('AddTeamMemberRequest'),
  responses: { '201': r201('The added membership.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/user-management${P}/teams/{teamId}/members/{userId}`, 'delete', op({
  tags: ['annotation-governance'], summary: 'Remove a team member',
  parameters: [strPathParam('teamId', 'Team id (UUID).'), strPathParam('userId', 'User id (UUID).')],
  responses: { '200': r200('Removal result.'), ...commonErrors({ notFound: true, validation: false }) },
}));
add(`/user-management${P}/teams/{teamId}/tags`, 'get', op({
  tags: ['annotation-governance'], summary: 'List a team\'s tags',
  parameters: [strPathParam('teamId', 'Team id (UUID).')],
  responses: { '200': r200('Tags scoped to the team.'), ...commonErrors({ notFound: true, validation: false }) },
}));
add(`/user-management${P}/teams/{teamId}/tags`, 'put', op({
  tags: ['annotation-governance'], summary: 'Set a team\'s tags',
  parameters: [strPathParam('teamId', 'Team id (UUID).')],
  requestBody: body('SetTeamTagsRequest'),
  responses: { '200': r200('The updated tag set.'), ...commonErrors({ notFound: true }) },
}));

// ===== annotation-governance: tags =====
add(`/user-management${P}/tags`, 'get', op({
  tags: ['annotation-governance'], summary: 'List tags',
  responses: { '200': r200('Tags in the tenant.'), ...commonErrors({ validation: false }) },
}));
add(`/user-management${P}/tags`, 'post', op({
  tags: ['annotation-governance'], summary: 'Create a tag',
  requestBody: body('CreateTagRequest'),
  responses: { '201': r201('The created tag.'), ...commonErrors({ conflict: true }) },
}));
add(`/user-management${P}/tags/{tagId}`, 'patch', op({
  tags: ['annotation-governance'], summary: 'Update a tag',
  parameters: [strPathParam('tagId', 'Tag id (UUID).')],
  requestBody: body('UpdateTagRequest'),
  responses: { '200': r200('The updated tag.'), ...commonErrors({ notFound: true }) },
}));
add(`/user-management${P}/tags/{tagId}`, 'delete', op({
  tags: ['annotation-governance'], summary: 'Delete a tag',
  parameters: [strPathParam('tagId', 'Tag id (UUID).')],
  responses: { '200': r200('Deletion result.'), ...commonErrors({ notFound: true, validation: false }) },
}));

// ===== annotation-governance: record tags + assignment =====
add(`/user-management${P}/records/{recordType}/{recordId}/tags`, 'get', op({
  tags: ['annotation-governance'], summary: 'List a record\'s tags',
  parameters: [paramRef('RecordTypeParam'), strPathParam('recordId', 'Record id (UUID).')],
  responses: { '200': r200('Tags attached to the record.'), ...commonErrors({ notFound: true, validation: false }) },
}));
add(`/user-management${P}/records/{recordType}/{recordId}/tags`, 'post', op({
  tags: ['annotation-governance'], summary: 'Attach a tag to a record',
  parameters: [paramRef('RecordTypeParam'), strPathParam('recordId', 'Record id (UUID).')],
  requestBody: body('AttachRecordTagRequest'),
  responses: { '200': r200('The attachment result.'), ...commonErrors({ notFound: true }) },
}));
add(`/user-management${P}/records/{recordType}/{recordId}/tags/{tagId}`, 'delete', op({
  tags: ['annotation-governance'], summary: 'Detach a tag from a record',
  parameters: [paramRef('RecordTypeParam'), strPathParam('recordId', 'Record id (UUID).'), strPathParam('tagId', 'Tag id (UUID).')],
  responses: { '200': r200('The detachment result.'), ...commonErrors({ notFound: true, validation: false }) },
}));
add(`/user-management${P}/records/{recordType}/{recordId}/assignee`, 'put', op({
  tags: ['annotation-governance'], summary: 'Assign a record to a user',
  parameters: [paramRef('RecordTypeParam'), strPathParam('recordId', 'Record id (UUID).')],
  requestBody: body('AssignRecordRequest'),
  responses: { '200': r200('The assignment result.'), ...commonErrors({ notFound: true }) },
}));

// ===== expense =====
add(`/expense${P}/expenses`, 'post', op({
  tags: ['expense'], summary: 'Create an expense item',
  requestBody: body('CreateExpenseRequest'),
  responses: { '201': r201('The created expense item.'), ...commonErrors() },
}));
add(`/expense${P}/expenses/{id}`, 'get', op({
  tags: ['expense'], summary: 'Get an expense item',
  parameters: [idParam('id', 'Expense item id (UUID).')],
  responses: { '200': r200('The expense item.'), ...commonErrors({ notFound: true }) },
}));
add(`/expense${P}/reports`, 'post', op({
  tags: ['expense'], summary: 'Create an expense report',
  requestBody: body('CreateReportRequest'),
  responses: { '201': r201('The created report (OPEN).'), ...commonErrors() },
}));
add(`/expense${P}/reports`, 'get', op({
  tags: ['expense'], summary: 'List expense reports',
  parameters: [...pageParams, ...annotationFilterParams],
  responses: { '200': r200List('Reports (row-scoped, paged).'), ...commonErrors({ validation: false }) },
}));
add(`/expense${P}/reports/{id}`, 'get', op({
  tags: ['expense'], summary: 'Get an expense report',
  parameters: [idParam('id', 'Report id (UUID).')],
  responses: { '200': r200('The report.'), ...commonErrors({ notFound: true, validation: false }) },
}));
add(`/expense${P}/reports/{id}/detail`, 'get', op({
  tags: ['expense'], summary: 'Get full report detail',
  description: 'Header + line expenses + approvals + comments + activity timeline in one tenant-scoped call.',
  parameters: [idParam('id', 'Report id (UUID).')],
  responses: { '200': r200('The full report detail.'), ...commonErrors({ notFound: true, validation: false }) },
}));
add(`/expense${P}/reports/{id}/expenses`, 'post', op({
  tags: ['expense'], summary: 'Attach an expense item to a report',
  parameters: [idParam('id', 'Report id (UUID).')],
  requestBody: body('AttachExpenseRequest'),
  responses: { '200': r200('The report with the attached item.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/expense${P}/reports/{id}/submit`, 'post', op({
  tags: ['expense'], summary: 'Submit a report (OPEN → APPROVALS)',
  parameters: [idParam('id', 'Report id (UUID).')],
  requestBody: body('SubmitReportRequest', false),
  responses: { '200': r200('The submitted report.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/expense${P}/reports/{id}/decisions`, 'post', op({
  tags: ['expense'], summary: 'Record an approval decision (engine-backed)',
  description: 'Canonical engine-backed decision surface. Records the vote + advances the approval chain. An over-cap approval is denied by an ABAC amount-cap policy even when RBAC grants `expense.report.approve`.',
  parameters: [idParam('id', 'Report id (UUID).')],
  requestBody: body('DecisionRequest'),
  responses: { '200': r200('The decision result.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/expense${P}/reports/{id}/approve`, 'post', op({
  tags: ['expense'], summary: 'Approve a report (alias)',
  description: 'Backward-compatible alias for `POST /reports/{id}/decisions { decision: "approved" }`.',
  parameters: [idParam('id', 'Report id (UUID).')],
  requestBody: body('CommentRequest', false),
  responses: { '200': r200('The approved report.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/expense${P}/reports/{id}/reject`, 'post', op({
  tags: ['expense'], summary: 'Reject a report (APPROVALS → REJECTED)',
  parameters: [idParam('id', 'Report id (UUID).')],
  requestBody: body('RejectRequest', false),
  responses: { '200': r200('The rejected report.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/expense${P}/reports/{id}/reimburse`, 'post', op({
  tags: ['expense'], summary: 'Reimburse a report (APPROVED → REIMBURSED)',
  parameters: [idParam('id', 'Report id (UUID).')],
  requestBody: body('CommentRequest', false),
  responses: { '200': r200('The reimbursed report.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/expense${P}/reports/{id}/recall`, 'post', op({
  tags: ['expense'], summary: 'Recall a pending report (APPROVALS → OPEN)',
  parameters: [idParam('id', 'Report id (UUID).')],
  requestBody: body('RecallRequest', false),
  responses: { '200': r200('The recalled report.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/expense${P}/reports/{id}/comments`, 'post', op({
  tags: ['expense'], summary: 'Add a comment to a report',
  parameters: [idParam('id', 'Report id (UUID).')],
  requestBody: body('AddCommentRequest'),
  responses: { '201': r201('The created comment.'), ...commonErrors({ notFound: true }) },
}));
add(`/expense${P}/reports/{id}/comments`, 'get', op({
  tags: ['expense'], summary: 'List a report\'s comments',
  parameters: [idParam('id', 'Report id (UUID).')],
  responses: { '200': r200('The comment thread (oldest first).'), ...commonErrors({ notFound: true, validation: false }) },
}));
add(`/expense${P}/reports/approvals/pending`, 'get', op({
  tags: ['expense'], summary: 'My pending report approvals',
  responses: { '200': r200('Pending approval slots for the caller.'), ...commonErrors({ validation: false }) },
}));

// ===== invoice =====
add(`/invoice${P}/invoices`, 'post', op({
  tags: ['invoice'], summary: 'Create an invoice',
  requestBody: body('CreateInvoiceRequest'),
  responses: { '201': r201('The created invoice.'), ...commonErrors() },
}));
add(`/invoice${P}/invoices`, 'get', op({
  tags: ['invoice'], summary: 'List invoices',
  parameters: [
    ...pageParams,
    { name: 'status', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by invoice status.' },
    { name: 'vendorId', in: 'query', required: false, schema: uuid, description: 'Filter by vendor.' },
    ...annotationFilterParams,
  ],
  responses: { '200': r200List('Invoices (paged).'), ...commonErrors({ validation: false }) },
}));
add(`/invoice${P}/invoices/{id}`, 'get', op({
  tags: ['invoice'], summary: 'Get an invoice',
  parameters: [idParam('id', 'Invoice id (UUID).')],
  responses: { '200': r200('The invoice.'), ...commonErrors({ notFound: true, validation: false }) },
}));
add(`/invoice${P}/invoices/{id}/submit`, 'post', op({
  tags: ['invoice'], summary: 'Submit an invoice',
  parameters: [idParam('id', 'Invoice id (UUID).')],
  responses: { '200': r200('The submitted invoice.'), ...commonErrors({ notFound: true, conflict: true, validation: false }) },
}));
add(`/invoice${P}/invoices/{id}/decisions`, 'post', op({
  tags: ['invoice'], summary: 'Record an approval decision (engine-backed)',
  description: 'Canonical engine-backed decision surface; records the vote + advances the chain (approved → Approved + ERP outbox push).',
  parameters: [idParam('id', 'Invoice id (UUID).')],
  requestBody: body('DecisionRequest'),
  responses: { '200': r200('The decision result.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/invoice${P}/invoices/{id}/approve`, 'post', op({
  tags: ['invoice'], summary: 'Approve an invoice (alias)',
  description: 'Backward-compatible alias for `POST /invoices/{id}/decisions { decision: "approved" }`.',
  parameters: [idParam('id', 'Invoice id (UUID).')],
  requestBody: body('ApproveInvoiceRequest', false),
  responses: { '200': r200('The approved invoice.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/invoice${P}/invoices/approvals/pending`, 'get', op({
  tags: ['invoice'], summary: 'My pending invoice approvals',
  responses: { '200': r200('Pending approval slots for the caller.'), ...commonErrors({ validation: false }) },
}));

// ===== payroll =====
add(`/payroll${P}/employees`, 'post', op({
  tags: ['payroll'], summary: 'Create an employee',
  requestBody: body('CreateEmployeeRequest'),
  responses: { '201': r201('The created employee.'), ...commonErrors() },
}));
add(`/payroll${P}/employees`, 'get', op({
  tags: ['payroll'], summary: 'List employees',
  description: 'Field-level obligation: sensitive PII is cleared unless the principal also holds `payroll.sensitive.read`.',
  responses: { '200': r200('Employees in the tenant.'), ...commonErrors({ validation: false }) },
}));
add(`/payroll${P}/pay-runs`, 'post', op({
  tags: ['payroll'], summary: 'Create a pay run',
  requestBody: body('CreatePayRunRequest'),
  responses: { '201': r201('The created pay run.'), ...commonErrors() },
}));
add(`/payroll${P}/pay-runs`, 'get', op({
  tags: ['payroll'], summary: 'List pay runs',
  parameters: [...pageParams, ...annotationFilterParams],
  responses: { '200': r200List('Pay runs (paged).'), ...commonErrors({ validation: false }) },
}));
add(`/payroll${P}/pay-runs/{id}`, 'get', op({
  tags: ['payroll'], summary: 'Get a pay run',
  parameters: [idParam('id', 'Pay-run id (UUID).')],
  responses: { '200': r200('The pay run.'), ...commonErrors({ notFound: true }) },
}));
add(`/payroll${P}/pay-runs/{id}/calculate`, 'post', op({
  tags: ['payroll'], summary: 'Calculate a pay run',
  parameters: [idParam('id', 'Pay-run id (UUID).')],
  responses: { '200': r200('The calculated pay run.'), ...commonErrors({ notFound: true, conflict: true, validation: false }) },
}));
add(`/payroll${P}/pay-runs/{id}/decisions`, 'post', op({
  tags: ['payroll'], summary: 'Record an approval decision (engine-backed)',
  description: 'Canonical engine-backed decision surface; records the vote + advances the chain (approved → Approved + PayRunApproved event).',
  parameters: [idParam('id', 'Pay-run id (UUID).')],
  requestBody: body('DecisionRequest'),
  responses: { '200': r200('The decision result.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/payroll${P}/pay-runs/{id}/approve`, 'post', op({
  tags: ['payroll'], summary: 'Approve a pay run (alias)',
  description: 'Backward-compatible alias for `POST /pay-runs/{id}/decisions { decision: "approved" }`.',
  parameters: [idParam('id', 'Pay-run id (UUID).')],
  requestBody: body('CommentRequest', false),
  responses: { '200': r200('The approved pay run.'), ...commonErrors({ notFound: true, conflict: true }) },
}));
add(`/payroll${P}/pay-runs/{id}/disburse`, 'post', op({
  tags: ['payroll'], summary: 'Disburse a pay run',
  description: 'Honors an optional `Idempotency-Key` header to make disbursement safely retriable.',
  parameters: [
    idParam('id', 'Pay-run id (UUID).'),
    { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' }, description: 'Idempotency key for safe retries.' },
  ],
  responses: { '200': r200('The disbursed pay run.'), ...commonErrors({ notFound: true, conflict: true, validation: false }) },
}));
add(`/payroll${P}/pay-runs/{id}/payslips`, 'get', op({
  tags: ['payroll'], summary: 'List payslips for a pay run',
  parameters: [
    idParam('id', 'Pay-run id (UUID).'),
    ...pageParams,
    { name: 'employeeId', in: 'query', required: false, schema: uuid, description: 'Filter by employee.' },
    { name: 'status', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by payslip status.' },
  ],
  responses: { '200': r200List('Payslips for the run.'), ...commonErrors({ notFound: true }) },
}));
add(`/payroll${P}/pay-runs/approvals/pending`, 'get', op({
  tags: ['payroll'], summary: 'My pending pay-run approvals',
  responses: { '200': r200('Pending approval slots for the caller.'), ...commonErrors({ validation: false }) },
}));
add(`/payroll${P}/payslips`, 'get', op({
  tags: ['payroll'], summary: 'List payslips',
  description: 'Returns own payslips with `payslip.view.own`, or all with `payslip.view.all`.',
  parameters: [
    ...pageParams,
    { name: 'payRunId', in: 'query', required: false, schema: uuid, description: 'Filter by pay run.' },
    { name: 'employeeId', in: 'query', required: false, schema: uuid, description: 'Filter by employee.' },
    { name: 'status', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by payslip status.' },
  ],
  responses: { '200': r200List('Payslips (paged).'), ...commonErrors() },
}));
add(`/payroll${P}/payslips/{id}`, 'get', op({
  tags: ['payroll'], summary: 'Get a payslip',
  parameters: [idParam('id', 'Payslip id (UUID).')],
  responses: { '200': r200('The payslip.'), ...commonErrors({ notFound: true }) },
}));

// ===== reporting =====
add(`/reporting${P}/report-definitions`, 'post', op({
  tags: ['reporting'], summary: 'Create a report definition',
  description: 'The `spec` is validated structurally (measures/dimensions/filters/grain) — never raw SQL.',
  requestBody: body('CreateDefinitionRequest'),
  responses: { '201': r201('The created definition.'), ...commonErrors() },
}));
add(`/reporting${P}/report-definitions`, 'get', op({
  tags: ['reporting'], summary: 'List report definitions',
  parameters: [...pageParams],
  responses: { '200': r200List('Definitions (paged).'), ...commonErrors({ validation: false }) },
}));
add(`/reporting${P}/report-runs`, 'post', op({
  tags: ['reporting'], summary: 'Enqueue a report run',
  description: 'Asynchronous: returns 202 + `{ runId }` with a `Location` header; poll `GET /report-runs/{id}` for status + `artifact_url`.',
  requestBody: body('CreateRunRequest'),
  responses: { '202': r202('Accepted — run enqueued (Location header points at the run).'), ...commonErrors() },
}));
add(`/reporting${P}/report-runs`, 'get', op({
  tags: ['reporting'], summary: 'List report runs',
  parameters: [
    ...pageParams,
    { name: 'definitionId', in: 'query', required: false, schema: uuid, description: 'Filter by definition.' },
    { name: 'status', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by run status.' },
  ],
  responses: { '200': r200List('Runs (paged).'), ...commonErrors() },
}));
add(`/reporting${P}/report-runs/{id}`, 'get', op({
  tags: ['reporting'], summary: 'Get a report run',
  parameters: [idParam('id', 'Run id (UUID).')],
  responses: { '200': r200('The run status DTO.'), ...commonErrors({ notFound: true }) },
}));
add(`/reporting${P}/report-runs/{id}/export`, 'get', op({
  tags: ['reporting'], summary: 'Get a report run export',
  parameters: [idParam('id', 'Run id (UUID).')],
  responses: { '200': r200('The export artifact reference.'), ...commonErrors({ notFound: true }) },
}));
add(`/reporting${P}/report-schedules`, 'post', op({
  tags: ['reporting'], summary: 'Create a report schedule',
  requestBody: body('CreateScheduleRequest'),
  responses: { '201': r201('The created schedule.'), ...commonErrors() },
}));
add(`/reporting${P}/report-schedules`, 'get', op({
  tags: ['reporting'], summary: 'List report schedules',
  parameters: [
    ...pageParams,
    { name: 'definitionId', in: 'query', required: false, schema: uuid, description: 'Filter by definition.' },
    { name: 'enabled', in: 'query', required: false, schema: { type: 'boolean' }, description: 'Filter by enabled state.' },
  ],
  responses: { '200': r200List('Schedules (paged).'), ...commonErrors() },
}));
add(`/reporting${P}/report-schedules/{id}`, 'patch', op({
  tags: ['reporting'], summary: 'Update a report schedule',
  parameters: [idParam('id', 'Schedule id (UUID).')],
  requestBody: body('UpdateScheduleRequest'),
  responses: { '200': r200('The updated schedule.'), ...commonErrors({ notFound: true }) },
}));
add(`/reporting${P}/report-schedules/{id}`, 'delete', op({
  tags: ['reporting'], summary: 'Delete a report schedule',
  parameters: [idParam('id', 'Schedule id (UUID).')],
  responses: { '200': r200('Deletion result.'), ...commonErrors({ notFound: true }) },
}));

// ===== workflow: rules =====
add(`/workflow${P}/rules`, 'post', op({
  tags: ['workflow'], summary: 'Create a rule',
  requestBody: body('CreateRuleRequest'),
  responses: { '201': r201('The created rule.'), ...commonErrors() },
}));
add(`/workflow${P}/rules`, 'get', op({
  tags: ['workflow'], summary: 'List rules',
  parameters: [...pageParams],
  responses: { '200': r200List('Rules (paged).'), ...commonErrors({ validation: false }) },
}));
add(`/workflow${P}/rules/{id}`, 'get', op({
  tags: ['workflow'], summary: 'Get a rule',
  parameters: [idParam('id', 'Rule id (UUID).')],
  responses: { '200': r200('The rule.'), ...commonErrors({ notFound: true, validation: false }) },
}));
add(`/workflow${P}/rules/{id}/run`, 'post', op({
  tags: ['workflow'], summary: 'Run (or dry-run) a rule',
  parameters: [idParam('id', 'Rule id (UUID).')],
  requestBody: body('RunRuleRequest'),
  responses: { '200': r200('The rule evaluation result.'), ...commonErrors({ notFound: true }) },
}));

// ===== workflow: connectors =====
add(`/workflow${P}/connectors`, 'get', op({
  tags: ['workflow'], summary: 'List connector configs',
  responses: { '200': r200('Connector configs for the tenant.'), ...commonErrors({ validation: false }) },
}));
add(`/workflow${P}/connectors/{kind}`, 'put', op({
  tags: ['workflow'], summary: 'Upsert a connector config',
  parameters: [paramRef('ConnectorKindParam')],
  requestBody: body('UpsertConnectorConfigRequest'),
  responses: { '200': r200('The upserted config.'), ...commonErrors() },
}));
add(`/workflow${P}/connectors/{kind}/health`, 'get', op({
  tags: ['workflow'], summary: 'Connector health',
  parameters: [paramRef('ConnectorKindParam')],
  responses: { '200': r200('The connector health snapshot.'), ...commonErrors({ notFound: true }) },
}));
add(`/workflow${P}/connectors/sync-state`, 'get', op({
  tags: ['workflow'], summary: 'List connector sync-state',
  parameters: [
    ...pageParams,
    { name: 'kind', in: 'query', required: false, schema: { type: 'string', enum: ['ledger_one', 'finovo', 'acct_bridge'] }, description: 'Filter by connector kind.' },
    { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['queued', 'in_progress', 'synced', 'error'] }, description: 'Filter by sync status.' },
  ],
  responses: { '200': r200List('Durable sync-state rows (paged).'), ...commonErrors() },
}));
add(`/workflow${P}/connectors/sync-state/{idempotencyKey}`, 'get', op({
  tags: ['workflow'], summary: 'Get a sync-state row',
  parameters: [strPathParam('idempotencyKey', 'Idempotency key of the push.')],
  responses: { '200': r200('The sync-state row.'), ...commonErrors({ notFound: true }) },
}));
add(`/workflow${P}/connectors/reconcile`, 'post', op({
  tags: ['workflow'], summary: 'Reconcile pending connector pushes',
  requestBody: body('ReconcileConnectorRequest', false),
  responses: { '202': r202('Accepted — reconciliation enqueued.'), ...commonErrors() },
}));

// ===== notification =====
add(`/notification${P}/notifications`, 'get', op({
  tags: ['notification'], summary: 'List inbox notifications',
  parameters: [...pageParams],
  responses: { '200': r200List('The caller\'s notifications (paged).'), ...commonErrors() },
}));
add(`/notification${P}/notifications/{id}`, 'get', op({
  tags: ['notification'], summary: 'Get a notification',
  parameters: [idParam('id', 'Notification id (UUID).')],
  responses: { '200': r200('The notification.'), ...commonErrors({ notFound: true }) },
}));
add(`/notification${P}/notifications/{id}/read`, 'post', op({
  tags: ['notification'], summary: 'Mark a notification read',
  parameters: [idParam('id', 'Notification id (UUID).')],
  responses: { '200': r200('The updated notification.'), ...commonErrors({ notFound: true }) },
}));
add(`/notification${P}/notifications/inbox/unread-count`, 'get', op({
  tags: ['notification'], summary: 'Unread count',
  responses: { '200': r200('The caller\'s unread count.'), ...commonErrors({ validation: false }) },
}));
add(`/notification${P}/notifications/inbox/read-all`, 'post', op({
  tags: ['notification'], summary: 'Mark all read',
  responses: { '200': r200('The bulk mark-read result.'), ...commonErrors({ validation: false }) },
}));
add(`/notification${P}/email-notification-logs`, 'get', op({
  tags: ['notification'], summary: 'List email notification logs',
  parameters: [
    ...pageParams,
    { name: 'status', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by email status.' },
    { name: 'userId', in: 'query', required: false, schema: uuid, description: 'Filter by recipient user.' },
  ],
  responses: { '200': r200List('Email logs (paged).'), ...commonErrors() },
}));

// ---- components.schemas ------------------------------------------------------
const schemas = {
  // envelopes
  SuccessEnvelope: {
    type: 'object',
    description: 'Standard success envelope. `data` is the entity/result; `correlationId` is echoed from context.',
    properties: {
      data: { description: 'The response payload (entity, array, or result object).' },
      correlationId: { type: 'string', description: 'Request correlation id (echoed from `X-Correlation-Id`).' },
    },
    required: ['data'],
  },
  PaginatedEnvelope: {
    type: 'object',
    description: 'Paged success envelope. Some list endpoints return `meta` with `{ total, page, pageSize }`, others the `{ totalCount, pageSize, pageNo, pageCount }` shape.',
    properties: {
      data: { type: 'array', items: {}, description: 'The page of rows.' },
      meta: ref('PageMeta'),
      correlationId: { type: 'string' },
    },
    required: ['data'],
  },
  PageMeta: {
    type: 'object',
    properties: {
      totalCount: { type: 'integer', description: 'Total rows across all pages.' },
      total: { type: 'integer', description: 'Total rows (legacy alias used by some services).' },
      pageSize: { type: 'integer' },
      pageNo: { type: 'integer', description: '1-based page number.' },
      page: { type: 'integer', description: '1-based page number (legacy alias).' },
      pageCount: { type: 'integer', description: 'Total number of pages (derived).' },
    },
  },
  ErrorEnvelope: {
    type: 'object',
    description: 'Terminal error envelope. 5xx errors return a generic message and omit `details`.',
    properties: {
      errors: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Stable machine error code (e.g. E_VALIDATION).' },
            type: { type: 'string', description: 'Error category (VALIDATION, AUTH, NOT_FOUND, CONFLICT, SYSTEM, GATEWAY, …).' },
            message: { type: 'string' },
            details: { description: 'Optional structured detail (operational 4xx only).' },
            correlationId: { type: 'string' },
          },
          required: ['code', 'type', 'message'],
        },
      },
    },
    required: ['errors'],
  },
  HealthStatus: {
    type: 'object',
    properties: {
      service: { type: 'string' },
      status: { type: 'string', enum: ['ok', 'degraded'] },
      uptime: { type: 'number' },
      db: { type: 'boolean', description: 'Present only with ?details=true.' },
      cache: { type: 'boolean', description: 'Present only with ?details=true.' },
    },
    required: ['service', 'status'],
  },

  // auth
  RegisterRequest: {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 8 },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
    },
    required: ['email', 'password'],
  },
  LoginRequest: {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string' },
    },
    required: ['email', 'password'],
  },

  // roles / policies / invites
  CreateRoleRequest: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2 },
      description: { type: 'string' },
      permissions: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
    required: ['name', 'permissions'],
  },
  AssignRoleRequest: {
    type: 'object',
    properties: {
      roleId: uuid,
      scope: { type: 'string', enum: ['all_records', 'own_and_team', 'own_only'] },
    },
    required: ['roleId'],
  },
  CreatePolicyRequest: {
    type: 'object',
    properties: {
      permission: { type: 'string', minLength: 3 },
      effect: { type: 'string', enum: ['allow', 'deny'] },
      rule: { type: 'object', additionalProperties: true },
      priority: { type: 'integer', minimum: 0 },
      isActive: { type: 'boolean' },
    },
    required: ['permission', 'effect'],
  },
  UpdatePolicyRequest: {
    type: 'object',
    description: 'At least one field must be supplied.',
    minProperties: 1,
    properties: {
      permission: { type: 'string', minLength: 3 },
      effect: { type: 'string', enum: ['allow', 'deny'] },
      rule: { type: 'object', additionalProperties: true },
      priority: { type: 'integer', minimum: 0 },
      isActive: { type: 'boolean' },
    },
  },
  CreateInviteRequest: {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      roleId: uuid,
      scope: { type: 'string', enum: ['all_records', 'own_and_team', 'own_only'] },
      teamIds: { type: 'array', items: uuid },
      expiresAt: { type: 'string', format: 'date-time' },
    },
    required: ['email'],
  },

  // tenant config
  SetConfigRequest: {
    type: 'object',
    properties: { value: { description: 'Any JSON value for the config key.' } },
    required: ['value'],
  },
  SetFlagRequest: {
    type: 'object',
    properties: { enabled: { type: 'boolean' } },
    required: ['enabled'],
  },

  // annotation-governance
  CreateTeamRequest: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 2 }, description: { type: 'string' } },
    required: ['name'],
  },
  UpdateTeamRequest: {
    type: 'object',
    minProperties: 1,
    properties: { name: { type: 'string', minLength: 2 }, description: { type: 'string' }, is_active: { type: 'boolean' } },
  },
  AddTeamMemberRequest: {
    type: 'object',
    properties: { userId: uuid, role: { type: 'string' } },
    required: ['userId'],
  },
  SetTeamTagsRequest: {
    type: 'object',
    properties: { tagIds: { type: 'array', items: uuid } },
    required: ['tagIds'],
  },
  CreateTagRequest: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1 }, color: { type: 'string', maxLength: 16 } },
    required: ['name'],
  },
  UpdateTagRequest: {
    type: 'object',
    minProperties: 1,
    properties: { name: { type: 'string', minLength: 1 }, color: { type: 'string', maxLength: 16 }, is_active: { type: 'boolean' } },
  },
  AttachRecordTagRequest: {
    type: 'object',
    properties: { tagId: uuid },
    required: ['tagId'],
  },
  AssignRecordRequest: {
    type: 'object',
    properties: { assigneeId: { type: 'string', format: 'uuid', nullable: true, description: 'Target user id, or null to unassign.' } },
    required: ['assigneeId'],
  },

  // expense
  CreateExpenseRequest: {
    type: 'object',
    properties: {
      amount: { type: 'integer', description: 'Amount in minor units.' },
      currency: { type: 'string', minLength: 3, maxLength: 3 },
      merchant: { type: 'string' },
      incurredOn: { type: 'string', format: 'date-time' },
      description: { type: 'string' },
      categoryId: uuid,
      receiptRef: { type: 'string' },
      reportId: uuid,
    },
    required: ['amount'],
  },
  CreateReportRequest: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1 }, currency: { type: 'string', minLength: 3, maxLength: 3 } },
    required: ['name'],
  },
  AttachExpenseRequest: {
    type: 'object',
    description: 'Either reference an existing `expenseId` or inline a new item (`amount` required when inlining).',
    properties: {
      expenseId: uuid,
      amount: { type: 'integer', description: 'Amount in minor units (when inlining a new item).' },
      currency: { type: 'string', minLength: 3, maxLength: 3 },
      merchant: { type: 'string' },
      incurredOn: { type: 'string', format: 'date-time' },
      description: { type: 'string' },
      categoryId: uuid,
      receiptRef: { type: 'string' },
      reportId: uuid,
    },
  },
  SubmitReportRequest: {
    type: 'object',
    properties: { note: { type: 'string' } },
  },
  DecisionRequest: {
    type: 'object',
    description: 'Engine-backed approval decision.',
    properties: {
      decision: { type: 'string', enum: ['approved', 'rejected'] },
      comment: { type: 'string' },
    },
    required: ['decision'],
  },
  CommentRequest: {
    type: 'object',
    properties: { comment: { type: 'string' } },
  },
  RejectRequest: {
    type: 'object',
    properties: { reason: { type: 'string' }, comment: { type: 'string' } },
  },
  RecallRequest: {
    type: 'object',
    properties: { reason: { type: 'string' }, comment: { type: 'string' } },
  },
  AddCommentRequest: {
    type: 'object',
    properties: { body: { type: 'string', minLength: 1 } },
    required: ['body'],
  },

  // invoice
  CreateInvoiceRequest: {
    type: 'object',
    properties: {
      vendorId: uuid,
      vendorName: { type: 'string', minLength: 1 },
      invoiceNumber: { type: 'string', minLength: 1 },
      invoiceDate: { type: 'string', format: 'date-time' },
      dueDate: { type: 'string', format: 'date-time' },
      transactionType: { type: 'string', enum: ['debit', 'credit'] },
      amountMinor: { type: 'integer', minimum: 0 },
      currency: { type: 'string', minLength: 3, maxLength: 3, description: 'Uppercase ISO-4217 code.' },
    },
    required: ['vendorName', 'invoiceNumber', 'invoiceDate', 'amountMinor', 'currency'],
  },
  ApproveInvoiceRequest: {
    type: 'object',
    properties: { comment: { type: 'string' }, approvalLevel: { type: 'integer', minimum: 1 } },
  },

  // payroll
  CreateEmployeeRequest: {
    type: 'object',
    properties: {
      userId: uuid,
      workJurisdiction: { type: 'string', minLength: 2 },
      residenceJurisdiction: { type: 'string' },
      personRef: uuid,
      employmentStatus: { type: 'string' },
      bankAccount: { type: 'string' },
      nationalId: { type: 'string' },
    },
    required: ['workJurisdiction'],
  },
  CreatePayRunRequest: {
    type: 'object',
    properties: {
      periodStart: { type: 'string', format: 'date-time' },
      periodEnd: { type: 'string', format: 'date-time' },
      payDate: { type: 'string', format: 'date-time' },
      type: { type: 'string', enum: ['regular', 'off_cycle'] },
      payCalendarId: uuid,
      employeeIds: { type: 'array', items: uuid },
    },
    required: ['periodStart', 'periodEnd', 'payDate'],
  },

  // reporting
  ReportSpec: {
    type: 'object',
    description: 'Declarative report spec — validated structurally, never raw SQL.',
    properties: {
      measures: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, agg: { type: 'string' }, field: { type: 'string' } }, required: ['name', 'agg', 'field'] } },
      dimensions: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, field: { type: 'string' }, grain: { type: 'string' } }, required: ['name', 'field'] } },
      filters: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, op: { type: 'string' }, value: {} }, required: ['field', 'op'] } },
      grain: { type: 'string' },
      source: { type: 'string' },
    },
  },
  CreateDefinitionRequest: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2 },
      spec: ref('ReportSpec'),
      requiredPermission: { type: 'string' },
    },
    required: ['name', 'spec'],
  },
  CreateRunRequest: {
    type: 'object',
    properties: { definitionId: uuid, params: { type: 'object', additionalProperties: true } },
    required: ['definitionId'],
  },
  CreateScheduleRequest: {
    type: 'object',
    properties: {
      definitionId: uuid,
      cron: { type: 'string', minLength: 3 },
      timezone: { type: 'string', default: 'UTC' },
      enabled: { type: 'boolean', default: true },
    },
    required: ['definitionId', 'cron'],
  },
  UpdateScheduleRequest: {
    type: 'object',
    minProperties: 1,
    properties: { cron: { type: 'string', minLength: 3 }, timezone: { type: 'string' }, enabled: { type: 'boolean' } },
  },

  // workflow
  RulePredicate: {
    type: 'object',
    properties: {
      field: { type: 'string', minLength: 1 },
      operator: { type: 'string', description: 'A RuleOperator value.' },
      value: { description: 'Any comparison value.' },
      conjunction: { type: 'string', description: 'A RuleConjunction value (and/or).' },
    },
    required: ['field', 'operator', 'value', 'conjunction'],
  },
  CreateRuleRequest: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2 },
      event: { type: 'string', description: 'A RuleEvent value.' },
      active: { type: 'boolean' },
      steps: {
        type: 'array', minItems: 1,
        items: { type: 'object', properties: { order: { type: 'integer', minimum: 0 }, query: { type: 'array', minItems: 1, items: ref('RulePredicate') } }, required: ['order', 'query'] },
      },
      actions: {
        type: 'array', minItems: 1,
        items: { type: 'object', properties: { type: { type: 'string', description: 'A RuleActionType value.' }, config: { type: 'object' } }, required: ['type'] },
      },
    },
    required: ['name', 'event', 'steps', 'actions'],
  },
  RunRuleRequest: {
    type: 'object',
    properties: { facts: { type: 'object', additionalProperties: true }, dryRun: { type: 'boolean' } },
    required: ['facts'],
  },
  UpsertConnectorConfigRequest: {
    type: 'object',
    properties: {
      active: { type: 'boolean' },
      baseUrl: { type: 'string', format: 'uri', nullable: true },
      credentialsRef: { type: 'string', minLength: 1, nullable: true },
      settings: { type: 'object', additionalProperties: true },
    },
  },
  ReconcileConnectorRequest: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
  },
};

// ---- components.parameters ---------------------------------------------------
const parameters = {
  RecordTypeParam: {
    name: 'recordType', in: 'path', required: true,
    schema: { type: 'string', enum: ['expense_report', 'invoice', 'pay_run'] },
    description: 'Polymorphic finance record type.',
  },
  ConnectorKindParam: {
    name: 'kind', in: 'path', required: true,
    schema: { type: 'string', enum: ['ledger_one', 'finovo', 'acct_bridge'] },
    description: 'ERP connector kind.',
  },
};

// ---- top-level doc -----------------------------------------------------------
const description = [
  'HTTP API for the Aegis enterprise access-control platform — a multi-tenant, microservices SaaS substrate (centralized RBAC + ABAC PDP/PEP, PostgreSQL row-level tenant isolation, signed service-to-service calls, hash-chained audit). Seven business services sit behind a single gateway.',
  '',
  '**Edge routing.** All authenticated traffic enters through the gateway (`http://localhost:4000`), which resolves the first path segment (`user-management`, `expense`, `payroll`, `reporting`, `workflow`, `notification`, `invoice`) to a downstream service and forwards the request unchanged. Each service independently re-validates auth via its own PEP (defense in depth). Every external path therefore has the form `/{service}/v1/...` (public prefix `/v1`). `/health` bypasses auth/context middleware.',
  '',
  '**Required context headers.** Authenticated requests carry `X-Tenant-Id` and `X-Correlation-Id` (the gateway mints the correlation id at the edge if absent and echoes it on every response, including error hops). `X-Caller` is set to `gateway` on every forwarded hop. The tenant is ambient (driven into PostgreSQL RLS via `SET LOCAL app.current_tenant`) — there is no tenant path segment. Money/state-changing writes may honor an `Idempotency-Key` header (pay-run disburse).',
  '',
  '**Auth.** `register` and `login` are public; the internal recipient-directory routes use signed service-to-service auth (not a user JWT). Every other route requires a Bearer JWT plus a `domain.action` permission enforced by the PEP. Payroll list applies a field-level obligation: sensitive PII is cleared unless the principal also holds `payroll.sensitive.read`.',
  '',
  '**Envelopes.** Single-entity reads/writes return `{ data }`; paged lists return `{ data, meta }`. Errors return `{ errors: [{ code, type, message, details?, correlationId }] }` (5xx return a generic message and omit details). This spec was regenerated directly from the controllers + Joi validators.',
].join('\n');

const tags = [
  { name: 'health', description: 'Liveness / readiness probes (auth-exempt).' },
  { name: 'auth', description: 'Reference IdP — register/login (public) + current principal.' },
  { name: 'user-management', description: 'Identity admin: roles, permissions, ABAC policies, users, invites, sessions, tenant config + feature flags, and the internal recipient directory.' },
  { name: 'annotation-governance', description: 'Teams, tags, and polymorphic record tagging/assignment across the finance record types.' },
  { name: 'expense', description: 'Expense items + expense-report lifecycle (submit/approve/reject/reimburse/recall, comments, engine-backed decisions).' },
  { name: 'invoice', description: 'Invoice lifecycle (create/submit/approve, engine-backed decisions, ERP push).' },
  { name: 'payroll', description: 'Employees, pay-run lifecycle (calculate/approve/disburse), and payslips.' },
  { name: 'reporting', description: 'Declarative report definitions, asynchronous runs + exports, and schedules.' },
  { name: 'workflow', description: 'Automation rules (author + dry-run) and ERP connector admin (config/health/sync-state/reconcile).' },
  { name: 'notification', description: 'In-app inbox (reads + mark-as-read) and email notification logs.' },
];

const doc = {
  openapi: '3.0.3',
  info: {
    title: 'Aegis API',
    version: '1.0.0',
    description,
  },
  servers: [{ url: 'http://localhost:4000', description: 'Gateway (single entry point).' }],
  tags,
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Signed access JWT from `POST /user-management/v1/auth/login`.' },
    },
    parameters,
    schemas,
  },
};

// ---- emit --------------------------------------------------------------------
const yamlStr = yaml.dump(doc, { lineWidth: 120, noRefs: true, sortKeys: false });
const yamlPath = join(here, 'openapi.yaml');
writeFileSync(yamlPath, yamlStr, 'utf8');

// count ops
let opCount = 0;
const byTag = {};
for (const p of Object.keys(paths)) {
  for (const m of Object.keys(paths[p])) {
    opCount++;
    const t = paths[p][m].tags[0];
    byTag[t] = (byTag[t] || 0) + 1;
  }
}

// patch index.html embedded spec
const idxPath = join(here, 'index.html');
let idx = readFileSync(idxPath, 'utf8');
const specJson = JSON.stringify(doc);
idx = idx.replace(
  /(<script id="spec" type="application\/json">)([\s\S]*?)(<\/script>)/,
  (_m, a, _b, c) => a + specJson + c,
);
writeFileSync(idxPath, idx, 'utf8');

console.log(JSON.stringify({ opCount, byTag, schemaCount: Object.keys(schemas).length }, null, 2));
