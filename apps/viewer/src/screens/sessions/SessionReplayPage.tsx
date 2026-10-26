import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/runs/:runId/sessions/:sessionId` — one person's gaze, intent, actions and outcome, on a scrubber.
 *
 * A placeholder on the route table, so that **#22** fills this file and touches neither
 * the router nor a sibling screen.
 */
export function SessionReplayPage() {
  return <ScreenPlaceholder screen="Session replay" ticket="#22" />;
}
