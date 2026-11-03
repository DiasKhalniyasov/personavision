import { StepPlaceholder } from '../StepPlaceholder';

/** `/new?step=estimate` — #279 builds this step. */
export function EstimateStep() {
  return <StepPlaceholder step="estimate" ticket="#279" />;
}
