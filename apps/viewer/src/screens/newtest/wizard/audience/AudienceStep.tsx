import { StepPlaceholder } from '../StepPlaceholder';

/** `/new?step=audience` — #273 builds this step. */
export function AudienceStep() {
  return <StepPlaceholder step="audience" ticket="#273" />;
}
