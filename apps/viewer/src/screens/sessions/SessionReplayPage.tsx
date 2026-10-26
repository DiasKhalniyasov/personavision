import { ReplayPage } from '@/screens/replay/ReplayPage';

/**
 * `/runs/:runId/sessions/:sessionId` — one person's gaze, intent, actions and outcome, on a
 * scrubber.
 *
 * The route table mounts this file; the screen itself lives in `src/screens/replay/`, so
 * **#24** and **#25** fill the column beside it without touching the router or the Sessions
 * list.
 */
export function SessionReplayPage() {
  return <ReplayPage />;
}
