#!/usr/bin/env node
//
// Contract tests for the temporal waveform visualizer.
//
//   node tests/AudioVisualizerModel.test.js
//
// Dependency-free (node built-ins only, plain-object fixtures, no mocks).
// Verifies the shared contract:
//   - AudioVisualizerModel.zeroLevels / clampUnit / advance
//   - MediaModel.playbackStreamForPlayer / playerHasPlaybackStream
//
"use strict";

var assert = require("assert");

var AudioVisualizerModel = require("../AudioVisualizerModel.js");
var MediaModel = require("../MediaModel.js");

var LEVEL_COUNT = 9;
var SAMPLE_MS = 40;
var ZERO_SNAP = 0.012;
var MAX_DECAY_FRAMES = 150;

var zeroLevels = AudioVisualizerModel.zeroLevels;
var clampUnit = AudioVisualizerModel.clampUnit;
var advance = AudioVisualizerModel.advance;

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
// AudioVisualizerModel
// ---------------------------------------------------------------------------

test("AudioVisualizerModel exports zeroLevels, clampUnit and advance", function () {
  assert.strictEqual(typeof zeroLevels, "function", "zeroLevels must be exported");
  assert.strictEqual(typeof clampUnit, "function", "clampUnit must be exported");
  assert.strictEqual(typeof advance, "function", "advance must be exported");
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
});

test("advance clamps and gates raw peaks", function () {
  var silent = zeroLevels(LEVEL_COUNT);
  assert.strictEqual(advance(silent, 4, 0, SAMPLE_MS, LEVEL_COUNT).peak, 1, "peaks above one clamp to one");
  assert.strictEqual(advance(silent, 1, 0, SAMPLE_MS, LEVEL_COUNT).peak, 1);
  var below = advance(silent, -2, 0, SAMPLE_MS, LEVEL_COUNT);
  assert.strictEqual(below.peak, 0, "negative peaks clamp to zero");
  assert.strictEqual(below.energy, 0);
  var invalid = advance(silent, NaN, 0.4, SAMPLE_MS, LEVEL_COUNT);
  assert.strictEqual(invalid.peak, 0, "NaN peaks gate to silence");
  assert.ok(invalid.energy < 0.4, "invalid input must never push energy upward");
});

test("advance snaps near-zero targets to silence", function () {
  var silent = zeroLevels(LEVEL_COUNT);
  var gated = advance(silent, 0.005, 0, SAMPLE_MS, LEVEL_COUNT);
  assert.strictEqual(gated.peak, 0, "targets below the snap threshold become zero");
  assert.strictEqual(gated.energy, 0);
  assert.deepStrictEqual(gated.levels, zeroLevels(LEVEL_COUNT));
  assert.strictEqual(advance(silent, ZERO_SNAP, 0, SAMPLE_MS, LEVEL_COUNT).peak, ZERO_SNAP,
    "the snap threshold itself still counts as signal");
});

test("advance returns peak, energy, live and a levels array", function () {
  var r = advance(zeroLevels(LEVEL_COUNT), 0.5, 0, SAMPLE_MS, LEVEL_COUNT);
  assert.ok(r && typeof r === "object", "advance returns an object");
  assert.ok("peak" in r);
  assert.ok("energy" in r);
  assert.ok("live" in r);
  assert.ok(Array.isArray(r.levels));
});

test("history holds exactly nine values, oldest first, newest appended", function () {
  var r = advance(zeroLevels(LEVEL_COUNT), 0.5, 0, SAMPLE_MS, LEVEL_COUNT);
  assert.strictEqual(r.levels.length, LEVEL_COUNT, "history length is exactly the requested count");
  assert.strictEqual(r.levels[LEVEL_COUNT - 1], r.energy, "the newest energy is appended at the end");
  assert.deepStrictEqual(r.levels.slice(0, LEVEL_COUNT - 1), zeroLevels(LEVEL_COUNT - 1),
    "prior zeros shift out from the front");
  assert.ok(r.energy > 0);
});

test("history slides a nine-frame window across a rising signal", function () {
  var levels = zeroLevels(LEVEL_COUNT);
  var energy = 0;
  var energies = [];
  for (var frame = 1; frame <= 12; frame++) {
    var target = Math.min(1, frame * 0.1);
    var r = advance(levels, target, energy, SAMPLE_MS, LEVEL_COUNT);
    energy = r.energy;
    energies.push(energy);
    levels = r.levels;
    assert.strictEqual(r.levels.length, LEVEL_COUNT);
  }
  for (var i = 1; i < energies.length; i++) {
    assert.ok(energies[i] > energies[i - 1], "rising targets must raise energy monotonically");
  }
  assert.deepStrictEqual(levels, energies.slice(-LEVEL_COUNT),
    "levels must be the last nine energies, oldest to newest");
  assert.strictEqual(levels[0], energies[3], "the oldest kept energy is frame four");
  assert.strictEqual(levels[LEVEL_COUNT - 1], energies[11], "the newest energy is frame twelve");
});

test("history length follows the requested count", function () {
  var r = advance(zeroLevels(9), 0.5, 0, SAMPLE_MS, 5);
  assert.strictEqual(r.levels.length, 5, "count overrides the incoming array length");
  assert.deepStrictEqual(r.levels, [0, 0, 0, 0, r.energy]);
});

test("the envelope attacks faster than it releases", function () {
  var silent = zeroLevels(LEVEL_COUNT);
  var attack = advance(silent, 1, 0.5, SAMPLE_MS, LEVEL_COUNT);
  var release = advance(silent, 0, 0.5, SAMPLE_MS, LEVEL_COUNT);
  assert.ok(attack.energy > 0.5, "attack rises toward the target");
  assert.ok(attack.energy <= 1, "attack never overshoots the target");
  assert.ok(release.energy >= 0, "release never undershoots zero");
  assert.ok(release.energy < 0.5, "release falls toward the target");
  assert.ok(attack.energy - 0.5 > 0.5 - release.energy,
    "a 24ms attack must cover more distance than a 110ms release in the same elapsed time");
});

test("silence decays to exactly zero within a bounded number of frames", function () {
  var levels = zeroLevels(LEVEL_COUNT);
  var energy = 1;
  var zeroFrame = -1;
  for (var frame = 0; frame < MAX_DECAY_FRAMES; frame++) {
    var r = advance(levels, 0, energy, SAMPLE_MS, LEVEL_COUNT);
    assert.ok(r.energy >= 0 && r.energy <= energy, "release is monotone non-increasing");
    energy = r.energy;
    levels = r.levels;
    if (zeroFrame === -1 && energy === 0) zeroFrame = frame;
  }
  assert.ok(zeroFrame !== -1,
    "energy must hit exactly zero within " + MAX_DECAY_FRAMES + " silent frames, not merely approach it");
  assert.deepStrictEqual(levels, zeroLevels(LEVEL_COUNT), "the history clears with the envelope");
  assert.ok(!advance(levels, 0, energy, SAMPLE_MS, LEVEL_COUNT).live,
    "settled silence reports no live signal");
});

test("repeated silence never fabricates motion", function () {
  var levels = zeroLevels(LEVEL_COUNT);
  var rawPeaks = [0, NaN, 0, -1, 0, 0.005, 0];
  var elapsedTimes = [SAMPLE_MS, 0, SAMPLE_MS, 5000, SAMPLE_MS, SAMPLE_MS, SAMPLE_MS];
  for (var i = 0; i < rawPeaks.length; i++) {
    var r = advance(levels, rawPeaks[i], 0, elapsedTimes[i], LEVEL_COUNT);
    assert.strictEqual(r.peak, 0, "silent frame " + i + " peak");
    assert.strictEqual(r.energy, 0, "silent frame " + i + " energy");
    assert.ok(!r.live, "silent frame " + i + " live");
    assert.deepStrictEqual(r.levels, zeroLevels(LEVEL_COUNT), "silent frame " + i + " levels");
    levels = r.levels;
  }
});

test("release depth scales with elapsed time", function () {
  var silent = zeroLevels(LEVEL_COUNT);
  var short = advance(silent, 0, 0.9, SAMPLE_MS, LEVEL_COUNT);
  var long = advance(silent, 0, 0.9, 5000, LEVEL_COUNT);
  assert.ok(short.energy > long.energy, "a longer silent gap releases further");
  assert.ok(long.energy < ZERO_SNAP, "a five second silent gap falls below the snap threshold");
});

test("a steady signal converges and then holds still", function () {
  var levels = zeroLevels(LEVEL_COUNT);
  var energy = 0;
  var energies = [];
  for (var frame = 0; frame < 60; frame++) {
    var r = advance(levels, 0.5, energy, SAMPLE_MS, LEVEL_COUNT);
    assert.strictEqual(r.peak, 0.5);
    assert.ok(r.live, "signal present means live");
    assert.ok(r.energy >= energy, "attack toward a steady target never dips");
    assert.ok(r.energy <= 0.5, "attack never overshoots a steady target");
    energy = r.energy;
    energies.push(energy);
    levels = r.levels;
  }
  assert.strictEqual(energies[57], energies[58], "converged frames must be identical");
  assert.strictEqual(energies[58], energies[59], "converged frames must be identical");
  assert.deepStrictEqual(levels, energies.slice(-LEVEL_COUNT));
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
    name: "exact beats partials on both sides",
    player: { desktopEntry: "spotify" },
    streams: [describedNode("Spotify Premium"), streamNode("Spotify"), streamNode("Spotify Web Player")],
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
    name: "empty stream list returns null",
    player: { desktopEntry: "vlc" },
    streams: [],
    expected: null
  },
  {
    name: "player without labels returns null",
    player: { trackTitle: "Only Metadata" },
    streams: [streamNode("Spotify")],
    expected: null
  },
  {
    name: "null player returns null",
    player: null,
    streams: [streamNode("Spotify")],
    expected: null
  },
  {
    name: "streams that are not an array return null",
    player: { desktopEntry: "vlc" },
    streams: undefined,
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
// summary
// ---------------------------------------------------------------------------

console.log("");
console.log(passedCount + " passed, " + failedCount + " failed");
if (failedCount > 0) process.exitCode = 1;
