/**
 * `@personavision/browser` — browser driving.
 *
 * Opens a variant under an emulated device, walks the task's steps, captures each screen
 * with its geometry and the fold, extracts the areas of interest a session can look at, and
 * executes the actions an agent decides — reporting every failure of its own as a typed
 * automation failure rather than as a failure of the product.
 *
 * This file is the package's whole public surface, each seam's signature included as a
 * named type. Nine tickets of the browser-driving step fill one function each behind it;
 * none of them changes a name here.
 */

export { openSession, closeSession, readSessionState } from './session.js';
export type { OpenSessionOptions, SessionState } from './session.js';

export { readGeometry, isBelowFold } from './geometry.js';

export { capture, captureCacheKey, readContentHash } from './capture.js';
export type { CaptureCacheKeyParts } from './capture.js';

export { extractElements } from './extract/elements.js';
export type { ExtractElements } from './extract/elements.js';
export { stableElementId } from './extract/stable-id.js';
export type { StableElementIdParts } from './extract/stable-id.js';

export { writeScreenshot } from './screenshot.js';
export type { ScreenshotTarget, WriteScreenshot } from './screenshot.js';

export { toAoiEntries, toScreenshotEntries } from './run-projection.js';
export type { ToAoiEntries, ToScreenshotEntries } from './run-projection.js';

export { detectStep, resolvePrimaryAction, taskStep } from './steps.js';
export type { DetectStep, ResolvePrimaryAction } from './steps.js';

export { act } from './act.js';
export type { Act, ActOptions } from './act.js';

export { DEFAULT_SESSION_BUDGET, SessionBudget } from './budget.js';
export type { BudgetIntegrity, SessionBudgetLimits, SessionIntegrity } from './budget.js';

export {
  UNKNOWN_STEP,
  frameFailure,
  mapToAutomationFailure,
  navigationFailure,
  toAutomationFailure,
  toAutomationFailureOutcome,
  watchFrameFailures,
} from './failure-mapping.js';
export type {
  AutomationFailureOutcome,
  FailedFrameRequest,
  FrameFailureWatch,
  MapToAutomationFailure,
  NavigationResponse,
  ToAutomationFailure,
} from './failure-mapping.js';

export { withCache } from './cache.js';
export type { CaptureCacheOptions } from './cache.js';

export { createFixtureSource } from './fixture-source.js';
export type { CreateFixtureSource } from './fixture-source.js';

export { createLiveSource, walkTask } from './live-source.js';
export type {
  DecideAction,
  TaskWalk,
  TaskWalkResult,
  WalkScreen,
  WalkTask,
} from './live-source.js';

export { AutomationFailure, NotImplementedError } from './errors.js';

export type {
  ActResult,
  Action,
  AutomationFailureReason,
  Box,
  Capture,
  CaptureContext,
  CaptureElement,
  CaptureSource,
  Device,
  Geometry,
  PageHandle,
  TaskDefinition,
  TaskStep,
  Variant,
  Viewport,
} from './types.js';
