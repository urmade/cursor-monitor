import type { Actor } from '@nexus/contracts';
import type { Db } from '@nexus/db';

export type Logger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
};

export type FeatureFlags = {
  isEnabled: (key: string, projectId?: string) => Promise<boolean>;
};

export type ServiceContext = {
  db: Db;
  actor: Actor;
  orgId: string;
  clock: () => Date;
  logger: Logger;
  flags: FeatureFlags;
  /** Test-only: allow loopback webhook URLs despite SSRF checks. */
  webhookSsrfAllowLoopback?: boolean;
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createContext(
  partial: Omit<ServiceContext, 'clock' | 'logger' | 'flags'> &
    Partial<Pick<ServiceContext, 'clock' | 'logger' | 'flags'>>,
): ServiceContext {
  return {
    clock: () => new Date(),
    logger: silentLogger,
    flags: {
      isEnabled: async () => true,
    },
    ...partial,
  };
}
