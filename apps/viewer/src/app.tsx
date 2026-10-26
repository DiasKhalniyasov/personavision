import { RouterProvider } from 'react-router';
import type { createBrowserRouter } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MotionProvider } from './shell/motion';

/**
 * The application: motion, tooltips and the route table.
 *
 * `MotionProvider` is mounted **above the router**, so that reduced motion is honoured on
 * every screen at once rather than screen by screen, and `TooltipProvider` is above it for
 * the same reason — a primitive deeper in the tree needs neither.
 *
 * The router is passed in rather than built here: `mount` gives it a browser router, and a
 * test gives it a memory router starting on the route under test.
 */
export function App({ router }: { router: ReturnType<typeof createBrowserRouter> }) {
  return (
    <MotionProvider>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </MotionProvider>
  );
}
