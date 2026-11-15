import {
  trackAiCall,
  trackAudit,
  trackClientMetric,
  trackFailure,
  trackRequest,
} from "../core/writer.js";

export const track = {
  request: trackRequest,
  clientMetric: trackClientMetric,
  aiCall: trackAiCall,
  failure: trackFailure,
  audit: trackAudit,
};
