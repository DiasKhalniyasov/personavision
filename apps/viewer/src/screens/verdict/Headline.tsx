import type { Run } from '@personavision/contract';
import './verdict.css';

/**
 * The one headline sentence naming the version the audience completes, in the user's words: the `.hero` of `#screen-verdict`.
 *
 * `verdict.audienceSentence`, rendered verbatim at display size. It is **not assembled
 * here** from the scores: the pipeline wrote it (`docs/FLOW.md` section 5), so the same
 * words appear on the Verdict screen, on the landing page and in the demo. Under it the
 * task that was tested, so the figures below have a verb attached.
 *
 * A run with no sentence is a contract violation rather than a run to paper over: the
 * screen says the verdict is missing and invents nothing. The figures are a sibling
 * section and still render, because they are the run's own.
 *
 * The four sections of this ticket share one stylesheet, `./verdict.css`, and each of them
 * imports it: the screen's own folder holds its layout rather than the app entry, so a
 * screen ticket adds no import to `src/main.tsx`, and a section rendered on its own — by
 * #125's reveal or #124's public demo — still brings its own styling.
 */
export function Headline({ run }: { run: Run }) {
  const sentence = run.verdict.audienceSentence.trim();

  return (
    <div className="hero" data-section="headline">
      <h1 className={sentence === '' ? 'hero-missing' : undefined}>
        {sentence === '' ? 'This test is missing its verdict sentence.' : sentence}
      </h1>
      {sentence === '' ? (
        <p className="sub">
          The sentence is the pipeline&rsquo;s to write and this run carries none, so nothing has
          been written in its place. The figures below are still the run&rsquo;s own.
        </p>
      ) : null}
      <p className="sub">
        Task tested: &ldquo;{run.task.prompt}&rdquo; Same audience, same people, both versions.
      </p>
    </div>
  );
}
