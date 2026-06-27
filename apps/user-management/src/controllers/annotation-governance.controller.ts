import type { Request, Response } from 'express';
import { inject } from 'inversify';
import {
  controller,
  httpDelete,
  httpGet,
  httpPatch,
  httpPost,
  httpPut,
} from 'inversify-express-utils';
import { routeParam, validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import { authenticate, authorize } from '@aegis/access-control';
import { AnnotationGovernanceService } from '../services/annotation-governance.service';
import {
  addTeamMemberSchema,
  assignRecordSchema,
  attachRecordTagSchema,
  createTagSchema,
  createTeamSchema,
  parseRecordType,
  setTeamTagsSchema,
  updateTagSchema,
  updateTeamSchema,
} from '../validators/annotation-governance.validator';

@controller(`/user-management${ApiConstants.PublicPrefix}`)
export class AnnotationGovernanceController {
  constructor(
    @inject(AnnotationGovernanceService) private readonly svc: AnnotationGovernanceService,
  ) {}

  @httpGet('/teams', authenticate(), authorize(Permission.TeamManage))
  async listTeams(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.svc.listTeams() });
  }

  @httpPost('/teams', authenticate(), authorize(Permission.TeamManage), validate(createTeamSchema))
  async createTeam(req: Request, res: Response): Promise<void> {
    res.status(201).json({ data: await this.svc.createTeam(req.body) });
  }

  @httpPatch(
    '/teams/:teamId',
    authenticate(),
    authorize(Permission.TeamManage),
    validate(updateTeamSchema),
  )
  async updateTeam(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.svc.updateTeam(routeParam(req, 'teamId'), req.body) });
  }

  @httpDelete('/teams/:teamId', authenticate(), authorize(Permission.TeamManage))
  async deleteTeam(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.svc.deleteTeam(routeParam(req, 'teamId')));
  }

  @httpGet('/teams/:teamId/members', authenticate(), authorize(Permission.TeamManage))
  async listTeamMembers(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.svc.listTeamMembers(routeParam(req, 'teamId')) });
  }

  @httpPost(
    '/teams/:teamId/members',
    authenticate(),
    authorize(Permission.TeamManage),
    validate(addTeamMemberSchema),
  )
  async addTeamMember(req: Request, res: Response): Promise<void> {
    res.status(201).json({ data: await this.svc.addTeamMember(routeParam(req, 'teamId'), req.body) });
  }

  @httpDelete('/teams/:teamId/members/:userId', authenticate(), authorize(Permission.TeamManage))
  async removeTeamMember(req: Request, res: Response): Promise<void> {
    res
      .status(200)
      .json(await this.svc.removeTeamMember(routeParam(req, 'teamId'), routeParam(req, 'userId')));
  }

  @httpGet('/teams/:teamId/tags', authenticate(), authorize(Permission.TagList))
  async listTeamTags(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.svc.listTeamTags(routeParam(req, 'teamId')) });
  }

  @httpPut(
    '/teams/:teamId/tags',
    authenticate(),
    authorize(Permission.TeamTagManage),
    validate(setTeamTagsSchema),
  )
  async setTeamTags(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.svc.setTeamTags(routeParam(req, 'teamId'), req.body.tagIds));
  }

  @httpGet('/tags', authenticate(), authorize(Permission.TagList))
  async listTags(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.svc.listTags() });
  }

  @httpPost('/tags', authenticate(), authorize(Permission.TagCreate), validate(createTagSchema))
  async createTag(req: Request, res: Response): Promise<void> {
    res.status(201).json({ data: await this.svc.createTag(req.body) });
  }

  @httpPatch(
    '/tags/:tagId',
    authenticate(),
    authorize(Permission.TagUpdate),
    validate(updateTagSchema),
  )
  async updateTag(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.svc.updateTag(routeParam(req, 'tagId'), req.body) });
  }

  @httpDelete('/tags/:tagId', authenticate(), authorize(Permission.TagDelete))
  async deleteTag(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.svc.deleteTag(routeParam(req, 'tagId')));
  }

  @httpGet('/records/:recordType/:recordId/tags', authenticate(), authorize(Permission.TagList))
  async listRecordTags(req: Request, res: Response): Promise<void> {
    res.status(200).json({
      data: await this.svc.listRecordTags(
        parseRecordType(routeParam(req, 'recordType')),
        routeParam(req, 'recordId'),
      ),
    });
  }

  @httpPost(
    '/records/:recordType/:recordId/tags',
    authenticate(),
    authorize(Permission.RecordTagAdd),
    validate(attachRecordTagSchema),
  )
  async attachRecordTag(req: Request, res: Response): Promise<void> {
    res
      .status(200)
      .json(
        await this.svc.attachRecordTag(
          parseRecordType(routeParam(req, 'recordType')),
          routeParam(req, 'recordId'),
          req.body.tagId,
        ),
      );
  }

  @httpDelete(
    '/records/:recordType/:recordId/tags/:tagId',
    authenticate(),
    authorize(Permission.RecordTagRemove),
  )
  async detachRecordTag(req: Request, res: Response): Promise<void> {
    res
      .status(200)
      .json(
        await this.svc.detachRecordTag(
          parseRecordType(routeParam(req, 'recordType')),
          routeParam(req, 'recordId'),
          routeParam(req, 'tagId'),
        ),
      );
  }

  @httpPut(
    '/records/:recordType/:recordId/assignee',
    authenticate(),
    authorize(Permission.RecordAssign),
    validate(assignRecordSchema),
  )
  async assignRecord(req: Request, res: Response): Promise<void> {
    res
      .status(200)
      .json(
        await this.svc.assignRecord(
          parseRecordType(routeParam(req, 'recordType')),
          routeParam(req, 'recordId'),
          req.body,
        ),
      );
  }
}
