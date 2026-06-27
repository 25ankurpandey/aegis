import { randomUUID } from 'node:crypto';
import { Logger } from '@aegis/service-core';
import type { NotificationShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';

/**
 * Default SMS provider — a key-proxy-brokered no-op stub mirroring `EmailProviderService`. Holds NO
 * credentials (a leaked notification DB row cannot send SMS); a real gateway (Twilio/SNS) replaces
 * this binding at composition. The send is logged so the channel is observable end-to-end in tests.
 */
@provideSingleton(SmsProviderService)
export class SmsProviderService implements NotificationShape.SmsProvider {
  async send(message: NotificationShape.SmsMessage): Promise<string> {
    const ref = `sms_${randomUUID()}`;
    Logger.info('sms dispatched via key-proxy broker', {
      to: message.to,
      providerRef: ref,
    });
    return ref;
  }
}
