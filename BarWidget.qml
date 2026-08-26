import QtQuick
import QtQuick.Effects
import Quickshell
import qs.Ui
import qs.Commons

BarWidget {
  id: root
  moduleName: "bitr0t.spotify-menu-chip"

  readonly property var mediaService: bar?.shell?.serviceFor(root.moduleName)
  readonly property var activePlayer: mediaService ? mediaService.activePlayer : null
  readonly property var sourcePlayers: mediaService ? mediaService.sourcePlayers : []
  readonly property bool hasMedia: activePlayer !== null && (activePlayer.trackTitle || activePlayer.trackArtist)
  readonly property bool isPlaying: !!(activePlayer && activePlayer.isPlaying)
  readonly property string playIcon: isPlaying ? "󰏤" : "󰐊"
  readonly property string title: activePlayer ? (activePlayer.trackTitle || "") : ""
  readonly property string artist: activePlayer ? (activePlayer.trackArtist || "") : ""

  readonly property var zeroVisualizerLevels: [0, 0, 0, 0, 0, 0, 0, 0, 0]
  readonly property var visualizerLevels: mediaService
    && mediaService.visualizerLevels
    && mediaService.visualizerLevels.length === 9
      ? mediaService.visualizerLevels
      : zeroVisualizerLevels
  readonly property real visualizerPeak: mediaService && isFinite(mediaService.visualizerPeak)
    ? mediaService.visualizerPeak : 0
  readonly property real visualizerEnergy: mediaService && isFinite(mediaService.visualizerEnergy)
    ? mediaService.visualizerEnergy : 0
  readonly property bool visualizerLive: !!(mediaService && mediaService.visualizerLive)
  readonly property bool visualizerAvailable: !!(mediaService && mediaService.visualizerAvailable)
  readonly property bool visualizerMonitoring: !!(mediaService && mediaService.visualizerMonitoring)
  readonly property int visualizerFrame: mediaService ? (mediaService.visualizerFrame || 0) : 0

  readonly property color barTextColor: Color.bar.text
  readonly property color barActiveColor: Color.bar.active
  readonly property color barMutedColor: Color.muted
  readonly property color chipSurface: chip.tooltipHovered
    ? Style.hoverFillFor(barTextColor, barActiveColor)
    : Style.normalFillFor(barTextColor, barActiveColor)
  readonly property color chipBorder: chip.tooltipHovered
    ? Style.hoverBorderFor(barTextColor, barActiveColor)
    : Style.normalBorderFor(barTextColor, barActiveColor)

  property bool popupOpen: false
  property real maxLabelWidth: 180
  property real leadingGap: Style.space(8)

  function close() { popupOpen = false }

  function mixColor(from, to, amount) {
    var t = Math.max(0, Math.min(1, amount))
    return Qt.rgba(
      from.r + (to.r - from.r) * t,
      from.g + (to.g - from.g) * t,
      from.b + (to.b - from.b) * t,
      from.a + (to.a - from.a) * t
    )
  }

  visible: hasMedia
  implicitWidth: hasMedia ? chip.implicitWidth + leadingGap * 2 : 0
  implicitHeight: barSize

  WidgetButton {
    id: chip
    anchors.left: parent.left
    anchors.leftMargin: root.leadingGap
    anchors.verticalCenter: parent.verticalCenter
    bar: root.bar
    labelVisible: false
    hasVisualContent: root.hasMedia
    fixedWidth: content.implicitWidth + Style.space(20)
    fixedHeight: root.barSize
    tooltipText: root.hasMedia ? (root.title + (root.artist ? " — " + root.artist : "")) : ""

    onPressed: function(button) {
      if (!root.activePlayer || !root.mediaService) return
      var playerKey = root.mediaService.playerKey(root.activePlayer)
      if (button === Qt.MiddleButton) {
        root.mediaService.runAction("next", false, playerKey)
      } else if (button === Qt.RightButton) {
        root.popupOpen = !root.popupOpen
      } else {
        root.mediaService.runAction(root.isPlaying ? "pause" : "play", false, playerKey)
      }
    }
    onWheelMoved: function(delta) {
      if (!root.activePlayer || !root.mediaService) return
      var playerKey = root.mediaService.playerKey(root.activePlayer)
      if (delta > 0) root.mediaService.runAction("previous", false, playerKey)
      else if (delta < 0) root.mediaService.runAction("next", false, playerKey)
    }

    Rectangle {
      anchors.fill: parent
      anchors.topMargin: 2
      anchors.bottomMargin: 2
      color: root.chipSurface
      border.width: chip.tooltipHovered ? Style.hoverBorderWidth : Style.normalBorderWidth
      border.color: root.chipBorder
      radius: height / 2

      Behavior on border.color {
        ColorAnimation { duration: 220 }
      }
    }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.space(4)

      Text {
        id: glyph
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(14)
        horizontalAlignment: Text.AlignHCenter
        text: root.playIcon
        color: root.isPlaying ? root.barActiveColor : root.barMutedColor
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.body
        opacity: root.isPlaying ? 1 : 0.7

        Behavior on color {
          ColorAnimation { duration: 180 }
        }
        Behavior on opacity {
          NumberAnimation { duration: 180 }
        }
      }

      Item {
        id: spectrum
        readonly property int bandCount: 9
        readonly property real bandWidth: Style.space(2)
        readonly property real bandGap: Style.space(1)
        readonly property real baselineHeight: Style.space(2)

        width: bandCount * bandWidth + (bandCount - 1) * bandGap
        height: Style.space(16)
        anchors.verticalCenter: parent.verticalCenter

        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          anchors.bottom: parent.bottom
          spacing: spectrum.bandGap

          Repeater {
            model: spectrum.bandCount

            Rectangle {
              required property int index
              readonly property real bandLevel: {
                root.visualizerFrame
                var value = root.visualizerLevels[index]
                return isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
              }

              width: spectrum.bandWidth
              height: spectrum.baselineHeight
                + bandLevel * (spectrum.height - spectrum.baselineHeight)
              radius: width / 2
              anchors.bottom: parent.bottom
              color: !root.visualizerAvailable || bandLevel <= 0
                ? root.barMutedColor
                : root.mixColor(root.barTextColor, root.barActiveColor, bandLevel)
              opacity: root.visualizerAvailable
                ? 0.55 + bandLevel * 0.45
                : 0.28

              Behavior on height {
                enabled: root.visualizerMonitoring

                NumberAnimation {
                  duration: 45
                  easing.type: Easing.OutCubic
                }
              }
            }
          }
        }
      }

      Item {
        id: scrollClip
        readonly property string marqueeText: root.title + (root.artist ? "  ·  " + root.artist : "")
        readonly property real textGap: Style.space(24)
        readonly property real travelDistance: labelText.implicitWidth + textGap
        property real scrollOffset: 0

        width: Math.min(root.maxLabelWidth, Math.max(Style.space(110), labelText.implicitWidth))
        height: glyph.height
        clip: true
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.bar.vertical && root.title !== ""

        Text {
          id: labelText
          x: -scrollClip.scrollOffset
          text: scrollClip.marqueeText
          color: root.barTextColor
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.body
          anchors.verticalCenter: parent.verticalCenter

          onTextChanged: scrollClip.scrollOffset = 0
        }

        Text {
          x: labelText.x + labelText.implicitWidth + scrollClip.textGap
          text: scrollClip.marqueeText
          color: root.barTextColor
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.body
          anchors.verticalCenter: parent.verticalCenter
        }

        SequentialAnimation on scrollOffset {
          id: scrollSequence
          running: scrollClip.visible && !root.popupOpen && !root.bar.vertical
          loops: Animation.Infinite
          onRunningChanged: if (!running) scrollClip.scrollOffset = 0

          NumberAnimation {
            from: 0
            to: scrollClip.travelDistance
            duration: Math.max(6000, scrollClip.travelDistance * 36)
            easing.type: Easing.Linear
          }
        }
      }
    }
  }

  PopupCard {
    id: popup
    anchorItem: root
    bar: root.bar
    owner: root
    open: root.popupOpen
    contentWidth: popup.fittedContentWidth(Style.space(420))
    contentHeight: popup.fittedContentHeight(column.implicitHeight)

    Column {
      id: column
      anchors.fill: parent
      spacing: Style.space(16)

      Row {
        id: header
        width: parent.width
        spacing: Style.space(16)

        BorderSurface {
          id: albumDisk
          readonly property bool artReady: albumArt.status === Image.Ready

          width: Style.space(112)
          height: width
          radius: width / 2
          antialiasing: true
          color: Style.normalFillFor(root.bar.foreground, Color.accent)
          borderSpec: Border.controlSpec("normal", root.bar.foreground, Color.accent)

          Item {
            id: recordFace
            anchors.centerIn: parent
            width: Style.space(104)
            height: width
            transformOrigin: Item.Center

            Image {
              id: albumArt
              anchors.fill: parent
              fillMode: Image.PreserveAspectCrop
              asynchronous: true
              smooth: true
              source: root.mediaService ? root.mediaService.artUrl : ""
              sourceSize.width: recordFace.width
              sourceSize.height: recordFace.height
              visible: false
            }

            Rectangle {
              id: albumArtMask
              anchors.fill: parent
              radius: width / 2
              antialiasing: true
              color: root.bar.foreground
              visible: false
              layer.enabled: true
              layer.smooth: true
              layer.samples: 4
            }

            MultiEffect {
              anchors.fill: parent
              source: albumArt
              maskEnabled: true
              maskSource: albumArtMask
              maskThresholdMin: 0.5
              maskThresholdMax: 1.0
              maskSpreadAtMin: 0.02
              maskSpreadAtMax: 0.02
              visible: albumDisk.artReady
            }

            Item {
              anchors.fill: parent
              visible: albumDisk.artReady


              Rectangle {
                anchors.centerIn: parent
                width: Style.space(32)
                height: width
                radius: width / 2
                antialiasing: true
                color: root.mixColor(Color.popups.background, root.bar.foreground, 0.12)
                border.width: Math.max(Style.normalBorderWidth, Style.space(2))
                border.color: root.bar.foreground

                Rectangle {
                  anchors.centerIn: parent
                  width: Style.space(8)
                  height: width
                  radius: width / 2
                  antialiasing: true
                  color: Color.popups.background
                  border.width: Style.normalBorderWidth
                  border.color: root.bar.foreground
                }
              }
            }

            RotationAnimator {
              target: recordFace
              from: 0
              to: 360
              duration: 10000
              loops: Animation.Infinite
              running: root.popupOpen && root.isPlaying && albumDisk.artReady
            }
          }

          Text {
            anchors.centerIn: parent
            visible: !albumDisk.artReady
            text: "󰝚"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.displayLarge
          }
        }

        Column {
          width: header.width - albumDisk.width - header.spacing
          spacing: Style.space(6)
          anchors.verticalCenter: parent.verticalCenter

          Text {
            text: root.title || "Nothing playing"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.heading
            font.bold: true
            wrapMode: Text.Wrap
            width: parent.width
          }

          Text {
            text: root.artist
            color: Qt.darker(root.bar.foreground, 1.3)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.subtitle
            wrapMode: Text.Wrap
            width: parent.width
            visible: text !== ""
          }

          Text {
            text: root.activePlayer && root.activePlayer.trackAlbum ? root.activePlayer.trackAlbum : ""
            color: Qt.darker(root.bar.foreground, 1.6)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            width: parent.width
            visible: text !== ""
          }
        }
      }

      Row {
        id: transportDeck
        width: parent.width
        height: Style.space(58)
        spacing: Style.space(8)

        Button {
          width: (transportDeck.width - transportDeck.spacing * 2) / 3
          height: transportDeck.height
          iconText: "󰒮"
          foreground: root.bar.foreground
          horizontalPadding: 0
          verticalPadding: 0
          iconSize: Style.font.display
          bordered: true
          enabled: root.activePlayer && root.activePlayer.canGoPrevious
          opacity: enabled ? 1.0 : 0.4
          onClicked: if (root.mediaService) root.mediaService.runAction("previous", false, root.mediaService.playerKey(root.activePlayer))
        }

        Button {
          width: (transportDeck.width - transportDeck.spacing * 2) / 3
          height: transportDeck.height
          iconText: root.activePlayer && root.activePlayer.isPlaying ? "󰏤" : "󰐊"
          foreground: root.bar.foreground
          horizontalPadding: 0
          verticalPadding: 0
          iconSize: Style.font.display
          bordered: true
          enabled: root.activePlayer && (root.activePlayer.canTogglePlaying || root.activePlayer.canPlay || root.activePlayer.canPause)
          opacity: enabled ? 1.0 : 0.4
          onClicked: if (root.mediaService) root.mediaService.runAction("playPause", false, root.mediaService.playerKey(root.activePlayer))
        }

        Button {
          width: (transportDeck.width - transportDeck.spacing * 2) / 3
          height: transportDeck.height
          iconText: "󰒭"
          foreground: root.bar.foreground
          horizontalPadding: 0
          verticalPadding: 0
          iconSize: Style.font.display
          bordered: true
          enabled: root.activePlayer && root.activePlayer.canGoNext
          opacity: enabled ? 1.0 : 0.4
          onClicked: if (root.mediaService) root.mediaService.runAction("next", false, root.mediaService.playerKey(root.activePlayer))
        }
      }

      PanelSeparator {
        visible: root.sourcePlayers.length > 1
        foreground: root.bar.foreground
      }

      Column {
        id: sourceList
        visible: root.sourcePlayers.length > 1
        width: parent.width
        spacing: Style.space(8)

        Repeater {
          model: root.sourcePlayers

          BorderSurface {
            id: sourceRow
            required property var modelData

            readonly property var player: modelData
            readonly property bool selected: root.activePlayer && player
              && root.mediaService.playerKey(root.activePlayer) === root.mediaService.playerKey(player)
            readonly property string sourceTitle: player ? (player.trackTitle || player.identity || player.desktopEntry || "Media source") : "Media source"
            readonly property string sourceDetail: player && player.trackArtist ? player.trackArtist : (player && player.identity ? player.identity : "")

            width: sourceList.width
            height: Math.max(Style.space(56), sourceInner.implicitHeight + Style.space(20))
            radius: Style.spacing.labelGap
            color: selected ? Style.selectedFillFor(root.bar.foreground, Color.accent) : "transparent"
            borderSpec: selected ? Border.controlSpec("normal", root.bar.foreground, Color.accent) : Border.none()

            Row {
              id: sourceInner
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: sourceRow.borderLeft + Style.space(12)
              anchors.rightMargin: sourceRow.borderRight + Style.space(12)
              spacing: Style.space(10)

              Text {
                id: sourceIcon
                text: sourceRow.player && sourceRow.player.isPlaying ? "󰏤" : "󰐊"
                color: root.bar.foreground
                font.family: root.bar.fontFamily
                font.pixelSize: Style.font.iconLarge
                width: Style.space(24)
                horizontalAlignment: Text.AlignHCenter
                anchors.verticalCenter: parent.verticalCenter
              }

              Column {
                width: sourceInner.width - sourceIcon.width - sourceInner.spacing
                spacing: Style.space(3)
                anchors.verticalCenter: parent.verticalCenter

                Text {
                  text: sourceRow.sourceTitle
                  color: root.bar.foreground
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.subtitle
                  font.bold: sourceRow.selected
                  wrapMode: Text.Wrap
                  width: parent.width
                }

                Text {
                  text: sourceRow.sourceDetail
                  color: Qt.darker(root.bar.foreground, 1.5)
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.body
                  wrapMode: Text.Wrap
                  width: parent.width
                  visible: text !== ""
                }
              }
            }

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: if (root.mediaService) root.mediaService.selectPlayer(root.mediaService.playerKey(sourceRow.player))
            }
          }
        }
      }
    }
  }
}
