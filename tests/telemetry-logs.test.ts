import { describe, expect, it } from 'vitest';
import { TIMER_LOG_CONTENT } from '../scripts/timerlog.ts';

// `sudo overlyx-telemetry logs 168 autodeploy` (28 Nov 2026) printed 5,000 lines of systemd's own
// "Starting / Deactivated / Finished" — 2.3 days of a timer that found nothing to do — and not one line
// of a deploy: the line limit was applied before anything was left out.
describe('a timer service\'s log: what counts as content', () => {
  const content = new RegExp(TIMER_LOG_CONTENT);
  it('leaves out what systemd writes around every run', () => {
    for (const message of [
      'Starting overlyx-autodeploy.service - OverLyX: check and deploy origin/master (scripts/autodeploy.sh)...',
      'overlyx-autodeploy.service: Deactivated successfully.',
      'Finished overlyx-autodeploy.service - OverLyX: check and deploy origin/master (scripts/autodeploy.sh).',
      'overlyx-autodeploy.service: Consumed 1min 29.191s CPU time.',
      'overlyx-maintenance.service: Consumed 6.366s CPU time.',
      'Starting overlyx-backup-offsite.service - OverLyX off-site backup (restic to Hetzner Object Storage)...',
    ]) expect(content.test(message), message).toBe(false);
  });
  it('keeps the services\' own lines and systemd\'s word on a failed run', () => {
    for (const message of [
      '12:37:15 origin/master is at 481431dba1, production at 421bd15708',
      '12:40:39 deployed 481431dba1: https://overlyx.app serves the tested assets',
      '[maintenance] screened 29 signals; 0 new or retryable',
      '[promote] queued 2026-11-25T10-10-07-000Z-12ab34cd for the owner (japhba/overlyx-maint): the evidence came from outside',
      'backup written to /mnt/HC_Volume_107166861/backups/2026-11-28T03-35-02Z (1.4G)',
      'overlyx-autodeploy.service: Main process exited, code=exited, status=1/FAILURE',
      'overlyx-autodeploy.service: Failed with result \'exit-code\'.',
      'Failed to start overlyx-autodeploy.service - OverLyX: check and deploy origin/master (scripts/autodeploy.sh).',
      'overlyx-backup.service: Consumed too much memory',
    ]) expect(content.test(message), message).toBe(true);
  });
});
