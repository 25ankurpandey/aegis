import { Config } from './config';

/**
 * Secrets seam. Locally, secrets resolve from env (the committed dummy .env files).
 * In real envs, swap this implementation for a param-store/secrets-manager backed provider
 * keyed by `/aegis/<env>/...` (SPEC §7) without changing call sites.
 */
export interface SecretsProvider {
  get(name: string): Promise<string>;
}

class EnvSecretsProvider implements SecretsProvider {
  async get(name: string): Promise<string> {
    return Config.require(name);
  }
}

export const Secrets: SecretsProvider = new EnvSecretsProvider();
