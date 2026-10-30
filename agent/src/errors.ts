/**
 * Errors and texts the session flows and tool results share. Dependency-free,
 * so the flows import them without pulling in git (child_process) or the
 * connection (the DB SDK, node:fs).
 */

/**
 * A git call killed at its timeout. limited: the timeout was the caller's
 * deadline (a flow's budget), not git's own GIT_TIMEOUT_MS, so trying again
 * in a new call may well succeed. detail: the reason without the prefix.
 */
export class GitTimeoutError extends Error {
  constructor(message: string, readonly detail: string, readonly limited: boolean) {
    super(message);
    this.name = 'GitTimeoutError';
  }
}

/** A git call whose output exceeded the buffer limit (e.g. the diff of a huge rewritten file). */
export class GitOutputTooLargeError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = 'GitOutputTooLargeError';
  }
}

export const NOT_CONNECTED = 'not connected (reconnecting)';
export const TIMED_OUT = 'reducer timed out (reconnecting)';
