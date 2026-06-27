/**
 * Pluggable ERP connector framework (@aegis/connectors). The connectors are MOCK implementations
 * with neutral names that prove the infra is production-ready. See docs/services/connectors.md.
 */
export enum ConnectorKind {
  LedgerOne = 'ledger_one',
  Finovo = 'finovo',
  AcctBridge = 'acct_bridge',
}

export enum ConnectorEntity {
  Expense = 'expense',
  Invoice = 'invoice',
  PayrollJournal = 'payroll_journal',
}

export enum ConnectorSyncStatus {
  Queued = 'queued',
  InProgress = 'in_progress',
  Synced = 'synced',
  Error = 'error',
}
