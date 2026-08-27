"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const MediaModel = require("../MediaModel.js");

const optionalBooleans = [undefined, false, true];

function actionPlayer(options = {}) {
  const log = [];
  const player = {
    dbusName: options.dbusName || "org.mpris.MediaPlayer2.fixture",
    isPlaying: Boolean(options.isPlaying),
    canTogglePlaying: Boolean(options.canTogglePlaying),
    canPlay: Boolean(options.canPlay),
    canPause: Boolean(options.canPause),
    canGoNext: Boolean(options.canGoNext),
    canGoPrevious: Boolean(options.canGoPrevious),
    togglePlaying() { log.push("toggle"); },
    play() { log.push("play"); },
    pause() { log.push("pause"); },
    next() { log.push("next"); },
    previous() { log.push("previous"); }
  };
  return { player, log };
}

for (const actualPlaying of [false, true]) {
  for (const playingOverride of optionalBooleans) {
    for (const canTogglePlaying of [false, true]) {
      for (const canPlay of [false, true]) {
        test(`play action actual=${actualPlaying} effective=${playingOverride === undefined ? "default" : playingOverride} toggle=${canTogglePlaying} play=${canPlay}`, () => {
          const { player, log } = actionPlayer({
            isPlaying: actualPlaying,
            canTogglePlaying,
            canPlay
          });
          const effective = typeof playingOverride === "boolean"
            ? playingOverride : actualPlaying;
          const expectedAction = canPlay
            ? "play"
            : (!effective && canTogglePlaying ? "toggle" : null);
          const handled = MediaModel.performPlaybackAction(
            player, "play", playingOverride);

          assert.equal(handled, expectedAction !== null);
          assert.deepEqual(log, expectedAction === null ? [] : [expectedAction]);
        });
      }
    }
  }
}

for (const actualPlaying of [false, true]) {
  for (const playingOverride of optionalBooleans) {
    for (const canTogglePlaying of [false, true]) {
      for (const canPause of [false, true]) {
        test(`pause action actual=${actualPlaying} effective=${playingOverride === undefined ? "default" : playingOverride} toggle=${canTogglePlaying} pause=${canPause}`, () => {
          const { player, log } = actionPlayer({
            isPlaying: actualPlaying,
            canTogglePlaying,
            canPause
          });
          const effective = typeof playingOverride === "boolean"
            ? playingOverride : actualPlaying;
          const expectedAction = canPause
            ? "pause"
            : (effective && canTogglePlaying ? "toggle" : null);
          const handled = MediaModel.performPlaybackAction(
            player, "pause", playingOverride);

          assert.equal(handled, expectedAction !== null);
          assert.deepEqual(log, expectedAction === null ? [] : [expectedAction]);
        });
      }
    }
  }
}

const capabilityNames = [
  "canTogglePlaying",
  "canPlay",
  "canPause",
  "canGoNext",
  "canGoPrevious"
];

for (let mask = 0; mask < 32; mask++) {
  const capabilities = {};
  capabilityNames.forEach((name, index) => {
    capabilities[name] = (mask & (1 << index)) !== 0;
  });

  for (const action of ["next", "previous"]) {
    test(`${action} capability noise mask=${mask.toString(2).padStart(5, "0")}`, () => {
      const { player, log } = actionPlayer(capabilities);
      const capable = action === "next"
        ? capabilities.canGoNext
        : capabilities.canGoPrevious;
      assert.equal(MediaModel.performPlaybackAction(player, action), capable);
      assert.deepEqual(log, capable ? [action] : []);
    });
  }
}

const rejectedActions = [
  "playPause",
  "stop",
  "Play",
  "PAUSE",
  "Next",
  "next ",
  " play",
  "play-pause",
  "seek",
  "",
  null,
  undefined,
  0,
  false
];

for (const capable of [false, true]) {
  rejectedActions.forEach((action, index) => {
    test(`rejected action index=${index} allCapabilities=${capable}`, () => {
      const { player, log } = actionPlayer({
        isPlaying: true,
        canTogglePlaying: capable,
        canPlay: capable,
        canPause: capable,
        canGoNext: capable,
        canGoPrevious: capable
      });
      assert.equal(MediaModel.performPlaybackAction(player, action), false);
      assert.deepEqual(log, []);
    });
  });
}

for (const action of ["play", "pause", "next", "previous", "playPause", "stop"]) {
  test(`missing player rejects action=${action}`, () => {
    assert.equal(MediaModel.performPlaybackAction(null, action), false);
    assert.equal(MediaModel.performPlaybackAction(undefined, action), false);
  });
}

const expiryCases = [
  { label: "past", value: 999, valid: false },
  { label: "equal", value: 1000, valid: false },
  { label: "future", value: 1001, valid: true },
  { label: "NaN", value: NaN, valid: false },
  { label: "Infinity", value: Infinity, valid: false },
  { label: "string", value: "1001", valid: false }
];

for (const actualPlaying of [false, true]) {
  for (const desiredPlaying of [false, true]) {
    expiryCases.forEach(expiry => {
      test(`effective state actual=${actualPlaying} desired=${desiredPlaying} expiry=${expiry.label}`, () => {
        const player = {
          dbusName: "org.mpris.MediaPlayer2.fixture",
          isPlaying: actualPlaying
        };
        const intents = {
          "org.mpris.MediaPlayer2.fixture": {
            playing: desiredPlaying,
            expiresAt: expiry.value
          }
        };
        const expected = expiry.valid ? desiredPlaying : actualPlaying;
        assert.equal(MediaModel.effectivePlaying(player, intents, 1000), expected);
      });
    });
  }
}

const malformedIntentCases = [
  { name: "no intents", intents: null },
  { name: "empty intents", intents: {} },
  { name: "wrong key", intents: { other: { playing: true, expiresAt: 2000 } } },
  { name: "missing desired", intents: { "org.mpris.MediaPlayer2.fixture": { expiresAt: 2000 } } },
  { name: "string desired", intents: { "org.mpris.MediaPlayer2.fixture": { playing: "true", expiresAt: 2000 } } },
  { name: "missing expiry", intents: { "org.mpris.MediaPlayer2.fixture": { playing: true } } },
  { name: "null intent", intents: { "org.mpris.MediaPlayer2.fixture": null } }
];

for (const actualPlaying of [false, true]) {
  malformedIntentCases.forEach(row => {
    test(`effective state fallback actual=${actualPlaying} case=${row.name}`, () => {
      const player = {
        dbusName: "org.mpris.MediaPlayer2.fixture",
        isPlaying: actualPlaying
      };
      assert.equal(
        MediaModel.effectivePlaying(player, row.intents, 1000),
        actualPlaying
      );
    });
  });
}

test("effective state rejects missing player regardless of intent", () => {
  const intents = {
    fixture: { playing: true, expiresAt: 2000 }
  };
  assert.equal(MediaModel.effectivePlaying(null, intents, 1000), false);
  assert.equal(MediaModel.effectivePlaying(undefined, intents, 1000), false);
});

const rapidSequences = [
  ["play", "pause"],
  ["pause", "play"],
  ["play", "pause", "play"],
  ["pause", "play", "pause"],
  ["play", "pause", "play", "pause"],
  ["pause", "play", "pause", "play"]
];

rapidSequences.forEach(sequence => {
  test(`rapid stale-property sequence=${sequence.join("->")}`, () => {
    const { player, log } = actionPlayer({
      isPlaying: sequence[0] === "pause",
      canTogglePlaying: true
    });
    let effectivePlaying = player.isPlaying;

    sequence.forEach(action => {
      assert.equal(
        MediaModel.performPlaybackAction(player, action, effectivePlaying),
        true
      );
      effectivePlaying = action === "play";
    });

    assert.deepEqual(log, sequence.map(() => "toggle"));
    assert.equal(player.isPlaying, sequence[0] === "pause",
      "authoritative fixture property intentionally remains stale");
  });
});

test("generic players prefer idempotent dedicated methods over toggle", () => {
  const playFixture = actionPlayer({
    isPlaying: false,
    canTogglePlaying: true,
    canPlay: true
  });
  assert.equal(MediaModel.performPlaybackAction(playFixture.player, "play"), true);
  assert.deepEqual(playFixture.log, ["play"]);

  const pauseFixture = actionPlayer({
    isPlaying: true,
    canTogglePlaying: true,
    canPause: true
  });
  assert.equal(MediaModel.performPlaybackAction(pauseFixture.player, "pause"), true);
  assert.deepEqual(pauseFixture.log, ["pause"]);
});

test("spotify-player uses guarded toggle for Play but dedicated Pause", () => {
  const playFixture = actionPlayer({
    dbusName: "org.mpris.MediaPlayer2.spotify_player",
    isPlaying: false,
    canTogglePlaying: true,
    canPlay: true,
    canPause: true
  });
  assert.equal(MediaModel.playerRequiresTogglePlay(playFixture.player), true);
  assert.equal(MediaModel.performPlaybackAction(playFixture.player, "play"), true);
  assert.deepEqual(playFixture.log, ["toggle"]);

  const alreadyPlaying = actionPlayer({
    dbusName: "org.mpris.MediaPlayer2.spotify_player",
    isPlaying: true,
    canTogglePlaying: true,
    canPlay: true
  });
  assert.equal(MediaModel.performPlaybackAction(alreadyPlaying.player, "play"), false);
  assert.deepEqual(alreadyPlaying.log, []);

  const pauseFixture = actionPlayer({
    dbusName: "org.mpris.MediaPlayer2.spotify_player",
    isPlaying: true,
    canTogglePlaying: true,
    canPause: true
  });
  assert.equal(MediaModel.performPlaybackAction(pauseFixture.player, "pause"), true);
  assert.deepEqual(pauseFixture.log, ["pause"]);
});

test("dedicated methods dispatch despite stale confirmed state", () => {
  const stalePlay = actionPlayer({
    isPlaying: true,
    canPlay: true,
    canTogglePlaying: true
  });
  assert.equal(MediaModel.performPlaybackAction(stalePlay.player, "play", true), true);
  assert.deepEqual(stalePlay.log, ["play"]);

  const stalePause = actionPlayer({
    isPlaying: false,
    canPause: true,
    canTogglePlaying: true
  });
  assert.equal(MediaModel.performPlaybackAction(stalePause.player, "pause", false), true);
  assert.deepEqual(stalePause.log, ["pause"]);
});

const suppressionProfiles = [
  {
    name: "chromium-dedicated",
    player: {
      dbusName: "org.mpris.MediaPlayer2.chromium",
      canPause: true
    }
  },
  {
    name: "spotify-player",
    player: {
      dbusName: "org.mpris.MediaPlayer2.spotify_player",
      canPause: true
    }
  },
  {
    name: "toggle-only",
    player: {
      dbusName: "org.mpris.MediaPlayer2.toggle_only",
      canPause: false
    }
  }
];

for (const profile of suppressionProfiles) {
  for (const action of ["play", "pause", "next"]) {
    for (const intentState of [null, false, true]) {
      for (const confirmedPlaying of [false, true]) {
        test(`pending action suppression profile=${profile.name} action=${action} intent=${intentState} confirmed=${confirmedPlaying}`, () => {
          const requiresTogglePlay = profile.name === "spotify-player";
          const expected = action === "play"
            ? intentState === true && !confirmedPlaying && requiresTogglePlay
            : (action === "pause"
              ? intentState === false
                && confirmedPlaying
                && !profile.player.canPause
              : false);
          assert.equal(
            MediaModel.shouldSuppressPendingPlaybackAction(
              profile.player, action, intentState, confirmedPlaying),
            expected
          );
        });
      }
    }
  }
}

test("pending action suppression rejects missing player", () => {
  assert.equal(
    MediaModel.shouldSuppressPendingPlaybackAction(
      null, "play", true, false),
    false
  );
});

test("repeated dedicated Pause is idempotently dispatched", () => {
  const chrome = actionPlayer({
    dbusName: "org.mpris.MediaPlayer2.chromium",
    isPlaying: true,
    canPause: true,
    canTogglePlaying: true
  });
  assert.equal(MediaModel.performPlaybackAction(
    chrome.player, "pause", true), true);
  assert.equal(MediaModel.performPlaybackAction(
    chrome.player, "pause", true), true);
  assert.deepEqual(chrome.log, ["pause", "pause"]);
});

const dedicatedStateCases = [
  {
    name: "Chromium Play",
    player: { dbusName: "org.mpris.MediaPlayer2.chromium", canPlay: true },
    action: "play",
    expected: true
  },
  {
    name: "Chromium Pause",
    player: { dbusName: "org.mpris.MediaPlayer2.chromium", canPause: true },
    action: "pause",
    expected: false
  },
  {
    name: "Spotify toggle Play waits for confirmation",
    player: {
      dbusName: "org.mpris.MediaPlayer2.spotify_player",
      canPlay: true,
      canTogglePlaying: true
    },
    action: "play",
    expected: null
  },
  {
    name: "Spotify dedicated Pause",
    player: {
      dbusName: "org.mpris.MediaPlayer2.spotify_player",
      canPause: true,
      canTogglePlaying: true
    },
    action: "pause",
    expected: false
  },
  {
    name: "toggle-only Play",
    player: { canTogglePlaying: true },
    action: "play",
    expected: null
  },
  {
    name: "toggle-only Pause",
    player: { canTogglePlaying: true },
    action: "pause",
    expected: null
  },
  {
    name: "unsupported action",
    player: { canPlay: true, canPause: true },
    action: "next",
    expected: null
  },
  {
    name: "missing player",
    player: null,
    action: "pause",
    expected: null
  }
];

dedicatedStateCases.forEach(row => {
  test(`dedicated command confirmation: ${row.name}`, () => {
    assert.equal(
      MediaModel.dedicatedPlaybackCommandState(row.player, row.action),
      row.expected
    );
  });
});

test("toggle Play reset is limited to fully controllable spotify-player", () => {
  assert.equal(MediaModel.playerNeedsTogglePlayReset({
    dbusName: "org.mpris.MediaPlayer2.spotify_player",
    canPause: true,
    canTogglePlaying: true
  }), true);
  assert.equal(MediaModel.playerNeedsTogglePlayReset({
    dbusName: "org.mpris.MediaPlayer2.spotify_player",
    canPause: false,
    canTogglePlaying: true
  }), false);
  assert.equal(MediaModel.playerNeedsTogglePlayReset({
    dbusName: "org.mpris.MediaPlayer2.chromium",
    canPause: true,
    canTogglePlaying: true
  }), false);
  assert.equal(MediaModel.playerNeedsTogglePlayReset(null), false);
});
