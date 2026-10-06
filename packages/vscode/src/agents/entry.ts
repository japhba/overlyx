/** dist/agents.cjs — the local tool server agents start (server.ts). */
import { main } from './server.ts';

main().catch(e => { process.stderr.write(`OverLyX local tools: ${(e as Error)?.stack ?? e}\n`); process.exit(1); });
