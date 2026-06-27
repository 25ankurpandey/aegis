#!/usr/bin/env node
/* eslint-disable no-console */

const BASE_URL = (process.env.AEGIS_BASE_URL || process.env.E2E_BASE_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const TENANT_A = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'admin@demo-org.test',
  password: 'demo-admin-pw',
};
const TENANT_B = {
  id: '00000000-0000-4000-8000-000000000002',
  email: 'admin@demo-org-b.test',
  password: 'demo-admin-pw-b',
};

let counter = 0;
const suffix = () => `${Date.now().toString(36)}-${++counter}`;
const state = {};
let lastApiResponse = null;

function healthUrls() {
  if (BASE_URL.includes('://gateway:4000')) {
    return [
      'http://gateway:4000',
      'http://user-management:4001',
      'http://expense:4002',
      'http://payroll:4003',
      'http://reporting:4004',
      'http://workflow:4005',
      'http://notification:4006',
      'http://invoice:4007',
    ];
  }
  return [4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007].map((port) =>
    BASE_URL.replace(/:\d+$/, `:${port}`),
  );
}

function pass(name, details = '') {
  console.log(`ok   ${name}${details ? ` — ${details}` : ''}`);
}

function fail(name, details) {
  const error = new Error(`${name}: ${details}`);
  error.stepName = name;
  throw error;
}

function expectStatus(name, actual, expected) {
  if (Array.isArray(expected) ? !expected.includes(actual) : actual !== expected) {
    const last =
      lastApiResponse && lastApiResponse.status === actual
        ? `; last ${lastApiResponse.method} ${lastApiResponse.path} -> ${lastApiResponse.status}: ${lastApiResponse.raw}`
        : '';
    fail(name, `expected HTTP ${expected}, got ${actual}${last}`);
  }
}

function dataOf(res) {
  return res.body?.data ?? res.body;
}

function rowsOf(res) {
  const data = dataOf(res);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function idOf(res, name) {
  const data = dataOf(res);
  const id = data?.id;
  if (!id) fail(name, `missing id in ${res.raw}`);
  return id;
}

function isoDate(daysFromNow) {
  const date = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function requireRow(name, rows, predicate) {
  const row = rows.find(predicate);
  if (!row) fail(name, `expected row not found in ${JSON.stringify(rows).slice(0, 500)}`);
  return row;
}

async function api(path, { method = 'GET', tenantId, token, body, headers = {} } = {}) {
  const requestHeaders = {
    'content-type': 'application/json',
    'x-correlation-id': `script-e2e-${suffix()}`,
    ...headers,
  };
  if (tenantId !== undefined) requestHeaders['x-tenant-id'] = tenantId;
  if (token) requestHeaders.authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let data = raw;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    // keep raw text
  }
  lastApiResponse = { method, path, status: res.status, raw };
  return { status: res.status, body: data, raw };
}

async function step(name, fn) {
  process.stdout.write(`run  ${name}\n`);
  const detail = await fn();
  pass(name, detail);
}

async function login(tenant) {
  const res = await api('/user-management/v1/auth/login', {
    method: 'POST',
    tenantId: tenant.id,
    body: { email: tenant.email, password: tenant.password },
  });
  expectStatus(`login ${tenant.email}`, res.status, 200);
  if (!res.body?.token) fail(`login ${tenant.email}`, `missing token in ${res.raw}`);
  return res.body.token;
}

async function main() {
  console.log(`Aegis live HTTP flow tests`);
  console.log(`base ${BASE_URL}`);
  console.log('Each block prints the platform capability it is asserting; failures include the HTTP body.');

  await step('health: gateway and all services', async () => {
    for (const url of healthUrls()) {
      const res = await fetch(`${url}/health`);
      if (!res.ok) fail('health', `${url}/health returned ${res.status}`);
    }
    return '8/8 healthy';
  });

  await step('gateway serves live OpenAPI docs', async () => {
    const res = await fetch(`${BASE_URL}/api-docs.json`);
    if (!res.ok) fail('api docs', `/api-docs.json returned ${res.status}`);
    const spec = await res.json();
    if (!spec?.openapi || !spec?.paths) fail('api docs', 'missing OpenAPI shape');
    return `${Object.keys(spec.paths).length} documented paths`;
  });

  await step('auth fails closed without tenant header', async () => {
    const res = await api('/user-management/v1/auth/login', {
      method: 'POST',
      body: { email: TENANT_A.email, password: TENANT_A.password },
    });
    if (res.status < 400 || res.status >= 500) fail('missing tenant', `expected 4xx, got ${res.status}`);
    return `HTTP ${res.status}`;
  });

  await step('auth register duplicate guard', async () => {
    const email = `script-e2e-${suffix()}@demo-org.test`;
    const password = 'script-password-123';
    const created = await api('/user-management/v1/auth/register', {
      method: 'POST',
      tenantId: TENANT_A.id,
      body: { email, password, firstName: 'Script', lastName: 'Runner' },
    });
    expectStatus('register', created.status, 201);
    state.employeeUser = { id: idOf(created, 'registered user'), email, password };
    const dup = await api('/user-management/v1/auth/register', {
      method: 'POST',
      tenantId: TENANT_A.id,
      body: { email, password },
    });
    if (dup.status < 400 || dup.status >= 500) fail('duplicate register', `expected 4xx, got ${dup.status}`);
    return email;
  });

  await step('auth login, /me, tenant-token mismatch', async () => {
    state.tokenA = await login(TENANT_A);
    const me = await api('/user-management/v1/auth/me', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('/auth/me', me.status, 200);
    state.userA = me.body?.id;
    if (!state.userA) fail('/auth/me', `missing user id in ${me.raw}`);
    const mismatch = await api('/user-management/v1/auth/me', { tenantId: TENANT_B.id, token: state.tokenA });
    expectStatus('tenant mismatch', mismatch.status, 403);
    return me.body?.email || TENANT_A.email;
  });

  await step('user-management PAP, sessions, tenants, invites', async () => {
    const permissions = await api('/user-management/v1/permissions', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('permissions', permissions.status, 200);
    const permissionRows = rowsOf(permissions);
    requireRow('permission catalog', permissionRows, (p) => p.name === 'payroll.payslip.view.own');

    const roles = await api('/user-management/v1/roles', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('roles', roles.status, 200);
    const roleRows = rowsOf(roles);
    requireRow('seeded admin role', roleRows, (r) => r.name === 'admin');

    const tenant = await api('/user-management/v1/tenants/current', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('current tenant', tenant.status, 200);
    if (dataOf(tenant)?.id !== TENANT_A.id) fail('current tenant', `unexpected tenant ${tenant.raw}`);

    const users = await api('/user-management/v1/users', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('users', users.status, 200);
    requireRow('registered user visible', rowsOf(users), (u) => u.id === state.employeeUser.id);

    const sessions = await api('/user-management/v1/sessions', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('sessions', sessions.status, 200);

    const employeeRole = await api('/user-management/v1/roles', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: {
        name: `script-own-payslip-${suffix()}`,
        description: 'Script-scoped employee role',
        permissions: ['payroll.payslip.view.own'],
      },
    });
    expectStatus('employee role create', employeeRole.status, 201);
    state.employeeRole = idOf(employeeRole, 'employee role create');

    const assigned = await api(`/user-management/v1/users/${state.employeeUser.id}/role`, {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { roleId: state.employeeRole, scope: 'own_only' },
    });
    expectStatus('employee role assign', assigned.status, 200);

    const invite = await api('/user-management/v1/invites', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: {
        email: `invite-${suffix()}@demo-org.test`,
        roleId: state.employeeRole,
        scope: 'own_only',
      },
    });
    expectStatus('invite create', invite.status, 201);
    const inviteId = idOf(invite, 'invite create');

    const revoked = await api(`/user-management/v1/invites/${inviteId}/revoke`, {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
    });
    expectStatus('invite revoke', revoked.status, 200);

    const config = await api('/user-management/v1/tenant/config', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('tenant config', config.status, 200);
    const features = await api('/user-management/v1/tenant/features', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('tenant features', features.status, 200);
    const annotationFlag = await api('/user-management/v1/tenant/features/record.annotations', {
      method: 'PUT',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { enabled: true },
    });
    expectStatus('record annotations feature enable', annotationFlag.status, 200);

    state.employeeToken = await login({ id: TENANT_A.id, email: state.employeeUser.email, password: state.employeeUser.password });
    return `${permissionRows.length} permissions, ${roleRows.length} roles, employee role ${state.employeeRole}`;
  });

  await step('expense create, attach item, submit, read back', async () => {
    const created = await api('/expense/v1/reports', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { name: `Script Trip ${suffix()}`, currency: 'USD' },
    });
    expectStatus('expense create', created.status, 201);
    state.reportA = created.body?.data?.id;
    if (!state.reportA) fail('expense create', `missing report id in ${created.raw}`);

    const attach = await api(`/expense/v1/reports/${state.reportA}/expenses`, {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { amount: 4200, currency: 'USD', merchant: 'Script Diner', description: 'dinner' },
    });
    expectStatus('expense attach', attach.status, 200);

    const submitted = await api(`/expense/v1/reports/${state.reportA}/submit`, {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { note: 'script run' },
    });
    expectStatus('expense submit', submitted.status, 200);
    if (submitted.body?.data?.status === 'open') fail('expense submit', 'report remained open');

    const detail = await api(`/expense/v1/reports/${state.reportA}`, { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('expense detail', detail.status, 200);
    return `${state.reportA} (${detail.body?.data?.status})`;
  });

  await step('teams/tags governance and record annotations', async () => {
    const team = await api('/user-management/v1/teams', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { name: `Script Finance ${suffix()}`, description: 'Script-created test team' },
    });
    expectStatus('team create', team.status, 201);
    state.teamA = idOf(team, 'team create');

    const tag = await api('/user-management/v1/tags', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { name: `script-tag-${suffix()}`, color: '#2374ab' },
    });
    expectStatus('tag create', tag.status, 201);
    state.tagA = idOf(tag, 'tag create');

    const member = await api(`/user-management/v1/teams/${state.teamA}/members`, {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { userId: state.userA, role: 'owner' },
    });
    expectStatus('team member add', member.status, 201);

    const teamTags = await api(`/user-management/v1/teams/${state.teamA}/tags`, {
      method: 'PUT',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { tagIds: [state.tagA] },
    });
    expectStatus('team tags set', teamTags.status, 200);

    const attach = await api(`/user-management/v1/records/expense_report/${state.reportA}/tags`, {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { tagId: state.tagA },
    });
    expectStatus('record tag attach', attach.status, 200);

    const assign = await api(`/user-management/v1/records/expense_report/${state.reportA}/assignee`, {
      method: 'PUT',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { assigneeId: state.userA },
    });
    expectStatus('record assign', assign.status, 200);

    const recordTags = await api(`/user-management/v1/records/expense_report/${state.reportA}/tags`, {
      tenantId: TENANT_A.id,
      token: state.tokenA,
    });
    expectStatus('record tags list', recordTags.status, 200);
    requireRow('record tag visible', rowsOf(recordTags), (r) => r.tag_id === state.tagA || r.tagId === state.tagA);
    return `team ${state.teamA}, tag ${state.tagA}`;
  });

  await step('expense decision endpoint requires auth', async () => {
    const res = await api(`/expense/v1/reports/${state.reportA}/decisions`, {
      method: 'POST',
      tenantId: TENANT_A.id,
      body: { decision: 'approved' },
    });
    expectStatus('unauth decision', res.status, 401);
    return '401';
  });

  await step('invoice create, duplicate detection, submit, read APIs', async () => {
    const invoiceNumber = `SCRIPT-${suffix()}`;
    const body = {
      vendorName: 'Script Supplies',
      invoiceNumber,
      invoiceDate: isoDate(-1),
      dueDate: isoDate(30),
      amountMinor: 125000,
      currency: 'USD',
      transactionType: 'debit',
    };
    const created = await api('/invoice/v1/invoices', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body,
    });
    expectStatus('invoice create', created.status, 201);
    state.invoiceA = idOf(created, 'invoice create');

    const duplicate = await api('/invoice/v1/invoices', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body,
    });
    expectStatus('invoice duplicate create', duplicate.status, 201);
    if (dataOf(duplicate)?.status !== 'duplicate') fail('invoice duplicate', `expected duplicate status in ${duplicate.raw}`);

    const submitted = await api(`/invoice/v1/invoices/${state.invoiceA}/submit`, {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
    });
    expectStatus('invoice submit', submitted.status, 200);
    if (dataOf(submitted)?.status === 'pending_review') fail('invoice submit', 'invoice remained pending_review');

    const detail = await api(`/invoice/v1/invoices/${state.invoiceA}`, { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('invoice detail', detail.status, 200);
    const list = await api('/invoice/v1/invoices?page=1&pageSize=5', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('invoice list', list.status, 200);
    const pending = await api('/invoice/v1/invoices/approvals/pending', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('invoice pending approvals', pending.status, 200);
    return `${state.invoiceA} (${dataOf(detail)?.status})`;
  });

  await step('payroll employee, pay-run, own payslip bridge, SoD guard', async () => {
    const employee = await api('/payroll/v1/employees', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: {
        userId: state.employeeUser.id,
        workJurisdiction: 'US-CA',
        residenceJurisdiction: 'US-CA',
        bankAccount: '000123456789',
        nationalId: '999-12-3456',
      },
    });
    expectStatus('employee create', employee.status, 201);
    state.employeeId = idOf(employee, 'employee create');

    const employees = await api('/payroll/v1/employees', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('employee list', employees.status, 200);
    requireRow('employee visible', rowsOf(employees), (e) => e.id === state.employeeId);

    const payRun = await api('/payroll/v1/pay-runs', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: {
        periodStart: isoDate(-14),
        periodEnd: isoDate(-1),
        payDate: isoDate(3),
        type: 'regular',
        employeeIds: [state.employeeId],
      },
    });
    expectStatus('pay-run create', payRun.status, 201);
    state.payRunId = idOf(payRun, 'pay-run create');

    const calculated = await api(`/payroll/v1/pay-runs/${state.payRunId}/calculate`, {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
    });
    expectStatus('pay-run calculate', calculated.status, 200);
    if (dataOf(calculated)?.status !== 'calculated') fail('pay-run calculate', `unexpected status ${calculated.raw}`);

    const adminPayslips = await api(`/payroll/v1/pay-runs/${state.payRunId}/payslips`, {
      tenantId: TENANT_A.id,
      token: state.tokenA,
    });
    expectStatus('admin payslips', adminPayslips.status, 200);
    const slip = requireRow('admin payslip visible', rowsOf(adminPayslips), (p) => p.employeeId === state.employeeId || p.employee_id === state.employeeId);
    state.payslipId = slip.id;

    const ownPayslips = await api(`/payroll/v1/payslips?payRunId=${state.payRunId}`, {
      tenantId: TENANT_A.id,
      token: state.employeeToken,
    });
    expectStatus('own payslips', ownPayslips.status, 200);
    requireRow('own payslip bridge', rowsOf(ownPayslips), (p) => p.id === state.payslipId);

    const ownPayslip = await api(`/payroll/v1/payslips/${state.payslipId}`, {
      tenantId: TENANT_A.id,
      token: state.employeeToken,
    });
    expectStatus('own payslip detail', ownPayslip.status, 200);

    const sod = await api(`/payroll/v1/pay-runs/${state.payRunId}/decisions`, {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { decision: 'approved', comment: 'script verifies maker-checker' },
    });
    expectStatus('payroll SoD guard', sod.status, 403);
    return `payRun ${state.payRunId}, payslip ${state.payslipId}`;
  });

  await step('reporting definition, run, export, schedule lifecycle', async () => {
    const definition = await api('/reporting/v1/report-definitions', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: {
        name: `Script Spend ${suffix()}`,
        spec: {
          source: 'expense_reports',
          measures: [{ name: 'total', agg: 'sum', field: 'amount_minor' }],
          dimensions: [{ name: 'status', field: 'status' }],
          filters: [],
        },
      },
    });
    expectStatus('report definition create', definition.status, 201);
    state.reportDefinitionId = idOf(definition, 'report definition create');

    const run = await api('/reporting/v1/report-runs', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { definitionId: state.reportDefinitionId, params: { script: true } },
    });
    expectStatus('report run create', run.status, 202);
    state.reportRunId = dataOf(run)?.runId;
    if (!state.reportRunId) fail('report run create', `missing runId in ${run.raw}`);

    const runDetail = await api(`/reporting/v1/report-runs/${state.reportRunId}`, { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('report run detail', runDetail.status, 200);
    if (dataOf(runDetail)?.status !== 'succeeded') fail('report run detail', `unexpected status ${runDetail.raw}`);

    const exportRes = await api(`/reporting/v1/report-runs/${state.reportRunId}/export`, { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('report run export', exportRes.status, 200);

    const schedule = await api('/reporting/v1/report-schedules', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { definitionId: state.reportDefinitionId, cron: '0 9 * * *', timezone: 'UTC', enabled: true },
    });
    expectStatus('report schedule create', schedule.status, 201);
    state.reportScheduleId = idOf(schedule, 'report schedule create');

    const patched = await api(`/reporting/v1/report-schedules/${state.reportScheduleId}`, {
      method: 'PATCH',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { enabled: false },
    });
    expectStatus('report schedule patch', patched.status, 200);

    const schedules = await api('/reporting/v1/report-schedules?page=1&pageSize=10', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('report schedules list', schedules.status, 200);
    requireRow('report schedule visible', rowsOf(schedules), (s) => s.id === state.reportScheduleId);

    const deleted = await api(`/reporting/v1/report-schedules/${state.reportScheduleId}`, {
      method: 'DELETE',
      tenantId: TENANT_A.id,
      token: state.tokenA,
    });
    expectStatus('report schedule delete', deleted.status, 200);
    return `definition ${state.reportDefinitionId}, run ${state.reportRunId}`;
  });

  await step('workflow connectors and rule dry-run', async () => {
    const configs = await api('/workflow/v1/connectors', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('connector configs list', configs.status, 200);

    const upsert = await api('/workflow/v1/connectors/ledger_one', {
      method: 'PUT',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { active: true, settings: { scriptRun: true } },
    });
    expectStatus('connector config upsert', upsert.status, 200);

    const health = await api('/workflow/v1/connectors/ledger_one/health', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('connector health', health.status, 200);
    if (dataOf(health)?.healthy !== true) fail('connector health', `expected healthy=true in ${health.raw}`);

    const syncState = await api('/workflow/v1/connectors/sync-state?page=1&pageSize=5', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('connector sync-state list', syncState.status, 200);

    const reconcile = await api('/workflow/v1/connectors/reconcile', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { limit: 10 },
    });
    expectStatus('connector reconcile', reconcile.status, 202);

    const rule = await api('/workflow/v1/rules', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: {
        name: `Script rule ${suffix()}`,
        event: 'record.created',
        active: true,
        steps: [
          {
            order: 0,
            query: [{ field: 'amount', operator: 'gte', value: 1, conjunction: 'AND' }],
          },
        ],
        actions: [{ type: 'notify', config: { recipientUserId: state.userA, template: 'rule.notice' } }],
      },
    });
    expectStatus('workflow rule create', rule.status, 201);
    state.ruleId = idOf(rule, 'workflow rule create');

    const ruleDetail = await api(`/workflow/v1/rules/${state.ruleId}`, { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('workflow rule detail', ruleDetail.status, 200);

    const dryRun = await api(`/workflow/v1/rules/${state.ruleId}/run`, {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: {
        dryRun: true,
        facts: { id: state.invoiceA, record_type: 'invoice', amount: 125000, owner_user_id: state.userA },
      },
    });
    expectStatus('workflow rule dry-run', dryRun.status, 200);
    return `rule ${state.ruleId}, connector configs ${rowsOf(configs).length}`;
  });

  await step('notification inbox, unread count, read-all, email logs', async () => {
    const list = await api('/notification/v1/notifications?page=1&pageSize=10', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('notification list', list.status, 200);
    const unread = await api('/notification/v1/notifications/inbox/unread-count', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('notification unread count', unread.status, 200);
    const readAll = await api('/notification/v1/notifications/inbox/read-all', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
    });
    expectStatus('notification read all', readAll.status, 200);
    const emailLogs = await api('/notification/v1/email-notification-logs?page=1&pageSize=10', { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('email notification logs', emailLogs.status, 200);

    const first = rowsOf(list)[0];
    if (first?.id) {
      const detail = await api(`/notification/v1/notifications/${first.id}`, { tenantId: TENANT_A.id, token: state.tokenA });
      expectStatus('notification detail', detail.status, 200);
      const read = await api(`/notification/v1/notifications/${first.id}/read`, {
        method: 'POST',
        tenantId: TENANT_A.id,
        token: state.tokenA,
      });
      expectStatus('notification mark read', read.status, 200);
    }
    return `${rowsOf(list).length} visible notifications`;
  });

  await step('cross-tenant RLS hides rows both ways', async () => {
    state.tokenB = await login(TENANT_B);
    const aReport = await api('/expense/v1/reports', {
      method: 'POST',
      tenantId: TENANT_A.id,
      token: state.tokenA,
      body: { name: `A-only ${suffix()}`, currency: 'USD' },
    });
    expectStatus('A create', aReport.status, 201);
    const bReport = await api('/expense/v1/reports', {
      method: 'POST',
      tenantId: TENANT_B.id,
      token: state.tokenB,
      body: { name: `B-only ${suffix()}`, currency: 'USD' },
    });
    expectStatus('B create', bReport.status, 201);

    const aId = aReport.body?.data?.id;
    const bId = bReport.body?.data?.id;
    const aOwn = await api(`/expense/v1/reports/${aId}`, { tenantId: TENANT_A.id, token: state.tokenA });
    const bReadsA = await api(`/expense/v1/reports/${aId}`, { tenantId: TENANT_B.id, token: state.tokenB });
    const aReadsB = await api(`/expense/v1/reports/${bId}`, { tenantId: TENANT_A.id, token: state.tokenA });
    expectStatus('A reads own', aOwn.status, 200);
    expectStatus('B reads A', bReadsA.status, 404);
    expectStatus('A reads B', aReadsB.status, 404);
    return `${aId} / ${bId}`;
  });

  console.log('\nPASS all scripted HTTP flows');
}

main().catch((err) => {
  console.error(`\nFAIL ${err.stepName || 'script'}: ${err.message}`);
  process.exit(1);
});
