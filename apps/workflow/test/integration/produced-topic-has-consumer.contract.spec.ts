import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EVENTING CONTRACT GUARD (BUG-0001 / BUG-0002 / BUG-0003 regression net). All three bugs had the SAME
 * root cause: a rule action PRODUCED an EventTopic that NO service CONSUMED, so the action reported
 * success while the work silently never happened. This test makes that class of bug un-shippable: it
 * statically scans the monorepo and asserts EVERY EventTopic that is PRODUCED somewhere (via
 * `makeEnvelope(...)` or a `*.publish(EventTopic.X, ...)`) has at least ONE subscriber registered (a
 * `subscribe(EventTopic.X` call OR a `[EventTopic.X]:` key in a consumer's dynamic topic->handler map,
 * e.g. the rules engine's TOPIC_TO_RULE_EVENT).
 *
 * It is a SOURCE scan (not a runtime registration) on purpose: it sees consumers across ALL services
 * (workflow, notification, finance) without booting any of them, and it covers the dynamic-map
 * subscriptions a runtime spy on one service's registerConsumers() would miss.
 *
 * KNOWN_UNCONSUMED documents topics produced by OTHER bundles that do not (yet) have a consumer. It is
 * now EMPTY: every produced topic has at least one consumer. A NEW produced-with-no-consumer topic, or
 * a regression that drops the ApprovalCommand / NotificationRequested / RecordUpdated consumers, fails
 * the test.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SCAN_DIRS = ['apps', 'libs'].map((d) => join(REPO_ROOT, d));

/**
 * Produced topics that do NOT (yet) have a consumer and are owned outside this bundle. Keep this list
 * SHRINKING — every entry is a latent BUG-0001/0002-class gap. It is now EMPTY: `RecordUpdated` (the
 * engine's assign_team / add_tag follow-on) is consumed by the per-service RecordUpdated consumers in
 * expense / invoice / payroll (BUG-0003), so there are no documented gaps left.
 */
const KNOWN_UNCONSUMED = new Set<string>([]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function collectProducedAndSubscribed(): { produced: Set<string>; subscribed: Set<string> } {
  const produced = new Set<string>();
  const subscribed = new Set<string>();

  const producedRe = /(?:makeEnvelope|\.publish)\(\s*EventTopic\.([A-Za-z0-9_]+)/g;
  const subscribeCallRe = /\.subscribe\(\s*EventTopic\.([A-Za-z0-9_]+)/g;
  const subscribeMapRe = /\[\s*EventTopic\.([A-Za-z0-9_]+)\s*\]\s*:/g;

  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(producedRe)) produced.add(m[1]);
      for (const m of src.matchAll(subscribeCallRe)) subscribed.add(m[1]);
      for (const m of src.matchAll(subscribeMapRe)) subscribed.add(m[1]);
    }
  }
  return { produced, subscribed };
}

describe('eventing contract — every PRODUCED EventTopic has at least one CONSUMER', () => {
  const { produced, subscribed } = collectProducedAndSubscribed();

  it('finds the producers + subscribers it expects (sanity: the scan actually works)', () => {
    expect(produced.has('ApprovalCommand')).toBe(true);
    expect(produced.has('NotificationRequested')).toBe(true);
    expect(produced.has('ConnectorPushRequested')).toBe(true);
    expect(subscribed.has('ConnectorPushRequested')).toBe(true);
  });

  it('the two fixed topics ARE now consumed (BUG-0001 / BUG-0002)', () => {
    expect(subscribed.has('ApprovalCommand')).toBe(true);
    expect(subscribed.has('NotificationRequested')).toBe(true);
  });

  it('RecordUpdated (assign_team / add_tag) IS now consumed by the owning finance services (BUG-0003)', () => {
    expect(produced.has('RecordUpdated')).toBe(true);
    expect(subscribed.has('RecordUpdated')).toBe(true);
  });

  it('no produced topic is left without a consumer (outside the documented KNOWN_UNCONSUMED gaps)', () => {
    const orphans = [...produced].filter(
      (topic) => !subscribed.has(topic) && !KNOWN_UNCONSUMED.has(topic),
    );
    expect(orphans).toEqual([]);
  });

  it('KNOWN_UNCONSUMED is now empty + only lists topics actually produced (honest + shrinking)', () => {
    expect([...KNOWN_UNCONSUMED]).toEqual([]);
    const stale = [...KNOWN_UNCONSUMED].filter((topic) => !produced.has(topic));
    expect(stale).toEqual([]);
  });
});
