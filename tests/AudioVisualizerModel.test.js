#!/usr/bin/env node
//
// Contract tests for the nine-band FFT spectrum visualizer.
//
//   node tests/AudioVisualizerModel.test.js
//
// Dependency-free (node built-ins only, plain-object fixtures, no mocks).
// Verifies the shared contract:
//   - AudioVisualizerModel.zeroLevels / clampUnit / parseSpectrumFrame
//   - MediaModel.playbackStreamForPlayer / playerHasPlaybackStream
//   - MediaModel.transferPlayback (explicit source-switch handoff)
//   - MediaModel.commitSourceSelection (explicit row-click selection commit)
//
// Expected spectra are recomputed here from the documented pipeline with
// literal constants (floor 0.008, gamma 0.72, live 0.02) so any drift in the
// model's scaling, ordering, summary, or parsing strictness fails loudly.

"use strict";

var assert = require("assert");

var AudioVisualizerModel = require("../AudioVisualizerModel.js");
var MediaModel = require("../MediaModel.js");

var LEVEL_COUNT = 9;
var MAX_RANGE = 1000;
var SILENCE_FLOOR = 0.008;
var BAND_GAMMA = 0.72;
var LIVE_THRESHOLD = 0.02;

var zeroLevels = AudioVisualizerModel.zeroLevels;
var clampUnit = AudioVisualizerModel.clampUnit;
var parseSpectrumFrame = AudioVisualizerModel.parseSpectrumFrame;

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------

var passedCount = 0;
var failedCount = 0;

function test(name, fn) {
  try {
    fn();
    passedCount += 1;
    console.log("ok - " + name);
  } catch (err) {
    failedCount += 1;
    console.error("FAIL - " + name);
    console.error("      " + (err && err.message ? err.message : String(err)));
  }
}

// ---------------------------------------------------------------------------
// reference pipeline (independent restatement of the contract)
// ---------------------------------------------------------------------------

function shapeBand(raw, maxRange) {
  var normalized = Math.min(1, raw / maxRange);
  return normalized < SILENCE_FLOOR ? 0 : Math.pow(normalized, BAND_GAMMA);
}

function shapeFrame(raws, maxRange) {
  var levels = [];
  var peak = 0;
  var sum = 0;
  for (var i = 0; i < raws.length; i++) {
    var level = shapeBand(raws[i], maxRange);
    levels.push(level);
    if (level > peak) peak = level;
    sum += level;
  }
  return {
    levels: levels,
    peak: peak,
    energy: sum / raws.length,
    live: peak > LIVE_THRESHOLD
  };
}

function frameLine(raws) {
  return raws.join(";") + ";";
}

// Distinct ascending magnitudes: the lowest band carries the least energy.
var ASCENDING = [40, 120, 200, 300, 420, 560, 700, 850, 1000];
var DESCENDING = ASCENDING.slice().reverse();
var SILENT = [0, 0, 0, 0, 0, 0, 0, 0, 0];

// ---------------------------------------------------------------------------
// AudioVisualizerModel
// ---------------------------------------------------------------------------

test("AudioVisualizerModel exports zeroLevels, clampUnit and parseSpectrumFrame", function () {
  assert.strictEqual(typeof zeroLevels, "function", "zeroLevels must be exported");
  assert.strictEqual(typeof clampUnit, "function", "clampUnit must be exported");
  assert.strictEqual(typeof parseSpectrumFrame, "function", "parseSpectrumFrame must be exported");
});

test("zeroLevels returns the requested number of zeros", function () {
  var nine = zeroLevels(LEVEL_COUNT);
  assert.ok(Array.isArray(nine), "zeroLevels returns an array");
  assert.strictEqual(nine.length, LEVEL_COUNT);
  for (var i = 0; i < nine.length; i++) assert.strictEqual(nine[i], 0);
  assert.deepStrictEqual(zeroLevels(3), [0, 0, 0]);
  assert.strictEqual(zeroLevels(0).length, 0);
});

test("clampUnit clamps values into the unit range", function () {
  assert.strictEqual(clampUnit(0), 0);
  assert.strictEqual(clampUnit(1), 1);
  assert.strictEqual(clampUnit(0.42), 0.42);
  assert.strictEqual(clampUnit(-0.5), 0, "negative values clamp to zero");
  assert.strictEqual(clampUnit(2.5), 1, "values above one clamp to one");
});

test("clampUnit gates invalid values to zero", function () {
  assert.strictEqual(clampUnit(NaN), 0);
  assert.strictEqual(clampUnit(undefined), 0);
  assert.strictEqual(clampUnit(null), 0);
  assert.strictEqual(clampUnit(-Infinity), 0);
  assert.strictEqual(clampUnit(Infinity), 0, "infinity is not a unit value");
});

test("parseSpectrumFrame accepts nine bands with or without the trailing delimiter", function () {
  var withDelimiter = parseSpectrumFrame(frameLine(ASCENDING), LEVEL_COUNT, MAX_RANGE);
  var withoutDelimiter = parseSpectrumFrame(ASCENDING.join(";"), LEVEL_COUNT, MAX_RANGE);
  assert.ok(withDelimiter && withoutDelimiter, "both delimiter forms must parse");
  assert.deepStrictEqual(withDelimiter, withoutDelimiter,
    "the trailing delimiter must not change the result");
  assert.ok(Array.isArray(withDelimiter.levels), "levels is an array");
  assert.strictEqual(withDelimiter.levels.length, LEVEL_COUNT, "exactly nine bands");
});

test("bands are normalized against maxRange and shaped with pow(x, 0.72)", function () {
  var expected = shapeFrame(ASCENDING, MAX_RANGE);
  var r = parseSpectrumFrame(frameLine(ASCENDING), LEVEL_COUNT, MAX_RANGE);
  for (var i = 0; i < LEVEL_COUNT; i++) {
    assert.strictEqual(r.levels[i], expected.levels[i],
      "band " + i + " must be pow(raw/maxRange, 0.72)");
    assert.ok(r.levels[i] >= 0 && r.levels[i] <= 1, "band " + i + " stays in the unit range");
  }
});

test("shaping honors the provided count and maxRange, not hardcoded constants", function () {
  var r = parseSpectrumFrame("50;50;50;", 3, 200);
  assert.ok(r, "three bands against maxRange 200 must parse");
  assert.strictEqual(r.levels.length, 3);
  assert.strictEqual(r.levels[0], Math.pow(50 / 200, BAND_GAMMA),
    "normalization divides by the caller's maxRange");
});

test("band order is positional, low to high, never sorted or reversed", function () {
  var asc = parseSpectrumFrame(frameLine(ASCENDING), LEVEL_COUNT, MAX_RANGE);
  var desc = parseSpectrumFrame(frameLine(DESCENDING), LEVEL_COUNT, MAX_RANGE);
  var ascExpected = shapeFrame(ASCENDING, MAX_RANGE).levels;
  var descExpected = shapeFrame(DESCENDING, MAX_RANGE).levels;
  for (var i = 0; i < LEVEL_COUNT; i++) {
    assert.strictEqual(asc.levels[i], ascExpected[i], "ascending band " + i + " maps in place");
    assert.strictEqual(desc.levels[i], descExpected[i], "descending band " + i + " maps in place");
  }
  for (var j = 1; j < LEVEL_COUNT; j++) {
    assert.ok(asc.levels[j] > asc.levels[j - 1], "ascending input keeps rising levels");
    assert.ok(desc.levels[j] < desc.levels[j - 1], "descending input keeps falling levels");
  }
  assert.ok(desc.levels[0] > desc.levels[LEVEL_COUNT - 1],
    "the loudest input band must stay at index 0, not sorted to the end");
});

test("bands above maxRange clamp to full scale", function () {
  var r = parseSpectrumFrame(frameLine([1200, 2000, 0, 0, 0, 0, 0, 0, 0]), LEVEL_COUNT, MAX_RANGE);
  assert.strictEqual(r.levels[0], 1, "over-range values clamp to exactly one");
  assert.strictEqual(r.levels[1], 1, "every over-range value clamps, not just the first");
  assert.strictEqual(r.peak, 1);
});

test("bands below the silence floor snap to exact zero; 0.008 itself passes", function () {
  var below = parseSpectrumFrame(frameLine([7, 7, 7, 7, 7, 7, 7, 7, 7]), LEVEL_COUNT, MAX_RANGE);
  assert.deepStrictEqual(below.levels, zeroLevels(LEVEL_COUNT),
    "sub-floor energy is digital silence, not noise");
  assert.strictEqual(below.peak, 0);
  assert.strictEqual(below.energy, 0);
  assert.ok(!below.live, "sub-floor frames are not live");

  var boundary = parseSpectrumFrame(frameLine([8, 0, 0, 0, 0, 0, 0, 0, 0]), LEVEL_COUNT, MAX_RANGE);
  assert.strictEqual(boundary.levels[0], shapeBand(8, MAX_RANGE),
    "a normalized value of exactly 0.008 survives the floor and is shaped");
  assert.ok(boundary.levels[0] > 0, "the floor boundary produces signal");
});

test("summary peak is the max level, energy the mean, live strictly derived from peak", function () {
  var mixed = [0, 300, 900, 500, 100, 0, 700, 200, 50];
  var expected = shapeFrame(mixed, MAX_RANGE);
  var r = parseSpectrumFrame(frameLine(mixed), LEVEL_COUNT, MAX_RANGE);
  assert.strictEqual(r.peak, expected.peak, "peak is the maximum shaped level");
  assert.strictEqual(r.peak, r.levels[2], "the peak sits on the loudest band, wherever it is");
  assert.strictEqual(r.energy, expected.energy, "energy is the mean of all nine levels");
  assert.strictEqual(r.live, expected.live);
  assert.ok(r.live, "an audible frame is live");

  var lone = parseSpectrumFrame(frameLine([8, 0, 0, 0, 0, 0, 0, 0, 0]), LEVEL_COUNT, MAX_RANGE);
  assert.ok(lone.energy < LIVE_THRESHOLD, "precondition: this frame's mean is under the threshold");
  assert.ok(lone.live, "live follows the peak, not the mean");
});

test("silence parses to exact zeros and repeated frames never fabricate motion", function () {
  var silent = parseSpectrumFrame(frameLine(SILENT), LEVEL_COUNT, MAX_RANGE);
  assert.deepStrictEqual(silent.levels, zeroLevels(LEVEL_COUNT), "nine exact zeros");
  assert.strictEqual(silent.peak, 0);
  assert.strictEqual(silent.energy, 0);
  assert.ok(!silent.live, "silence is not live");

  assert.deepStrictEqual(silent, parseSpectrumFrame(SILENT.join(";"), LEVEL_COUNT, MAX_RANGE),
    "delimiter-free silence matches");
  assert.deepStrictEqual(silent, parseSpectrumFrame(frameLine(SILENT), LEVEL_COUNT, MAX_RANGE),
    "parsing is pure: identical frames give identical results, no hidden state");
});

test("malformed frames are rejected as null", function () {
  var badFrames = [
    ["eight bands", "40;120;200;300;420;560;700;850;"],
    ["ten bands", "40;120;200;300;420;560;700;850;1000;120;"],
    ["internal empty band", "40;120;;300;420;560;700;850;1000"],
    ["nonnumeric band", "40;abc;200;300;420;560;700;850;1000"],
    ["trailing garbage on a band", "40;120;200;300;420;560;700;12abc;1000"],
    ["NaN band", "40;NaN;200;300;420;560;700;850;1000"],
    ["Infinity band", "40;120;Infinity;300;420;560;700;850;1000"],
    ["negative band", "40;-5;200;300;420;560;700;850;1000"],
    ["signed band", "40;+5;200;300;420;560;700;850;1000"],
    ["exponent notation", "40;1e3;200;300;420;560;700;850;1000"],
    ["hex notation", "40;0x10;200;300;420;560;700;850;1000"],
    ["leading-space band", "40; 120;200;300;420;560;700;850;1000"],
    ["trailing-space band", "40;120 ;200;300;420;560;700;850;1000"],
    ["lone decimal point", "40;.5;200;300;420;560;700;850;1000"],
    ["dangling decimal point", "40;5.;200;300;420;560;700;850;1000"],
    ["double trailing delimiter", frameLine(ASCENDING) + ";"],
    ["empty line", ""],
    ["whitespace-only line", "   "]
  ];
  for (var i = 0; i < badFrames.length; i++) {
    assert.strictEqual(parseSpectrumFrame(badFrames[i][1], LEVEL_COUNT, MAX_RANGE), null,
      "must reject: " + badFrames[i][0]);
  }
});

test("non-string lines and degenerate arguments are rejected as null", function () {
  var nonStrings = [null, undefined, 123, true, [frameLine(SILENT)], { line: frameLine(SILENT) }];
  for (var i = 0; i < nonStrings.length; i++) {
    assert.strictEqual(parseSpectrumFrame(nonStrings[i], LEVEL_COUNT, MAX_RANGE), null,
      "must reject non-string input #" + i);
  }
  assert.strictEqual(parseSpectrumFrame(frameLine(ASCENDING), 0, MAX_RANGE), null,
    "a zero band count cannot parse");
  assert.strictEqual(parseSpectrumFrame(frameLine(ASCENDING), -3, MAX_RANGE), null,
    "a negative band count cannot parse");
  assert.strictEqual(parseSpectrumFrame(frameLine(ASCENDING), LEVEL_COUNT, 0), null,
    "a zero range cannot normalize");
  assert.strictEqual(parseSpectrumFrame(frameLine(ASCENDING), LEVEL_COUNT, -MAX_RANGE), null,
    "a negative range cannot normalize");
  assert.strictEqual(parseSpectrumFrame(frameLine(ASCENDING), LEVEL_COUNT, NaN), null,
    "a NaN range cannot normalize");
  assert.strictEqual(parseSpectrumFrame(frameLine(ASCENDING), LEVEL_COUNT, Infinity), null,
    "an infinite range cannot normalize");
});

// ---------------------------------------------------------------------------
// MediaModel playback stream matching
// ---------------------------------------------------------------------------

test("MediaModel exports playbackStreamForPlayer and playerHasPlaybackStream", function () {
  assert.strictEqual(typeof MediaModel.playbackStreamForPlayer, "function",
    "playbackStreamForPlayer must be exported");
  assert.strictEqual(typeof MediaModel.playerHasPlaybackStream, "function",
    "playerHasPlaybackStream must be exported");
});

function streamNode(label) {
  return { ready: true, properties: { "application.name": label } };
}

function describedNode(label) {
  return { ready: true, properties: {}, description: label };
}

function notReadyNode(label) {
  return { ready: false, properties: { "application.name": label } };
}

var matchScenarios = [
  {
    name: "exact beats earlier partial",
    player: { desktopEntry: "Spotify" },
    streams: [streamNode("Spotify Web Player"), streamNode("Spotify")],
    expected: 1
  },
  {
    name: "case-insensitive exact match",
    player: { desktopEntry: "Spotify" },
    streams: [streamNode("SPOTIFY")],
    expected: 0
  },
  {
    name: "pipewire alsa prefix is stripped before matching",
    player: { identity: "Firefox" },
    streams: [streamNode("PipeWire ALSA [FireFox]")],
    expected: 0
  },
  {
    name: "punctuation-insensitive exact match",
    player: { desktopEntry: "Spotify Player" },
    streams: [streamNode("spotify-player")],
    expected: 0
  },
  {
    name: "first partial containment wins among partials",
    player: { desktopEntry: "firefox" },
    streams: [describedNode("Firefox - Mail"), describedNode("Firefox - YouTube")],
    expected: 0
  },
  {
    name: "partial containment in the stream label",
    player: { desktopEntry: "firefox" },
    streams: [streamNode("Chrome"), describedNode("Mozilla Firefox")],
    expected: 1
  },
  {
    name: "partial containment in the player label",
    player: { dbusName: "org.mpris.MediaPlayer2.spotifyd" },
    streams: [streamNode("Firefox"), streamNode("Spotify")],
    expected: 1
  },
  {
    name: "unlabeled and not-ready nodes are skipped",
    player: { desktopEntry: "spotify" },
    streams: [notReadyNode("Spotify"), { ready: true, properties: {} }, streamNode("Spotify")],
    expected: 2
  },
  {
    name: "no matching stream returns null",
    player: { desktopEntry: "vlc" },
    streams: [streamNode("Spotify"), describedNode("Mozilla Firefox")],
    expected: null
  },
  {
    name: "null player returns null",
    player: null,
    streams: [streamNode("Spotify")],
    expected: null
  }
];

matchScenarios.forEach(function (scenario) {
  test("playbackStreamForPlayer: " + scenario.name, function () {
    var stream = MediaModel.playbackStreamForPlayer(scenario.player, scenario.streams);
    if (scenario.expected === null) {
      assert.strictEqual(stream, null, "expected no match");
    } else {
      assert.strictEqual(stream, scenario.streams[scenario.expected],
        "expected the stream at index " + scenario.expected);
    }
  });
});

test("playerHasPlaybackStream delegates to playbackStreamForPlayer", function () {
  matchScenarios.forEach(function (scenario) {
    var stream = MediaModel.playbackStreamForPlayer(scenario.player, scenario.streams);
    assert.strictEqual(MediaModel.playerHasPlaybackStream(scenario.player, scenario.streams), stream !== null,
      "delegation mismatch for scenario: " + scenario.name);
  });
});

// ---------------------------------------------------------------------------
// MediaModel.transferPlayback
// ---------------------------------------------------------------------------

test("MediaModel exports transferPlayback", function () {
  assert.strictEqual(typeof MediaModel.transferPlayback, "function",
    "transferPlayback must be exported");
});

function mprisSource(key, isPlaying) {
  return { dbusName: "org.mpris.MediaPlayer2." + key, isPlaying: isPlaying };
}

// Every spy call is recorded as { action, player } so deepStrictEqual pins
// the exact sequence: reversing play/pause, pausing after a failed start,
// or acting on a refused transfer all fail loudly.
function actionSpy(log, action, result) {
  return function (player) {
    log.push({ action: action, player: player });
    return result;
  };
}

test("transferPlayback starts a paused target before pausing current", function () {
  var current = mprisSource("chrome", true);
  var target = mprisSource("spotify", false);
  var log = [];

  var ran = MediaModel.transferPlayback(current, target, true,
    actionSpy(log, "play", true), actionSpy(log, "pause", true));

  assert.strictEqual(ran, true, "a completed transfer reports true");
  assert.deepStrictEqual(log, [
    { action: "play", player: target },
    { action: "pause", player: current }
  ], "play(target) must precede pause(current)");
});

test("transferPlayback skips play when the target is already playing", function () {
  var current = mprisSource("chrome", true);
  var target = mprisSource("spotify", true);
  var log = [];

  var ran = MediaModel.transferPlayback(current, target, true,
    actionSpy(log, "play", true), actionSpy(log, "pause", true));

  assert.strictEqual(ran, true, "an already-playing target still transfers");
  assert.deepStrictEqual(log, [
    { action: "pause", player: current }
  ], "an already-playing target must never be sent play");
});

test("transferPlayback never pauses current after a failed target start", function () {
  var current = mprisSource("chrome", true);
  var target = mprisSource("spotify", false);
  var log = [];

  var ran = MediaModel.transferPlayback(current, target, true,
    actionSpy(log, "play", false), actionSpy(log, "pause", true));

  assert.strictEqual(ran, false, "a failed start reports false");
  assert.deepStrictEqual(log, [
    { action: "play", player: target }
  ], "a target that cannot start must never silence current");

  // A play callback without a truthy result is equally a failed start.
  log = [];
  var reluctantTarget = mprisSource("spotify", false);
  ran = MediaModel.transferPlayback(mprisSource("chrome", true), reluctantTarget, true,
    actionSpy(log, "play"), actionSpy(log, "pause", true));

  assert.strictEqual(ran, false, "a falsy play result reports false");
  assert.deepStrictEqual(log, [
    { action: "play", player: reluctantTarget }
  ], "a falsy play result must never pause current");
});

var transferRefusals = [
  {
    name: "transfer was not requested",
    transfer: function (play, pause) {
      return MediaModel.transferPlayback(mprisSource("chrome", true), mprisSource("spotify", false), false, play, pause);
    }
  },
  {
    name: "current is paused",
    transfer: function (play, pause) {
      return MediaModel.transferPlayback(mprisSource("chrome", false), mprisSource("spotify", false), true, play, pause);
    }
  },
  {
    name: "the target is the current player itself",
    transfer: function (play, pause) {
      var current = mprisSource("chrome", true);
      return MediaModel.transferPlayback(current, current, true, play, pause);
    }
  },
  {
    name: "the target only shares the current player's key",
    transfer: function (play, pause) {
      return MediaModel.transferPlayback(mprisSource("chrome", true), mprisSource("chrome", false), true, play, pause);
    }
  },
  {
    name: "no current player exists",
    transfer: function (play, pause) {
      return MediaModel.transferPlayback(null, mprisSource("spotify", false), true, play, pause);
    }
  },
  {
    name: "no target player exists",
    transfer: function (play, pause) {
      return MediaModel.transferPlayback(mprisSource("chrome", true), null, true, play, pause);
    }
  }
];

transferRefusals.forEach(function (scenario) {
  test("transferPlayback refuses to act when " + scenario.name, function () {
    var log = [];
    var ran = scenario.transfer(actionSpy(log, "play", true), actionSpy(log, "pause", true));

    assert.strictEqual(ran, false, "a refused transfer reports false");
    assert.deepStrictEqual(log, [], "a refused transfer must issue no playback actions");
  });
});

// ---------------------------------------------------------------------------
// MediaModel.commitSourceSelection
// ---------------------------------------------------------------------------

test("MediaModel exports commitSourceSelection", function () {
  assert.strictEqual(typeof MediaModel.commitSourceSelection, "function",
    "commitSourceSelection must be exported");
});

test("commitSourceSelection starts a paused target before pausing current", function () {
  var current = mprisSource("chrome", true);
  var target = mprisSource("spotify", false);
  var log = [];

  var started = MediaModel.commitSourceSelection(current, target, true,
    actionSpy(log, "play", true), actionSpy(log, "pause", true));

  assert.strictEqual(started, true, "a started target reports true");
  assert.deepStrictEqual(log, [
    { action: "play", player: target },
    { action: "pause", player: current }
  ], "play(target) must precede pause(current)");
});

test("commitSourceSelection skips play when the target is already playing", function () {
  var current = mprisSource("chrome", true);
  var target = mprisSource("spotify", true);
  var log = [];

  var started = MediaModel.commitSourceSelection(current, target, true,
    actionSpy(log, "play", true), actionSpy(log, "pause", true));

  assert.strictEqual(started, true, "an already-playing target reports true");
  assert.deepStrictEqual(log, [
    { action: "pause", player: current }
  ], "an already-playing target must never be sent play");
});

test("commitSourceSelection still pauses current after a failed target start", function () {
  var current = mprisSource("chrome", true);
  var target = mprisSource("spotify", false);
  var log = [];

  var started = MediaModel.commitSourceSelection(current, target, true,
    actionSpy(log, "play", false), actionSpy(log, "pause", true));

  assert.strictEqual(started, false, "a failed start reports false");
  assert.deepStrictEqual(log, [
    { action: "play", player: target },
    { action: "pause", player: current }
  ], "an explicit selection must silence current even when the target cannot start");

  // A play callback without a truthy result is equally a failed start, and
  // the explicit selection still commits.
  log = [];
  var reluctantTarget = mprisSource("spotify", false);
  var playingCurrent = mprisSource("chrome", true);
  started = MediaModel.commitSourceSelection(playingCurrent, reluctantTarget, true,
    actionSpy(log, "play"), actionSpy(log, "pause", true));

  assert.strictEqual(started, false, "a falsy play result reports false");
  assert.deepStrictEqual(log, [
    { action: "play", player: reluctantTarget },
    { action: "pause", player: playingCurrent }
  ], "a falsy play result still pauses current so it cannot outrank the target");
});

var commitRefusals = [
  {
    name: "the selection was not requested",
    commit: function (play, pause) {
      return MediaModel.commitSourceSelection(mprisSource("chrome", true), mprisSource("spotify", false), false, play, pause);
    }
  },
  {
    name: "current is paused",
    commit: function (play, pause) {
      return MediaModel.commitSourceSelection(mprisSource("chrome", false), mprisSource("spotify", false), true, play, pause);
    }
  },
  {
    name: "the target is the current player itself",
    commit: function (play, pause) {
      var current = mprisSource("chrome", true);
      return MediaModel.commitSourceSelection(current, current, true, play, pause);
    }
  },
  {
    name: "the target only shares the current player's key",
    commit: function (play, pause) {
      return MediaModel.commitSourceSelection(mprisSource("chrome", true), mprisSource("chrome", false), true, play, pause);
    }
  },
  {
    name: "no current player exists",
    commit: function (play, pause) {
      return MediaModel.commitSourceSelection(null, mprisSource("spotify", false), true, play, pause);
    }
  },
  {
    name: "no target player exists",
    commit: function (play, pause) {
      return MediaModel.commitSourceSelection(mprisSource("chrome", true), null, true, play, pause);
    }
  }
];

commitRefusals.forEach(function (scenario) {
  test("commitSourceSelection refuses to act when " + scenario.name, function () {
    var log = [];
    var started = scenario.commit(actionSpy(log, "play", true), actionSpy(log, "pause", true));

    assert.strictEqual(started, false, "a refused selection reports false");
    assert.deepStrictEqual(log, [], "a refused selection must issue no playback actions");
  });
});

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

console.log("");
console.log(passedCount + " passed, " + failedCount + " failed");
if (failedCount > 0) process.exitCode = 1;
