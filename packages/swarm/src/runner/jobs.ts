/**
 * The Cloud Run Jobs API, behind an injected transport — the shape every third-party call in
 * this repository goes through (`@personavision/provider`'s `ModelTransport` is the same
 * idea). There is exactly one path to the network from here, it is the function below, and
 * **it is built only when no transport was given**, so a test that passes its own never
 * reaches it.
 *
 * Three calls, because three are what a session needs: start one execution, wait for it to
 * end, and cancel one that has outstayed its welcome. Nothing here classifies a failure —
 * `failures.ts` does that, from what was asked and what was answered — and nothing here
 * knows what a session is.
 *
 * **The credential is Google's to read, not ours.** The default transport takes its access
 * token from the metadata server of the machine it runs on, which is how a workload on
 * Google's own infrastructure is handed one; this repository reads no variable whose name is
 * key-, token-, secret- or credential-shaped, and `tests/workspace.test.ts` holds it to that.
 * A coordinator running anywhere else injects a transport that knows how it is authorised.
 */

/** What one session's execution is asked for. */
export interface JobRunRequest {
  /** `projects/<project>/locations/<region>/jobs/<job>` — the job the execution runs. */
  readonly job: string;
  /** The container's argument vector, which overrides the image's own. */
  readonly args: readonly string[];
  /** This session's environment, on top of whatever the job itself declares. */
  readonly env: Readonly<Record<string, string>>;
  /** The wall clock one task gets: the session's own cap, which does not move for being remote. */
  readonly taskTimeoutMs: number;
}

/** One execution, as the API named it. */
export interface JobExecution {
  /** The execution's own resource name, exactly as the API returned it. */
  readonly name: string;
}

/** How an execution ended, as the API reported it. */
export type JobExecutionResult =
  | { readonly kind: 'succeeded' }
  | {
      readonly kind: 'failed';
      /** The API's own status word, e.g. `RESOURCE_EXHAUSTED`, or `''` when it named none. */
      readonly status: string;
      /** What it said, verbatim, for the one field a person reads. */
      readonly said: string;
    };

/**
 * The API refused outright: it never created an execution, or it stopped answering about one.
 * It carries its own status and words so that `failures.ts` can place it without reading a
 * message for keywords it was not promised.
 */
export class JobsRefused extends Error {
  readonly status: string;
  readonly said: string;

  constructor(status: string, said: string) {
    super(said === '' ? status : `${status}: ${said}`);
    this.name = 'JobsRefused';
    this.status = status;
    this.said = said;
  }
}

export interface JobsTransport {
  /** Creates one execution. Throws `JobsRefused` when the API would not create it. */
  start(request: JobRunRequest): Promise<JobExecution>;
  /**
   * Settles when the execution has ended. Throws `JobsRefused` when the API stopped
   * answering about it, and settles — it does not throw — for an execution that failed,
   * because a failed task is a session's outcome rather than a broken run.
   */
  settle(execution: JobExecution, options: { signal: AbortSignal }): Promise<JobExecutionResult>;
  /** Cancels an execution. Never throws: a cancel that failed is reported, not retried. */
  cancel(execution: JobExecution): Promise<void>;
}

/** How often the default transport asks whether an execution has ended. */
const POLL_MS = 2_000;

/** Where a workload on Google's own infrastructure is handed an access token. */
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** The regional endpoint, which is the one Google asks callers to prefer. */
const endpointFor = (region: string): string => `https://${region}-run.googleapis.com/v2`;

/** Cloud Run spells a timeout in seconds with an `s`, and the shortest it takes is one. */
const asSeconds = (ms: number): string => `${String(Math.max(1, Math.round(ms / 1000)))}s`;

interface Operation {
  readonly name?: string;
  readonly error?: { readonly code?: number; readonly message?: string; readonly status?: string };
  readonly response?: { readonly name?: string };
  readonly metadata?: { readonly name?: string };
}

interface ExecutionState {
  readonly succeededCount?: number;
  readonly failedCount?: number;
  readonly cancelledCount?: number;
  readonly conditions?: ReadonlyArray<{
    readonly type?: string;
    readonly state?: string;
    readonly message?: string;
    readonly reason?: string;
  }>;
}

/** The one place a status word is read off an HTTP answer rather than off a payload. */
const statusOf = (response: Response, body: unknown): string => {
  const named =
    typeof body === 'object' && body !== null && 'error' in body
      ? ((body as { error?: { status?: string } }).error?.status ?? '')
      : '';
  return named === '' ? `HTTP_${String(response.status)}` : named;
};

const saidOf = (body: unknown, fallback: string): string => {
  const message =
    typeof body === 'object' && body !== null && 'error' in body
      ? ((body as { error?: { message?: string } }).error?.message ?? '')
      : '';
  return message === '' ? fallback : message;
};

/**
 * The Jobs API over `fetch`, which is the only code in this repository that talks to it.
 *
 * It is a plain HTTP client on purpose: a Google client library would be a dependency whose
 * own transport we could not inject, and the three calls below are three requests.
 */
export const createCloudRunJobsTransport = ({
  region,
  fetchImpl = fetch,
  token,
}: {
  region: string;
  /** Overridable so that the default transport itself can be exercised without a socket. */
  fetchImpl?: typeof fetch;
  /** Where the access token comes from. Defaults to the metadata server. */
  token?: () => Promise<string>;
}): JobsTransport => {
  const endpoint = endpointFor(region);

  const accessToken =
    token ??
    (async (): Promise<string> => {
      const response = await fetchImpl(METADATA_TOKEN_URL, {
        headers: { 'Metadata-Flavor': 'Google' },
      });
      if (!response.ok) {
        throw new JobsRefused(
          `HTTP_${String(response.status)}`,
          'the metadata server would not issue an access token for this workload',
        );
      }
      const body = (await response.json()) as { access_token?: string };
      const issued = body.access_token ?? '';
      if (issued === '') {
        throw new JobsRefused('UNAUTHENTICATED', 'the metadata server issued no access token');
      }
      return issued;
    });

  const call = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${endpoint}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answered: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new JobsRefused(
        statusOf(response, answered),
        saidOf(answered, `the Jobs API answered ${String(response.status)} for ${path}`),
      );
    }
    return answered;
  };

  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((settle) => {
      const timer = setTimeout(settle, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        settle();
      });
    });

  return {
    start: async (request) => {
      const operation = (await call(`${request.job}:run`, {
        overrides: {
          taskCount: 1,
          timeout: asSeconds(request.taskTimeoutMs),
          containerOverrides: [
            {
              args: [...request.args],
              env: Object.entries(request.env).map(([name, value]) => ({ name, value })),
            },
          ],
        },
      })) as Operation;
      if (operation.error !== undefined) {
        throw new JobsRefused(
          operation.error.status ?? `CODE_${String(operation.error.code ?? 0)}`,
          operation.error.message ?? 'the Jobs API refused to run this job',
        );
      }
      const name = operation.response?.name ?? operation.metadata?.name ?? '';
      if (name === '') {
        throw new JobsRefused(
          'UNKNOWN',
          'the Jobs API accepted the request and named no execution, so there is nothing to wait for',
        );
      }
      return { name };
    },

    settle: async (execution, { signal }) => {
      for (;;) {
        const state = (await call(execution.name)) as ExecutionState;
        if ((state.succeededCount ?? 0) > 0) return { kind: 'succeeded' };
        const lost = (state.failedCount ?? 0) + (state.cancelledCount ?? 0);
        if (lost > 0) {
          const condition = state.conditions?.find((entry) => entry.state === 'CONDITION_FAILED');
          return {
            kind: 'failed',
            status: condition?.reason ?? '',
            said: condition?.message ?? 'the task did not succeed and the API gave no reason',
          };
        }
        if (signal.aborted) {
          throw new JobsRefused('ABORTED', 'nobody is waiting for this execution any more');
        }
        await sleep(POLL_MS, signal);
      }
    },

    cancel: async (execution) => {
      await call(`${execution.name}:cancel`, {}).catch(() => undefined);
    },
  };
};
