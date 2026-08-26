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

  readonly property var players: Mpris.players ? Mpris.players.values : []
  readonly property var nodes: Pipewire.nodes ? Pipewire.nodes.values : []
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
  readonly property bool visualizerWanted: visualizerAvailable && activePlayer !== null && activePlayer.isPlaying
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

  function canCycleSource(player) {
    return MediaModel.canCycleSource(player)
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
      if (hasMetadata(p) && !isBackgroundPlayer(p)) list.push(p)
    }

    list.sort(function(a, b) {
      if (!!a.isPlaying !== !!b.isPlaying) return a.isPlaying ? -1 : 1
      if (isProxyPlayer(a) !== isProxyPlayer(b)) return isProxyPlayer(a) ? 1 : -1
      if (a.isPlaying && b.isPlaying) {
        var orderDelta = playerOrder(a, 1000) - playerOrder(b, 1000)
        if (orderDelta !== 0) return orderDelta
      }
      return labelFor(a).localeCompare(labelFor(b))
    })

    return list
  }

  function orderedCycleSourcePlayers() {
    var list = []
    for (var i = 0; i < players.length; i++) {
      var p = players[i]
      if (canCycleSource(p) && !isBackgroundPlayer(p)) list.push(p)
    }

    list.sort(function(a, b) {
      if (isProxyPlayer(a) !== isProxyPlayer(b)) return isProxyPlayer(a) ? 1 : -1
      return labelFor(a).localeCompare(labelFor(b))
    })

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
      if (p.isPlaying) {
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

    if (preferred && preferred.isPlaying) return preferred
    var streamCandidate = streamPlayer || streamProxy
    var streamPreferred = preferred && playerHasPlaybackStream(preferred) ? preferred : null
    return oldestPlayingPlayer(true) || oldestPlayingPlayer(false) || streamPreferred || streamCandidate || preferred || trackPlayer || trackProxy || controllablePlayer || controllableProxy || identityPlayer || identityProxy || null
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

  function transferPlaybackBetween(current, next, enabled) {
    return MediaModel.transferPlayback(current, next, enabled,
      function(target) { return root.playPlayer(target) },
      function(target) { return root.pausePlayer(target) })
  }

  function selectPlayer(key, transferPlayback) {
    var player = playerForKey(key)
    if (!player || isBackgroundPlayer(player) || !hasMetadata(player)) return false
    var current = activePlayer
    preferredPlayerKey = playerKey(player)
    transferPlaybackBetween(current, player, transferPlayback)
    return true
  }

  function playPlayer(player) {
    if (!player) return false
    if (player.canPlay) {
      player.play()
      return true
    }
    return false
  }

  function pausePlayer(player) {
    if (!player) return false
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
    var current = activePlayer
    var next = list[index]

    preferredPlayerKey = playerKey(next)
    transferPlaybackBetween(current, next, transferPlayback)

    if (showFeedback !== false) Qt.callLater(function() {
      root.showOsd("Source", "media-source", next)
    })

    return true
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
    var handled = false

    if (action === "next") {
      actionLabel = "Next"
      iconName = "media-next"
      if (player && player.canGoNext) {
        player.next()
        handled = true
      }
    } else if (action === "previous") {
      actionLabel = "Previous"
      iconName = "media-previous"
      if (player && player.canGoPrevious) {
        player.previous()
        handled = true
      }
    } else if (action === "play") {
      actionLabel = "Play"
      iconName = "media-play"
      if (player && player.canPlay) {
        player.play()
        handled = true
      } else if (player && player.canTogglePlaying && !player.isPlaying) {
        player.togglePlaying()
        handled = true
      }
    } else if (action === "pause") {
      actionLabel = "Pause"
      iconName = "media-pause"
      if (player && player.canPause) {
        player.pause()
        handled = true
      } else if (player && player.canTogglePlaying && player.isPlaying) {
        player.togglePlaying()
        handled = true
      }
    } else if (action === "playPause") {
      actionLabel = player && player.isPlaying ? "Pause" : "Play"
      iconName = player && player.isPlaying ? "media-pause" : "media-play"
      if (player && player.isPlaying && player.canPause) {
        player.pause()
        handled = true
      } else if (player && !player.isPlaying && player.canPlay) {
        player.play()
        handled = true
      } else if (player && player.canTogglePlaying) {
        player.togglePlaying()
        handled = true
      }
    }

    if (handled && key) preferredPlayerKey = key
    if (showFeedback !== false)
      scheduleOsd(actionLabel, iconName, player, handled && (action === "next" || action === "previous"), beforeTrackSignature)
    return handled
  }

  // Recompute play-order reactively instead of polling every 500ms.
  // syncPlayingOrder only depends on the set of players and each player's
  // isPlaying state: onPlayersChanged covers players appearing/disappearing,
  // and the Instantiator wires isPlayingChanged for each live player.
  Component.onCompleted: {
    root.syncPlayingOrder()
    root.syncArtwork()
  }
  onPlayersChanged: root.syncPlayingOrder()
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
      function onIsPlayingChanged() { root.syncPlayingOrder() }
    }
  }

  Timer {
    id: trackOsdTimer
    interval: 120
    repeat: false
    onTriggered: root.flushPendingTrackOsd(false)
  }

  PwObjectTracker { objects: root.playbackStreams }
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

  // The single analyzer process, one per service. Any exit that was not
  // requested by stopVisualizer while media is still playing is unexpected.
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

  function startVisualizer() {
    if (!visualizerWanted || cavaProcess.running) return
    if (!cavaConfigPath) {
      visualizerError = "cannot locate cava.conf (plugin source dir unknown)"
      return
    }
    visualizerError = ""
    cavaStopRequested = false
    cavaProcess.running = true
  }

  function stopVisualizer() {
    cavaRestartTimer.stop()
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
    if (visualizerWanted) startVisualizer()
    else stopVisualizer()
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
    return JSON.stringify({
      hasPlayer: p !== null,
      hasMedia: root.hasMedia,
      playing: p ? !!p.isPlaying : false,
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
