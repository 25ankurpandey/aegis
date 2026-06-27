import { getPagination, pageMeta, success, paginated } from '../../src/http/response-envelope';
import { RequestContext } from '../../src/context/request-context';

describe('response envelope helpers (W2-13)', () => {
  describe('getPagination', () => {
    it('defaults to page 1 with the default size', () => {
      expect(getPagination()).toEqual({ pageNo: 1, pageSize: 25, offset: 0 });
    });

    it('computes offset from a 1-based page', () => {
      expect(getPagination({ page: 3, pageSize: 10 })).toEqual({ pageNo: 3, pageSize: 10, offset: 20 });
    });

    it('coerces string query inputs', () => {
      expect(getPagination({ page: '2', pageSize: '5' })).toEqual({ pageNo: 2, pageSize: 5, offset: 5 });
    });

    it('clamps an oversized pageSize to the max', () => {
      expect(getPagination({ pageSize: 100000 }).pageSize).toBe(100);
    });

    it('floors invalid/negative inputs to safe defaults', () => {
      expect(getPagination({ page: -4, pageSize: 0 })).toEqual({ pageNo: 1, pageSize: 25, offset: 0 });
    });
  });

  describe('pageMeta', () => {
    it('derives pageCount from totalCount and pageSize', () => {
      expect(pageMeta(23, getPagination({ page: 1, pageSize: 10 }))).toEqual({
        totalCount: 23,
        pageSize: 10,
        pageNo: 1,
        pageCount: 3,
      });
    });
  });

  describe('success/paginated envelopes', () => {
    it('wraps a payload and backfills correlationId from context', () => {
      RequestContext.run(
        { tenantId: 't', correlationId: 'corr-9', startedAt: Date.now() },
        () => {
          expect(success({ a: 1 })).toEqual({ data: { a: 1 }, correlationId: 'corr-9' });
        },
      );
    });

    it('omits correlationId off the request path', () => {
      expect(success([1, 2]).correlationId).toBeUndefined();
    });

    it('builds a paginated envelope with meta', () => {
      const env = paginated([{ id: 1 }], 1, getPagination({ page: 1, pageSize: 10 }));
      expect(env.data).toEqual([{ id: 1 }]);
      expect(env.meta).toEqual({ totalCount: 1, pageSize: 10, pageNo: 1, pageCount: 1 });
    });
  });
});
