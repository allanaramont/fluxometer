import type { Pool } from "pg";
import {
  aiCostSpike,
  aiFailureRate,
  errorSpike,
  highVariance,
  peakHourBottleneck,
  platformErrorConcentration,
  postDeployRegression,
  regression,
  type RuleResult,
  slowQuery,
  slowRoute,
  timeoutSpike,
  topConsumer,
} from "./queries.js";

export const RULES: ((pool: Pool) => Promise<RuleResult[]>)[] = [
  slowRoute,
  regression,
  topConsumer,
  errorSpike,
  slowQuery,
  highVariance,
  platformErrorConcentration,
  timeoutSpike,
  aiCostSpike,
  aiFailureRate,
  peakHourBottleneck,
  postDeployRegression,
];
