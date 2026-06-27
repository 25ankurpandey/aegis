/**
 * @aegis/events — the event bus: topic enum + envelopes (context-carrying), an in-process bus
 * (default, local/no-broker) and an opt-in Kafka transport, plus a transactional-outbox helper.
 * Redis is cache-only now. See docs/06-service-to-service.md.
 */
export * from './topics';
export * from './payloads';
export * from './bus';
export * from './kafka-bus';
export * from './init-bus';
export * from './outbox';
export * from './init-relay';
