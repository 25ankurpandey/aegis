/**
 * OFFLINE unit test for the app-brain indexers' pure content-composition functions. No DB, no
 * network — proves the exact kind/ref/subject/content/metadata each indexer writes, so the live
 * integration spec only has to prove persistence + recall ranking.
 */
import {
  buildAuditMemoryInput,
  buildToolMemoryInput,
  type IndexableAuditProposal,
  type IndexableTool,
} from '../src/brain/indexers';

describe('buildToolMemoryInput (pure, offline)', () => {
  const tool: IndexableTool = {
    name: 'expense.create',
    description: 'Create a new expense for reimbursement',
    method: 'POST',
    path: '/api/expenses',
    requiredPermissions: ['expense:write', 'expense:read'],
  };

  it('composes kind "tool", ref = name, subject = "tool:<name>", title = name', () => {
    const input = buildToolMemoryInput(tool);
    expect(input.kind).toBe('tool');
    expect(input.ref).toBe('expense.create');
    expect(input.subject).toBe('tool:expense.create');
    expect(input.title).toBe('expense.create');
  });

  it('composes content = description + [method path] + required permissions', () => {
    const input = buildToolMemoryInput(tool);
    expect(input.content).toBe(
      'Create a new expense for reimbursement [POST /api/expenses] requires: expense:write,expense:read',
    );
  });

  it('renders absent method/path as empty strings and absent permissions as an empty join', () => {
    const input = buildToolMemoryInput({ name: 'noop', description: 'Does nothing' });
    expect(input.content).toBe('Does nothing [ ] requires: ');
    expect(input.ref).toBe('noop');
    expect(input.subject).toBe('tool:noop');
  });
});

describe('buildAuditMemoryInput (pure, offline)', () => {
  const proposal: IndexableAuditProposal = {
    checkId: 'expense-approval-chain',
    status: 'proposed',
    blast: 'low',
    finding: {
      subjectRef: 'expense:42',
      summary: 'Expense 42 was approved by its own submitter.',
      expected: { approver: 'distinct-from-submitter' },
      observed: { approver: 'user-7', submitter: 'user-7' },
      recommendation: 'Route expense 42 to an independent approver.',
    },
  };

  it('composes kind "audit_finding", ref = "<checkId>:<subjectRef>", subject = "audit:<subjectRef>"', () => {
    const input = buildAuditMemoryInput(proposal);
    expect(input.kind).toBe('audit_finding');
    expect(input.ref).toBe('expense-approval-chain:expense:42');
    expect(input.subject).toBe('audit:expense:42');
  });

  it('composes content = summary + expected/observed (JSON) + recommendation', () => {
    const input = buildAuditMemoryInput(proposal);
    expect(input.content).toBe(
      'Expense 42 was approved by its own submitter. ' +
        'expected: {"approver":"distinct-from-submitter"} ' +
        'observed: {"approver":"user-7","submitter":"user-7"} ' +
        'recommendation: Route expense 42 to an independent approver.',
    );
  });

  it('carries { status, blast } as metadata', () => {
    const input = buildAuditMemoryInput(proposal);
    expect(input.metadata).toEqual({ status: 'proposed', blast: 'low' });
  });

  it('stringifies non-object expected/observed values (including undefined) without throwing', () => {
    const input = buildAuditMemoryInput({
      ...proposal,
      finding: { ...proposal.finding, expected: 3, observed: undefined },
    });
    expect(input.content).toContain('expected: 3 observed: undefined ');
  });
});
