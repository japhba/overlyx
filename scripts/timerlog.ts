/**
 * The timers' services (autodeploy every two minutes, maintenance every ten, the backups): which journal
 * messages are content. systemd itself writes three or four lines around every run, also one that found
 * nothing to do — a week of the autodeploy's log was 5,000 such lines and not one of its own. journalctl
 * leaves them out (--grep, a PCRE on the message alone) before the lines are counted; what systemd says
 * about a run that failed ("Failed with result …", "Main process exited …") stays.
 */
export const TIMER_LOG_CONTENT = String.raw`^(?!(Starting|Finished) overlyx-[\w-]+\.service\b|overlyx-[\w-]+\.service: (Deactivated successfully\.|Consumed .* CPU time))`;
