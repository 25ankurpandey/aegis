/**
 * Standard SUCCESS response envelope + pagination meta. This is the success-side counterpart to the
 * `{ errors: [...] }` error envelope, so every service returns a consistent shape instead of
 * hand-rolling `res.json(...)`. Controllers can return these directly (inversify-express-utils
 * serialises the returned value) or pass through `sendSuccess`/`sendPaginated`.
 */
import type { Response } from 'express';
import { RequestContext } from '../context/request-context';

/** Pagination meta block — mirrors the donor's `{ total_count, page_size, page_no }` shape. */
export interface PageMeta {
  /** Total rows matching the query across all pages. */
  totalCount: number;
  /** Rows per page (the requested/effective limit). */
  pageSize: number;
  /** 1-based page number. */
  pageNo: number;
  /** Total number of pages (derived). */
  pageCount: number;
}

/** A successful single-payload envelope. */
export interface SuccessEnvelope<T> {
  data: T;
  meta?: PageMeta;
  correlationId?: string;
}

/** Normalised paging inputs (1-based page, bounded size). */
export interface Pagination {
  pageNo: number;
  pageSize: number;
  /** SQL OFFSET derived from (pageNo-1)*pageSize. */
  offset: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * Coerce raw `page`/`pageSize` query inputs into a safe, bounded {@link Pagination}. Defends against
 * `pageSize=1e9` scans and `page=0`/negative inputs. `pageNo` is 1-based.
 */
export function getPagination(
  input: { page?: number | string; pageSize?: number | string } = {},
  opts: { defaultSize?: number; maxSize?: number } = {},
): Pagination {
  const maxSize = opts.maxSize ?? MAX_PAGE_SIZE;
  const defaultSize = opts.defaultSize ?? DEFAULT_PAGE_SIZE;
  const rawPage = Number(input.page);
  const rawSize = Number(input.pageSize);
  const pageNo = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  let pageSize = Number.isFinite(rawSize) && rawSize >= 1 ? Math.floor(rawSize) : defaultSize;
  pageSize = Math.min(pageSize, maxSize);
  return { pageNo, pageSize, offset: (pageNo - 1) * pageSize };
}

/** Build a {@link PageMeta} from the total row count and the {@link Pagination} used. */
export function pageMeta(totalCount: number, pagination: Pagination): PageMeta {
  return {
    totalCount,
    pageSize: pagination.pageSize,
    pageNo: pagination.pageNo,
    pageCount: pagination.pageSize > 0 ? Math.ceil(totalCount / pagination.pageSize) : 0,
  };
}

/** Wrap a payload in the success envelope, backfilling `correlationId` from context when available. */
export function success<T>(data: T, meta?: PageMeta): SuccessEnvelope<T> {
  return {
    data,
    ...(meta ? { meta } : {}),
    correlationId: RequestContext.tryGet()?.correlationId,
  };
}

/** Wrap a page of rows + pagination into a paginated success envelope. */
export function paginated<T>(
  rows: T[],
  totalCount: number,
  pagination: Pagination,
): SuccessEnvelope<T[]> {
  return success(rows, pageMeta(totalCount, pagination));
}

/** Write a success envelope to the response (default 200). */
export function sendSuccess<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json(success(data));
}

/** Write a paginated success envelope to the response. */
export function sendPaginated<T>(
  res: Response,
  rows: T[],
  totalCount: number,
  pagination: Pagination,
  status = 200,
): Response {
  return res.status(status).json(paginated(rows, totalCount, pagination));
}
