import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { internalAuth, validate } from '@aegis/service-core';
import type { UserManagementShape } from '@aegis/shared-types';
import { RecipientDirectoryService } from '../services/recipient-directory.service';
import {
  recipientDirectoryQuerySchema,
  userContactParamSchema,
} from '../validators/internal-recipient.validator';

/** Internal service-to-service recipient directory consumed by notification fan-out. */
@controller('/user-management/internal')
export class InternalRecipientController {
  constructor(
    @inject(RecipientDirectoryService) private readonly directory: RecipientDirectoryService,
  ) {}

  @httpGet('/users/:id/contact', internalAuth(), validate(userContactParamSchema, 'params'))
  async getUserContact(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.directory.getUserContact(req.params['id']));
  }

  @httpGet('/recipients', internalAuth(), validate(recipientDirectoryQuerySchema, 'query'))
  async listRecipients(req: Request, res: Response): Promise<void> {
    res
      .status(200)
      .json(
        await this.directory.listRecipients(
          req.query as UserManagementShape.RecipientDirectoryQuery,
        ),
      );
  }
}
