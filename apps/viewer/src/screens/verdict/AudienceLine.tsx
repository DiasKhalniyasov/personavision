import { Link } from 'react-router';
import type { Audience, Run } from '@personavision/contract';
import { Button } from '@/components/ui/button';
import { paths } from '@/shell/paths';
import './verdict.css';

/**
 * The audience the result is about, and the people it generated: the `.audbar` of `#screen-verdict`.
 *
 * It is above the answer because the answer is only true of these people, and saying so is
 * what stops the figures below being read as a conversion-lift estimate (`docs/FLOW.md`
 * sections 1 and 5). The audience is the run's **frozen copy** — `run.audience`, written
 * when the test started — so editing an audience afterwards cannot restate an old result.
 *
 * Four things are said, in this order: who they are, what they are like in one phrase, how
 * many people were generated from them and with which seed, and the way back to the
 * audience itself.
 */

/** The audience's own words for the two 0..1 dials, which the artifact stores as numbers. */
const PRICE_WORDS = {
  high: 'price-aware',
  middle: 'moderately price-aware',
  low: 'price-insensitive',
};

/**
 * Where a dial stops being the middle. The two bounds are the wording's, not the product's:
 * no figure is banded by them and nothing in `docs/design/tokens.css` declares them, so
 * they live beside the words they choose rather than pretending to be a threshold.
 */
const HIGH = 0.6;
const LOW = 0.4;

/** `25–45`, the span the personas' ages were drawn from. */
const ages = ({ min, max }: Audience['ageRange']): string => `${min}–${max}`;

/**
 * `mostly mobile` when the mix leans one way, `desktop` when there is only one device, and
 * both names when the shares are level — the mix is a distribution, so the phrase says
 * which way it leans rather than naming the first device in the list.
 */
function deviceLean(devices: Audience['devices']): string {
  const names = devices.map((device) => device.name);
  if (names.length === 1) return names[0] as string;

  const top = Math.max(...devices.map((device) => device.share));
  const leading = devices.filter((device) => device.share === top).map((device) => device.name);
  return leading.length === 1 ? `mostly ${leading[0] as string}` : leading.join(' and ');
}

/** `United Kingdom & Ireland`, as the prototype writes a list of places. */
function places(regions: readonly string[]): string {
  if (regions.length < 2) return regions.join('');
  return `${regions.slice(0, -1).join(', ')} & ${regions[regions.length - 1] as string}`;
}

/** How much price matters to them, in the three words the audience screens use. */
function priceWords(priceSensitivity: number): string {
  if (priceSensitivity >= HIGH) return PRICE_WORDS.high;
  if (priceSensitivity <= LOW) return PRICE_WORDS.low;
  return PRICE_WORDS.middle;
}

/**
 * The audience in one phrase: `25–45 · mostly mobile · price-aware · United Kingdom & Ireland`.
 *
 * The artifact stores no such phrase, so it is composed from the audience's own fields —
 * age range, device lean, how price-aware, regions. Nothing about the *result* is composed
 * here: the sentence, the figures and the reasons are all read as the pipeline wrote them.
 */
export function audienceSummary(audience: Audience): string {
  return [
    ages(audience.ageRange),
    deviceLean(audience.devices),
    priceWords(audience.priceSensitivity),
    places(audience.regions),
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

/** `24 simulated people, generated from this audience with seed 20261024`. */
export function generatedFrom(audience: Audience): string {
  const people = audience.size === 1 ? '1 simulated person' : `${audience.size} simulated people`;
  return `${people}, generated from this audience with seed ${audience.generatedFrom.seed}`;
}

export function AudienceLine({ run }: { run: Run }) {
  const { audience } = run;
  const audiencePath = paths.audience(audience.id);

  return (
    <div className="audbar" data-section="audience-line">
      <Link className="who" to={audiencePath}>
        <i aria-hidden="true" />
        {audience.name}
      </Link>
      <span>{audienceSummary(audience)}</span>
      <span className="faint">{generatedFrom(audience)}</span>
      <span className="grow" />
      <Button variant="ghost" size="sm" asChild>
        <Link to={audiencePath}>Change audience</Link>
      </Button>
    </div>
  );
}
