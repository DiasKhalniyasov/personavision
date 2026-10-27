/**
 * The conversion (#86): a UEyes record in, sessions `packages/contract`'s own schema accepts
 * out, with `kind: "real"`, a participant and no persona.
 *
 * It is what makes calibration a comparison of two files of the same shape — a human's free
 * viewing beside a simulated session — and the one place the dataset's vocabulary meets the
 * artifact's. `../docs/conversion.md` states every decision it makes and why.
 */

export { ConversionError, convertRecord, convertRecords } from './session.js';
export type {
  ConversionRejection,
  ConversionReport,
  ConvertOptions,
  ConvertedSession,
  RawDisplay,
  RawFixation,
  RawImage,
  RawRecord,
  RawScanpath,
} from './session.js';
