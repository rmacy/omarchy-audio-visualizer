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

// Returns a valid unexpired desired state, or null when the player has no
// authoritative pending intent.
function playbackIntentState(player, intents, nowMs) {
  if (!player) return null

  var key = playerKey(player)
  var intent = key && intents ? intents[key] : null
  var now = typeof nowMs === "number" && isFinite(nowMs) ? nowMs : Date.now()
  if (intent
      && typeof intent.playing === "boolean"
      && typeof intent.expiresAt === "number"
      && isFinite(intent.expiresAt)
      && intent.expiresAt > now)
    return intent.playing
  return null
}

// Returns the MPRIS state with a short-lived command intent overlaid.
function effectivePlaying(player, intents, nowMs) {
  if (!player) return false
  var intentState = playbackIntentState(player, intents, nowMs)
  return typeof intentState === "boolean" ? intentState : !!player.isPlaying
}

// An active PipeWire link is authoritative. A matching but paused stream is
// also authoritative when `streamObserved` is true. Before the first match,
// null preserves the MPRIS fallback for uncorrelatable player labels.
function nextStreamPlayerState(previousState, streamActive, streamObserved) {
  if (streamActive) return true
  if (streamObserved) return false
  return typeof previousState === "boolean" ? false : null
}

// Only a real raw link edge replaces an existing confirmed state. This keeps
// a confirmed MPRIS Pause stable when PipeWire leaves the old link object
// Active, while still allowing a later false→true link edge to confirm Play.
function nextSynchronizedStreamState(previousConfirmed, previousLink,
                                     currentLink) {
  if (typeof currentLink !== "boolean")
    return typeof previousConfirmed === "boolean" ? previousConfirmed : null
  if (typeof previousLink !== "boolean") return currentLink
  if (currentLink !== previousLink) return currentLink
  return typeof previousConfirmed === "boolean"
    ? previousConfirmed : currentLink
}

function mprisTransitionMayConfirmPlaying(mprisPlaying, linkState,
                                         confirmedState, intentState) {
  if (!mprisPlaying) return true
  if (linkState === false) return false
  return confirmedState !== false || intentState === true
}

function streamTransitionContradictsIntent(previousState, streamPresent,
                                           intentState) {
  var changed = typeof previousState === "boolean"
    ? previousState !== streamPresent
    : !!streamPresent
  return changed
    && typeof intentState === "boolean"
    && intentState !== streamPresent
}

// Command intent wins for immediate feedback. Once no intent remains, an
// observed PipeWire stream state wins over stale MPRIS PlaybackStatus.
function synchronizedPlaying(player, intents, streamStates, nowMs) {
  if (!player) return false
  var intentState = playbackIntentState(player, intents, nowMs)
  if (typeof intentState === "boolean") return intentState

  var key = playerKey(player)
  var streamState = key && streamStates ? streamStates[key] : undefined
  return typeof streamState === "boolean" ? streamState : !!player.isPlaying
}

// spotify-player currently ignores dedicated Play while honoring PlayPause.
// Other players use idempotent Play/Pause first so repeated clicks cannot
// invert state when MPRIS and PipeWire notifications arrive out of order.
function playerRequiresTogglePlay(player) {
  if (!player) return false
  var dbus = String(player.dbusName || "").toLowerCase()
  var desktop = String(player.desktopEntry || "").toLowerCase()
  var identity = String(player.identity || "").toLowerCase()
  return dbus.indexOf("spotify_player") !== -1
    || desktop === "spotify_player"
    || identity === "spotify player"
}

function playerNeedsTogglePlayReset(player) {
  return !!(player
    && playerRequiresTogglePlay(player)
    && player.canPause
    && player.canTogglePlaying)
}

function shouldSuppressPendingPlaybackAction(player, action, intentState,
                                             confirmedPlaying) {
  if (!player) return false
  if (action === "play")
    return intentState === true
      && !confirmedPlaying
      && playerRequiresTogglePlay(player)
  if (action === "pause")
    return intentState === false
      && !!confirmedPlaying
      && !player.canPause
  return false
}

function dedicatedPlaybackCommandState(player, action) {
  if (!player) return null
  if (action === "pause" && player.canPause) return false
  if (action === "play" && player.canPlay
      && !playerRequiresTogglePlay(player)) return true
  return null
}

// Pulse-backed playback nodes expose the real running state as pulse.corked.
// Prefer it over PipeWire link state because links may remain Active while
// their ports are paused. Non-Pulse streams fall back to the tracked link.
function playbackStreamActive(node, hasActiveLink) {
  if (!node) return false
  var corked = nodeProps(node)["pulse.corked"]
  return typeof corked === "boolean" ? !corked : !!hasActiveLink
}

// Single executor for MPRIS playback actions. `action` must be one of
// next/previous/play/pause; the generic playPause toggle is never accepted
// here — callers normalize it to an explicit play or pause first. Play and
// pause are state-aware. Dedicated Play/Pause methods are idempotent under
// MPRIS and are always dispatched, even when cached state is stale.
// spotify-player is the one verified exception for Play and uses guarded
// PlayPause. Toggle-only fallbacks remain guarded because toggling in the
// wrong direction is destructive.
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
    if (playerRequiresTogglePlay(player) && player.canTogglePlaying) {
      if (isPlaying) return false
      player.togglePlaying()
      return true
    }
    if (player.canPlay) {
      player.play()
      return true
    }
    if (isPlaying) return false
    if (player.canTogglePlaying) {
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
    if (!isPlaying) return false
    if (player.canTogglePlaying) {
      player.togglePlaying()
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

function sourceHandoffConfirmed(pending, player, confirmedPlaying) {
  var playing = player && typeof confirmedPlaying === "boolean"
    ? confirmedPlaying : !!(player && player.isPlaying)
  return !!pending
    && !!pending.toKey
    && !!player
    && playing
    && playerKey(player) === pending.toKey
}

// Pure decisions for the Service's pending handoff lifecycle. Keeping these
// transitions here makes player removal, timeout, confirmation, and repeated
// selection behavior deterministic and exhaustively testable.
function sourceHandoffResolution(pending, target, outgoing, event,
                                 targetPlaying) {
  if (!pending) return "none"
  if (target && sourceHandoffConfirmed(
      pending, target, targetPlaying)) return "confirm"

  if (event === "timeout") return "rollback"
  if (event === "playersChanged") {
    if (!target) return "rollback"
    if (!outgoing) return "clear"
    return "wait"
  }
  if (event === "playingChanged") return "wait"
  return "none"
}

function sourceHandoffSupersession(pending, targetKey) {
  if (!pending) return "none"
  return pending.toKey === targetKey ? "same" : "replace"
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
    playbackIntentState: playbackIntentState,
    nextStreamPlayerState: nextStreamPlayerState,
    nextSynchronizedStreamState: nextSynchronizedStreamState,
    streamTransitionContradictsIntent: streamTransitionContradictsIntent,
    mprisTransitionMayConfirmPlaying: mprisTransitionMayConfirmPlaying,
    synchronizedPlaying: synchronizedPlaying,
    shouldSuppressPendingPlaybackAction: shouldSuppressPendingPlaybackAction,
    playerRequiresTogglePlay: playerRequiresTogglePlay,
    playerNeedsTogglePlayReset: playerNeedsTogglePlayReset,
    dedicatedPlaybackCommandState: dedicatedPlaybackCommandState,
    performPlaybackAction: performPlaybackAction,
    playbackStreamActive: playbackStreamActive,
    sourceIsSelectable: sourceIsSelectable,
    sourceIsVisible: sourceIsVisible,
    compareSourcePlayers: compareSourcePlayers,
    sourceHandoffPlan: sourceHandoffPlan,
    sourceHandoffConfirmed: sourceHandoffConfirmed,
    sourceHandoffResolution: sourceHandoffResolution,
    sourceHandoffSupersession: sourceHandoffSupersession,
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
