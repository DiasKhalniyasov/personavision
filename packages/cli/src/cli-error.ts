/**
 * A failure the developer is meant to read: the message is the whole output and no stack
 * trace is printed, because every one of these names something to do next.
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
