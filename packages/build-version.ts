/** Fixed at build/dev-server startup, in UTC; shared by the web app and VS Code webview. */
export const buildVersion = new Date().toISOString().slice(2, 16).replaceAll('-', '/').replace('T', '-');
