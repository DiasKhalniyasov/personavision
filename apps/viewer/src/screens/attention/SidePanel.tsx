import type { ReactNode } from 'react';
import styles from './attentionPage.module.css';

/**
 * The column beside the page, and one panel in it — the prototype's `.sidepanel` and
 * `.panel`.
 *
 * It is the scaffold's, not any one panel's, because three tickets of this step put a panel
 * in this column: the Overlays panel (#58), the "This step" readings and the "Reading this"
 * note. One wrapper means they stack on the same rhythm and are bordered the same way
 * without any of them knowing about the others.
 */

export function SideColumn({ children }: { children: ReactNode }) {
  return <div className={styles.sidepanel}>{children}</div>;
}

/**
 * One panel: its title and whatever it holds.
 *
 * The title is an `h2`. The prototype sets it in `h3`, but on the built screen these are
 * the first headings under the page's own `h1` and a reader moving through the page by
 * heading should not be asked to step over a level that is not there. The type role is the
 * prototype's either way; `attentionPage.module.css` carries it.
 */
export function SidePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.panel}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
