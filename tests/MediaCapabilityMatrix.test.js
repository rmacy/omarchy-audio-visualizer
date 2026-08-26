"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const MediaModel = require("../MediaModel.js");

function flags(mask, names) {
  const value = {};
  names.forEach((name, index) => {
    value[name] = (mask & (1 << index)) !== 0;
  });
  return value;
}

const metadataFields = [
  "trackTitle",
  "trackArtist",
  "trackAlbum",
  "trackArtUrl",
  "identity",
  "desktopEntry"
];

for (let mask = 0; mask < (1 << metadataFields.length); mask++) {
  const present = flags(mask, metadataFields);
  const player = {};
  metadataFields.forEach(name => {
    player[name] = present[name] ? name + "-value" : "";
  });

  test(`metadata truth table mask=${mask.toString(2).padStart(6, "0")}`, () => {
    const expectedMetadata = present.trackTitle || present.trackArtist
      || present.identity || present.desktopEntry;
    const expectedTrackMetadata = present.trackTitle || present.trackArtist
      || present.trackAlbum || present.trackArtUrl;
    const expectedTrackIdentity = present.trackTitle || present.trackArtist
      || present.trackAlbum;

    assert.equal(MediaModel.hasMetadata(player), Boolean(expectedMetadata));
    assert.equal(MediaModel.hasTrackMetadata(player), Boolean(expectedTrackMetadata));
    assert.equal(MediaModel.hasTrackIdentity(player), Boolean(expectedTrackIdentity));
  });
}

test("metadata helpers reject missing players", () => {
  assert.equal(MediaModel.hasMetadata(null), false);
  assert.equal(MediaModel.hasTrackMetadata(undefined), false);
  assert.equal(MediaModel.hasTrackIdentity(null), false);
});

const capabilityFields = [
  "canTogglePlaying",
  "canPlay",
  "canPause",
  "canGoNext",
  "canGoPrevious"
];

for (let mask = 0; mask < (1 << capabilityFields.length); mask++) {
  const player = flags(mask, capabilityFields);
  test(`capability/action truth table mask=${mask.toString(2).padStart(5, "0")}`, () => {
    assert.equal(MediaModel.playerCanControl(player), mask !== 0);
    assert.equal(MediaModel.canHandleAction(player, "play"),
      player.canTogglePlaying || player.canPlay);
    assert.equal(MediaModel.canHandleAction(player, "pause"),
      player.canTogglePlaying || player.canPause);
    assert.equal(MediaModel.canHandleAction(player, "playPause"),
      player.canTogglePlaying || player.canPlay || player.canPause);
    assert.equal(MediaModel.canHandleAction(player, "next"), player.canGoNext);
    assert.equal(MediaModel.canHandleAction(player, "previous"), player.canGoPrevious);
    assert.equal(MediaModel.canHandleAction(player, "stop"), false);
    assert.equal(MediaModel.canHandleAction(player, "Play"), false);
  });
}

test("control helpers reject missing players", () => {
  assert.equal(MediaModel.playerCanControl(null), false);
  assert.equal(MediaModel.canHandleAction(null, "play"), false);
});

const proxyCases = [
  [{ dbusName: "org.mpris.MediaPlayer2.playerctld" }, true],
  [{ dbusName: "ORG.MPRIS.MEDIAPLAYER2.PLAYERCTLD" }, true],
  [{ dbusName: "org.mpris.MediaPlayer2.playerctld.instance1" }, true],
  [{ desktopEntry: "playerctld" }, true],
  [{ desktopEntry: "PLAYERCTLD" }, true],
  [{ dbusName: "org.mpris.MediaPlayer2.spotify" }, false],
  [{ desktopEntry: "spotify" }, false],
  [{ identity: "playerctld" }, false],
  [{}, false],
  [null, false]
];

proxyCases.forEach(([player, expected], index) => {
  test(`proxy detection case=${index} expected=${expected}`, () => {
    assert.equal(MediaModel.isProxyPlayer(player), expected);
  });
});

const identityCases = [
  {
    name: "desktop entry outranks identity and dbus",
    player: { desktopEntry: "desktop", identity: "Identity", dbusName: "org.mpris.MediaPlayer2.bus" },
    app: "desktop",
    key: "org.mpris.MediaPlayer2.bus"
  },
  {
    name: "identity outranks normalized dbus",
    player: { identity: "Identity", dbusName: "org.mpris.MediaPlayer2.bus" },
    app: "Identity",
    key: "org.mpris.MediaPlayer2.bus"
  },
  {
    name: "dbus prefix and numeric instance suffix normalize",
    player: { dbusName: "org.mpris.MediaPlayer2.chromium.instance123" },
    app: "chromium",
    key: "org.mpris.MediaPlayer2.chromium.instance123"
  },
  {
    name: "non-numeric instance suffix remains",
    player: { dbusName: "org.mpris.MediaPlayer2.chromium.instanceABC" },
    app: "chromium.instanceABC",
    key: "org.mpris.MediaPlayer2.chromium.instanceABC"
  },
  {
    name: "key falls back to desktop entry",
    player: { desktopEntry: "spotify" },
    app: "spotify",
    key: "spotify"
  },
  {
    name: "key falls back to identity",
    player: { identity: "Spotify" },
    app: "Spotify",
    key: "Spotify"
  },
  {
    name: "empty player yields empty labels",
    player: {},
    app: "",
    key: ""
  }
];

identityCases.forEach(row => {
  test(`player identity fallback: ${row.name}`, () => {
    assert.equal(MediaModel.playerAppLabel(row.player), row.app);
    assert.equal(MediaModel.playerKey(row.player), row.key);
  });
});

test("player identity helpers reject missing players", () => {
  assert.equal(MediaModel.playerAppLabel(null), "");
  assert.equal(MediaModel.playerKey(undefined), "");
});

const labelCases = [
  [{ trackTitle: "Track", identity: "App", desktopEntry: "desktop" }, "Track"],
  [{ identity: "App", desktopEntry: "desktop" }, "App"],
  [{ desktopEntry: "desktop" }, "desktop"],
  [{}, ""],
  [null, ""]
];

labelCases.forEach(([player, expected], index) => {
  test(`display label precedence case=${index}`, () => {
    assert.equal(MediaModel.labelFor(player), expected);
  });
});

const osdCases = [
  [{ trackTitle: "Track", trackArtist: "Artist" }, "fallback", "Track - Artist"],
  [{ trackTitle: "Track" }, "fallback", "Track"],
  [{ identity: "App", trackArtist: "Artist" }, "fallback", "App - Artist"],
  [{}, "fallback", "fallback"],
  [null, "fallback", "fallback"]
];

osdCases.forEach(([player, fallback, expected], index) => {
  test(`OSD label case=${index}`, () => {
    assert.equal(MediaModel.osdMessage(player, fallback), expected);
  });
});

const signatureFields = ["trackTitle", "trackArtist", "trackAlbum", "trackArtUrl"];
for (let changedIndex = -1; changedIndex < signatureFields.length; changedIndex++) {
  test(`track signature changed field=${changedIndex < 0 ? "none" : signatureFields[changedIndex]}`, () => {
    const before = {
      trackTitle: "Title",
      trackArtist: "Artist",
      trackAlbum: "Album",
      trackArtUrl: "https://example.test/art.png"
    };
    const after = { ...before };
    if (changedIndex >= 0) after[signatureFields[changedIndex]] += "-changed";
    const signature = MediaModel.trackSignature(before);
    assert.equal(signature.split("\u001f").length, 4);
    assert.equal(MediaModel.trackChanged(signature, after), changedIndex >= 0);
  });
}

test("track signature handles missing values and player", () => {
  assert.equal(MediaModel.trackSignature({}), "\u001f\u001f\u001f");
  assert.equal(MediaModel.trackSignature(null), "");
  assert.equal(MediaModel.trackChanged("", null), false);
  assert.equal(MediaModel.trackChanged("old", null), true);
});

const streamTypes = [
  [null, false],
  [{}, false],
  [{ isStream: false, type: "Stream/Output/Audio" }, false],
  [{ isStream: true, isSink: true }, true],
  [{ isStream: true, type: "Stream/Output/Audio" }, true],
  [{ isStream: true, type: "AudioOutStream" }, true],
  [{ isStream: true, type: "SomeOutputNode" }, true],
  [{ isStream: true, type: "Stream/Input/Audio" }, false],
  [{ isStream: true, type: "AudioInStream" }, false],
  [{ isStream: true, type: "" }, false]
];

streamTypes.forEach(([node, expected], index) => {
  test(`PipeWire playback classification case=${index}`, () => {
    assert.equal(MediaModel.isPlaybackStream(node), expected);
  });
});

const nodePropsCases = [
  [null, {}],
  [{ ready: false, properties: { a: 1 } }, {}],
  [{ ready: true }, {}],
  [{ ready: true, properties: null }, {}],
  [{ ready: true, properties: { a: 1 } }, { a: 1 }]
];

nodePropsCases.forEach(([node, expected], index) => {
  test(`PipeWire node properties case=${index}`, () => {
    assert.deepEqual(MediaModel.nodeProps(node), expected);
  });
});

const rawLabelCases = [
  [{ ready: true, properties: { "application.name": "Application", "media.name": "Media" }, description: "Description", name: "Node" }, "Application"],
  [{ ready: true, properties: { "media.name": "Media" }, description: "Description", name: "Node" }, "Description"],
  [{ ready: true, properties: { "media.name": "Media", "node.name": "Property node" }, name: "Node" }, "Media"],
  [{ ready: true, properties: { "node.name": "Property node" }, name: "Node" }, "Property node"],
  [{ ready: true, properties: {}, name: "Node" }, "Node"],
  [{ ready: false, properties: { "application.name": "Ignored" }, description: "Description", name: "Node" }, "Description"]
];

rawLabelCases.forEach(([node, expected], index) => {
  test(`raw stream label precedence case=${index}`, () => {
    assert.equal(MediaModel.rawStreamLabel(node), expected);
  });
});

test("raw stream label falls back to node name and empty", () => {
  assert.equal(MediaModel.rawStreamLabel({ ready: true, properties: {}, name: "Node" }), "Node");
  assert.equal(MediaModel.rawStreamLabel({ ready: false, name: "Node" }), "Node");
  assert.equal(MediaModel.rawStreamLabel(null), "");
});

const normalizationCases = [
  ["Spotify", "spotify"],
  ["spotify_player", "spotifyplayer"],
  ["  Chromium---Browser  ", "chromiumbrowser"],
  ["org.PulseAudio.pavucontrol", "orgpulseaudiopavucontrol"],
  ["PipeWire ALSA [Firefox]", "firefox"],
  ["ALSA playback [Chrome]", "chrome"],
  ["Foo.Bar/Baz_qux", "foobarbazqux"],
  ["", ""],
  [null, ""],
  [undefined, ""]
];

normalizationCases.forEach(([input, expected], index) => {
  test(`stream label normalization case=${index}`, () => {
    assert.equal(MediaModel.streamLabelKey(input), expected);
  });
});
