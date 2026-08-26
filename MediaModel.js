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

function hasTrackIdentity(player) {
  return !!(player && (player.trackTitle || player.trackArtist || player.trackAlbum))
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

// Returns the playback state the UI should render while an asynchronous MPRIS
// command settles. Intents are keyed by playerKey and expire quickly; malformed
// or stale entries always fall back to the player's authoritative bus state.
function effectivePlaying(player, intents, nowMs) {
  if (!player) return false

  var key = playerKey(player)
  var intent = key && intents ? intents[key] : null
  var now = typeof nowMs === "number" && isFinite(nowMs) ? nowMs : Date.now()
  if (intent
      && typeof intent.playing === "boolean"
      && typeof intent.expiresAt === "number"
      && isFinite(intent.expiresAt)
      && intent.expiresAt > now)
    return intent.playing

  return !!player.isPlaying
}

// Single executor for MPRIS playback actions. `action` must be one of
// next/previous/play/pause; the generic playPause toggle is never accepted
// here — callers normalize it to an explicit play or pause first. Play and
// pause are state-aware: the desired state is a no-op when already
// satisfied, otherwise togglePlaying() is preferred — Spotify-like players
// advertise CanPlay/CanPause but only honor the PlayPause toggle on the
// bus — and the dedicated method runs only when no toggle is available.
// `playingState`, when supplied, is the caller's short-lived optimistic state
// and prevents rapid clicks from waiting for the MPRIS property round trip.
// next/previous stay guarded by their own capabilities. Returns whether a
// player method actually ran.
function performPlaybackAction(player, action, playingState) {
  if (!player) return false
  var isPlaying = typeof playingState === "boolean" ? playingState : !!player.isPlaying

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
    if (isPlaying) return false
    if (player.canTogglePlaying) {
      player.togglePlaying()
      return true
    }
    if (player.canPlay) {
      player.play()
      return true
    }
    return false
  }

  if (action === "pause") {
    if (!isPlaying) return false
    if (player.canTogglePlaying) {
      player.togglePlaying()
      return true
    }
    if (player.canPause) {
      player.pause()
      return true
    }
    return false
  }

  return false
}

function sourceIsSelectable(player, playingState) {
  if (!player || !hasMetadata(player)) return false
  var playing = typeof playingState === "boolean"
    ? playingState : !!player.isPlaying
  return playing || canHandleAction(player, "play")
}

function sourceIsVisible(player, playingState) {
  return hasTrackIdentity(player) || sourceIsSelectable(player, playingState)
}

function compareSourcePlayers(a, b) {
  var aProxy = isProxyPlayer(a)
  var bProxy = isProxyPlayer(b)
  if (aProxy !== bProxy) return aProxy ? 1 : -1

  var aLabel = String(playerAppLabel(a) || "").toLowerCase()
  var bLabel = String(playerAppLabel(b) || "").toLowerCase()
  var labelOrder = aLabel.localeCompare(bLabel)
  if (labelOrder !== 0) return labelOrder
  return playerKey(a).localeCompare(playerKey(b))
}

// Plans a source-row click without issuing player calls. A paused target is
// started first. When another source is playing, that source is paused only
// after MPRIS confirms the target is actually playing; this prevents a failed
// target start from silencing current audio. `nextRequestedPlaying` separates
// an in-flight optimistic Play from authoritative target playback.
function sourceHandoffPlan(current, next, enabled, currentPlaying,
                           nextPlaying, nextRequestedPlaying) {
  var valid = !!enabled && !!next
  if (!valid) {
    return {
      valid: false,
      startTarget: false,
      pauseCurrent: false,
      waitForTarget: false
    }
  }

  var currentState = !!current && (typeof currentPlaying === "boolean"
    ? currentPlaying : !!current.isPlaying)
  var nextState = typeof nextPlaying === "boolean"
    ? nextPlaying : !!next.isPlaying
  var nextRequested = typeof nextRequestedPlaying === "boolean"
    ? nextRequestedPlaying : nextState
  var samePlayer = !!current
    && playerKey(current) === playerKey(next)

  return {
    valid: true,
    startTarget: !nextRequested,
    pauseCurrent: !samePlayer && currentState && nextState,
    waitForTarget: !samePlayer && currentState && !nextState
  }
}

function sourceHandoffConfirmed(pending, player) {
  return !!pending
    && !!pending.toKey
    && !!player
    && !!player.isPlaying
    && playerKey(player) === pending.toKey
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
    hasTrackIdentity: hasTrackIdentity,
    playerCanControl: playerCanControl,
    canHandleAction: canHandleAction,
    effectivePlaying: effectivePlaying,
    performPlaybackAction: performPlaybackAction,
    sourceIsSelectable: sourceIsSelectable,
    sourceIsVisible: sourceIsVisible,
    compareSourcePlayers: compareSourcePlayers,
    sourceHandoffPlan: sourceHandoffPlan,
    sourceHandoffConfirmed: sourceHandoffConfirmed,
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
