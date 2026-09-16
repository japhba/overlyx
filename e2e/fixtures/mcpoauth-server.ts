import express from 'express';
import http from 'node:http';
import { authMiddleware, createUser, signSession, toSessionUser } from '../../packages/server/src/auth.ts';
import { db } from '../../packages/server/src/db.ts';
import { oauthRoutes, wellKnownRoutes } from '../../packages/server/src/mcpOauth.ts';
import { setSecurityHeaders } from '../../packages/server/src/security.ts';

const session = signSession(toSessionUser(createUser('oauth-browser', 'OAuth Browser', null)));
const app = express();
app.use(authMiddleware);
app.use((_req, res, next) => { setSecurityHeaders(res); next(); });
app.use(wellKnownRoutes());
app.use('/oauth', oauthRoutes());
app.get('/', (_req, res) => { res.type('html').send('<p>OverLyX</p>'); });
const server = http.createServer(app);
server.listen(0, '127.0.0.1', () => {
  process.send!({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, session });
});
process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
