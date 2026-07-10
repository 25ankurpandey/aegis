import type { QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';

// Physical table name (created by 0001). Referenced as a literal to keep this migration
// self-contained and matching the raw-SQL style of 0034.
const USER_ROLES = 'user_roles';

/**
 * ABAC-01 remediation (Decision 1, Option A — docs/strategy/security-findings.md §Recommendations):
 * give the per-approver amount cap a real source so `amountCapPolicies` stops being inert.
 *
 * - `approval_limit_minor` BIGINT NULL — the max amount (MINOR units, e.g. cents) this *person* may
 *   approve in *this* role assignment. NULL = unlimited = today's behavior (back-compat: an
 *   unconfigured approver is not newly blocked). Per role-assignment, per tenant, per user — it lives
 *   right where `scope` already lives, so the PIP reads it straight into
 *   `principal.attributes.approvalLimit`. A user holding >1 role takes the MAX non-null (see the PIP).
 *
 * A plain column add does not touch the FORCE + RESTRICTIVE tenant-isolation RLS policies from 0001
 * (they key on `tenant_id`), so RLS is intentionally untouched here.
 */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(
    `ALTER TABLE "${USER_ROLES}"
       ADD COLUMN "approval_limit_minor" BIGINT NULL;`,
  );
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.sequelize.query(
    `ALTER TABLE "${USER_ROLES}"
       DROP COLUMN IF EXISTS "approval_limit_minor";`,
  );
}
