import { Link, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { paths } from './paths';

/**
 * A URL this product has no screen for. It names the path that was asked for and offers the
 * way back, rather than leaving a blank page or throwing.
 */
export function NotFoundRoute() {
  const { pathname } = useLocation();

  return (
    <div className="strip">
      <div className="wrap">
        <div className="empty">
          <h2>There is no page here</h2>
          <p>
            PersonaVision has no screen at <span className="mono">{pathname}</span>.
          </p>
          <div className="actions">
            <Button asChild>
              <Link to={paths.home}>Open the most recent test</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
