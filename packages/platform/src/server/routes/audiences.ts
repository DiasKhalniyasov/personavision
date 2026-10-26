import { notImplemented } from './types.js';
import type { Route } from './types.js';

/**
 * Audience storage: the workspace's audiences, and the people each would generate.
 *
 * #102 fills these in over `AudienceStore`. The two `GET`s are `jsonOnly`, because
 * `/audiences` and `/audiences/:audienceId` are also the app's own screens
 * (`docs/FLOW.md` section 3) and a browser navigating to one wants the screen.
 */

const TICKET = 102;

export const audienceRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/audiences$/,
    jsonOnly: true,
    handle: notImplemented(TICKET, 'Listing the workspace’s audiences'),
  },
  { method: 'POST', path: /^\/audiences$/, handle: notImplemented(TICKET, 'Saving an audience') },
  {
    method: 'GET',
    path: /^\/audiences\/([^/]+)$/,
    jsonOnly: true,
    handle: notImplemented(TICKET, 'Reading an audience'),
  },
  {
    method: 'PATCH',
    path: /^\/audiences\/([^/]+)$/,
    handle: notImplemented(TICKET, 'Editing an audience'),
  },
];
