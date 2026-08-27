"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const MediaModel = require("../MediaModel.js");

const optionalBooleans = [undefined, false, true];

function player(key, playing) {
  return {
    dbusName: `org.mpris.MediaPlayer2.${key}`,
    isPlaying: playing
  };
}

function expectedPlan(current, target, enabled, currentOverride,
                      targetOverride, requestedOverride) {
  if (!enabled || !target) {
    return {
      valid: false,
      startTarget: false,
      pauseCurrent: false,
      waitForTarget: false
    };
  }

  const currentState = Boolean(current) && (
    typeof currentOverride === "boolean"
      ? currentOverride
      : Boolean(current.isPlaying)
  );
  const targetState = typeof targetOverride === "boolean"
    ? targetOverride
    : Boolean(target.isPlaying);
  const requestedState = typeof requestedOverride === "boolean"
    ? requestedOverride
    : targetState;
  const samePlayer = Boolean(current)
    && MediaModel.playerKey(current) === MediaModel.playerKey(target);

  return {
    valid: true,
    startTarget: !requestedState,
    pauseCurrent: !samePlayer && currentState && targetState,
    waitForTarget: !samePlayer && currentState && !targetState
  };
}

for (const targetActual of [false, true]) {
  for (const targetRequested of optionalBooleans) {
    test(`handoff plan no outgoing targetActual=${targetActual} requested=${targetRequested === undefined ? "default" : targetRequested}`, () => {
      const target = player("youtube", targetActual);
      const actual = MediaModel.sourceHandoffPlan(
        null, target, true, undefined, targetActual, targetRequested);
      assert.deepEqual(actual, expectedPlan(
        null, target, true, undefined, targetActual, targetRequested));
    });
  }
}

for (const relation of ["different", "same"]) {
  for (const currentActual of [false, true]) {
    for (const currentOverride of optionalBooleans) {
      for (const targetActual of [false, true]) {
        for (const targetRequested of optionalBooleans) {
          const name = [
            `relation=${relation}`,
            `currentActual=${currentActual}`,
            `currentEffective=${currentOverride === undefined ? "default" : currentOverride}`,
            `targetActual=${targetActual}`,
            `targetRequested=${targetRequested === undefined ? "default" : targetRequested}`
          ].join(" ");

          test(`handoff plan ${name}`, () => {
            const target = player("youtube", targetActual);
            const current = relation === "same"
              ? player("youtube", currentActual)
              : player("spotify", currentActual);
            const actual = MediaModel.sourceHandoffPlan(
              current,
              target,
              true,
              currentOverride,
              targetActual,
              targetRequested
            );
            assert.deepEqual(actual, expectedPlan(
              current,
              target,
              true,
              currentOverride,
              targetActual,
              targetRequested
            ));
          });
        }
      }
    }
  }
}

const invalidCurrentModes = [
  null,
  player("spotify", false),
  player("spotify", true),
  player("youtube", false),
  player("youtube", true)
];

invalidCurrentModes.forEach((current, currentIndex) => {
  for (const targetPresent of [false, true]) {
    for (const enabled of [false, true]) {
      if (enabled && targetPresent) continue;
      test(`handoff invalid current=${currentIndex} targetPresent=${targetPresent} enabled=${enabled}`, () => {
        const target = targetPresent ? player("youtube", false) : null;
        assert.deepEqual(
          MediaModel.sourceHandoffPlan(current, target, enabled, true, false, false),
          {
            valid: false,
            startTarget: false,
            pauseCurrent: false,
            waitForTarget: false
          }
        );
      });
    }
  }
});

const pendingModes = [
  { name: "missing", value: null },
  { name: "empty", value: {} },
  { name: "empty target key", value: { fromKey: "spotify", toKey: "" } },
  { name: "matching target", value: { fromKey: "spotify", toKey: "org.mpris.MediaPlayer2.youtube" } },
  { name: "wrong target", value: { fromKey: "spotify", toKey: "org.mpris.MediaPlayer2.firefox" } }
];
const playerModes = [
  { name: "missing", value: null },
  { name: "matching paused", value: player("youtube", false) },
  { name: "matching playing", value: player("youtube", true) },
  { name: "wrong paused", value: player("firefox", false) },
  { name: "wrong playing", value: player("firefox", true) },
  { name: "keyless playing", value: { isPlaying: true } }
];

pendingModes.forEach(pendingMode => {
  playerModes.forEach(playerMode => {
    test(`handoff confirmation pending=${pendingMode.name} player=${playerMode.name}`, () => {
      const pending = pendingMode.value;
      const target = playerMode.value;
      const expected = Boolean(
        pending
        && pending.toKey
        && target
        && target.isPlaying
        && MediaModel.playerKey(target) === pending.toKey
      );
      assert.equal(MediaModel.sourceHandoffConfirmed(pending, target), expected);
    });
  });
});

const invariantScenarios = [
  {
    name: "paused target with playing outgoing starts and waits",
    current: player("spotify", true),
    target: player("youtube", false),
    currentEffective: true,
    targetActual: false,
    targetRequested: false,
    expected: ["start-target", "wait"]
  },
  {
    name: "failed target never authorizes outgoing pause",
    current: player("spotify", true),
    target: player("youtube", false),
    currentEffective: true,
    targetActual: false,
    targetRequested: true,
    expected: ["wait"]
  },
  {
    name: "already-playing target pauses outgoing without replay",
    current: player("spotify", true),
    target: player("youtube", true),
    currentEffective: true,
    targetActual: true,
    targetRequested: true,
    expected: ["pause-current"]
  },
  {
    name: "no outgoing starts paused target without wait",
    current: null,
    target: player("youtube", false),
    currentEffective: false,
    targetActual: false,
    targetRequested: false,
    expected: ["start-target"]
  },
  {
    name: "same paused source starts without self-pause",
    current: player("youtube", false),
    target: player("youtube", false),
    currentEffective: false,
    targetActual: false,
    targetRequested: false,
    expected: ["start-target"]
  },
  {
    name: "same playing source is a no-op",
    current: player("youtube", true),
    target: player("youtube", true),
    currentEffective: true,
    targetActual: true,
    targetRequested: true,
    expected: []
  },
  {
    name: "optimistic outgoing play is treated as audible",
    current: player("spotify", false),
    target: player("youtube", false),
    currentEffective: true,
    targetActual: false,
    targetRequested: false,
    expected: ["start-target", "wait"]
  },
  {
    name: "optimistic target play is awaited without duplicate toggle",
    current: player("spotify", true),
    target: player("youtube", false),
    currentEffective: true,
    targetActual: false,
    targetRequested: true,
    expected: ["wait"]
  },
  {
    name: "paused outgoing does not create a confirmation dependency",
    current: player("spotify", false),
    target: player("youtube", false),
    currentEffective: false,
    targetActual: false,
    targetRequested: false,
    expected: ["start-target"]
  },
  {
    name: "target confirmation never depends on outgoing existence",
    current: null,
    target: player("youtube", true),
    currentEffective: false,
    targetActual: true,
    targetRequested: true,
    expected: []
  }
];

invariantScenarios.forEach(row => {
  test(`handoff invariant: ${row.name}`, () => {
    const plan = MediaModel.sourceHandoffPlan(
      row.current,
      row.target,
      true,
      row.currentEffective,
      row.targetActual,
      row.targetRequested
    );
    const actions = [];
    if (plan.startTarget) actions.push("start-target");
    if (plan.pauseCurrent) actions.push("pause-current");
    if (plan.waitForTarget) actions.push("wait");
    assert.deepEqual(actions, row.expected);
  });
});

test("authoritative Playing is the only event that confirms a pending target", () => {
  const target = player("youtube", false);
  const pending = {
    fromKey: "org.mpris.MediaPlayer2.spotify",
    toKey: MediaModel.playerKey(target)
  };
  assert.equal(MediaModel.sourceHandoffConfirmed(pending, target), false);
  target.isPlaying = true;
  assert.equal(MediaModel.sourceHandoffConfirmed(pending, target), true);
  target.isPlaying = false;
  assert.equal(MediaModel.sourceHandoffConfirmed(pending, target), false);
});

test("handoff confirmation accepts synchronized stream state over stale MPRIS", () => {
  const target = player("youtube", false);
  const pending = {
    fromKey: "org.mpris.MediaPlayer2.spotify",
    toKey: MediaModel.playerKey(target)
  };
  assert.equal(
    MediaModel.sourceHandoffConfirmed(pending, target, true),
    true
  );
  target.isPlaying = true;
  assert.equal(
    MediaModel.sourceHandoffConfirmed(pending, target, false),
    false
  );
});

test("handoff resolution confirms a stream-playing target with stale MPRIS", () => {
  const target = player("youtube", false);
  const pending = {
    fromKey: "org.mpris.MediaPlayer2.spotify",
    toKey: MediaModel.playerKey(target)
  };
  assert.equal(
    MediaModel.sourceHandoffResolution(
      pending, target, player("spotify", true), "playingChanged", true),
    "confirm"
  );
});

const resolutionPendingModes = [
  { name: "missing", value: null },
  {
    name: "present",
    value: {
      fromKey: "org.mpris.MediaPlayer2.spotify",
      toKey: "org.mpris.MediaPlayer2.youtube"
    }
  }
];
const resolutionTargetModes = [
  { name: "missing", value: null },
  { name: "matching-paused", value: player("youtube", false) },
  { name: "matching-playing", value: player("youtube", true) },
  { name: "wrong-playing", value: player("firefox", true) }
];
const resolutionEvents = [
  "timeout",
  "playersChanged",
  "playingChanged",
  "unknown"
];

resolutionPendingModes.forEach(pendingMode => {
  resolutionTargetModes.forEach(targetMode => {
    for (const outgoingPresent of [false, true]) {
      resolutionEvents.forEach(event => {
        test(`handoff resolution pending=${pendingMode.name} target=${targetMode.name} outgoing=${outgoingPresent} event=${event}`, () => {
          const pending = pendingMode.value;
          const target = targetMode.value;
          const outgoing = outgoingPresent ? player("spotify", true) : null;
          let expected = "none";
          if (pending) {
            const confirmed = Boolean(
              target
              && target.isPlaying
              && MediaModel.playerKey(target) === pending.toKey
            );
            if (confirmed) {
              expected = "confirm";
            } else if (event === "timeout") {
              expected = "rollback";
            } else if (event === "playersChanged") {
              expected = !target ? "rollback" : (!outgoing ? "clear" : "wait");
            } else if (event === "playingChanged") {
              expected = "wait";
            }
          }
          assert.equal(
            MediaModel.sourceHandoffResolution(
              pending, target, outgoing, event),
            expected
          );
        });
      });
    }
  });
});

const supersessionPendingModes = [
  { name: "missing", value: null },
  { name: "empty", value: {} },
  { name: "youtube", value: { toKey: "youtube" } },
  { name: "spotify", value: { toKey: "spotify" } }
];
for (const pendingMode of supersessionPendingModes) {
  for (const targetKey of ["", "youtube", "spotify"]) {
    test(`handoff supersession pending=${pendingMode.name} target=${targetKey || "empty"}`, () => {
      const expected = !pendingMode.value
        ? "none"
        : (pendingMode.value.toKey === targetKey ? "same" : "replace");
      assert.equal(
        MediaModel.sourceHandoffSupersession(pendingMode.value, targetKey),
        expected
      );
    });
  }
}
