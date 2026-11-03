import { ScreenPlaceholder } from '@/shell/ScreenPlaceholder';

/**
 * `/signup` — create a workspace with an email and a password.
 *
 * Public, outside the product chrome, like `/signin`: there is no workspace to name yet.
 * `#screen-signup` of `docs/design/prototype.html` is the screen and **#265** builds it,
 * against the platform route of that ticket.
 */
export function SignUpPage() {
  return <ScreenPlaceholder screen="Sign up" ticket="#265" />;
}
