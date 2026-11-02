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
