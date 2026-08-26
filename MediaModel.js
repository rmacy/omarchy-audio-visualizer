function isProxyPlayer(player) {
  var dbusName = String(player && player.dbusName || "").toLowerCase()
  var desktopEntry = String(player && player.desktopEntry || "").toLowerCase()
  return dbusName.indexOf("playerctld") !== -1 || desktopEntry === "playerctld"
}

function hasMetadata(player) {
  return !!(player && (player.trackTitle || player.trackArtist || player.identity || player.desktopEntry))
}

function hasTrackMetadata(player) {
  return !!(player && (player.trackTitle || player.trackArtist || player.trackAlbum || player.trackArtUrl))
}

function playerCanControl(player) {
  return !!(player && (player.canTogglePlaying || player.canPlay || player.canPause || player.canGoNext || player.canGoPrevious))
}

function canHandleAction(player, action) {
  if (!player) return false
  if (action === "next") return !!player.canGoNext
  if (action === "previous") return !!player.canGoPrevious
  if (action === "play") return !!(player.canPlay || player.canTogglePlaying)
  if (action === "pause") return !!(player.canPause || player.canTogglePlaying)
  if (action === "playPause") return !!(player.canTogglePlaying || player.canPlay || player.canPause)
  return false
}

// Single executor for MPRIS playback actions. `action` must be one of
// next/previous/play/pause; the generic playPause toggle is never accepted
// here — callers normalize it to an explicit play or pause first. Each
// action is guarded by the player's capabilities and falls back to
// togglePlaying() only for players that expose no dedicated method.
// Returns whether a player method actually ran.
function performPlaybackAction(player, action) {
  if (!player) return false

  if (action === "next") {
    if (player.canGoNext) {
      player.next()
      return true
    }
    return false
  }

  if (action === "previous") {
    if (player.canGoPrevious) {
      player.previous()
      return true
    }
    return false
  }

  if (action === "play") {
    if (player.canPlay) {
      player.play()
      return true
    }
    if (player.canTogglePlaying && !player.isPlaying) {
      player.togglePlaying()
      return true
    }
    return false
  }

  if (action === "pause") {
    if (player.canPause) {
      player.pause()
      return true
    }
    if (player.canTogglePlaying && player.isPlaying) {
      player.togglePlaying()
      return true
    }
    return false
  }

  return false
}

function canCycleSource(player) {
  return !!(player && hasMetadata(player) && (player.isPlaying || player.canPlay))
}

// Transfers playback from `current` to `next` through the injected
// playFn/pauseFn so callers share one implementation. Runs only when
// transfer was explicitly requested, the sources differ, and current is
// playing. A paused target is started first; current is paused only once
// the target is already playing or started successfully, so a target that
// cannot start never silences current playback. Returns whether the
// transfer ran.
function transferPlayback(current, next, enabled, playFn, pauseFn) {
  if (!enabled || !current || !current.isPlaying) return false
  if (!next || playerKey(next) === playerKey(current)) return false

  var nextStarted = next.isPlaying || (playFn ? playFn(next) : false)
  if (!nextStarted) return false

  if (pauseFn) pauseFn(current)
  return true
}

// Commits an explicit selection of `next` over the playing `current`
// through the injected playFn/pauseFn. Guards match transferPlayback:
// nothing runs unless the selection was requested, current is playing,
// and the sources differ. The pause policy is what differs — current is
// paused even when a paused target fails to start, so a still-playing
// source can never outrank the explicitly preferred (possibly paused)
// target afterwards. Returns whether the target ended up playing.
function commitSourceSelection(current, next, enabled, playFn, pauseFn) {
  if (!enabled || !current || !current.isPlaying) return false
  if (!next || playerKey(next) === playerKey(current)) return false

  var nextStarted = !!(next.isPlaying || (playFn ? playFn(next) : false))
  if (pauseFn) pauseFn(current)
  return nextStarted
}

function nodeProps(node) {
  return node && node.ready && node.properties ? node.properties : {}
}

function isPlaybackStream(node) {
  if (!node || !node.isStream) return false
  if (node.isSink === true) return true

  var mediaClass = String(node.type || "")
  return mediaClass.indexOf("Stream/Output/Audio") !== -1
    || mediaClass.indexOf("AudioOutStream") !== -1
    || mediaClass.indexOf("Output") !== -1
}

function streamLabelKey(label) {
  var key = String(label || "").toLowerCase()
  key = key.replace(/^pipewire alsa \[/, "")
  key = key.replace(/\]$/, "")
  key = key.replace(/^alsa playback \[/, "")
  key = key.replace(/[^a-z0-9]+/g, "")
  return key
}

function rawStreamLabel(node) {
  if (!node) return ""
  var p = nodeProps(node)
  return p["application.name"]
    || node.description
    || p["media.name"]
    || p["node.name"]
    || node.name
}

function playerAppLabel(player) {
  if (!player) return ""
  var dbus = String(player.dbusName || "")
  dbus = dbus.replace(/^org\.mpris\.MediaPlayer2\./, "")
  dbus = dbus.replace(/\.instance[0-9]+$/, "")
  return player.desktopEntry || player.identity || dbus
}

// Matches a player to its PipeWire playback stream: the first stream whose
// normalized label exactly matches the player's app label, else the first
// partial match (either label containing the other), else null.
function playbackStreamForPlayer(player, playbackStreams) {
  var key = streamLabelKey(playerAppLabel(player))
  if (!key) return null

  var streams = Array.isArray(playbackStreams) ? playbackStreams : []
  var partial = null

  for (var i = 0; i < streams.length; i++) {
    var streamKey = streamLabelKey(rawStreamLabel(streams[i]))
    if (!streamKey) continue
    if (streamKey === key) return streams[i]
    if (partial === null
        && (streamKey.indexOf(key) !== -1 || key.indexOf(streamKey) !== -1))
      partial = streams[i]
  }

  return partial
}

function playerHasPlaybackStream(player, playbackStreams) {
  return playbackStreamForPlayer(player, playbackStreams) !== null
}

function playerKey(player) {
  if (!player) return ""
  return String(player.dbusName || player.desktopEntry || player.identity || "")
}

function trackSignature(player) {
  if (!player) return ""
  return [
    player.trackTitle || "",
    player.trackArtist || "",
    player.trackAlbum || "",
    player.trackArtUrl || ""
  ].join("\u001f")
}

function trackChanged(previousSignature, player) {
  return trackSignature(player) !== String(previousSignature || "")
}

// Pure gate for the spectrum analyzer: the visualizer should run only when
// the backend is available and the given (active) player is playing. Kept
// free of process state so the wanted/monitoring split stays testable.
function visualizerShouldRun(player, available) {
  return !!available && !!player && !!player.isPlaying
}

function labelFor(player) {
  if (!player) return ""
  return player.trackTitle || player.identity || player.desktopEntry || ""
}

function osdMessage(player, fallback) {
  if (!player) return fallback
  var label = labelFor(player)
  if (label && player.trackArtist) return label + " - " + player.trackArtist
  return label || fallback
}

if (typeof module !== "undefined") {
  module.exports = {
    isProxyPlayer: isProxyPlayer,
    hasMetadata: hasMetadata,
    hasTrackMetadata: hasTrackMetadata,
    playerCanControl: playerCanControl,
    canHandleAction: canHandleAction,
    performPlaybackAction: performPlaybackAction,
    canCycleSource: canCycleSource,
    transferPlayback: transferPlayback,
    commitSourceSelection: commitSourceSelection,
    nodeProps: nodeProps,
    isPlaybackStream: isPlaybackStream,
    streamLabelKey: streamLabelKey,
    rawStreamLabel: rawStreamLabel,
    playerAppLabel: playerAppLabel,
    playerHasPlaybackStream: playerHasPlaybackStream,
    playbackStreamForPlayer: playbackStreamForPlayer,
    playerKey: playerKey,
    trackSignature: trackSignature,
    trackChanged: trackChanged,
    visualizerShouldRun: visualizerShouldRun,
    labelFor: labelFor,
    osdMessage: osdMessage
  }
}
