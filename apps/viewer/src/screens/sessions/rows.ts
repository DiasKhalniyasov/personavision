import type { Run, Session } from '@personavision/contract';
import type { SessionRow } from '@/session';

/**
 * How one person is put on screen by the two Sessions views — the row of `#screen-sessions`
 * and the tile of `#screen-grid`. Nothing here computes a reading: the outcome, the
 * attribution, the duration, the fixation count and `excludedFromScores` all arrive from
 * the session module exactly as the pipeline wrote them, and these are the rules for
 * putting them on screen.
 */

/**
 * The chip class carrying a vocabulary token's colour.
 *
 * `src/styles/base.css` publishes one class per outcome, attribution and version, each
 * declaring nothing but the matching `--outcome-*`, `--attr-*` or `--variant-*` pair. The
 * class is therefore derived from the token name the vocabulary hands over rather than
 * from a second list of four statuses here — an automation failure borrows the attribution
 * token, and `tag-automation` is the class that carries it, with no special case.
 */
export function tagClass(token: string): string {
  return `tag-${token.replace(/^--(?:outcome|attr|variant)-/, '')}`;
}

/**
 * Version A and version B keep one identity everywhere the two appear.
 *
 * Those two are the only versions the tokens carry a colour for, and a version id is any
 * name in the contract, so a third reads as information rather than as a chip with no
 * colour at all — the same fallback the Verdict's findings use.
 */
const COLOURED_VARIANTS = ['a', 'b'];

export function variantTagClass(variant: string): string {
  const word = variant.toLowerCase();
  return COLOURED_VARIANTS.includes(word) ? tagClass(`--variant-${word}`) : 'tag-info';
}

/** Seconds to one decimal, as every duration in the product reads. */
export function durationSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)} s`;
}

/**
 * Where the session ended, and why, in one line.
 *
 * The step is the run's own label for it, and the reason is the pipeline's sentence. That
 * sentence already opens with the step on every session that ended somewhere it did not
 * mean to — "Payment — selector timeout on the card iframe" — so the step is not printed
 * twice; a session that ended where it was meant to reads "Confirmation — Order placed".
 * A step the run never planned has no label, and then its id is the best name there is.
 */
export function whereItEnded(endedOn: SessionRow['endedOn'], reason: string): string {
  const step = endedOn.label ?? endedOn.step;
  // The step's own name, not merely its letters: "Reviewed the fees and left" opens with
  // "Review" without naming the Review step, and dropping the step there would leave the
  // one column headed "Where it ended" not saying where.
  const names = reason === step || reason.startsWith(`${step} `);
  return names ? reason : `${step} — ${reason}`;
}

/**
 * Who the tile is about: `Rushed buyer, 29`, as `#screen-grid`'s `.meta` prints it.
 *
 * The age is the persona's own `profile.age` and is **optional with no default** in the
 * contract, so a person generated before profiles existed is a person with no stated age
 * rather than one aged nothing: the clause is simply absent, and the tile still names them.
 * A real participant has no persona at all and reads by their participant id, the same
 * fallback the row's Persona column uses.
 */
export function personLine(run: Run, row: SessionRow): string {
  const named = row.personaName ?? row.participantId ?? 'Unnamed';
  const persona = run.personas.find((candidate) => candidate.id === row.personaId);
  const age = persona?.profile?.age;
  return age === undefined ? named : `${named}, ${age}`;
}

/** `phone · first time`: the device this ran on and the segment they came from. */
export function deviceAndSegment(row: SessionRow): string {
  return [row.deviceName, row.segment].filter((part) => part !== null).join(' · ');
}

/** Where one fixation sits in the frame, as a percentage of it. */
export interface GazePoint {
  readonly xPct: number;
  readonly yPct: number;
}

/**
 * The frame a tile shows, and where the person was looking in it.
 *
 * **Which frame.** The last screen the recording reaches — `screenOffsetsMs`' last entry
 * that is not `null`, which is the whole list on a recording that was not truncated. That
 * is the screen the attempt ended on, and it is what makes a wall of a hundred tiles worth
 * scanning: the tile shows where this person got to, so the ones worth watching are the
 * ones that got stuck somewhere interesting. The alternative — the first frame — is a
 * hundred pictures of the same landing page.
 *
 * **Where the gaze mark goes.** The first fixation recorded on that screen. A screen
 * carries no timestamp of its own and *begins* at its first fixation, which is the one
 * clock the replay reads too (`src/session/timeline.ts`), so the offset this returns and
 * that fixation are the same moment of the session: the mark is where the session says
 * they were looking in the frame the tile is showing, not an interpolation between two
 * things it recorded.
 *
 * `null` when there is no recording to take a frame from. A fixation-less screen has no
 * gaze to mark, and then the frame is shown with nothing drawn on it rather than with a
 * mark in the middle of nowhere — and a session imported from a real participant carries
 * no persona, so there is no viewport to place a fixation in either.
 */
export interface PosterFrame {
  /** Where in the recording the frame is, in milliseconds from its start. */
  readonly offsetMs: number;
  /** The screen that frame is of, as an index into the session's own `screens`. */
  readonly screenIndex: number;
  readonly gaze: GazePoint | null;
}

export function posterFrame(session: Session): PosterFrame | null {
  const video = session.video;
  if (video === undefined || video.state !== 'recorded') return null;

  // The offsets are positional — `screenOffsetsMs[i]` is where `screens[i]` begins — and
  // only a truncated recording has `null`s, for the screens it stopped before.
  let screenIndex = -1;
  video.screenOffsetsMs.forEach((offsetMs, index) => {
    if (offsetMs !== null) screenIndex = index;
  });
  // A recording whose every screen is past the cap, which the contract allows only for a
  // truncated one: the frame is then the start of the recording, which is a frame it has.
  if (screenIndex < 0) return { offsetMs: 0, screenIndex: 0, gaze: null };

  const offsetMs = video.screenOffsetsMs[screenIndex] as number;
  const fixation = session.fixations.find((candidate) => candidate.screenIndex === screenIndex);
  const viewport = session.persona?.device.viewport;
  const gaze =
    fixation === undefined || viewport === undefined
      ? null
      : { xPct: (fixation.x / viewport.width) * 100, yPct: (fixation.y / viewport.height) * 100 };

  return { offsetMs, screenIndex, gaze };
}

/**
 * The recording's own shape, as a CSS `aspect-ratio`, so the tile is the device's screen
 * and not a letterbox around it.
 *
 * A session video is recorded at the device's own aspect scaled into 720p, which is the
 * owner's decision on the recorder: a phone's recording is tall and a desktop's is wide,
 * and a thumbnail of a phone session fitted into a landscape tile would be a thin strip of
 * product between two bars. So the tile takes the viewport's shape, and the gaze mark above
 * is then a plain percentage of the frame.
 *
 * `null` for a session with no persona to read a viewport from; the tile keeps the
 * prototype's own landscape shape, which is also what a tile still being read reserves.
 */
export function frameAspect(session: Session): string | null {
  const viewport = session.persona?.device.viewport;
  return viewport === undefined ? null : `${viewport.width} / ${viewport.height}`;
}

/**
 * The media fragment a `<video>` is asked to show one frame of: `videos/S-01.webm#t=12.4`.
 *
 * It is how a browser is told *which* frame without a line of script and without playing
 * anything — the element loads metadata, seeks to that second over a byte range and paints
 * it. Seconds, as the fragment spells them and as the contract's `t` means them; the
 * offsets themselves are milliseconds.
 */
export function posterSrc(base: string, path: string, offsetMs: number): string {
  return `${base}${path}#t=${(offsetMs / 1000).toFixed(3).replace(/\.?0+$/, '')}`;
}
