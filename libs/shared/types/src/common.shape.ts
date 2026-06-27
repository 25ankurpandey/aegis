/** Cross-cutting DTO/shape namespaces. See docs/08-api-conventions.md. */
export namespace CommonShape {
  export interface PageQuery {
    page?: number;
    pageSize?: number;
  }

  export interface PageMeta {
    total: number;
    page: number;
    pageSize: number;
  }

  export interface PagedResult<T> {
    data: T[];
    meta: PageMeta;
  }

  export interface ErrorEnvelopeItem {
    code: string;
    type: string;
    message: string;
    details?: unknown;
    correlationId?: string;
  }

  export interface ErrorEnvelope {
    errors: ErrorEnvelopeItem[];
  }

  /** Columns every tenant-scoped row carries. */
  export interface TenantScoped {
    id: string;
    tenant_id: string;
    created_at: Date;
    updated_at: Date;
  }
}
