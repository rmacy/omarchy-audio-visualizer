import QtQuick
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

  // Midnight surface with teal/cyan playback instrumentation.
  readonly property color musicColor: "#5eead4"
  readonly property color musicHighlight: "#61d5f8"
  readonly property color mutedMusicColor: "#5b8f91"
  readonly property color chipSurface: bar && !bar.transparent
    ? Qt.rgba(0.025, 0.05, 0.10, 0.94)
    : Qt.rgba(0.025, 0.05, 0.10, 0.68)
  readonly property color chipBorder: Qt.rgba(
    musicColor.r, musicColor.g, musicColor.b, isPlaying ? 0.56 : 0.28
  )

  property bool popupOpen: false
  property real maxLabelWidth: 180
  property real leadingGap: Style.space(8)

  function close() { popupOpen = false }

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
      border.width: 1
      border.color: root.chipBorder
      radius: height / 2

      Behavior on border.color {
        ColorAnimation { duration: 220 }
      }
    }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.space(6)

      Text {
        id: glyph
        anchors.verticalCenter: parent.verticalCenter
        text: root.playIcon
        color: root.isPlaying ? root.musicColor : root.mutedMusicColor
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
        id: equalizer
        width: Style.space(20)
        height: Style.space(16)
        anchors.verticalCenter: parent.verticalCenter

        Row {
          anchors.centerIn: parent
          spacing: Style.space(2)

          Repeater {
            model: 4

            Rectangle {
              required property int index
              readonly property real restingHeight: Style.space(3)
              readonly property real peakHeight: Style.space([8, 14, 11, 16][index])
              readonly property real middleHeight: Style.space([5, 8, 6, 10][index])
              property real pulseHeight: restingHeight

              width: Style.space(2)
              height: root.isPlaying ? pulseHeight : restingHeight
              radius: width / 2
              anchors.verticalCenter: parent.verticalCenter
              color: root.isPlaying && index % 2 ? root.musicHighlight
                : (root.isPlaying ? root.musicColor : root.mutedMusicColor)

              Behavior on color {
                ColorAnimation { duration: 180 }
              }

              SequentialAnimation on pulseHeight {
                running: root.isPlaying
                loops: Animation.Infinite

                PauseAnimation { duration: 40 + index * 55 }
                NumberAnimation {
                  to: peakHeight
                  duration: 170 + index * 25
                  easing.type: Easing.OutQuad
                }
                NumberAnimation {
                  to: middleHeight
                  duration: 150 + (3 - index) * 30
                  easing.type: Easing.InOutQuad
                }
                NumberAnimation {
                  to: restingHeight
                  duration: 220 + index * 20
                  easing.type: Easing.InQuad
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
          color: root.musicHighlight
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.body
          anchors.verticalCenter: parent.verticalCenter

          onTextChanged: scrollClip.scrollOffset = 0
        }

        Text {
          x: labelText.x + labelText.implicitWidth + scrollClip.textGap
          text: scrollClip.marqueeText
          color: root.musicHighlight
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
    contentWidth: popup.fittedContentWidth(Style.space(320))
    contentHeight: popup.fittedContentHeight(column.implicitHeight)

    Column {
      id: column
      anchors.fill: parent
      spacing: Style.space(10)

      Row {
        spacing: Style.space(10)
        width: parent.width

        BorderSurface {
          width: Style.space(64)
          height: Style.space(64)
          radius: Style.spacing.labelGap
          color: Style.normalFillFor(root.bar.foreground, Color.accent)
          borderSpec: Border.controlSpec("normal", root.bar.foreground, Color.accent)

          Image {
            anchors.fill: parent
            anchors.margins: Style.space(2)
            fillMode: Image.PreserveAspectCrop
            asynchronous: true
            source: root.activePlayer && root.activePlayer.trackArtUrl ? root.activePlayer.trackArtUrl : ""
            visible: source !== ""
          }

          Text {
            anchors.centerIn: parent
            visible: !root.activePlayer || !root.activePlayer.trackArtUrl
            text: "󰝚"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.displayLarge
          }
        }

        Column {
          spacing: Style.space(4)
          width: parent.width - Style.space(74)

          Text {
            text: root.title || "Nothing playing"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.subtitle
            font.bold: true
            elide: Text.ElideRight
            width: parent.width
          }

          Text {
            text: root.artist
            color: Qt.darker(root.bar.foreground, 1.3)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
            width: parent.width
            visible: text !== ""
          }

          Text {
            text: root.activePlayer && root.activePlayer.trackAlbum ? root.activePlayer.trackAlbum : ""
            color: Qt.darker(root.bar.foreground, 1.6)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
            width: parent.width
            visible: text !== ""
          }
        }
      }

      Row {
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: Style.space(6)

        Button {
          iconText: "󰒮"
          foreground: root.bar.foreground
          horizontalPadding: Style.spacing.controlPaddingX
          verticalPadding: Style.spacing.controlPaddingY
          enabled: root.activePlayer && root.activePlayer.canGoPrevious
          opacity: enabled ? 1.0 : 0.4
          onClicked: if (root.mediaService) root.mediaService.runAction("previous", false, root.mediaService.playerKey(root.activePlayer))
        }

        Button {
          iconText: root.activePlayer && root.activePlayer.isPlaying ? "󰏤" : "󰐊"
          foreground: root.bar.foreground
          horizontalPadding: Style.spacing.panelGap
          verticalPadding: Style.spacing.controlPaddingY
          iconSize: Style.font.iconLarge
          enabled: root.activePlayer && (root.activePlayer.canTogglePlaying || root.activePlayer.canPlay || root.activePlayer.canPause)
          opacity: enabled ? 1.0 : 0.4
          onClicked: if (root.mediaService) root.mediaService.runAction("playPause", false, root.mediaService.playerKey(root.activePlayer))
        }

        Button {
          iconText: "󰒭"
          foreground: root.bar.foreground
          horizontalPadding: Style.spacing.controlPaddingX
          verticalPadding: Style.spacing.controlPaddingY
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
        spacing: Style.space(4)

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
            height: sourceInner.implicitHeight + Style.space(10)
            radius: Style.spacing.labelGap
            color: selected ? Style.selectedFillFor(root.bar.foreground, Color.accent) : "transparent"
            borderSpec: selected ? Border.controlSpec("normal", root.bar.foreground, Color.accent) : Border.none()

            Row {
              id: sourceInner
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: sourceRow.borderLeft + Style.space(8)
              anchors.rightMargin: sourceRow.borderRight + Style.space(8)
              spacing: Style.space(8)

              Text {
                text: sourceRow.player && sourceRow.player.isPlaying ? "󰏤" : "󰐊"
                color: root.bar.foreground
                font.family: root.bar.fontFamily
                font.pixelSize: Style.font.body
                width: Style.space(18)
                horizontalAlignment: Text.AlignHCenter
                anchors.verticalCenter: parent.verticalCenter
              }

              Column {
                width: parent.width - Style.space(26)
                spacing: Style.space(1)
                anchors.verticalCenter: parent.verticalCenter

                Text {
                  text: sourceRow.sourceTitle
                  color: root.bar.foreground
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.bold: sourceRow.selected
                  elide: Text.ElideRight
                  width: parent.width
                }

                Text {
                  text: sourceRow.sourceDetail
                  color: Qt.darker(root.bar.foreground, 1.5)
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
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
