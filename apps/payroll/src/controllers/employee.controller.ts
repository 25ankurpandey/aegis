import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import { validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import { authenticate, authorize } from '@aegis/access-control';
import { EmployeeService } from '../services/employee.service';
import { createEmployeeSchema } from '../validators/employee.validator';

/** Employee master HTTP surface — every route is PEP-guarded (authenticate → authorize(permission)). */
@controller(`/payroll${ApiConstants.PublicPrefix}`)
export class EmployeeController {
  constructor(@inject(EmployeeService) private readonly employees: EmployeeService) {}

  @httpPost('/employees', authenticate(), authorize(Permission.PayrollEmployeeManage), validate(createEmployeeSchema))
  async create(req: Request, res: Response): Promise<void> {
    res.status(201).json(await this.employees.create(req.body));
  }

  @httpGet('/employees', authenticate(), authorize(Permission.PayrollEmployeeView))
  async list(req: Request, res: Response): Promise<void> {
    // Field-level obligation: clear PII only for principals also holding payroll.sensitive.read.
    const perms = req.principal?.permissions ?? [];
    const canReadSensitive = perms.includes(Permission.PayrollSensitiveRead);
    res.status(200).json(await this.employees.list(canReadSensitive));
  }
}
