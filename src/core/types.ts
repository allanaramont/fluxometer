export type RequestMetric = {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  userHash?: string;
  platform?: string;
};

export type ClientMetric = {
  screen: string;
  action: string;
  durationMs: number;
  appVersion?: string;
  platform?: string;
};

export type AiCallMetric = {
  model: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  toolsCalled?: string[];
  success: boolean;
  userHash?: string;
};

/** A failed (4xx/5xx) request of a matched route, with its cause. */
export type FailureEvent = {
  route: string;
  method: string;
  status: number;
  durationMs?: number;
  errorName?: string;
  errorCode?: string;
  /** Sanitized and truncated before it is stored (see sanitizeMessage). */
  message?: string;
  correlationId?: string;
  tenant?: string;
  userHash?: string;
  platform?: string;
};

/**
 * "Something changed". There is nowhere to put a VALUE: `fields` takes the
 * NAMES of what changed, never what it changed to.
 */
export type AuditEvent = {
  entity: string;
  action: string;
  targetId?: string;
  affectedCount?: number;
  tenant?: string;
  /** An id or a hash - the host decides; never a name or an e-mail. */
  actor?: string;
  /** Where it came from, e.g. "http", "cron", "internal". */
  source?: string;
  route?: string;
  method?: string;
  correlationId?: string;
  fields?: string[];
  /** Free text, e.g. "wide", "scoped", "none". */
  effect?: string;
  tags?: string[];
};
