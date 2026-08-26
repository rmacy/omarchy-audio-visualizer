"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const MediaModel = require("../MediaModel.js");

const overrideStates = [undefined, false, true];

for (const actualPlaying of [false, true]) {
  for (const playingOverride of overrideStates) {
    for (const hasTitle of [false, true]) {
      for (const hasIdentity of [false, true]) {
        for (const canPlay of [false, true]) {
          for (const canTogglePlaying of [false, true]) {
            const label = [
              `actual=${actualPlaying}`,
              `override=${playingOverride === undefined ? "none" : playingOverride}`,
              `title=${hasTitle}`,
              `identity=${hasIdentity}`,
              `canPlay=${canPlay}`,
              `canToggle=${canTogglePlaying}`
            ].join(" ");

            test(`source selectable/visible ${label}`, () => {
              const player = {
                dbusName: "org.mpris.MediaPlayer2.fixture",
                trackTitle: hasTitle ? "Track" : "",
                identity: hasIdentity ? "Fixture" : "",
                isPlaying: actualPlaying,
                canPlay,
                canTogglePlaying
              };
              const effectivePlaying = playingOverride === undefined
                ? actualPlaying : playingOverride;
              const hasMetadata = hasTitle || hasIdentity;
              const expectedSelectable = hasMetadata
                && (effectivePlaying || canPlay || canTogglePlaying);
              const expectedVisible = hasTitle || expectedSelectable;

              assert.equal(
                MediaModel.sourceIsSelectable(player, playingOverride),
                expectedSelectable
              );
              assert.equal(
                MediaModel.sourceIsVisible(player, playingOverride),
                expectedVisible
              );
            });
          }
        }
      }
    }
  }
}

const meaningfulFields = ["trackTitle", "trackArtist", "trackAlbum"];
for (let mask = 1; mask < (1 << meaningfulFields.length); mask++) {
  for (const canPlay of [false, true]) {
    for (const playing of [false, true]) {
      test(`meaningful row persistence mask=${mask.toString(2).padStart(3, "0")} canPlay=${canPlay} playing=${playing}`, () => {
        const player = {
          dbusName: "org.mpris.MediaPlayer2.chromium",
          identity: "Chromium",
          canPlay,
          isPlaying: playing
        };
        meaningfulFields.forEach((field, index) => {
          player[field] = (mask & (1 << index)) !== 0 ? field : "";
        });

        assert.equal(MediaModel.sourceIsVisible(player), true);
        assert.equal(MediaModel.sourceIsSelectable(player), playing || canPlay);
      });
    }
  }
}

const artOnlyCases = [
  { identity: "", canPlay: false, expectedVisible: false },
  { identity: "Chromium", canPlay: false, expectedVisible: false },
  { identity: "Chromium", canPlay: true, expectedVisible: true },
  { identity: "Chromium", canTogglePlaying: true, expectedVisible: true }
];

artOnlyCases.forEach((row, index) => {
  test(`art-only endpoint visibility case=${index}`, () => {
    const player = {
      dbusName: "org.mpris.MediaPlayer2.chromium",
      identity: row.identity,
      trackArtUrl: "file:///tmp/stale-art",
      isPlaying: false,
      canPlay: Boolean(row.canPlay),
      canTogglePlaying: Boolean(row.canTogglePlaying)
    };
    assert.equal(MediaModel.sourceIsVisible(player), row.expectedVisible);
  });
});

function permutations(values) {
  if (values.length < 2) return [values.slice()];
  const result = [];
  values.forEach((value, index) => {
    const rest = values.slice(0, index).concat(values.slice(index + 1));
    permutations(rest).forEach(permutation => {
      result.push([value].concat(permutation));
    });
  });
  return result;
}

function orderingFixtures() {
  return [
    {
      id: "chromium",
      dbusName: "org.mpris.MediaPlayer2.chromium.instance12",
      identity: "Chromium",
      trackTitle: "Zulu",
      isPlaying: false,
      canPlay: true
    },
    {
      id: "firefox",
      dbusName: "org.mpris.MediaPlayer2.firefox.instance3",
      identity: "Firefox",
      trackTitle: "Middle",
      isPlaying: true,
      canPlay: false
    },
    {
      id: "spotify",
      dbusName: "org.mpris.MediaPlayer2.spotify",
      identity: "Spotify Player",
      trackTitle: "Alpha",
      isPlaying: true,
      canPlay: true
    },
    {
      id: "proxy",
      dbusName: "org.mpris.MediaPlayer2.playerctld",
      identity: "A Proxy That Sorts Last",
      trackTitle: "Aardvark",
      isPlaying: true,
      canPlay: true
    }
  ];
}

const expectedOrder = ["chromium", "firefox", "spotify", "proxy"];
permutations(orderingFixtures()).forEach((input, index) => {
  test(`stable source ordering permutation=${index}`, () => {
    const sorted = input.slice().sort(MediaModel.compareSourcePlayers);
    assert.deepEqual(sorted.map(player => player.id), expectedOrder);
  });
});

for (let mutationMask = 0; mutationMask < 32; mutationMask++) {
  test(`source ordering ignores dynamic mutation mask=${mutationMask.toString(2).padStart(5, "0")}`, () => {
    const players = orderingFixtures();
    players.forEach((player, index) => {
      player.isPlaying = (mutationMask & (1 << (index % 5))) !== 0;
      player.trackTitle = (mutationMask & (1 << ((index + 1) % 5))) !== 0
        ? `Changed-${4 - index}` : `Original-${index}`;
      player.trackArtist = (mutationMask & (1 << ((index + 2) % 5))) !== 0
        ? `Artist-${index}` : "";
      player.canPlay = (mutationMask & (1 << ((index + 3) % 5))) !== 0;
      player.canTogglePlaying = (mutationMask & (1 << ((index + 4) % 5))) !== 0;
    });

    const sorted = players.slice().reverse().sort(MediaModel.compareSourcePlayers);
    assert.deepEqual(sorted.map(player => player.id), expectedOrder);
  });
}

test("source ordering is case-insensitive and uses DBus key as final tie-break", () => {
  const later = {
    dbusName: "org.mpris.MediaPlayer2.same.instance20",
    identity: "SAME"
  };
  const earlier = {
    dbusName: "org.mpris.MediaPlayer2.same.instance10",
    identity: "same"
  };
  assert.equal(MediaModel.compareSourcePlayers(later, earlier) > 0, true);
  assert.deepEqual(
    [later, earlier].sort(MediaModel.compareSourcePlayers),
    [earlier, later]
  );
});

test("non-proxy source always sorts before playerctld regardless of label", () => {
  const source = {
    dbusName: "org.mpris.MediaPlayer2.spotify",
    identity: "Zulu"
  };
  const proxy = {
    dbusName: "org.mpris.MediaPlayer2.playerctld",
    identity: "Alpha"
  };
  assert.equal(MediaModel.compareSourcePlayers(source, proxy) < 0, true);
  assert.equal(MediaModel.compareSourcePlayers(proxy, source) > 0, true);
});

function stream(label) {
  return {
    ready: true,
    properties: { "application.name": label }
  };
}

const streamMatchCases = [
  {
    name: "exact match",
    player: { identity: "Spotify" },
    streams: [stream("Firefox"), stream("Spotify")],
    expectedIndex: 1
  },
  {
    name: "case and punctuation insensitive exact",
    player: { identity: "Spotify Player" },
    streams: [stream("spotify_player")],
    expectedIndex: 0
  },
  {
    name: "exact beats earlier partial",
    player: { identity: "Chromium" },
    streams: [stream("Chromium Audio"), stream("Chromium")],
    expectedIndex: 1
  },
  {
    name: "first stream-containing-player partial",
    player: { identity: "Chromium" },
    streams: [stream("Chromium Helper"), stream("Chromium Tab")],
    expectedIndex: 0
  },
  {
    name: "first player-containing-stream partial",
    player: { identity: "Spotify Player" },
    streams: [stream("Spotify"), stream("Player")],
    expectedIndex: 0
  },
  {
    name: "empty labels skipped",
    player: { identity: "Spotify" },
    streams: [stream(""), stream("Spotify")],
    expectedIndex: 1
  },
  {
    name: "no match",
    player: { identity: "Spotify" },
    streams: [stream("Firefox"), stream("Chromium")],
    expectedIndex: -1
  },
  {
    name: "missing player",
    player: null,
    streams: [stream("Spotify")],
    expectedIndex: -1
  },
  {
    name: "non-array streams",
    player: { identity: "Spotify" },
    streams: null,
    expectedIndex: -1
  }
];

streamMatchCases.forEach(row => {
  test(`playback stream matching: ${row.name}`, () => {
    const result = MediaModel.playbackStreamForPlayer(row.player, row.streams);
    const expected = row.expectedIndex < 0 ? null : row.streams[row.expectedIndex];
    assert.equal(result, expected);
    assert.equal(
      MediaModel.playerHasPlaybackStream(row.player, row.streams),
      row.expectedIndex >= 0
    );
  });
});
