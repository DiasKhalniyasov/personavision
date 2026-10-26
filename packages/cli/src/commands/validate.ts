import { stat } from 'node:fs/promises';
import { validate } from '@personavision/contract';
import { CliError } from '../cli-error.js';

/**
 * `personavision validate <runDir>` — every schema violation in a run directory, each at
 * the JSON path of the offending value, so that the output alone says which value is wrong
 * and where. It reports all of them rather than stopping at the first.
 */

export interface ValidateCommandOptions {
  runDir: string;
  log?: (line: string) => void;
}

const pathProblem = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'there is no such directory';
  if (code === 'ENOTDIR') return 'a path along it is a file, not a directory';
  if (code === 'EACCES') return 'it cannot be read';
  return `it cannot be read: ${(error as Error).message}`;
};

export const validateCommand = async ({
  runDir,
  log = (line) => process.stdout.write(`${line}\n`),
}: ValidateCommandOptions): Promise<void> => {
  let directory: boolean;
  try {
    directory = (await stat(runDir)).isDirectory();
  } catch (error) {
    throw new CliError(
      `${runDir} is not a run directory: ${pathProblem(error)}. Pass the directory a run was written to, such as runs/2026-10-24-1402-northwind-demo.`,
    );
  }
  if (!directory) {
    throw new CliError(
      `${runDir} is not a run directory: it is a file. Pass the directory a run was written to, such as runs/2026-10-24-1402-northwind-demo.`,
    );
  }

  const violations = await validate(runDir);
  if (violations.length === 0) {
    log(`${runDir} is a valid run directory.`);
    return;
  }
  throw new CliError(
    [
      `${runDir} is not a valid run directory (${violations.length} violation${violations.length === 1 ? '' : 's'}):`,
      ...violations.map(
        (violation) => `  ${violation.file}${violation.path} — ${violation.message}`,
      ),
    ].join('\n'),
  );
};
