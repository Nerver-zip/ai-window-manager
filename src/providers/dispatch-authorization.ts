/** A proven rejection at the synchronous boundary immediately before send. */
export class DispatchAuthorizationError extends Error {
  constructor(readonly reasonCode: string) {
    super('provider dispatch authorization revoked before send');
    this.name = 'DispatchAuthorizationError';
  }
}
