/**
 * OFFLINE unit test for the app-brain embedding seam. No DB, no network — proves the default
 * {@link HashingEmbeddingClient} is deterministic, correctly dimensioned, L2-normalized, and produces
 * vectors whose cosine similarity actually tracks lexical overlap (so pgvector recall is meaningful).
 */
import { HashingEmbeddingClient } from '../src/brain/embedding-client';
import { APP_BRAIN_EMBEDDING_DIM } from '../src/brain/types';

/** Cosine similarity. For L2-normalized vectors this equals the dot product, but compute it fully. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function l2(v: number[]): number {
  return Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
}

describe('HashingEmbeddingClient (offline, deterministic)', () => {
  const client = new HashingEmbeddingClient();

  it('reports the single-source-of-truth dimension and produces vectors of that length', async () => {
    expect(client.dimensions).toBe(APP_BRAIN_EMBEDDING_DIM);
    const v = await client.embed('quarterly revenue and invoices');
    expect(v).toHaveLength(APP_BRAIN_EMBEDDING_DIM);
  });

  it('is deterministic: the same text always yields an identical vector', async () => {
    const a = await client.embed('reconcile the ledger against invoices');
    const b = await client.embed('reconcile the ledger against invoices');
    expect(a).toEqual(b);
  });

  it('L2-normalizes non-empty input (unit norm) and returns all-zeros for empty/symbol-only input', async () => {
    const v = await client.embed('payroll salaries and benefits');
    expect(l2(v)).toBeCloseTo(1, 6);

    const empty = await client.embed('   !!! --- ');
    expect(empty).toHaveLength(APP_BRAIN_EMBEDDING_DIM);
    expect(l2(empty)).toBe(0);
  });

  it('cosine similarity tracks lexical overlap: related text > unrelated text', async () => {
    const revenue = await client.embed('quarterly revenue growth and invoices billed to customers');
    const query = await client.embed('revenue invoices customers');
    const payroll = await client.embed('employee payroll salaries benefits and tax withholding');

    const simRelated = cosine(query, revenue);
    const simUnrelated = cosine(query, payroll);

    expect(simRelated).toBeGreaterThan(simUnrelated);
    expect(simRelated).toBeGreaterThan(0.1); // shares three tokens with the revenue doc
    expect(simUnrelated).toBeCloseTo(0, 6); // shares no tokens with payroll
  });

  it('is case-insensitive and punctuation-agnostic (same tokens ⇒ same vector)', async () => {
    const a = await client.embed('Revenue, Invoices; Customers!');
    const b = await client.embed('revenue invoices customers');
    expect(a).toEqual(b);
  });
});
