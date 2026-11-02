import {
  trackAiCall,
  trackClientMetric,
  trackRequest,
} from "../core/writer.js";

export const track = {
  request: trackRequest,
  clientMetric: trackClientMetric,
  aiCall: trackAiCall,
};
