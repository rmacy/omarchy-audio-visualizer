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
//   - MediaModel.sourceHandoffPlan / sourceHandoffConfirmed
//     (one-click, confirmation-driven source transfer)
//   - MediaModel.performPlaybackAction (explicit play/pause/next/previous execution)
//   - MediaModel.visualizerShouldRun (visualizer wanted-state predicate)
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
// MediaModel confirmation-driven source handoff
// ---------------------------------------------------------------------------

function mprisSource(key, isPlaying) {
  return { dbusName: "org.mpris.MediaPlayer2." + key, isPlaying: isPlaying };
}

test("MediaModel exports source eligibility, handoff planning, and confirmation", function () {
  assert.strictEqual(typeof MediaModel.sourceIsSelectable, "function",
    "sourceIsSelectable must be exported");
  assert.strictEqual(typeof MediaModel.sourceHandoffPlan, "function",
    "sourceHandoffPlan must be exported");
  assert.strictEqual(typeof MediaModel.sourceHandoffConfirmed, "function",
    "sourceHandoffConfirmed must be exported");
});

test("source eligibility hides stopped identity-only players that cannot start", function () {
  var stoppedChromium = {
    dbusName: "org.mpris.MediaPlayer2.chromium",
    identity: "Chromium",
    isPlaying: false,
    canPlay: false,
    canTogglePlaying: false
  };
  assert.strictEqual(MediaModel.sourceIsSelectable(stoppedChromium), false,
    "a stale Chromium MPRIS endpoint must not appear as a switchable row");

  var pausedYoutube = {
    dbusName: "org.mpris.MediaPlayer2.chromium",
    identity: "Chromium",
    trackTitle: "YouTube",
    isPlaying: false,
    canPlay: true
  };
  assert.strictEqual(MediaModel.sourceIsSelectable(pausedYoutube), true,
    "a paused YouTube session that advertises Play remains selectable");

  stoppedChromium.isPlaying = true;
  assert.strictEqual(MediaModel.sourceIsSelectable(stoppedChromium), true,
    "a currently playing source remains selectable regardless of CanPlay");
});

test("paused target starts before the playing source may pause", function () {
  var spotify = mprisSource("spotify", true);
  var youtube = mprisSource("chromium", false);
  var plan = MediaModel.sourceHandoffPlan(spotify, youtube, true);

  assert.deepStrictEqual(plan, {
    valid: true,
    startTarget: true,
    pauseCurrent: false,
    waitForTarget: true
  }, "the initial click may start YouTube but must not silence Spotify");

  var actions = [];
  if (plan.startTarget) actions.push({ action: "play", player: youtube });
  if (plan.pauseCurrent) actions.push({ action: "pause", player: spotify });
  assert.deepStrictEqual(actions, [{ action: "play", player: youtube }],
    "no pause is issued before target confirmation");

  var pending = {
    fromKey: MediaModel.playerKey(spotify),
    toKey: MediaModel.playerKey(youtube)
  };
  assert.strictEqual(MediaModel.sourceHandoffConfirmed(pending, youtube), false,
    "a paused target cannot confirm the transfer");

  youtube.isPlaying = true;
  assert.strictEqual(MediaModel.sourceHandoffConfirmed(pending, youtube), true,
    "the authoritative target Playing state confirms the transfer");
  actions.push({ action: "pause", player: spotify });
  assert.deepStrictEqual(actions, [
    { action: "play", player: youtube },
    { action: "pause", player: spotify }
  ], "Spotify pauses only after YouTube confirms playback");
});

test("an already-playing target transfers immediately without another play", function () {
  var plan = MediaModel.sourceHandoffPlan(
    mprisSource("spotify", true), mprisSource("chromium", true), true);

  assert.deepStrictEqual(plan, {
    valid: true,
    startTarget: false,
    pauseCurrent: true,
    waitForTarget: false
  }, "an already-playing target only requires the outgoing pause");
});

test("a paused source starts without a deferred handoff when nothing else plays", function () {
  var target = mprisSource("chromium", false);
  assert.deepStrictEqual(MediaModel.sourceHandoffPlan(null, target, true), {
    valid: true,
    startTarget: true,
    pauseCurrent: false,
    waitForTarget: false
  });

  assert.deepStrictEqual(MediaModel.sourceHandoffPlan(target, target, true), {
    valid: true,
    startTarget: true,
    pauseCurrent: false,
    waitForTarget: false
  }, "clicking the selected paused source starts it");

  target.isPlaying = true;
  assert.deepStrictEqual(MediaModel.sourceHandoffPlan(target, target, true), {
    valid: true,
    startTarget: false,
    pauseCurrent: false,
    waitForTarget: false
  }, "clicking the selected playing source is a no-op");
});

test("handoff planning honors optimistic playback states", function () {
  var current = mprisSource("spotify", false);
  var target = mprisSource("chromium", false);
  var plan = MediaModel.sourceHandoffPlan(
    current, target, true, true, false, false);

  assert.deepStrictEqual(plan, {
    valid: true,
    startTarget: true,
    pauseCurrent: false,
    waitForTarget: true
  }, "in-flight source states must not drop a rapid handoff");

  plan = MediaModel.sourceHandoffPlan(
    current, target, true, true, false, true);
  assert.deepStrictEqual(plan, {
    valid: true,
    startTarget: false,
    pauseCurrent: false,
    waitForTarget: true
  }, "an existing optimistic Play is awaited, never mistaken for confirmation or toggled again");
});

test("invalid handoff requests issue no actions", function () {
  var disabled = MediaModel.sourceHandoffPlan(
    mprisSource("spotify", true), mprisSource("chromium", false), false);
  var missing = MediaModel.sourceHandoffPlan(
    mprisSource("spotify", true), null, true);

  [disabled, missing].forEach(function (plan) {
    assert.deepStrictEqual(plan, {
      valid: false,
      startTarget: false,
      pauseCurrent: false,
      waitForTarget: false
    });
  });
});

test("handoff confirmation rejects wrong, paused, or missing targets", function () {
  var pending = {
    fromKey: "org.mpris.MediaPlayer2.spotify",
    toKey: "org.mpris.MediaPlayer2.chromium"
  };

  assert.strictEqual(MediaModel.sourceHandoffConfirmed(pending,
    mprisSource("firefox", true)), false);
  assert.strictEqual(MediaModel.sourceHandoffConfirmed(pending,
    mprisSource("chromium", false)), false);
  assert.strictEqual(MediaModel.sourceHandoffConfirmed(null,
    mprisSource("chromium", true)), false);
  assert.strictEqual(MediaModel.sourceHandoffConfirmed(pending, null), false);
});

// ---------------------------------------------------------------------------
// MediaModel.performPlaybackAction
// ---------------------------------------------------------------------------

test("MediaModel exports playback actions, optimistic state, and visualizer policy", function () {
  assert.strictEqual(typeof MediaModel.performPlaybackAction, "function",
    "performPlaybackAction must be exported");
  assert.strictEqual(typeof MediaModel.effectivePlaying, "function",
    "effectivePlaying must be exported");
  assert.strictEqual(typeof MediaModel.visualizerShouldRun, "function",
    "visualizerShouldRun must be exported");
});

// Builds a player whose MPRIS methods are spies appending { action, player }
// to `log`; play/pause/toggle mirror isPlaying the way the real bus would.
// performPlaybackAction invokes these methods directly on the player, so the
// log pins exactly which method ran, on whom, and in what order.
function spyPlayer(log, key, capabilities) {
  var caps = capabilities || ({});
  var player = {
    dbusName: "org.mpris.MediaPlayer2." + key,
    isPlaying: !!caps.isPlaying,
    canPlay: !!caps.canPlay,
    canPause: !!caps.canPause,
    canGoNext: !!caps.canGoNext,
    canGoPrevious: !!caps.canGoPrevious,
    canTogglePlaying: !!caps.canTogglePlaying
  };
  player.next = function () {
    log.push({ action: "next", player: key });
    return true;
  };
  player.previous = function () {
    log.push({ action: "previous", player: key });
    return true;
  };
  player.play = function () {
    log.push({ action: "play", player: key });
    player.isPlaying = true;
    return true;
  };
  player.pause = function () {
    log.push({ action: "pause", player: key });
    player.isPlaying = false;
    return true;
  };
  player.togglePlaying = function () {
    log.push({ action: "toggle", player: key });
    player.isPlaying = !player.isPlaying;
    return true;
  };
  return player;
}

test("effectivePlaying uses a valid unexpired intent, then returns to MPRIS state", function () {
  var player = {
    dbusName: "org.mpris.MediaPlayer2.spotify",
    isPlaying: false
  };
  var key = MediaModel.playerKey(player);
  var intents = {};
  intents[key] = { playing: true, expiresAt: 1200 };

  assert.strictEqual(MediaModel.effectivePlaying(player, intents, 1000), true,
    "an unexpired play intent must render immediately");
  assert.strictEqual(MediaModel.effectivePlaying(player, intents, 1200), false,
    "an intent expires at its deadline and the bus state becomes authoritative");

  player.isPlaying = true;
  intents[key] = { playing: "yes", expiresAt: 1300 };
  assert.strictEqual(MediaModel.effectivePlaying(player, intents, 1000), true,
    "a malformed desired state must fall back to the player's actual state");
  intents[key] = { playing: false, expiresAt: Infinity };
  assert.strictEqual(MediaModel.effectivePlaying(player, intents, 1000), true,
    "a non-finite deadline must fall back to the player's actual state");
  assert.strictEqual(MediaModel.effectivePlaying(null, intents, 1000), false,
    "a missing player is never effectively playing");
});

test("effective state lets rapid play then pause outrun stale MPRIS properties", function () {
  var log = [];
  var player = {
    dbusName: "org.mpris.MediaPlayer2.spotify",
    isPlaying: false,
    canTogglePlaying: true,
    togglePlaying: function () {
      log.push("toggle");
      // Deliberately do not mutate isPlaying: this models the interval before
      // Quickshell receives MPRIS PropertiesChanged.
    }
  };

  assert.strictEqual(MediaModel.performPlaybackAction(player, "play", false), true,
    "the first click sends PlayPause from the effective paused state");
  assert.strictEqual(MediaModel.performPlaybackAction(player, "pause", true), true,
    "the second click sends PlayPause from the optimistic playing state");
  assert.deepStrictEqual(log, ["toggle", "toggle"],
    "rapid opposite clicks must not be dropped while the bus property is stale");
  assert.strictEqual(player.isPlaying, false,
    "the test keeps the authoritative property stale throughout");
});

test("performPlaybackAction runs next only behind canGoNext", function () {
  var log = [];
  var capable = spyPlayer(log, "spotify", { canGoNext: true });

  assert.strictEqual(MediaModel.performPlaybackAction(capable, "next"), true,
    "a capable player reports that the action ran");
  assert.deepStrictEqual(log, [{ action: "next", player: "spotify" }],
    "next must invoke the player's next callback and nothing else");

  var incapable = spyPlayer(log, "chrome", {});
  assert.strictEqual(MediaModel.performPlaybackAction(incapable, "next"), false,
    "a player without canGoNext reports that nothing ran");
  assert.deepStrictEqual(log, [{ action: "next", player: "spotify" }],
    "an incapable player must never receive next");
});

test("performPlaybackAction runs previous only behind canGoPrevious", function () {
  var log = [];
  var capable = spyPlayer(log, "spotify", { canGoPrevious: true });

  assert.strictEqual(MediaModel.performPlaybackAction(capable, "previous"), true,
    "a capable player reports that the action ran");
  assert.deepStrictEqual(log, [{ action: "previous", player: "spotify" }],
    "previous must invoke the player's previous callback and nothing else");

  var incapable = spyPlayer(log, "chrome", {});
  assert.strictEqual(MediaModel.performPlaybackAction(incapable, "previous"), false,
    "a player without canGoPrevious reports that nothing ran");
  assert.deepStrictEqual(log, [{ action: "previous", player: "spotify" }],
    "an incapable player must never receive previous");
});

test("pausing a playing player prefers togglePlaying over the dedicated pause", function () {
  var log = [];
  var player = spyPlayer(log, "spotify", {
    isPlaying: true, canPause: true, canTogglePlaying: true
  });

  assert.strictEqual(MediaModel.performPlaybackAction(player, "pause"), true);
  assert.deepStrictEqual(log, [{ action: "toggle", player: "spotify" }],
    "pause must run togglePlaying(), never pause(), when canTogglePlaying holds");
  assert.strictEqual(player.isPlaying, false,
    "the playing state must follow the toggle");

  log = [];
  var toggleOnly = spyPlayer(log, "spotify", { isPlaying: true, canTogglePlaying: true });
  assert.strictEqual(MediaModel.performPlaybackAction(toggleOnly, "pause"), true);
  assert.deepStrictEqual(log, [{ action: "toggle", player: "spotify" }],
    "a toggle-only player is paused through togglePlaying as well");
});

test("pause falls back to the dedicated pause method without a toggle", function () {
  var log = [];
  var player = spyPlayer(log, "spotify", { isPlaying: true, canPause: true });

  assert.strictEqual(MediaModel.performPlaybackAction(player, "pause"), true);
  assert.deepStrictEqual(log, [{ action: "pause", player: "spotify" }],
    "a player without canTogglePlaying is paused through pause()");
  assert.strictEqual(player.isPlaying, false,
    "the playing state must follow the dedicated pause");
});

test("pausing an already-paused player is a no-op, never a toggle", function () {
  var log = [];
  var player = spyPlayer(log, "spotify", {
    isPlaying: false, canPause: true, canTogglePlaying: true
  });

  assert.strictEqual(MediaModel.performPlaybackAction(player, "pause"), false,
    "an already paused player reports that nothing ran");
  assert.deepStrictEqual(log, [],
    "the desired state is already satisfied: pausing must never toggle, that would start it");
});

test("pause without pause or toggle capability is a no-op", function () {
  var log = [];
  var player = spyPlayer(log, "spotify", { isPlaying: true });

  assert.strictEqual(MediaModel.performPlaybackAction(player, "pause"), false,
    "an incapable player reports that nothing ran");
  assert.deepStrictEqual(log, [], "an incapable player must not be touched");
});

test("playing a paused player prefers togglePlaying over the dedicated play", function () {
  var log = [];
  var player = spyPlayer(log, "spotify", {
    isPlaying: false, canPlay: true, canTogglePlaying: true
  });

  assert.strictEqual(MediaModel.performPlaybackAction(player, "play"), true);
  assert.deepStrictEqual(log, [{ action: "toggle", player: "spotify" }],
    "play must run togglePlaying(), never play(), when canTogglePlaying holds");
  assert.strictEqual(player.isPlaying, true,
    "the playing state must follow the toggle");

  log = [];
  var toggleOnly = spyPlayer(log, "spotify", { isPlaying: false, canTogglePlaying: true });
  assert.strictEqual(MediaModel.performPlaybackAction(toggleOnly, "play"), true);
  assert.deepStrictEqual(log, [{ action: "toggle", player: "spotify" }],
    "a toggle-only player is started through togglePlaying as well");
});

test("play falls back to the dedicated play method without a toggle", function () {
  var log = [];
  var player = spyPlayer(log, "spotify", { isPlaying: false, canPlay: true });

  assert.strictEqual(MediaModel.performPlaybackAction(player, "play"), true);
  assert.deepStrictEqual(log, [{ action: "play", player: "spotify" }],
    "a player without canTogglePlaying is started through play()");
  assert.strictEqual(player.isPlaying, true,
    "the playing state must follow the dedicated play");
});

test("playing an already-playing player is a no-op, never a toggle", function () {
  var log = [];
  var player = spyPlayer(log, "spotify", {
    isPlaying: true, canPlay: true, canTogglePlaying: true
  });

  assert.strictEqual(MediaModel.performPlaybackAction(player, "play"), false,
    "an already playing player reports that nothing ran");
  assert.deepStrictEqual(log, [],
    "the desired state is already satisfied: playing must never toggle, that would pause it");
});

test("performPlaybackAction rejects playPause; callers normalize it first", function () {
  var log = [];
  var player = spyPlayer(log, "spotify", {
    isPlaying: true,
    canPlay: true,
    canPause: true,
    canGoNext: true,
    canGoPrevious: true,
    canTogglePlaying: true
  });

  assert.strictEqual(MediaModel.performPlaybackAction(player, "playPause"), false,
    "the generic playPause action must be refused by the executor");
  assert.deepStrictEqual(log, [],
    "refusing playPause must not touch any player method: the Service normalizes it to play or pause before executing");
});

var rejectedActions = ["stop", "Play", "PAUSE", "Next", "next ", "", "play-pause", "seek", null, undefined];

rejectedActions.forEach(function (action) {
  test("performPlaybackAction refuses the unknown action " + JSON.stringify(action), function () {
    var log = [];
    var player = spyPlayer(log, "spotify", {
      isPlaying: true,
      canPlay: true,
      canPause: true,
      canGoNext: true,
      canGoPrevious: true,
      canTogglePlaying: true
    });

    assert.strictEqual(MediaModel.performPlaybackAction(player, action), false,
      "unknown actions must report that nothing ran");
    assert.deepStrictEqual(log, [], "unknown actions must not touch any player method");
  });
});

test("performPlaybackAction rejects missing players without throwing", function () {
  assert.strictEqual(MediaModel.performPlaybackAction(null, "play"), false);
  assert.strictEqual(MediaModel.performPlaybackAction(undefined, "pause"), false);
  assert.strictEqual(MediaModel.performPlaybackAction(null, "next"), false);
  assert.strictEqual(MediaModel.performPlaybackAction(undefined, "previous"), false);
});

// ---------------------------------------------------------------------------
// MediaModel.visualizerShouldRun
// ---------------------------------------------------------------------------

var visualizerMatrix = [
  {
    name: "an available visualizer and a playing player",
    player: { isPlaying: true },
    available: true,
    expected: true
  },
  {
    name: "an available visualizer but a paused player",
    player: { isPlaying: false },
    available: true,
    expected: false
  },
  {
    name: "an available visualizer but no player at all",
    player: null,
    available: true,
    expected: false
  },
  {
    name: "an unavailable visualizer even while a player plays",
    player: { isPlaying: true },
    available: false,
    expected: false
  },
  {
    name: "an undefined player",
    player: undefined,
    available: true,
    expected: false
  },
  {
    name: "a player without an isPlaying flag",
    player: {},
    available: true,
    expected: false
  },
  {
    name: "an omitted availability flag",
    player: { isPlaying: true },
    expected: false
  }
];

visualizerMatrix.forEach(function (row) {
  test("visualizerShouldRun returns " + row.expected + " for " + row.name, function () {
    assert.strictEqual(MediaModel.visualizerShouldRun(row.player, row.available),
      row.expected, "the wanted state must be an exact boolean, not a coerced truthy value");
  });
});

// ---------------------------------------------------------------------------
// sequential source-transition scenario
// ---------------------------------------------------------------------------

// One continuous model walk of the one-click, confirmation-driven policy.
// Each target receives PlayPause first; only its authoritative Playing state
// permits the outgoing source to receive Pause. The shared log pins both
// Chrome→Spotify and Spotify→Chrome ordering, and visualizer state follows the
// selected source throughout.
test("one-click handoff starts each target before pausing its outgoing source", function () {
  var log = [];
  var chrome = spyPlayer(log, "chromium", {
    isPlaying: true, canPlay: true, canPause: true, canTogglePlaying: true
  });
  var spotify = spyPlayer(log, "spotify", {
    isPlaying: false, canPlay: true, canPause: true, canTogglePlaying: true
  });

  var active = chrome;
  assert.strictEqual(MediaModel.visualizerShouldRun(active, true), true,
    "the visualizer starts on the currently playing source");

  var toSpotify = MediaModel.sourceHandoffPlan(
    chrome, spotify, true, chrome.isPlaying, spotify.isPlaying);
  assert.strictEqual(toSpotify.startTarget, true);
  assert.strictEqual(toSpotify.waitForTarget, true);
  assert.strictEqual(toSpotify.pauseCurrent, false);
  assert.strictEqual(MediaModel.performPlaybackAction(spotify, "play"), true);
  assert.deepStrictEqual(log, [{ action: "toggle", player: "spotify" }],
    "Spotify starts before Chrome receives any pause");

  var spotifyPending = {
    fromKey: MediaModel.playerKey(chrome),
    toKey: MediaModel.playerKey(spotify)
  };
  assert.strictEqual(MediaModel.sourceHandoffConfirmed(spotifyPending, spotify), true);
  assert.strictEqual(MediaModel.performPlaybackAction(chrome, "pause"), true);
  assert.deepStrictEqual(log, [
    { action: "toggle", player: "spotify" },
    { action: "toggle", player: "chromium" }
  ], "Chrome pauses only after Spotify confirms Playing");

  active = spotify;
  assert.strictEqual(spotify.isPlaying, true);
  assert.strictEqual(chrome.isPlaying, false);
  assert.strictEqual(MediaModel.visualizerShouldRun(active, true), true,
    "the visualizer follows the confirmed Spotify target");
  log.length = 0;

  var toChrome = MediaModel.sourceHandoffPlan(
    spotify, chrome, true, spotify.isPlaying, chrome.isPlaying);
  assert.strictEqual(toChrome.startTarget, true);
  assert.strictEqual(toChrome.waitForTarget, true);
  assert.strictEqual(toChrome.pauseCurrent, false);
  assert.strictEqual(MediaModel.performPlaybackAction(chrome, "play"), true);
  assert.deepStrictEqual(log, [{ action: "toggle", player: "chromium" }],
    "Chrome starts before Spotify receives any pause");

  var chromePending = {
    fromKey: MediaModel.playerKey(spotify),
    toKey: MediaModel.playerKey(chrome)
  };
  assert.strictEqual(MediaModel.sourceHandoffConfirmed(chromePending, chrome), true);
  assert.strictEqual(MediaModel.performPlaybackAction(spotify, "pause"), true);
  assert.deepStrictEqual(log, [
    { action: "toggle", player: "chromium" },
    { action: "toggle", player: "spotify" }
  ], "Spotify pauses only after Chrome confirms Playing");

  active = chrome;
  assert.strictEqual(chrome.isPlaying, true);
  assert.strictEqual(spotify.isPlaying, false);
  assert.strictEqual(MediaModel.visualizerShouldRun(active, true), true,
    "the visualizer follows the confirmed Chrome target");

  assert.strictEqual(MediaModel.performPlaybackAction(chrome, "pause"), true);
  assert.strictEqual(MediaModel.visualizerShouldRun(active, true), false,
    "pausing the selected source still clears the visualizer");
});

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

console.log("");
console.log(passedCount + " passed, " + failedCount + " failed");
if (failedCount > 0) process.exitCode = 1;
