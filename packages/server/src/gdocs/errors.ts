/** An error answered by the Google APIs (no imports: the tests' API simulation uses it too). */
export class GoogleApiError extends Error {
  constructor(message: string, public status: number, public reason?: string) { super(message); }
}
