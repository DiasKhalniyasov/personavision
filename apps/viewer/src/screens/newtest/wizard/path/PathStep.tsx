import { StepPlaceholder } from '../StepPlaceholder';

/** `/new?step=path` — #271 builds this step. */
export function PathStep() {
  return <StepPlaceholder step="path" ticket="#271" />;
}
