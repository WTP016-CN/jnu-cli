import { CliError } from './errors.js';

/**
 * Report that a JNU real-mode integration is waiting for verified traffic.
 * Captured requests must still be replayed through the normal authentication
 * boundary; this helper never suggests bypassing it.
 */
export function notCaptured(module, hint) {
  const name = String(module ?? '').trim() || 'this module';
  const nextStep =
    'Run `jnu-cli dev capture` to record the JNU endpoint, or provide a browser HAR with ' +
    '`jnu-cli dev import-har --file <path>`.';
  const extra = String(hint ?? '').trim();

  return new CliError(
    'UPSTREAM_NOT_CAPTURED',
    `The real JNU interface for "${name}" has not been captured yet.`,
    {
      hint: `${nextStep}${extra ? ` ${extra}` : ''} Do not bypass JNU unified authentication or WebVPN.`
    }
  );
}
