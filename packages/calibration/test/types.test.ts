import { describe, expect, it } from 'vitest';
import * as entryPoint from '../src/index.js';
import {
  RECORD_CATEGORIES,
  VIEWING_DURATIONS_SECONDS,
  type ImageSize,
  type Predictor,
  type SaliencyMap,
} from '../src/types.js';

/**
 * A value shaped exactly as the engine's `predict` is documented to return (#68): the
 * saliency map, the scanpath, and the display it assumed for a bare image.
 *
 * Declared here with **no import of `packages/engine`**, which is what this package is held
 * to. So it pins **this** side of the seam — the shape #68 has to produce — and not the
 * engine's: `predict` does not exist yet, and when it does this fixture will not see it.
 * #68 is asked on its own issue to assign its real `predict` to `Predictor`, where the
 * function lives.
 */
const predict = (image: { readonly bytes: Uint8Array; readonly size: ImageSize }, seed: number) => {
  const width = 4;
  const height = 2;
  // A map that sums to one, as this package's maps are normalised (`sum-to-one`).
  const values = Array.from({ length: width * height }, (_, cell) => (cell === 1 ? 0.72 : 0.04));

  return {
    saliencyMap: {
      width,
      height,
      values,
      imageSize: image.size,
      normalisation: 'sum-to-one' as const,
    },
    scanpath: {
      participantId: null,
      fixations: [
        { index: 0, tMs: 0, durationMs: 240, x: image.size.width / 2, y: 120 },
        { index: 1, tMs: 240, durationMs: 180, x: 40 + (seed % 7), y: 60 },
      ],
    },
    display: { viewport: { width: image.size.width, height: 900 }, scale: 1 },
  };
};

/** The assignment is the assertion: the documented return shape satisfies the seam. */
const seam: Predictor = predict;

const imageOf = (size: ImageSize): Parameters<Predictor>[0] => ({
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  size,
  display: { viewport: { width: size.width, height: size.height }, scale: 2 },
});

describe('the Predictor seam', () => {
  it('accepts a value shaped as the engine’s documented predict return, with no engine import', async () => {
    const prediction = await seam(imageOf({ width: 1280, height: 1024 }), 7);

    expect(prediction.saliencyMap.normalisation).toBe('sum-to-one');
    expect(prediction.scanpath.fixations).toHaveLength(2);
    // A predicted scanpath belongs to no participant; a human one names theirs (#84).
    expect(prediction.scanpath.participantId).toBeNull();
    // The engine records the display it assumed for a bare image; the seam carries it.
    expect(prediction.display?.viewport.width).toBe(1280);
  });

  it('takes a seed, so the same image twice gives the same prediction', async () => {
    const image = imageOf({ width: 800, height: 600 });
    const [first, second] = await Promise.all([seam(image, 42), seam(image, 42)]);

    expect(second).toEqual(first);
    expect((await seam(image, 43)).scanpath.fixations[1]!.x).not.toBe(
      first.scanpath.fixations[1]!.x,
    );
  });

  it('reports a map whose cells are finite, non-negative and as many as its resolution', async () => {
    const { saliencyMap } = await seam(imageOf({ width: 400, height: 300 }), 1);
    const total = saliencyMap.values.reduce((sum, value) => sum + value, 0);

    expect(saliencyMap.values).toHaveLength(saliencyMap.width * saliencyMap.height);
    expect(saliencyMap.values.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(total).toBeCloseTo(1, 10);
  });

  it('states the image a map describes, so a comparison can say what it compared', async () => {
    const { saliencyMap } = await seam(imageOf({ width: 400, height: 300 }), 1);

    expect(saliencyMap.imageSize).toEqual({ width: 400, height: 300 });
    // The map is coarser than the image and the convention is row-major in image space:
    // the cell a pixel falls in is derived from both sizes, never assumed.
    const cellOf = (x: number, y: number, map: SaliencyMap): number =>
      Math.floor((y * map.height) / map.imageSize.height) * map.width +
      Math.floor((x * map.width) / map.imageSize.width);
    expect(cellOf(0, 0, saliencyMap)).toBe(0);
    expect(cellOf(399, 299, saliencyMap)).toBe(saliencyMap.values.length - 1);
  });
});

describe('the vocabulary', () => {
  it('lists the four UI categories with the webpage first, which is what this product is for', () => {
    expect(RECORD_CATEGORIES).toEqual(['webpage', 'desktop', 'mobile', 'poster']);
  });

  it('lists the viewing durations UEyes publishes its ground truth at', () => {
    expect(VIEWING_DURATIONS_SECONDS).toEqual([1, 3, 7]);
  });
});

describe('the public entry point', () => {
  it('exports the types, the corpus loader, the metrics, the manifest loader, the cache-path helpers, the download, the conversion, the scoring and the fit, and nothing else', () => {
    // The types carry no runtime binding, so this is the whole runtime surface. A later
    // ticket of step #11 adds its own exports here deliberately rather than by accident.
    expect(Object.keys(entryPoint).sort()).toEqual([
      'BASELINE_SCANPATH',
      'BaselineError',
      'CACHE_ENV_VAR',
      'CALIBRATED_SCHEMA_VERSION',
      'CENTRE_BIAS_PREDICTOR_ID',
      'CENTRE_BIAS_PRIOR',
      'COMMITTED_CORPUS_ID',
      'COMMITTED_MANIFEST_PATH',
      'CORPUS_RECORD_NAMES',
      'CachePathError',
      'ConversionError',
      'CorpusError',
      'DEFAULT_CHECKSUM_ALGORITHM',
      'DatasetFetchError',
      'ENGINE_PREDICTOR_ID',
      'FIT_DEFAULTS',
      'FitError',
      'MANIFEST_SCHEMA_VERSION',
      'MAP_RENDERING',
      'ManifestError',
      'OBJECTIVE',
      'RANDOM_FIXATION_PREDICTOR_ID',
      'RANDOM_FIXATION_UNIFORMITY',
      'RECORD_CATEGORIES',
      'SALIENCY_METRICS',
      'SALIENCY_METRIC_IDS',
      'SALIENCY_METRIC_PARAMETERS',
      'SCANPATH_CHANCE',
      'SCANPATH_METRICS',
      'SCANPATH_METRIC_IDS',
      'SCANPATH_METRIC_PARAMETERS',
      'SCANPATH_REGION_COUNT',
      'SCORING_BUDGET',
      'SEARCH_COST',
      'SEARCH_KIND',
      'SEARCH_SPACE',
      'SaliencyMetricError',
      'ScanpathMetricError',
      'ScoreError',
      'VIEWING_DURATIONS_SECONDS',
      'VerificationError',
      'aucJudd',
      'cacheRoot',
      'calibratedRecordOf',
      'cc',
      'centreBiasBaseline',
      'centreBiasPeakCell',
      'centreBiasPredictor',
      'centreBiasPrior',
      'committedCorpus',
      'comparableFigures',
      'comparableFit',
      'convertRecord',
      'convertRecords',
      'datasetCachePaths',
      'defaultAt',
      'defaultBaselines',
      'describeChecksum',
      'enginePredictor',
      'fetchDataset',
      'fit',
      'gridCandidates',
      'hashFile',
      'isContainedRelativePath',
      'isDatasetId',
      'kld',
      'loadCorpus',
      'loadCorpusCategory',
      'loadCorpusRecord',
      'loadManifest',
      'mapResolution',
      'needlemanWunsch',
      'nss',
      'objectiveOf',
      'parseManifest',
      'poolFixations',
      'randomFixationBaseline',
      'randomFixationPredictor',
      'recordedChecksum',
      'regionOfFixation',
      'renderSaliencyMap',
      'resampleSaliencyMap',
      'saliencyMetric',
      'sampleDurationMs',
      'scanMatch',
      'scanMatchLetters',
      'scanMatchSubstitutionMatrix',
      'scanpathMetric',
      'scanpathOf',
      'score',
      'scoreSaliency',
      'scoreScanpath',
      'scoreScanpathAgainstHumans',
      'sequenceScore',
      'unverifiedFiles',
      'verifyFile',
      'visitedRegions',
    ]);
  });
});
