"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const MediaModel = require("../MediaModel.js");

function player(playing) {
  return {
    dbusName: "org.mpris.MediaPlayer2.fixture",
    isPlaying: playing
  };
}

const expiryModes = [
  { name: "past", value: 999, valid: false },
  { name: "equal", value: 1000, valid: false },
  { name: "future", value: 1001, valid: true },
  { name: "NaN", value: NaN, valid: false },
  { name: "Infinity", value: Infinity, valid: false },
  { name: "string", value: "1001", valid: false }
];

for (const desired of [false, true]) {
  for (const expiry of expiryModes) {
    test(`intent state desired=${desired} expiry=${expiry.name}`, () => {
      const fixture = player(false);
      const intents = {
        "org.mpris.MediaPlayer2.fixture": {
          playing: desired,
          expiresAt: expiry.value
        }
      };
      assert.equal(
        MediaModel.playbackIntentState(fixture, intents, 1000),
        expiry.valid ? desired : null
      );
    });
  }
}

const malformedIntentModes = [
  { name: "no-map", intents: null },
  { name: "empty-map", intents: {} },
  { name: "wrong-key", intents: { wrong: { playing: true, expiresAt: 2000 } } },
  { name: "null-intent", intents: { "org.mpris.MediaPlayer2.fixture": null } },
  { name: "missing-playing", intents: { "org.mpris.MediaPlayer2.fixture": { expiresAt: 2000 } } },
  { name: "string-playing", intents: { "org.mpris.MediaPlayer2.fixture": { playing: "true", expiresAt: 2000 } } },
  { name: "missing-expiry", intents: { "org.mpris.MediaPlayer2.fixture": { playing: true } } }
];

malformedIntentModes.forEach(row => {
  test(`intent state malformed=${row.name}`, () => {
    assert.equal(
      MediaModel.playbackIntentState(player(false), row.intents, 1000),
      null
    );
  });
});

test("intent state rejects missing player", () => {
  assert.equal(MediaModel.playbackIntentState(null, {}, 1000), null);
  assert.equal(MediaModel.playbackIntentState(undefined, {}, 1000), null);
});

const intentModes = [
  { name: "none", value: null, expected: null },
  { name: "play", value: { playing: true, expiresAt: 2000 }, expected: true },
  { name: "pause", value: { playing: false, expiresAt: 2000 }, expected: false },
  { name: "expired-play", value: { playing: true, expiresAt: 999 }, expected: null },
  { name: "expired-pause", value: { playing: false, expiresAt: 999 }, expected: null }
];
const streamModes = [
  { name: "unobserved", include: false, value: undefined },
  { name: "absent", include: true, value: false },
  { name: "present", include: true, value: true }
];

for (const actual of [false, true]) {
  for (const intentMode of intentModes) {
    for (const streamMode of streamModes) {
      test(`synchronized playing actual=${actual} intent=${intentMode.name} stream=${streamMode.name}`, () => {
        const fixture = player(actual);
        const intents = {};
        if (intentMode.value) {
          intents[MediaModel.playerKey(fixture)] = intentMode.value;
        }
        const streams = {};
        if (streamMode.include) {
          streams[MediaModel.playerKey(fixture)] = streamMode.value;
        }
        const expected = typeof intentMode.expected === "boolean"
          ? intentMode.expected
          : (streamMode.include ? streamMode.value : actual);
        assert.equal(
          MediaModel.synchronizedPlaying(fixture, intents, streams, 1000),
          expected
        );
      });
    }
  }
}

test("synchronized playing rejects missing player", () => {
  assert.equal(MediaModel.synchronizedPlaying(null, {}, {}, 1000), false);
  assert.equal(MediaModel.synchronizedPlaying(undefined, {}, {}, 1000), false);
});

const previousModes = [
  { name: "undefined", value: undefined },
  { name: "null", value: null },
  { name: "absent", value: false },
  { name: "present", value: true }
];
const intentStateModes = [
  { name: "none", value: null },
  { name: "pause", value: false },
  { name: "play", value: true }
];

for (const previousMode of previousModes) {
  for (const present of [false, true]) {
    test(`next stream state previous=${previousMode.name} present=${present}`, () => {
      const expected = present
        ? true
        : (typeof previousMode.value === "boolean" ? false : null);
      assert.equal(
        MediaModel.nextStreamPlayerState(previousMode.value, present),
        expected
      );
    });

    for (const intentMode of intentStateModes) {
      test(`stream/intent contradiction previous=${previousMode.name} present=${present} intent=${intentMode.name}`, () => {
        const changed = typeof previousMode.value === "boolean"
          ? previousMode.value !== present
          : present;
        const expected = changed
          && typeof intentMode.value === "boolean"
          && intentMode.value !== present;
        assert.equal(
          MediaModel.streamTransitionContradictsIntent(
            previousMode.value, present, intentMode.value),
          expected
        );
      });
    }
  }
}

function binarySequences(length) {
  const values = [];
  for (let mask = 0; mask < (1 << length); mask++) {
    values.push(Array.from({ length }, (_, index) =>
      (mask & (1 << index)) !== 0));
  }
  return values;
}

for (let length = 1; length <= 5; length++) {
  for (const sequence of binarySequences(length)) {
    test(`stream lifecycle sequence=${sequence.map(value => value ? "1" : "0").join("")}`, () => {
      let state;
      let seenPresent = false;
      sequence.forEach(present => {
        state = MediaModel.nextStreamPlayerState(state, present);
        if (present) seenPresent = true;
        assert.equal(state, seenPresent ? present : null);
      });
    });
  }
}

const reconciliationScenarios = [
  {
    name: "external start overrides pending pause",
    previous: false,
    present: true,
    intent: false,
    contradicts: true
  },
  {
    name: "external stop overrides pending play",
    previous: true,
    present: false,
    intent: true,
    contradicts: true
  },
  {
    name: "play stream acknowledges pending play",
    previous: false,
    present: true,
    intent: true,
    contradicts: false
  },
  {
    name: "stream removal acknowledges pending pause",
    previous: true,
    present: false,
    intent: false,
    contradicts: false
  },
  {
    name: "unrelated stable present stream preserves pause intent",
    previous: true,
    present: true,
    intent: false,
    contradicts: false
  },
  {
    name: "unrelated stable absent stream preserves play intent",
    previous: false,
    present: false,
    intent: true,
    contradicts: false
  },
  {
    name: "first observed stream overrides pause intent",
    previous: undefined,
    present: true,
    intent: false,
    contradicts: true
  },
  {
    name: "unobserved absence does not reject play intent",
    previous: undefined,
    present: false,
    intent: true,
    contradicts: false
  }
];

reconciliationScenarios.forEach(row => {
  test(`stream reconciliation: ${row.name}`, () => {
    assert.equal(
      MediaModel.streamTransitionContradictsIntent(
        row.previous, row.present, row.intent),
      row.contradicts
    );
  });
});

for (const previousMode of previousModes) {
  for (const streamObserved of [false, true]) {
    for (const streamActive of [false, true]) {
      test(`link-aware stream state previous=${previousMode.name} observed=${streamObserved} active=${streamActive}`, () => {
        const expected = streamActive
          ? true
          : (streamObserved
            ? false
            : (typeof previousMode.value === "boolean" ? false : null));
        assert.equal(
          MediaModel.nextStreamPlayerState(
            previousMode.value, streamActive, streamObserved),
          expected
        );
      });
    }
  }
}

test("a first observed paused link is authoritative over stale playing MPRIS", () => {
  const fixture = player(true);
  const key = MediaModel.playerKey(fixture);
  const state = MediaModel.nextStreamPlayerState(undefined, false, true);
  assert.equal(state, false);
  assert.equal(
    MediaModel.synchronizedPlaying(fixture, {}, { [key]: state }, 1000),
    false
  );
});

test("an active link is authoritative over stale paused MPRIS", () => {
  const fixture = player(false);
  const key = MediaModel.playerKey(fixture);
  const state = MediaModel.nextStreamPlayerState(false, true, true);
  assert.equal(state, true);
  assert.equal(
    MediaModel.synchronizedPlaying(fixture, {}, { [key]: state }, 1000),
    true
  );
});
