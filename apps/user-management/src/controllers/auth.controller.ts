import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import { validate } from '@aegis/service-core';
import { ApiConstants } from '@aegis/shared-constants';
import { Permission } from '@aegis/shared-enums';
import { authenticate, authorize } from '@aegis/access-control';
import { AuthService } from '../services/auth.service';
import { registerSchema, loginSchema } from '../validators/auth.validator';

/** Auth HTTP surface (the reference IdP): register/login are public; `me` requires a token. */
@controller(`/user-management${ApiConstants.PublicPrefix}/auth`)
export class AuthController {
  constructor(@inject(AuthService) private readonly auth: AuthService) {}

  @httpPost('/register', validate(registerSchema))
  async register(req: Request, res: Response): Promise<void> {
    res.status(201).json(await this.auth.register(req.body));
  }

  @httpPost('/login', validate(loginSchema))
  async login(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.auth.login(req.body));
  }

  @httpGet('/me', authenticate(), authorize(Permission.UserView))
  async me(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.auth.me());
  }
}
