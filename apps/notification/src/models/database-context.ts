import type { ModelStatic, Model, Sequelize } from 'sequelize';
import { getSequelize, createModelRegistry } from '@aegis/db';
import { defineNotification } from './notification.model';
import { defineEmailNotificationLog } from './email-notification-log.model';
import { defineNotificationPreference } from './notification-preference.model';
import { defineEmailSuppression } from './email-suppression.model';
import { defineEmailSenderIdentity } from './email-sender-identity.model';

type M = ModelStatic<Model>;

/** The set of notification models, registered on the shared connection (the service's DatabaseContext). */
export interface NotificationContext {
  Notification: M;
  EmailNotificationLog: M;
  NotificationPreference: M;
  EmailSuppression: M;
  EmailSenderIdentity: M;
  sequelize: Sequelize;
}

let ctx: NotificationContext | null = null;

/**
 * Defines every notification model on the shared `getSequelize()` connection (once) and returns the
 * assembled context. The return shape is unchanged from the previous single-file `context.ts`, so all
 * callers keep working (SPEC §11.1 — one `*.model.ts` per table + a `database-context.ts` that
 * imports + registers them).
 */
export function getNotificationContext(): NotificationContext {
  if (ctx) return ctx;
  const s = getSequelize();
  // Single registration path through the registry (W2-09).
  const registry = createModelRegistry(s);

  const Notification = registry.register(defineNotification(s));
  const EmailNotificationLog = registry.register(defineEmailNotificationLog(s));
  const NotificationPreference = registry.register(defineNotificationPreference(s));
  const EmailSuppression = registry.register(defineEmailSuppression(s));
  const EmailSenderIdentity = registry.register(defineEmailSenderIdentity(s));

  ctx = {
    Notification,
    EmailNotificationLog,
    NotificationPreference,
    EmailSuppression,
    EmailSenderIdentity,
    sequelize: s,
  };
  return ctx;
}
