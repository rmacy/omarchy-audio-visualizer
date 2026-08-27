import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Mpris
import Quickshell.Services.Pipewire
import "MediaModel.js" as MediaModel
import "AudioVisualizerModel.js" as AudioVisualizerModel

Item {
  id: root

  property var shell: null
  property var manifest: null
  property string preferredPlayerKey: ""
  property var playerStartedAt: ({})
  property var pendingTrackOsd: null
  property int playSerial: 0
  // Short-lived desired states make controls and source selection react in
  // the same frame as the MPRIS call instead of waiting for its property
  // round trip. The player remains authoritative after the bounded timeout.
  property var playbackIntents: ({})
  readonly property int playbackIntentTimeoutMs: 1200
  // Raw PipeWire link edges and confirmed playback are tracked separately:
  // link edges override stale MPRIS, while an MPRIS transition remains stable
  // until the next real link edge.
  property var streamLinkStates: ({})
  property var streamPlayerStates: ({})
  // One source transfer may wait for the selected target's authoritative
  // MPRIS Playing signal before the outgoing source is paused.
  property var pendingSourceHandoff: null
  readonly property int sourceHandoffTimeoutMs: 3000
  // spotify-player Play is normalized through Pause, then one delayed
  // PlayPause, so stale PlaybackStatus cannot toggle in the wrong direction.
  property var pendingTogglePlay: null
  readonly property int togglePlayResetDelayMs: 60
  readonly property int togglePlayVerifyDelayMs: 180
  readonly property int togglePlayMaxRetries: 10

  readonly property var players: Mpris.players ? Mpris.players.values : []
  readonly property string mprisPlayingSignature: {
    var states = []
    for (var i = 0; i < players.length; i++) {
      var player = players[i]
      states.push(playerKey(player) + ":" + (player && player.isPlaying ? "1" : "0"))
    }
    return states.join("|")
  }
  readonly property var nodes: Pipewire.nodes ? Pipewire.nodes.values : []
  readonly property var links: Pipewire.links ? Pipewire.links.values : []
  readonly property var playbackStreams: {
    var list = []
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      if (n && n.isStream && isPlaybackStream(n) && n.audio) list.push(n)
    }
    return list
  }
  readonly property var sourcePlayers: orderedSourcePlayers()
  readonly property var sourceCyclePlayers: orderedCycleSourcePlayers()
  readonly property var activePlayer: selectActivePlayer()
  readonly property bool activePlaying: isConfirmedPlaying(activePlayer)
  readonly property bool hasMedia: activePlayer !== null && (activePlayer.trackTitle || activePlayer.trackArtist)
  readonly property string title: activePlayer ? (activePlayer.trackTitle || "") : ""
  readonly property string artist: activePlayer ? (activePlayer.trackArtist || "") : ""
  readonly property string album: activePlayer && activePlayer.trackAlbum ? activePlayer.trackAlbum : ""
  readonly property string identity: activePlayer ? (activePlayer.identity || activePlayer.desktopEntry || "") : ""
  // Artwork pipeline: activePlayer.trackArtUrl is a remote, untrusted URL
  // and is never exposed. A short-lived broker child fetches, decodes, and
  // re-encodes the image into a canonical local PNG; only that verified
  // broker-owned file URL may ever populate the public artUrl below.
  property string artUrl: ""
  readonly property string artworkPythonExecutable: "/usr/bin/python3"
  readonly property string artworkHelperPath: manifest && manifest.__sourceDir ? String(manifest.__sourceDir) + "/artwork_broker.py" : ""
  readonly property int artworkDebounceMs: 250
  readonly property int artworkWatchdogMs: 12000
  // Private request state: candidate is the newest raw MPRIS art URL;
  // request/generation correlate broker answers so only a response for the
  // current player, track, and URL can ever become artUrl.
  readonly property string artworkCandidateUrl: activePlayer && activePlayer.trackArtUrl ? String(activePlayer.trackArtUrl) : ""
  readonly property string activePlayerKey: activePlayer ? playerKey(activePlayer) : ""
  readonly property string activeTrackSignature: activePlayer ? trackSignature(activePlayer) : ""
  property string artworkError: ""
  property var artworkRequest: null
  property int artworkGeneration: 0
  property bool artworkResponded: false
  property bool artworkStopRequested: false
  property bool artworkPendingLaunch: false
  // Spectrum state: a supervised Cava child analyzes the default PipeWire
  // output monitor and streams nine low -> high frequency bands (0-1000 raw)
  // while the active player is playing. Cava frames are the only thing that
  // moves these values — no native peak sampling or temporal history remains.
  readonly property string visualizerBackend: "cava"
  readonly property string cavaExecutable: "/usr/bin/cava"
  readonly property string cavaConfigPath: manifest && manifest.__sourceDir ? String(manifest.__sourceDir) + "/cava.conf" : ""
  property bool cavaAvailable: false
  readonly property bool visualizerAvailable: cavaAvailable && cavaConfigPath !== ""
  readonly property bool visualizerWanted: activePlaying && visualizerAvailable
  readonly property bool visualizerMonitoring: visualizerWanted && cavaProcess.running
  readonly property int visualizerLevelCount: 9
  readonly property int cavaMaxRange: 1000
  property var visualizerLevels: AudioVisualizerModel.zeroLevels(visualizerLevelCount)
  property real visualizerPeak: 0
  property real visualizerEnergy: 0
  property bool visualizerLive: false
  property int visualizerFrame: 0
  property string visualizerError: ""
  property bool cavaStopRequested: false
  // Keep a just-used analyzer warm long enough for a confirmed source
  // handoff or quick resume, then stop it so paused media has no
  // unbounded FFT cost.
  readonly property int cavaLingerMs: 5000

  function isProxyPlayer(player) {
    return MediaModel.isProxyPlayer(player)
  }

  function hasMetadata(player) {
    return MediaModel.hasMetadata(player)
  }

  function hasTrackMetadata(player) {
    return MediaModel.hasTrackMetadata(player)
  }

  // mpvpaper exposes the looping wallpaper as an MPRIS player. It must never
  // displace an actual music player after that player is paused.
  function isBackgroundPlayer(player) {
    if (!player) return false
    var identity = String(player.identity || "").toLowerCase()
    var metadata = player.metadata || ({})
    var url = String(metadata["xesam:url"] || "")
    return identity === "mpv" && url.indexOf("/.config/omarchy/themes/") !== -1
  }

  function playerCanControl(player) {
    return MediaModel.playerCanControl(player)
  }

  function canHandleAction(player, action) {
    return MediaModel.canHandleAction(player, action)
  }

  function sourceIsSelectable(player) {
    return MediaModel.sourceIsSelectable(player, isConfirmedPlaying(player))
  }

  function sourceIsVisible(player) {
    return MediaModel.sourceIsVisible(player, isConfirmedPlaying(player))
  }

  function compareSourcePlayers(a, b) {
    return MediaModel.compareSourcePlayers(a, b)
  }

  function nodeProps(node) {
    return MediaModel.nodeProps(node)
  }

  function isPlaybackStream(node) {
    return MediaModel.isPlaybackStream(node)
  }

  function streamLabelKey(label) {
    return MediaModel.streamLabelKey(label)
  }

  function rawStreamLabel(node) {
    return MediaModel.rawStreamLabel(node)
  }

  function playerAppLabel(player) {
    return MediaModel.playerAppLabel(player)
  }

  function playerHasPlaybackStream(player) {
    return MediaModel.playerHasPlaybackStream(player, playbackStreams)
  }
  function playbackStreamForPlayer(player) {
    return MediaModel.playbackStreamForPlayer(player, playbackStreams)
  }

  function playerHasActivePlaybackStream(player) {
    var stream = playbackStreamForPlayer(player)
    if (!stream) return false
    var activeLink = false
    for (var i = 0; i < links.length; i++) {
      var link = links[i]
      if (link && link.source === stream && link.state === PwLinkState.Active) {
        activeLink = true
        break
      }
    }
    return MediaModel.playbackStreamActive(stream, activeLink)
  }

  function playerKey(player) {
    return MediaModel.playerKey(player)
  }

  function playerForKey(key) {
    if (!key) return null
    for (var i = 0; i < players.length; i++) {
      var p = players[i]
      if (playerKey(p) === key) return p
    }
    return null
  }

  function isEffectivelyPlaying(player) {
    return MediaModel.synchronizedPlaying(
      player, playbackIntents, streamPlayerStates, Date.now())
  }

  function isConfirmedPlaying(player) {
    return MediaModel.synchronizedPlaying(
      player, null, streamPlayerStates, Date.now())
  }

  function schedulePlaybackIntentExpiry() {
    var earliest = 0
    for (var key in playbackIntents) {
      var intent = playbackIntents[key]
      if (!intent || typeof intent.expiresAt !== "number" || !isFinite(intent.expiresAt)) continue
      if (earliest === 0 || intent.expiresAt < earliest) earliest = intent.expiresAt
    }

    if (earliest === 0) {
      playbackIntentTimer.stop()
      return
    }

    playbackIntentTimer.interval = Math.max(1, Math.ceil(earliest - Date.now()))
    playbackIntentTimer.restart()
  }

  function removePlaybackIntent(key) {
    if (!key || !playbackIntents[key]) return

    var next = {}
    for (var existing in playbackIntents) {
      if (existing !== key) next[existing] = playbackIntents[existing]
    }
    playbackIntents = next
    schedulePlaybackIntentExpiry()
  }

  function recordPlaybackIntent(player, playing, timeoutMs) {
    var key = playerKey(player)
    if (!key) return

    var duration = typeof timeoutMs === "number" && timeoutMs > 0
      ? timeoutMs : playbackIntentTimeoutMs
    var next = {}
    for (var existing in playbackIntents)
      next[existing] = playbackIntents[existing]
    next[key] = {
      playing: !!playing,
      expiresAt: Date.now() + duration
    }
    playbackIntents = next
    schedulePlaybackIntentExpiry()
  }

  function applyDedicatedPlaybackCommandState(player, action) {
    var state = MediaModel.dedicatedPlaybackCommandState(player, action)
    var key = playerKey(player)
    if (typeof state !== "boolean" || !key) return

    var next = {}
    for (var existing in streamPlayerStates)
      next[existing] = streamPlayerStates[existing]
    next[key] = state
    if (!playbackStateMapsEqual(streamPlayerStates, next))
      streamPlayerStates = next
  }

  // Any authoritative MPRIS transition ends the optimistic overlay. Matching
  // transitions acknowledge the command; contradictory transitions report an
  // external change or rejection and must not remain masked until timeout.
  function settlePlaybackIntent(player) {
    var key = playerKey(player)
    if (key && playbackIntents[key]) removePlaybackIntent(key)
  }

  function expirePlaybackIntents() {
    var now = Date.now()
    var next = {}
    var changed = false
    for (var key in playbackIntents) {
      var intent = playbackIntents[key]
      if (!intent || typeof intent.playing !== "boolean"
          || typeof intent.expiresAt !== "number"
          || !isFinite(intent.expiresAt)
          || intent.expiresAt <= now) {
        changed = true
        continue
      }
      next[key] = intent
    }

    if (changed) playbackIntents = next
    schedulePlaybackIntentExpiry()
  }

  function playbackStateMapsEqual(a, b) {
    for (var key in a) {
      if (a[key] !== b[key]) return false
    }
    for (var other in b) {
      if (a[other] !== b[other]) return false
    }
    return true
  }

  function syncPlaybackStreamStates() {
    var now = Date.now()
    var nextLinks = {}
    var nextConfirmed = {}
    var contradictoryIntents = []

    for (var i = 0; i < players.length; i++) {
      var player = players[i]
      if (!player || isBackgroundPlayer(player)) continue
      var key = playerKey(player)
      if (!key) continue

      var previousLink = streamLinkStates[key]
      var previousConfirmed = streamPlayerStates[key]
      var observed = playerHasPlaybackStream(player)
      var active = observed && playerHasActivePlaybackStream(player)
      var currentLink = MediaModel.nextStreamPlayerState(
        previousLink, active, observed)
      var confirmed = MediaModel.nextSynchronizedStreamState(
        previousConfirmed, previousLink, currentLink)
      if (typeof currentLink === "boolean") nextLinks[key] = currentLink
      if (typeof confirmed === "boolean") nextConfirmed[key] = confirmed

      var intentState = MediaModel.playbackIntentState(
        player, playbackIntents, now)
      if (MediaModel.streamTransitionContradictsIntent(
          previousLink, active, intentState))
        contradictoryIntents.push(key)
    }

    if (!playbackStateMapsEqual(streamLinkStates, nextLinks))
      streamLinkStates = nextLinks
    if (!playbackStateMapsEqual(streamPlayerStates, nextConfirmed))
      streamPlayerStates = nextConfirmed
    for (var j = 0; j < contradictoryIntents.length; j++)
      removePlaybackIntent(contradictoryIntents[j])
  }

  function reconcileMprisPlaying(player) {
    var key = playerKey(player)
    if (!key) return false
    var toggleResetPending = !!(pendingTogglePlay
      && pendingTogglePlay.playerKey === key)
    var linkState = streamLinkStates[key]
    var confirmedState = streamPlayerStates[key]
    var intentState = MediaModel.playbackIntentState(
      player, playbackIntents, Date.now())
    // Delayed stale Playing must not resurrect confirmed Pause; the expected
    // Paused edge inside Spotify's reset must not erase its requested Play.
    if (!MediaModel.mprisTransitionMayConfirmPlaying(
        player.isPlaying, linkState, confirmedState, intentState,
        toggleResetPending)) return false

    var next = {}
    for (var existing in streamPlayerStates)
      next[existing] = streamPlayerStates[existing]
    next[key] = !!player.isPlaying
    if (!playbackStateMapsEqual(streamPlayerStates, next))
      streamPlayerStates = next
    return true
  }

  function syncMprisPlayingStates() {
    for (var i = 0; i < players.length; i++)
      reconcileMprisPlaying(players[i])
  }

  function playerOrder(player, fallback) {
    var key = playerKey(player)
    var value = key ? playerStartedAt[key] : undefined
    return value === undefined ? fallback : value
  }

  function syncPlayingOrder() {
    var next = {}
    var alive = {}
    var serial = playSerial

    for (var i = 0; i < players.length; i++) {
      var p = players[i]
      var key = playerKey(p)
      if (!key) continue

      alive[key] = true
      if (!p.isPlaying) continue

      if (playerStartedAt[key] === undefined) {
        serial += 1
        next[key] = serial
      } else {
        next[key] = playerStartedAt[key]
      }
    }

    if (preferredPlayerKey && !alive[preferredPlayerKey]) preferredPlayerKey = ""

    playSerial = serial
    playerStartedAt = next
  }

  function orderedSourcePlayers() {
    var list = []
    for (var i = 0; i < players.length; i++) {
      var p = players[i]
      if (sourceIsVisible(p) && !isBackgroundPlayer(p)) list.push(p)
    }

    list.sort(compareSourcePlayers)

    return list
  }

  function orderedCycleSourcePlayers() {
    var list = []
    for (var i = 0; i < players.length; i++) {
      var p = players[i]
      if (sourceIsSelectable(p) && !isBackgroundPlayer(p)) list.push(p)
    }

    list.sort(compareSourcePlayers)

    return list
  }

  function oldestPlayingPlayer(requirePlaybackStream) {
    var oldest = null
    var oldestOrder = 0
    var playingProxy = null
    var proxyOrder = 0

    for (var i = 0; i < players.length; i++) {
      var p = players[i]
      if (!p || isBackgroundPlayer(p)) continue

      var proxyPlayer = isProxyPlayer(p)
      if (isEffectivelyPlaying(p)) {
        if (requirePlaybackStream && !playerHasPlaybackStream(p)) continue

        var order = playerOrder(p, i + 1000)
        if (!proxyPlayer && (!oldest || order < oldestOrder)) {
          oldest = p
          oldestOrder = order
        } else if (proxyPlayer && (!playingProxy || order < proxyOrder)) {
          playingProxy = p
          proxyOrder = order
        }
      }
    }

    return oldest || playingProxy || null
  }

  function selectActivePlayer() {
    var preferred = null
    var trackPlayer = null
    var trackProxy = null
    var streamPlayer = null
    var streamProxy = null
    var controllablePlayer = null
    var controllableProxy = null
    var identityPlayer = null
    var identityProxy = null

    for (var i = 0; i < players.length; i++) {
      var p = players[i]
      if (!p || isBackgroundPlayer(p)) continue

      var proxy = isProxyPlayer(p)

      if (preferredPlayerKey && playerKey(p) === preferredPlayerKey && hasMetadata(p)) preferred = p

      if (playerHasPlaybackStream(p)) {
        if (!proxy && !streamPlayer) streamPlayer = p
        else if (proxy && !streamProxy) streamProxy = p
      } else if (hasTrackMetadata(p)) {
        if (!proxy && !trackPlayer) trackPlayer = p
        else if (proxy && !trackProxy) trackProxy = p
      } else if (playerCanControl(p)) {
        if (!proxy && !controllablePlayer) controllablePlayer = p
        else if (proxy && !controllableProxy) controllableProxy = p
      } else if (hasMetadata(p)) {
        if (!proxy && !identityPlayer) identityPlayer = p
        else if (proxy && !identityProxy) identityProxy = p
      }
    }

    if (preferred && isEffectivelyPlaying(preferred)) return preferred
    var streamCandidate = streamPlayer || streamProxy
    // Invariant: any effectively playing source wins; once none is, an
    // explicit preferred player outranks generic stream/metadata fallbacks
    // even while paused or without a live PipeWire playback stream.
    return oldestPlayingPlayer(true) || oldestPlayingPlayer(false) || preferred || streamCandidate || trackPlayer || trackProxy || controllablePlayer || controllableProxy || identityPlayer || identityProxy || null
  }

  function labelFor(player) {
    return MediaModel.labelFor(player)
  }

  function osdMessage(player, fallback) {
    return MediaModel.osdMessage(player, fallback)
  }

  function trackSignature(player) {
    return MediaModel.trackSignature(player)
  }

  function utf8ByteLength(value) {
    var text = String(value || "")
    var bytes = 0
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i)
      if (code <= 0x7f) bytes += 1
      else if (code <= 0x7ff) bytes += 2
      else if (code >= 0xd800 && code <= 0xdbff
          && i + 1 < text.length
          && text.charCodeAt(i + 1) >= 0xdc00
          && text.charCodeAt(i + 1) <= 0xdfff) {
        bytes += 4
        i += 1
      } else bytes += 3
    }
    return bytes
  }

  function showOsd(actionLabel, iconName, player) {
    if (!shell) return
    shell.summon("omarchy.osd", JSON.stringify({
      icon: iconName || "media",
      message: osdMessage(player || activePlayer, actionLabel)
    }))
  }

  function scheduleOsd(actionLabel, iconName, player, waitForTrackChange, beforeTrackSignature) {
    if (waitForTrackChange) {
      pendingTrackOsd = {
        actionLabel: actionLabel,
        iconName: iconName,
        player: player,
        playerKey: playerKey(player),
        before: beforeTrackSignature,
        attempts: 0
      }
      trackOsdTimer.restart()
    } else {
      Qt.callLater(function() { root.showOsd(actionLabel, iconName, player) })
    }
  }

  function flushPendingTrackOsd(force) {
    var pending = pendingTrackOsd
    if (!pending) return

    var player = playerForKey(pending.playerKey) || pending.player
    if (force || MediaModel.trackChanged(pending.before, player) || pending.attempts >= 10) {
      pendingTrackOsd = null
      trackOsdTimer.stop()
      root.showOsd(pending.actionLabel, pending.iconName, player)
      return
    }

    pending.attempts = pending.attempts + 1
    pendingTrackOsd = pending
    trackOsdTimer.restart()
  }

  function clearSourceHandoff() {
    sourceHandoffTimer.stop()
    pendingSourceHandoff = null
  }

  function rollbackSourceHandoff(handoff) {
    if (!handoff || preferredPlayerKey !== handoff.toKey) return
    var outgoing = playerForKey(handoff.fromKey)
    preferredPlayerKey = outgoing ? handoff.fromKey : ""
  }

  function cancelSourceHandoff(cancelTarget, rollbackSelection) {
    var handoff = pendingSourceHandoff
    if (!handoff) return

    clearSourceHandoff()
    if (cancelTarget) {
      var target = playerForKey(handoff.toKey)
      if (target && isEffectivelyPlaying(target)) pausePlayer(target)
    }
    if (rollbackSelection) rollbackSourceHandoff(handoff)
  }

  function confirmSourceHandoff(player) {
    var handoff = pendingSourceHandoff
    if (!MediaModel.sourceHandoffConfirmed(
        handoff, player, isConfirmedPlaying(player))) return false

    clearSourceHandoff()
    var outgoing = playerForKey(handoff.fromKey)
    if (outgoing && playerKey(outgoing) !== handoff.toKey
        && isEffectivelyPlaying(outgoing))
      pausePlayer(outgoing)
    return true
  }

  function handleSourceHandoffTimeout() {
    var handoff = pendingSourceHandoff
    if (!handoff) return

    var target = playerForKey(handoff.toKey)
    var outgoing = playerForKey(handoff.fromKey)
    var resolution = MediaModel.sourceHandoffResolution(
      handoff, target, outgoing, "timeout",
      target ? isConfirmedPlaying(target) : false)
    if (resolution === "confirm") {
      confirmSourceHandoff(target)
      return
    }
    if (resolution === "rollback") {
      clearSourceHandoff()
      rollbackSourceHandoff(handoff)
    }
  }

  function reconcileSourceHandoff() {
    var handoff = pendingSourceHandoff
    if (!handoff) return

    var target = playerForKey(handoff.toKey)
    var outgoing = playerForKey(handoff.fromKey)
    var resolution = MediaModel.sourceHandoffResolution(
      handoff, target, outgoing, "playersChanged",
      target ? isConfirmedPlaying(target) : false)
    if (resolution === "confirm") {
      confirmSourceHandoff(target)
    } else if (resolution === "rollback") {
      clearSourceHandoff()
      rollbackSourceHandoff(handoff)
    } else if (resolution === "clear") {
      // The target's already-issued Play may finish, but no outgoing player
      // remains to pause after confirmation.
      clearSourceHandoff()
    }
  }

  function currentSourceForHandoff(targetKey) {
    var current = activePlayer
    if (current && playerKey(current) !== targetKey
        && isEffectivelyPlaying(current))
      return current

    var list = sourcePlayers
    for (var i = 0; i < list.length; i++) {
      var candidate = list[i]
      if (playerKey(candidate) !== targetKey
          && isEffectivelyPlaying(candidate))
        return candidate
    }
    return current && playerKey(current) === targetKey ? current : null
  }

  // A row click is a one-click, confirmation-driven handoff. The target is
  // selected and started immediately, but the outgoing source stays audible
  // until the target's authoritative MPRIS state reports Playing.
  function selectPlayer(key, transferPlayback) {
    var player = playerForKey(key)
    if (!player || isBackgroundPlayer(player) || !sourceIsSelectable(player)) return false

    var targetKey = playerKey(player)
    var previous = pendingSourceHandoff
    var current = previous
      ? playerForKey(previous.fromKey)
      : currentSourceForHandoff(targetKey)

    var supersession = MediaModel.sourceHandoffSupersession(
      previous, targetKey)
    if (supersession === "same") return true
    if (supersession === "replace") cancelSourceHandoff(true, false)

    preferredPlayerKey = targetKey
    if (!transferPlayback) return true

    var plan = MediaModel.sourceHandoffPlan(
      current, player, true, isEffectivelyPlaying(current),
      isConfirmedPlaying(player), isEffectivelyPlaying(player))

    if (plan.pauseCurrent && current) pausePlayer(current)

    if (plan.waitForTarget) {
      pendingSourceHandoff = {
        fromKey: playerKey(current),
        toKey: targetKey
      }
      sourceHandoffTimer.restart()
    }

    if (plan.startTarget && !playPlayer(player,
        plan.waitForTarget ? sourceHandoffTimeoutMs : playbackIntentTimeoutMs)) {
      if (plan.waitForTarget) {
        var failed = pendingSourceHandoff
        clearSourceHandoff()
        rollbackSourceHandoff(failed)
      }
      return false
    }

    if (plan.waitForTarget && isConfirmedPlaying(player))
      confirmSourceHandoff(player)
    return true
  }

  // Commands use confirmed stream/MPRIS state, never the optimistic icon
  // overlay. Repeated idempotent Play/Pause calls are safe; repeated
  // Spotify PlayPause is suppressed until its first Play settles.
  function performPlayerAction(player, action, intentTimeoutMs) {
    var confirmed = isConfirmedPlaying(player)
    var intentState = MediaModel.playbackIntentState(
      player, playbackIntents, Date.now())
    if (MediaModel.shouldSuppressPendingPlaybackAction(
        player, action, intentState, confirmed))
      return true

    var handled = MediaModel.performPlaybackAction(
      player, action, confirmed)
    if (handled && (action === "play" || action === "pause")) {
      applyDedicatedPlaybackCommandState(player, action)
      recordPlaybackIntent(player, action === "play", intentTimeoutMs)
    }
    return handled
  }

  function clearPendingTogglePlay() {
    togglePlayResetTimer.stop()
    togglePlayVerifyTimer.stop()
    pendingTogglePlay = null
  }

  function finishTogglePlay() {
    var request = pendingTogglePlay
    if (!request) return
    var player = playerForKey(request.playerKey)
    if (!player || !player.canTogglePlaying) {
      clearPendingTogglePlay()
      return
    }
    player.togglePlaying()
    recordPlaybackIntent(player, true, request.intentTimeoutMs)
    togglePlayVerifyTimer.restart()
  }

  function verifyTogglePlay() {
    var request = pendingTogglePlay
    if (!request) return
    var player = playerForKey(request.playerKey)
    if (!player || isConfirmedPlaying(player)) {
      clearPendingTogglePlay()
      return
    }
    if (request.attempt >= togglePlayMaxRetries) {
      clearPendingTogglePlay()
      return
    }

    performPlayerAction(player, "pause", playbackIntentTimeoutMs)
    pendingTogglePlay = {
      playerKey: request.playerKey,
      intentTimeoutMs: request.intentTimeoutMs,
      attempt: request.attempt + 1
    }
    togglePlayResetTimer.restart()
  }

  function queueTogglePlay(player, intentTimeoutMs) {
    var key = playerKey(player)
    if (!key) return false
    if (pendingTogglePlay && pendingTogglePlay.playerKey === key) return true

    clearPendingTogglePlay()
    pendingTogglePlay = {
      playerKey: key,
      intentTimeoutMs: Math.max(
        intentTimeoutMs || playbackIntentTimeoutMs,
        sourceHandoffTimeoutMs),
      attempt: 0
    }
    // Dedicated Pause is idempotent and establishes a known baseline before
    // the only PlayPause toggle that spotify-player honors for Play.
    performPlayerAction(player, "pause", playbackIntentTimeoutMs)
    togglePlayResetTimer.restart()
    return true
  }

  function playPlayer(player, intentTimeoutMs) {
    if (MediaModel.playerNeedsTogglePlayReset(player))
      return queueTogglePlay(player, intentTimeoutMs)
    return performPlayerAction(player, "play", intentTimeoutMs)
  }

  function pausePlayer(player) {
    if (pendingTogglePlay
        && pendingTogglePlay.playerKey === playerKey(player))
      clearPendingTogglePlay()
    return performPlayerAction(player, "pause")
  }

  function switchSource(delta, transferPlayback, showFeedback) {
    var list = sourceCyclePlayers
    if (!list || list.length === 0) return false

    var activeKey = playerKey(activePlayer)
    var index = 0
    for (var i = 0; i < list.length; i++) {
      if (playerKey(list[i]) === activeKey) {
        index = i
        break
      }
    }

    index = (index + delta + list.length) % list.length
    var next = list[index]
    var selected = selectPlayer(playerKey(next), transferPlayback)

    if (showFeedback !== false) Qt.callLater(function() {
      root.showOsd("Source", "media-source", next)
    })

    return selected
  }

  function playerForAction(action, targetKey) {
    var targeted = playerForKey(targetKey)
    if (targeted) return targeted

    if (action === "pause" || action === "playPause") {
      var oldest = oldestPlayingPlayer(true) || oldestPlayingPlayer(false)
      if (oldest) return oldest
    }

    if (canHandleAction(activePlayer, action)) return activePlayer

    var list = sourcePlayers
    for (var i = 0; i < list.length; i++) {
      if (canHandleAction(list[i], action)) return list[i]
    }

    return activePlayer
  }

  function runAction(action, showFeedback, targetKey) {
    var player = playerForAction(action, targetKey)
    var key = playerKey(player)
    var actionLabel = "Play/pause"
    var iconName = "media"
    var beforeTrackSignature = trackSignature(player)
    // playPause is normalized to an explicit play or pause using confirmed
    // synchronized state; every action then runs through the idempotent
    // performPlayerAction implementation above.
    var effective = action

    if (action === "next") {
      actionLabel = "Next"
      iconName = "media-next"
    } else if (action === "previous") {
      actionLabel = "Previous"
      iconName = "media-previous"
    } else if (action === "play") {
      actionLabel = "Play"
      iconName = "media-play"
    } else if (action === "pause") {
      actionLabel = "Pause"
      iconName = "media-pause"
    } else if (action === "playPause") {
      effective = player && isConfirmedPlaying(player) ? "pause" : "play"
      actionLabel = effective === "pause" ? "Pause" : "Play"
      iconName = effective === "pause" ? "media-pause" : "media-play"
    }

    var handled = effective === "play"
      ? playPlayer(player, playbackIntentTimeoutMs)
      : (effective === "pause"
        ? pausePlayer(player)
        : performPlayerAction(player, effective))

    if (handled && key) preferredPlayerKey = key
    if (showFeedback !== false)
      scheduleOsd(actionLabel, iconName, player, handled && (action === "next" || action === "previous"), beforeTrackSignature)
    return handled
  }

  // A signature binding reliably bridges every MPRIS PlaybackStatus edge;
  // PipeWire object changes are reconciled separately below.
  Component.onCompleted: {
    root.syncMprisPlayingStates()
    root.syncPlaybackStreamStates()
    root.syncPlayingOrder()
    root.syncArtwork()
  }
  onPlayersChanged: {
    root.syncMprisPlayingStates()
    root.syncPlaybackStreamStates()
    root.syncPlayingOrder()
    root.reconcileSourceHandoff()
  }
  onMprisPlayingSignatureChanged: {
    root.syncMprisPlayingStates()
    root.syncPlaybackStreamStates()
    root.syncPlayingOrder()
    var target = pendingSourceHandoff
      ? playerForKey(pendingSourceHandoff.toKey) : null
    if (target) root.confirmSourceHandoff(target)
  }
  onPlaybackStreamsChanged: root.syncPlaybackStreamStates()
  onVisualizerWantedChanged: root.syncVisualizer()
  // Every player, track, or candidate-artwork transition invalidates the
  // whole pipeline: artUrl clears immediately and any in-flight request dies.
  onActivePlayerChanged: root.syncArtwork()
  onArtworkCandidateUrlChanged: root.syncArtwork()
  onActiveTrackSignatureChanged: root.syncArtwork()
  onArtworkHelperPathChanged: root.syncArtwork()

  Instantiator {
    model: root.players
    delegate: Connections {
      required property var modelData
      target: modelData
      function onIsPlayingChanged() {
        var pendingForPlayer = pendingTogglePlay
          && pendingTogglePlay.playerKey === playerKey(modelData)
        var applied = root.reconcileMprisPlaying(modelData)
        if (applied && !pendingForPlayer)
          root.settlePlaybackIntent(modelData)
        root.syncPlaybackStreamStates()
        root.confirmSourceHandoff(modelData)
        root.syncPlayingOrder()
      }
    }
  }

  // Quickshell's PipeWire object model does not reliably notify a derived
  // JavaScript array when a stream node appears or disappears. A tiny guarded
  // reconciliation loop closes that signal gap without changing state when
  // the boolean map is unchanged.
  Timer {
    id: streamSyncTimer
    interval: 50
    repeat: true
    running: root.players.length > 0
    onTriggered: root.syncPlaybackStreamStates()
  }

  Timer {
    id: togglePlayResetTimer
    interval: root.togglePlayResetDelayMs
    repeat: false
    onTriggered: root.finishTogglePlay()
  }

  Timer {
    id: togglePlayVerifyTimer
    interval: root.togglePlayVerifyDelayMs
    repeat: false
    onTriggered: root.verifyTogglePlay()
  }

  Timer {
    id: playbackIntentTimer
    interval: root.playbackIntentTimeoutMs
    repeat: false
    onTriggered: root.expirePlaybackIntents()
  }

  Timer {
    id: sourceHandoffTimer
    interval: root.sourceHandoffTimeoutMs
    repeat: false
    onTriggered: root.handleSourceHandoffTimeout()
  }

  Timer {
    id: trackOsdTimer
    interval: 120
    repeat: false
    onTriggered: root.flushPendingTrackOsd(false)
  }

  PwObjectTracker { objects: root.playbackStreams }
  PwObjectTracker { objects: root.links }
  // One-shot availability probe: `started` fires only when /usr/bin/cava
  // exists and executes; a missing binary silently flips running back to
  // false and we stay unavailable.
  Process {
    id: cavaProbe
    command: [root.cavaExecutable, "-v"]
    Component.onCompleted: running = true
    onStarted: root.cavaAvailable = true
    onExited: function(exitCode) {
      if (!root.cavaAvailable && exitCode !== 0)
        root.visualizerError = "cava is unavailable; install it with: omarchy pkg add cava"
    }
  }

  // The single analyzer process, one per service. It may stay warm for the
  // bounded linger window; every requested exit goes through stopVisualizerNow.
  Process {
    id: cavaProcess
    command: [root.cavaExecutable, "-p", root.cavaConfigPath]
    stdout: SplitParser {
      onRead: function(data) { root.handleSpectrumLine(data) }
    }
    stderr: SplitParser {
      onRead: function(data) {
        if (data) root.visualizerError = data
      }
    }
    onExited: function(exitCode, exitStatus) { root.handleCavaExited(exitCode, exitStatus) }
  }

  Timer {
    id: cavaRestartTimer
    interval: 2000
    repeat: false
    onTriggered: if (root.visualizerWanted) root.startVisualizer()
  }

  Timer {
    id: cavaLingerTimer
    interval: root.cavaLingerMs
    repeat: false
    onTriggered: root.stopVisualizerNow()
  }

  function resetVisualizer() {
    visualizerPeak = 0
    visualizerEnergy = 0
    visualizerLive = false
    visualizerLevels = AudioVisualizerModel.zeroLevels(visualizerLevelCount)
  }

  function handleSpectrumLine(line) {
    if (!visualizerMonitoring || !cavaProcess.running) return
    var frame = AudioVisualizerModel.parseSpectrumFrame(line, visualizerLevelCount, cavaMaxRange)
    if (!frame) return
    visualizerLevels = frame.levels
    visualizerPeak = frame.peak
    visualizerEnergy = frame.energy
    visualizerLive = frame.live
    visualizerFrame += 1
  }

  function startVisualizer(force) {
    if ((!visualizerWanted && !force) || cavaProcess.running) return
    if (!cavaConfigPath) {
      visualizerError = "cannot locate cava.conf (plugin source dir unknown)"
      return
    }
    if (!cavaAvailable) return
    visualizerError = ""
    cavaStopRequested = false
    cavaProcess.running = true
  }

  // Hover and popup-open prewarm the analyzer startup before the user presses
  // Play. If playback never starts, the same bounded linger timer tears it
  // down.
  function primeVisualizer() {
    if (!visualizerAvailable) return
    if (visualizerWanted) {
      cavaLingerTimer.stop()
      startVisualizer(false)
      return
    }
    cavaLingerTimer.restart()
    startVisualizer(true)
  }

  function stopVisualizerNow() {
    cavaRestartTimer.stop()
    cavaLingerTimer.stop()
    cavaStopRequested = true
    if (cavaProcess.running) cavaProcess.running = false
    visualizerError = ""
    resetVisualizer()
  }

  function handleCavaExited(exitCode, exitStatus) {
    resetVisualizer()
    if (cavaStopRequested || !visualizerWanted) return
    visualizerError = "cava exited unexpectedly (code " + exitCode + "); retrying"
    cavaRestartTimer.restart()
  }

  function syncVisualizer() {
    if (visualizerWanted) {
      cavaLingerTimer.stop()
      startVisualizer(false)
      return
    }

    resetVisualizer()
    if (cavaProcess.running) cavaLingerTimer.restart()
  }

  // One short-lived broker child per request. Each launch receives a single
  // JSON request line on stdin and must answer with a single JSON line on
  // stdout; the watchdog kills any child that outlives its deadline.
  Process {
    id: artworkBrokerProcess
    command: [root.artworkPythonExecutable, "-I", "-B", root.artworkHelperPath]
    stdinEnabled: true
    stdout: SplitParser {
      onRead: function(data) { root.handleArtworkLine(data) }
    }
    // The broker contract keeps stderr empty; drain it so the child can
    // never block on a full pipe. Its content is never surfaced.
    stderr: SplitParser {
      onRead: function(data) {}
    }
    onStarted: {
      if (!root.artworkRequest) {
        root.artworkStopRequested = true
        artworkBrokerProcess.running = false
        return
      }
      var payload = JSON.stringify({
        id: root.artworkRequest.id,
        url: root.artworkRequest.url
      }) + "\n"
      if (root.utf8ByteLength(payload) > 4096) {
        root.artworkError = "request-too-long"
        root.artworkRequest = null
        root.artworkStopRequested = true
        artworkBrokerProcess.running = false
        return
      }
      artworkBrokerProcess.write(payload)
    }
    onExited: function(exitCode, exitStatus) { root.handleArtworkBrokerExited(exitCode) }
  }

  Timer {
    id: artworkDebounceTimer
    interval: root.artworkDebounceMs
    repeat: false
    onTriggered: root.launchArtwork()
  }

  Timer {
    id: artworkWatchdog
    interval: root.artworkWatchdogMs
    repeat: false
    onTriggered: root.handleArtworkTimeout()
  }

  function syncArtwork() {
    // Invalidate everything in flight: a bumped generation and a cleared
    // request make any late broker answer undeliverable.
    artworkGeneration += 1
    artworkRequest = null
    artworkResponded = false
    artworkPendingLaunch = false
    artworkDebounceTimer.stop()
    artworkWatchdog.stop()
    artworkStopRequested = true
    if (artworkBrokerProcess.running) artworkBrokerProcess.running = false
    if (root.artUrl !== "") root.artUrl = ""

    if (!artworkCandidateUrl) {
      artworkError = ""
      return
    }
    if (!artworkHelperPath) {
      artworkError = "broker-unavailable"
      return
    }
    if (root.utf8ByteLength(artworkCandidateUrl) > 2048) {
      artworkError = "url-too-long"
      return
    }
    if (artworkCandidateUrl.slice(0, 8).toLowerCase() !== "https://") {
      // The broker only ever accepts absolute HTTPS; skip the spawn for the
      // local-file art covers many players advertise.
      artworkError = "artwork-unsupported-scheme"
      return
    }

    artworkPendingLaunch = true
    artworkDebounceTimer.restart()
  }

  function launchArtwork() {
    if (!artworkPendingLaunch) return
    if (artworkBrokerProcess.running) return
    if (!artworkCandidateUrl || !artworkHelperPath) return

    artworkPendingLaunch = false
    artworkError = ""
    artworkResponded = false
    artworkStopRequested = false
    artworkRequest = {
      id: artworkGeneration,
      url: artworkCandidateUrl,
      playerKey: root.activePlayerKey,
      trackSignature: root.activeTrackSignature
    }
    artworkBrokerProcess.running = true
    artworkWatchdog.restart()
  }

  function artworkRequestIsCurrent(request) {
    return !!request
      && request.id === artworkGeneration
      && request.url === root.artworkCandidateUrl
      && request.playerKey === root.activePlayerKey
      && request.trackSignature === root.activeTrackSignature
  }

  function retireArtworkBroker() {
    artworkStopRequested = true
    if (artworkBrokerProcess.running) artworkBrokerProcess.running = false
  }

  function finishArtworkRequest() {
    artworkWatchdog.stop()
    artworkRequest = null
    artworkResponded = false
    retireArtworkBroker()
  }

  function artworkFail(code) {
    if (root.artUrl !== "") root.artUrl = ""
    artworkError = code
    finishArtworkRequest()
  }

  function handleArtworkLine(line) {
    var request = artworkRequest
    if (!request || artworkResponded) return
    if (!line) return

    // Only the first answer line is meaningful and it must stay small.
    if (line.length > 8192) {
      artworkFail("broker-output")
      return
    }

    var parsed = null
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      parsed = null
    }

    if (!parsed || typeof parsed !== "object" || parsed.id !== request.id) {
      artworkFail("broker-protocol")
      return
    }

    artworkResponded = true
    artworkWatchdog.stop()

    if (!artworkRequestIsCurrent(request)) {
      // An answer for a superseded player/track/url can never become artUrl.
      artworkRequest = null
      retireArtworkBroker()
      return
    }

    if (parsed.ok !== true) {
      var err = parsed.error
      artworkFail(err && err.code ? String(err.code) : "broker-error")
      return
    }

    var path = parsed.path
    if (typeof path !== "string"
        || !/^\/[A-Za-z0-9._\/-]+\.png$/.test(path)) {
      artworkFail("broker-path")
      return
    }

    artworkError = ""
    root.artUrl = "file://" + path
    artworkRequest = null
    retireArtworkBroker()
  }

  function handleArtworkTimeout() {
    if (!artworkRequest || artworkResponded) return
    if (root.artUrl !== "") root.artUrl = ""
    artworkError = "broker-timeout"
    artworkRequest = null
    artworkResponded = false
    // SIGKILL (9): a wedged child must not survive its deadline.
    artworkStopRequested = true
    if (artworkBrokerProcess.running) artworkBrokerProcess.signal(9)
  }

  function handleArtworkBrokerExited(exitCode) {
    artworkWatchdog.stop()
    if (!artworkStopRequested && artworkRequest && !artworkResponded) {
      // Give a still-queued answer line one event loop pass to land before
      // declaring the exit a failure; capture the id so a newer request is
      // never punished for an older child's death.
      var awaitedId = artworkRequest.id
      Qt.callLater(function() {
        var req = root.artworkRequest
        if (req && req.id === awaitedId && !root.artworkResponded)
          root.artworkFail("broker-exit")
      })
    } else {
      artworkRequest = null
      artworkResponded = false
      artworkStopRequested = false
    }
    if (artworkPendingLaunch) artworkDebounceTimer.restart()
  }

  function statusJson() {
    var p = activePlayer
    var key = playerKey(p)
    var streamState = key && typeof streamPlayerStates[key] === "boolean"
      ? streamPlayerStates[key] : null
    var linkState = key && typeof streamLinkStates[key] === "boolean"
      ? streamLinkStates[key] : null
    var intentState = MediaModel.playbackIntentState(
      p, playbackIntents, Date.now())
    var matchedStream = p ? playbackStreamForPlayer(p) : null
    var matchedProperties = matchedStream ? nodeProps(matchedStream) : ({})
    var streamCorked = typeof matchedProperties["pulse.corked"] === "boolean"
      ? matchedProperties["pulse.corked"] : null
    return JSON.stringify({
      hasPlayer: p !== null,
      hasMedia: root.hasMedia,
      playing: root.activePlaying,
      mprisPlaying: p ? !!p.isPlaying : false,
      playbackStreamCount: playbackStreams.length,
      matchedPlaybackStream: p ? playerHasPlaybackStream(p) : false,
      activePlaybackStream: p ? playerHasActivePlaybackStream(p) : false,
      playbackStreamCorked: streamCorked,
      streamPlaying: streamState,
      pipewireLinkPlaying: linkState,
      intentPlaying: intentState,
      identity: p ? (p.identity || "") : "",
      desktopEntry: p ? (p.desktopEntry || "") : "",
      title: p ? (p.trackTitle || "") : "",
      artist: p ? (p.trackArtist || "") : "",
      album: p && p.trackAlbum ? p.trackAlbum : "",
      artUrl: root.artUrl,
      artworkError: root.artworkError,
      canGoNext: p ? !!p.canGoNext : false,
      canGoPrevious: p ? !!p.canGoPrevious : false,
      canTogglePlaying: p ? !!p.canTogglePlaying : false,
      visualizerBackend: root.visualizerBackend,
      visualizerError: root.visualizerError,
      visualizerAvailable: root.visualizerAvailable,
      visualizerMonitoring: root.visualizerMonitoring,
      visualizerLive: root.visualizerLive,
      visualizerPeak: root.visualizerPeak,
      visualizerEnergy: root.visualizerEnergy,
      visualizerLevels: root.visualizerLevels,
      visualizerFrame: root.visualizerFrame
    })
  }

  IpcHandler {
    target: "media"

    function status(): string {
      return root.statusJson()
    }

    function playPause(): string {
      return root.runAction("playPause", true) ? "ok" : "unhandled"
    }

    function next(): string {
      return root.runAction("next", true) ? "ok" : "unhandled"
    }

    function previous(): string {
      return root.runAction("previous", true) ? "ok" : "unhandled"
    }

    function play(): string {
      return root.runAction("play", true) ? "ok" : "unhandled"
    }

    function pause(): string {
      return root.runAction("pause", true) ? "ok" : "unhandled"
    }

    function sourceNext(): string {
      return root.switchSource(1, false, true) ? "ok" : "unhandled"
    }

    function sourcePrevious(): string {
      return root.switchSource(-1, false, true) ? "ok" : "unhandled"
    }

    function sourceSwitch(): string {
      return root.switchSource(1, true, true) ? "ok" : "unhandled"
    }

    function sourceSwitchPrevious(): string {
      return root.switchSource(-1, true, true) ? "ok" : "unhandled"
    }

    function ping(): string {
      return "ok"
    }
  }
}
