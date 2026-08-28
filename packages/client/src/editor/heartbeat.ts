/**
 * Timer that browsers do not throttle. Timers on the page itself run at most once a minute after a
 * tab has been in the background for a while (Chrome's intensive throttling), which starved the
 * presence heartbeat and the reconnect logic of hidden tabs; a dedicated worker's timer keeps its
 * cadence, and its messages are delivered to the page as soon as they arrive.
 * Used by editor.ts: `new Worker(new URL('./heartbeat.ts', import.meta.url), { type: 'module' })`.
 */
const INTERVAL_MS = 10000;
setInterval(() => postMessage('tick'), INTERVAL_MS);
