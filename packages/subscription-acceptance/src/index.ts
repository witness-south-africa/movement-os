/** Private Node-only acceptance tooling, separate from runtime Worker adapters. */
export { runAcceptance } from './lib/runner.js';
export type {
  AcceptanceConfig,
  AcceptanceDependencies,
  AcceptanceReport,
  BuildProvenance,
} from './lib/runner.js';
