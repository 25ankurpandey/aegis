import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import { validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { CommonShape, NotificationShape } from '@aegis/shared-types';
import { ApiConstants } from '@aegis/shared-constants';
import { authenticate, authorize } from '@aegis/access-control';
import { NotificationService } from '../services/notification.service';
import {
  emailLogQuerySchema,
  idParamSchema,
  listQuerySchema,
} from '../validators/notification.validator';

/**
 * In-app inbox HTTP surface. The write path is event-only (§8); these routes are reads +
 * mark-as-read, every one PEP-guarded (authenticate → authorize) and RLS-scoped to the caller's
 * own notifications within their tenant. Request segments validate via the `validate(...)` middleware.
 */
@controller(`/notification${ApiConstants.PublicPrefix}`)
export class NotificationController {
  constructor(@inject(NotificationService) private readonly notifications: NotificationService) {}

  @httpGet(
    '/notifications',
    authenticate(),
    authorize(Permission.NotificationView),
    validate(listQuerySchema, 'query'),
  )
  async list(req: Request, res: Response): Promise<void> {
    // `req.query` is coerced + stripped by the `validate(listQuerySchema, 'query')` middleware.
    res.status(200).json(await this.notifications.listForUser(req.query as CommonShape.PageQuery));
  }

  @httpGet('/notifications/inbox/unread-count', authenticate(), authorize(Permission.NotificationView))
  async unreadCount(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.notifications.unreadCountForUser());
  }

  @httpPost('/notifications/inbox/read-all', authenticate(), authorize(Permission.NotificationView))
  async markAllRead(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.notifications.markAllRead());
  }

  @httpGet(
    '/notifications/:id',
    authenticate(),
    authorize(Permission.NotificationView),
    validate(idParamSchema, 'params'),
  )
  async get(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.notifications.getForUser(req.params['id']) });
  }

  @httpPost(
    '/notifications/:id/read',
    authenticate(),
    authorize(Permission.NotificationView),
    validate(idParamSchema, 'params'),
  )
  async markRead(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.notifications.markRead(req.params['id']));
  }

  @httpGet(
    '/email-notification-logs',
    authenticate(),
    authorize(Permission.NotificationView),
    validate(emailLogQuerySchema, 'query'),
  )
  async emailLogs(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.notifications.listEmailLogs(req.query as NotificationShape.EmailLogQuery));
  }
}
