/** Why the server refuses an editor's connection (editor/connection.ts), and how the editors' indicators say it. */
export type Refusal = 'signed-out' | 'no-access';

export const refusalLabel = (r: Refusal): string => (r === 'signed-out' ? 'Signed out — reload the page to sign in' : 'No access');

export const refusalTitle = (r: Refusal): string => (r === 'signed-out'
  ? 'This browser’s sign-in has ended (signed out elsewhere, or it expired). Changes made since are kept in this browser: reload the page and sign in, and they are saved.'
  : 'You do not have access to this file (any more): changes made here cannot be saved. It reconnects by itself if access is given back.');
