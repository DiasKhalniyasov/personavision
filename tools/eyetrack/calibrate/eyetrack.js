/**
 * The page: the camera, the nine calibration points, the accuracy check that gates
 * recording, the screenshots one at a time, and the one file at the end.
 *
 * The arithmetic is next door in `fixations.js`, which has no DOM and is checked by
 * `packages/calibration/test/eyetrack-sample.test.ts`. This file is the instrument around it.
 *
 * **It makes no network request.** That test also scans these bytes for every networking
 * entry point a browser offers and requires that not one of them is so much as named here —
 * which is why this comment does not spell them either. The screenshots are read with a
 * `FileReader` from the participant's own disk, and the recording leaves the tab only through
 * a download the participant starts.
 *
 * **Three things protect the data, and each one is a deliberate fight with the library.**
 *
 * 1. WebGazer trains itself on every mouse click and mouse movement by default, so merely
 *    pressing *Start recording* would teach it that the participant was looking at a button.
 *    Its listeners are removed the moment it starts, and the only training is the nine
 *    points, recorded explicitly.
 * 2. WebGazer keeps its fitted model in `localStorage` and loads it on `begin()`, so the
 *    previous participant's calibration would silently become this one's. It is cleared
 *    first, every time.
 * 3. Nothing is on the display during a recording except the screenshot — no video preview,
 *    no face overlay, no gaze dot. Each of those is a bright moving thing, and a bright
 *    moving thing is where the eye goes.
 */
(function (window, document) {
  'use strict';

  const core = window.eyetrackFixations;

  /** Where WebGazer 1.x keeps its fitted model between visits. */
  const WEBGAZER_STORAGE_KEY = 'webgazerGlobalData';

  /** The nine calibration points, as fractions of the viewport in each axis. */
  const CALIBRATION_FRACTIONS = [0.1, 0.5, 0.9];

  /** How many times the participant clicks each point while looking at it. */
  const CLICKS_PER_POINT = 5;

  /** How long the participant stares at the accuracy target. */
  const CHECK_MS = 5000;

  /**
   * The fewest gaze estimates the accuracy check must produce before recording is allowed.
   *
   * It is a floor on the tracker *working*, not on it being good: WebGazer predicts at
   * roughly 25 Hz, so five seconds of a tracked face gives well over a hundred. Fifteen means
   * the face was found. The measured error is reported and recorded whatever it is — refusing
   * a recording for being inaccurate would be this tool deciding what counts as data, and
   * reporting the figure is the honest half of that.
   */
  const MIN_CHECK_SAMPLES = 15;

  /** Above this mean error the check says so plainly. Still recordable; still recorded. */
  const POOR_ERROR_PX = 250;

  /** The centre cross between screenshots, so every recording starts from the same place. */
  const CROSS_MS = 1000;

  /** How much of the viewport a screenshot may fill, leaving a mat around it. */
  const STAGE_FILL = 0.9;

  const el = function (id) {
    return document.getElementById(id);
  };

  const nodes = {
    steps: {
      setup: el('step-setup'),
      camera: el('step-camera'),
      calibrate: el('step-calibrate'),
      accuracy: el('step-accuracy'),
      record: el('step-record'),
      save: el('step-save'),
      broken: el('step-broken'),
    },
    participant: el('participant'),
    shots: el('shots'),
    category: el('category'),
    exposure: el('exposure'),
    toCamera: el('to-camera'),
    setupStatus: el('setup-status'),
    toCalibration: el('to-calibration'),
    cameraStatus: el('camera-status'),
    calibrateSummary: el('calibrate-summary'),
    startCalibration: el('start-calibration'),
    calibrateStatus: el('calibrate-status'),
    accuracyFigures: el('accuracy-figures'),
    accuracyNote: el('accuracy-note'),
    toRecord: el('to-record'),
    recalibrate: el('recalibrate'),
    recordStatus: el('record-status'),
    saveRows: el('save-rows'),
    saveStatus: el('save-status'),
    save: el('save'),
    brokenReason: el('broken-reason'),
    overlay: el('overlay'),
    overlayInstruction: el('overlay-instruction'),
    targets: el('targets'),
    stage: el('stage'),
    cross: el('cross'),
    shot: el('shot'),
  };

  const state = {
    participantId: '',
    category: 'webpage',
    viewingDurationSeconds: 3,
    /** `{ id, name, src, image }` per chosen screenshot, in the order they were chosen. */
    shots: [],
    calibrated: false,
    /** What the accuracy check measured, or null while it has not run. */
    check: null,
    records: [],
    /** The live gaze sink. Set while checking or recording, null the rest of the time. */
    sink: null,
    file: null,
  };

  // ---------------------------------------------------------------- page plumbing

  const show = function (name) {
    Object.keys(nodes.steps).forEach(function (key) {
      nodes.steps[key].hidden = key !== name;
    });
  };

  const say = function (node, text, tone) {
    node.textContent = text;
    node.className = tone ? 'status ' + tone : 'status';
  };

  const fail = function (reason) {
    show('broken');
    nodes.brokenReason.textContent = reason;
  };

  const wait = function (ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  };

  /**
   * Resolve once the browser has put a frame on the screen.
   *
   * Two frames, because the first callback runs *before* the paint it belongs to. It is what
   * the recording clock waits for: start it when `src` is assigned and the first sample or two
   * are gaze over a stage the screenshot had not reached yet, which is a measurement of the
   * wrong thing.
   */
  const painted = function () {
    return new Promise(function (resolve) {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(resolve);
      });
    });
  };

  // ------------------------------------------------------------------- statistics

  const quantile = function (sorted, fraction) {
    const position = (sorted.length - 1) * fraction;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  };

  const round1 = function (value) {
    return Math.round(value * 10) / 10;
  };

  // --------------------------------------------------------------------- the gaze

  /**
   * Every gaze estimate goes here. `state.sink` is what is currently collecting, which is
   * nothing at all unless an accuracy check or a recording is running — so a stray estimate
   * between the two is never counted against either.
   */
  const onGaze = function (data) {
    if (data === null || data === undefined) return;
    if (state.sink === null) return;
    state.sink(data.x, data.y, window.performance.now());
  };

  /**
   * Give WebGazer a `localStorage` it cannot throw on.
   *
   * It reads and writes `window.localStorage` unguarded, and on some browsers merely touching
   * that property from a `file://` URL throws — which would turn `begin()` into an exception
   * and this page into a blank one. Where that happens it gets an in-memory stand-in instead,
   * which is all it ever needed: this tool deliberately keeps nothing between visits.
   */
  const ensureStorage = function () {
    try {
      window.localStorage.getItem(WEBGAZER_STORAGE_KEY);
      return;
    } catch {
      // No usable storage. Fall through and substitute one.
    }
    let store = {};
    try {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          getItem: function (key) {
            return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
          },
          setItem: function (key, value) {
            store[key] = String(value);
          },
          removeItem: function (key) {
            delete store[key];
          },
          clear: function () {
            store = {};
          },
        },
      });
    } catch {
      // Nothing further to try; `begin()` may still throw, and `onStart` reports it.
    }
  };

  /** Forget any model a previous participant left behind. */
  const clearStoredModel = function () {
    try {
      window.localStorage.removeItem(WEBGAZER_STORAGE_KEY);
    } catch {
      // Nothing stored means nothing stale.
    }
  };

  /**
   * What the participant can see of the tracker itself.
   *
   * `chrome` is WebGazer's camera preview, its face mesh and its face box: the things that
   * tell somebody they are being tracked and let them sit square to the camera. They are
   * shown while positioning and calibrating, and gone for the accuracy check and the
   * recording, where the only thing on the display should be the thing being looked at.
   *
   * **The prediction dot is never shown.** It looks like the tool working, and it is the one
   * mark on the display guaranteed to sit near where the eye already is — so a participant
   * who glances at it is chasing their own gaze. During calibration that poisons the pair
   * being trained; during the accuracy check it flatters the very figure the check exists to
   * measure. The figure afterwards is the honest feedback that it worked.
   */
  const setTrackerChrome = function (chrome) {
    window.webgazer.showVideo(chrome);
    window.webgazer.showFaceOverlay(chrome);
    window.webgazer.showFaceFeedbackBox(chrome);
    window.webgazer.showPredictionPoints(false);
  };

  /**
   * Start the camera and the tracker.
   *
   * The `alert` WebGazer 1.x fires on any origin that is not `https:` or `localhost` is
   * swallowed, because on a `file://` URL it is simply wrong: a browser treats `file:` as a
   * secure context and hands over the camera. What is *not* swallowed is the real rule, which
   * `onStart` checks itself and states in the page — an ordinary `http://` host has no camera
   * to offer, whatever this library thinks.
   */
  const beginTracking = function () {
    const realAlert = window.alert;
    window.alert = function () {};
    try {
      window.webgazer
        .setRegression('ridge')
        .setTracker('clmtrackr')
        .setGazeListener(onGaze)
        .begin(function () {
          say(
            nodes.cameraStatus,
            'The camera did not start. Allow it in the browser, and close any other tab using it.',
            'bad',
          );
        });
    } finally {
      window.alert = realAlert;
    }

    // WebGazer adds mouse listeners that train the model on every click and movement. The
    // only training this tool allows is the nine points, recorded by hand.
    window.webgazer.removeMouseEventListeners();
    setTrackerChrome(true);
  };

  /** Stop predicting and let go of the camera: the light goes out when it is no longer needed. */
  const stopTracking = function () {
    try {
      window.webgazer.pause();
      window.webgazer.stopVideo();
    } catch {
      // The recording is already built; failing to release the camera must not lose it.
    }
  };

  // ------------------------------------------------------------------------ setup

  const fillChoices = function () {
    const labels = {
      webpage: 'A web page',
      mobile: 'A mobile UI',
      desktop: 'A desktop UI',
      poster: 'A poster',
    };
    core.CATEGORIES.forEach(function (category) {
      const option = document.createElement('option');
      option.value = category;
      option.textContent = labels[category] + ' (' + category + ')';
      nodes.category.appendChild(option);
    });

    core.VIEWING_DURATIONS_SECONDS.forEach(function (seconds) {
      const option = document.createElement('option');
      option.value = String(seconds);
      option.textContent = seconds + (seconds === 1 ? ' second' : ' seconds');
      if (seconds === 3) option.selected = true;
      nodes.exposure.appendChild(option);
    });
  };

  /** Load one chosen file into an `Image`, so its own pixel size is known before it is shown. */
  const loadShot = function (file, takenIds) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onerror = function () {
        reject(new Error('could not be read'));
      };
      reader.onload = function () {
        const image = new window.Image();
        image.onerror = function () {
          reject(new Error('is not an image this browser can show'));
        };
        image.onload = function () {
          if (image.naturalWidth < 1 || image.naturalHeight < 1) {
            reject(new Error('has no pixels'));
            return;
          }
          // The record's id is the name without its extension, as `packages/calibration`
          // spells it. Two files can share one, and two records under one id are two
          // recordings nobody can tell apart, so a repeat is suffixed rather than merged.
          const base = file.name.replace(/\.[^.]+$/, '');
          let id = base;
          let suffix = 2;
          while (takenIds[id] === true) {
            id = base + '-' + suffix;
            suffix += 1;
          }
          takenIds[id] = true;
          resolve({ id: id, name: file.name, src: String(reader.result), image: image });
        };
        image.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  };

  const onStart = function () {
    const participantId = nodes.participant.value.trim();
    if (participantId === '') {
      say(
        nodes.setupStatus,
        'A participant id is needed: it is what the file names instead of a person.',
        'bad',
      );
      return;
    }
    const files = Array.prototype.slice.call(nodes.shots.files || []);
    if (files.length === 0) {
      say(nodes.setupStatus, 'Choose at least one screenshot.', 'bad');
      return;
    }
    if (!window.navigator.mediaDevices || !window.navigator.mediaDevices.getUserMedia) {
      say(
        nodes.setupStatus,
        'This browser offers no camera here. A camera needs a secure context: open this file ' +
          'directly, or serve it from localhost or over https — a plain http:// host will not do.',
        'bad',
      );
      return;
    }

    nodes.toCamera.disabled = true;
    say(nodes.setupStatus, 'Reading the screenshots…');

    const takenIds = {};
    Promise.all(
      files.map(function (file) {
        return loadShot(file, takenIds).catch(function (error) {
          throw new Error(file.name + ' ' + error.message);
        });
      }),
    ).then(
      function (shots) {
        state.shots = shots;
        state.participantId = participantId;
        state.category = nodes.category.value;
        state.viewingDurationSeconds = Number(nodes.exposure.value);
        say(nodes.setupStatus, '');
        show('camera');
        ensureStorage();
        clearStoredModel();
        try {
          beginTracking();
        } catch (error) {
          fail(
            'WebGazer could not start: ' + String(error && error.message ? error.message : error),
          );
          return;
        }
        waitForCamera();
      },
      function (error) {
        nodes.toCamera.disabled = false;
        say(nodes.setupStatus, String(error.message), 'bad');
      },
    );
  };

  // ----------------------------------------------------------------------- camera

  const waitForCamera = function () {
    const started = window.performance.now();
    const poll = function () {
      if (window.webgazer.isReady()) {
        say(nodes.cameraStatus, 'The camera is on and your face is being tracked.', 'ok');
        nodes.toCalibration.disabled = false;
        return;
      }
      if (window.performance.now() - started > 30000) {
        say(
          nodes.cameraStatus,
          'The camera has not started after thirty seconds. Allow it in the browser, close any ' +
            'other tab using it, and reload.',
          'bad',
        );
        return;
      }
      window.setTimeout(poll, 250);
    };
    poll();
  };

  // ------------------------------------------------------------------ calibration

  const calibrationPoints = function () {
    const points = [];
    CALIBRATION_FRACTIONS.forEach(function (fy) {
      CALIBRATION_FRACTIONS.forEach(function (fx) {
        points.push({ fx: fx, fy: fy });
      });
    });
    return points;
  };

  const instruct = function (lead, rest) {
    nodes.overlayInstruction.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = lead;
    nodes.overlayInstruction.appendChild(strong);
    nodes.overlayInstruction.appendChild(document.createTextNode(' ' + rest));
  };

  const runCalibration = function () {
    const points = calibrationPoints();
    let remaining = points.length * CLICKS_PER_POINT;

    nodes.targets.textContent = '';
    nodes.overlay.hidden = false;
    instruct(
      'Look at a dot and click it, five times.',
      'Keep your eyes on the dot you are clicking.',
    );
    setTrackerChrome(true);

    return new Promise(function (resolve) {
      points.forEach(function (point) {
        const left = point.fx * window.innerWidth;
        const top = point.fy * window.innerHeight;
        let clicks = 0;

        const target = document.createElement('button');
        target.type = 'button';
        target.className = 'target';
        target.style.left = left + 'px';
        target.style.top = top + 'px';
        target.setAttribute(
          'aria-label',
          'Calibration point, ' + CLICKS_PER_POINT + ' clicks needed',
        );

        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = String(CLICKS_PER_POINT);
        target.appendChild(count);

        target.addEventListener('click', function () {
          if (clicks >= CLICKS_PER_POINT) return;
          clicks += 1;
          remaining -= 1;
          // The one place the model is trained: this point, now, while the eye is on it.
          window.webgazer.recordScreenPosition(left, top, 'click');
          count.textContent = String(CLICKS_PER_POINT - clicks);
          if (clicks >= CLICKS_PER_POINT) {
            target.dataset.done = 'true';
            target.disabled = true;
            count.textContent = '';
          }
          say(nodes.calibrateStatus, remaining + ' clicks to go.');
          if (remaining === 0) resolve();
        });

        nodes.targets.appendChild(target);
      });
    });
  };

  /**
   * The accuracy check: the participant stares at one point, and the estimates are compared
   * with where it is.
   *
   * It is a separate measurement from the calibration and not a summary of it. The fit's own
   * residuals would flatter it — they are the points it was fitted on — so this is five
   * seconds of gaze the model never saw, which is the only figure worth putting in the file.
   */
  const runCheck = function () {
    const left = window.innerWidth / 2;
    const top = window.innerHeight / 2;

    nodes.targets.textContent = '';
    nodes.overlay.hidden = false;
    instruct('Now just look at the dot.', 'Hold still until it disappears.');
    // Nothing on the display but the target: an error measured while the eye had somewhere
    // else to go is not the error this tool has.
    setTrackerChrome(false);

    const target = document.createElement('button');
    target.type = 'button';
    target.className = 'target';
    target.dataset.done = 'true';
    target.disabled = true;
    target.style.left = left + 'px';
    target.style.top = top + 'px';
    target.setAttribute('aria-label', 'Hold your gaze on this point');
    nodes.targets.appendChild(target);

    const errors = [];
    state.sink = function (x, y) {
      const dx = x - left;
      const dy = y - top;
      errors.push(Math.sqrt(dx * dx + dy * dy));
    };

    return wait(CHECK_MS).then(function () {
      state.sink = null;
      nodes.overlay.hidden = true;
      const sorted = errors.slice().sort(function (a, b) {
        return a - b;
      });
      const mean =
        errors.length === 0
          ? null
          : round1(
              errors.reduce(function (sum, value) {
                return sum + value;
              }, 0) / errors.length,
            );
      return {
        samples: errors.length,
        meanErrorPx: mean,
        medianErrorPx: errors.length === 0 ? null : round1(quantile(sorted, 0.5)),
        p90ErrorPx: errors.length === 0 ? null : round1(quantile(sorted, 0.9)),
      };
    });
  };

  const figure = function (value, label) {
    const wrapper = document.createElement('div');
    wrapper.className = 'figure';
    const big = document.createElement('div');
    big.className = 'value';
    big.textContent = value;
    const small = document.createElement('div');
    small.className = 'label';
    small.textContent = label;
    wrapper.appendChild(big);
    wrapper.appendChild(small);
    return wrapper;
  };

  const pixels = function (value) {
    return value === null ? '—' : value + ' px';
  };

  const showAccuracy = function (check) {
    state.check = check;
    nodes.accuracyFigures.textContent = '';
    nodes.accuracyFigures.appendChild(figure(pixels(check.meanErrorPx), 'mean error'));
    nodes.accuracyFigures.appendChild(figure(pixels(check.medianErrorPx), 'median error'));
    nodes.accuracyFigures.appendChild(figure(pixels(check.p90ErrorPx), '90th percentile'));
    nodes.accuracyFigures.appendChild(figure(String(check.samples), 'gaze estimates'));

    const enough = check.samples >= MIN_CHECK_SAMPLES;
    nodes.toRecord.disabled = !enough;
    if (!enough) {
      say(
        nodes.accuracyNote,
        'Only ' +
          check.samples +
          ' estimates arrived in five seconds, which means your face was not being tracked. ' +
          'Recording stays closed until it is. Light your face from the front, and calibrate again.',
        'bad',
      );
      return;
    }
    if (check.meanErrorPx > POOR_ERROR_PX) {
      say(
        nodes.accuracyNote,
        'That is well above the hundred pixels a webcam manages at best. You can record, and ' +
          'the figure goes in the file — but calibrating again is usually worth it.',
        'bad',
      );
      return;
    }
    say(nodes.accuracyNote, 'Good enough to record.', 'ok');
  };

  const goToCalibration = function () {
    show('calibrate');
    nodes.startCalibration.disabled = false;
    say(nodes.calibrateStatus, '');
  };

  const calibrate = function () {
    show('calibrate');
    nodes.startCalibration.disabled = true;
    runCalibration()
      .then(function () {
        state.calibrated = true;
        say(nodes.calibrateStatus, 'Calibrated. Measuring how far off it is…', 'ok');
        return runCheck();
      })
      .then(function (check) {
        nodes.overlay.hidden = true;
        show('accuracy');
        showAccuracy(check);
      });
  };

  // -------------------------------------------------------------------- recording

  /** The size a screenshot is shown at: its own pixels, shrunk to fit the stage, never grown. */
  const displaySizeOf = function (image) {
    const maxWidth = window.innerWidth * STAGE_FILL;
    const maxHeight = window.innerHeight * STAGE_FILL;
    const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    return {
      cssWidth: Math.max(1, Math.round(image.naturalWidth * scale)),
      cssHeight: Math.max(1, Math.round(image.naturalHeight * scale)),
    };
  };

  const recordOne = function (shot, position) {
    const size = displaySizeOf(shot.image);
    const samples = [];
    let geometry = null;

    nodes.stage.hidden = false;
    nodes.cross.hidden = false;
    nodes.shot.hidden = true;
    say(
      nodes.recordStatus,
      'Screenshot ' + (position + 1) + ' of ' + state.shots.length + ': ' + shot.name,
    );

    return wait(CROSS_MS)
      .then(function () {
        nodes.cross.hidden = true;
        nodes.shot.src = shot.src;
        nodes.shot.width = size.cssWidth;
        nodes.shot.height = size.cssHeight;
        nodes.shot.alt = 'Screenshot being viewed: ' + shot.name;
        nodes.shot.hidden = false;

        return painted();
      })
      .then(function () {
        // The rect is read once the screenshot is on the screen, so both the mapping below
        // and the `display` recorded afterwards describe where it actually was — not where it
        // was meant to be. The clock starts here, at the first moment it could be seen.
        const rect = nodes.shot.getBoundingClientRect();
        geometry = rect;
        const perCssPixel = shot.image.naturalWidth / rect.width;
        const started = window.performance.now();

        state.sink = function (x, y, now) {
          samples.push({
            tMs: now - started,
            x: (x - rect.left) * perCssPixel,
            y: (y - rect.top) * perCssPixel,
          });
        };

        return wait(state.viewingDurationSeconds * 1000);
      })
      .then(function () {
        state.sink = null;
        nodes.shot.hidden = true;
        return core.buildRecord({
          id: shot.id,
          category: state.category,
          viewingDurationSeconds: state.viewingDurationSeconds,
          participantId: state.participantId,
          image: {
            file: shot.name,
            width: shot.image.naturalWidth,
            height: shot.image.naturalHeight,
          },
          display: { cssWidth: geometry.width, cssHeight: geometry.height },
          samples: samples,
        });
      });
  };

  const record = function () {
    // The gate, in code as well as in the disabled button: a recording with no calibration
    // behind it is not data, and neither is one whose calibration was never measured.
    if (!state.calibrated || state.check === null || state.check.samples < MIN_CHECK_SAMPLES) {
      say(nodes.accuracyNote, 'Calibrate first: recording needs a measured calibration.', 'bad');
      return;
    }

    show('record');
    nodes.overlay.hidden = true;
    // Nothing on the display but the screenshot: no preview, no overlay, nothing.
    setTrackerChrome(false);

    const records = [];
    const next = function (position) {
      if (position >= state.shots.length) {
        nodes.stage.hidden = true;
        stopTracking();
        state.records = records;
        finish();
        return;
      }
      recordOne(state.shots[position], position).then(function (built) {
        records.push(built);
        next(position + 1);
      });
    };
    next(0);
  };

  // ------------------------------------------------------------------------- save

  const finish = function () {
    state.file = core.buildFile({
      tracker: {
        name: 'WebGazer.js',
        version: '1.0.1',
        regression: 'ridge',
        faceTracker: 'clmtrackr',
      },
      gazeSource: 'webcam',
      recordedAt: new Date().toISOString(),
      participantId: state.participantId,
      screen: {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      calibration: {
        points: CALIBRATION_FRACTIONS.length * CALIBRATION_FRACTIONS.length,
        clicksPerPoint: CLICKS_PER_POINT,
        checkDurationMs: CHECK_MS,
        check: state.check,
      },
      records: state.records,
    });

    nodes.saveRows.textContent = '';
    state.records.forEach(function (built) {
      const row = document.createElement('tr');
      const cells = [
        built.image.file,
        built.image.width + ' × ' + built.image.height,
        String(built.gaze.length),
        String(built.dropped.outsideImage),
        String(built.participants[0].fixations.length),
      ];
      cells.forEach(function (text, column) {
        const cell = document.createElement('td');
        if (column >= 2) cell.className = 'num';
        cell.textContent = text;
        row.appendChild(cell);
      });
      nodes.saveRows.appendChild(row);
    });

    const empty = state.records.filter(function (built) {
      return built.participants[0].fixations.length === 0;
    });
    show('save');
    if (empty.length > 0) {
      say(
        nodes.saveStatus,
        empty.length +
          ' of ' +
          state.records.length +
          ' screenshots came out with no fixations, and the project rejects a record with an ' +
          'empty scanpath. Keep the file if you want the raw gaze, but record those again.',
        'bad',
      );
    } else {
      say(nodes.saveStatus, '');
    }
  };

  const onSave = function () {
    const text = JSON.stringify(state.file, null, 2);
    const blob = new window.Blob([text], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = state.file.recordedAt.replace(/[:.]/g, '-');
    link.href = url;
    link.download = 'eyetrack-' + state.participantId + '-' + stamp + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  // ------------------------------------------------------------------------ start

  const start = function () {
    if (!core) {
      fail('fixations.js did not load, so there is nothing to shape a recording with.');
      return;
    }
    if (!window.webgazer) {
      fail('vendor/webgazer.js did not load. It sits beside this page; check that it is there.');
      return;
    }

    fillChoices();
    nodes.calibrateSummary.textContent =
      CALIBRATION_FRACTIONS.length * CALIBRATION_FRACTIONS.length +
      ' points, ' +
      CLICKS_PER_POINT +
      ' clicks each, then five seconds of looking at one point to measure how far off it is.';

    nodes.toCamera.addEventListener('click', onStart);
    nodes.toCalibration.addEventListener('click', goToCalibration);
    nodes.startCalibration.addEventListener('click', calibrate);
    nodes.recalibrate.addEventListener('click', calibrate);
    nodes.toRecord.addEventListener('click', record);
    nodes.save.addEventListener('click', onSave);
    show('setup');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(window, document);
