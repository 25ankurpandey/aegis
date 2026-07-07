import {
  getAttributeReadPort,
  getPolicyReadPort,
  registerAccessControlPorts,
  resetAccessControlPorts,
  type AttributeReadPort,
  type PolicyReadPort,
} from '../src/policy-ports';

/**
 * Phase-0 tests for the per-process read-port registry
 * (docs/strategy/abac-generalization.md §2.1/§2.2, §3 Q6/Q10).
 */

const policyPort: PolicyReadPort = {
  listActive: async () => [],
};

const attributePort: AttributeReadPort = {
  load: async () => ({ teamIds: ['team-1'] }),
};

describe('access-control read-port registry', () => {
  beforeEach(() => resetAccessControlPorts());
  afterAll(() => resetAccessControlPorts());

  it('both getters return undefined while dormant/unregistered', () => {
    expect(getPolicyReadPort()).toBeUndefined();
    expect(getAttributeReadPort()).toBeUndefined();
  });

  it('registers and returns the policy read port', () => {
    registerAccessControlPorts({ policyRead: policyPort });
    expect(getPolicyReadPort()).toBe(policyPort);
    // The other key stays dormant.
    expect(getAttributeReadPort()).toBeUndefined();
  });

  it('registers and returns the attribute (PIP) read port', () => {
    registerAccessControlPorts({ attributeRead: attributePort });
    expect(getAttributeReadPort()).toBe(attributePort);
    expect(getPolicyReadPort()).toBeUndefined();
  });

  it('merges per key: a later call providing one port leaves the other in place', () => {
    registerAccessControlPorts({ policyRead: policyPort });
    registerAccessControlPorts({ attributeRead: attributePort });
    expect(getPolicyReadPort()).toBe(policyPort);
    expect(getAttributeReadPort()).toBe(attributePort);
  });

  it('re-registering a key replaces the implementation (idempotent bootstrap)', () => {
    const replacement: PolicyReadPort = { listActive: async () => [] };
    registerAccessControlPorts({ policyRead: policyPort });
    registerAccessControlPorts({ policyRead: replacement });
    expect(getPolicyReadPort()).toBe(replacement);
  });

  it('an empty registration call changes nothing', () => {
    registerAccessControlPorts({ policyRead: policyPort, attributeRead: attributePort });
    registerAccessControlPorts({});
    expect(getPolicyReadPort()).toBe(policyPort);
    expect(getAttributeReadPort()).toBe(attributePort);
  });

  it('reset drops all ports (back to dormant)', () => {
    registerAccessControlPorts({ policyRead: policyPort, attributeRead: attributePort });
    resetAccessControlPorts();
    expect(getPolicyReadPort()).toBeUndefined();
    expect(getAttributeReadPort()).toBeUndefined();
  });
});
