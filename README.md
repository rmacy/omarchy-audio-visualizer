# Spotify Player

A now-playing media chip for the [Omarchy](https://omarchy.org) bar, with
playback controls, a live audio waveform, a track popup, and multi-player
source switching over MPRIS.

Despite the name, the chip is a **generic MPRIS client**, not a Spotify
integration. It is optimized for [`spotify_player`](https://github.com/aome510/spotify_player),
a lightweight terminal Spotify client, but any MPRIS-capable player works:
mpv, Firefox, Chromium, Rhythmbox, Elisa, Audacious, and friends all show up
and can be controlled. There is no Spotify-exclusive code, no login, and no
credentials or API keys — if your desktop can show a media overlay for it,
this chip can display it.

## Features

- **Now-playing chip** in the bar: play/pause glyph, a live temporal
  waveform while playing, and a scrolling title · artist marquee.
- **Temporal waveform**: nine columns of recent peak levels sampled from
  the active player's PipeWire playback stream — real signal data, not a
  looping animation (see [Waveform](#waveform)).
- **Quick controls from the bar** without opening anything (see
  [Controls](#controls)).
- **Track popup** with album art, title, artist, album, and
  previous / play-pause / next buttons.
- **Multi-player source selection**: when several MPRIS players are
  running, the popup lists them all so you can pick which one the chip
  follows.
- **Standard media keys keep working**: the service keeps Omarchy's stock
  `media` IPC target, so your existing media-key bindings and scripts need
  no changes.

## Requirements

- [Omarchy](https://omarchy.org) 4.x with `omarchy-shell`.
- Any MPRIS player. For the intended setup, install
  [`spotify_player`](https://github.com/aome510/spotify_player) (AUR:
  `spotify-player`) and log into Spotify inside it once; this plugin only
  reads and controls what the player exposes over MPRIS.

## Install

From any Omarchy machine:

```bash
omarchy plugin add https://github.com/rmacy/spotify-player.git --enable
```

The chip appears in the left bar section when media is playing
(`omarchy bar move` relocates it). Enabling this plugin disables the
built-in `omarchy.media` widget it replaces.

Manual alternative: clone or copy this folder to
~/.config/omarchy/plugins/bitr0t.spotify-menu-chip/, run
`omarchy-shell shell rescanPlugins`, then
`omarchy plugin enable bitr0t.spotify-menu-chip`.

## Controls

| Action                     | Result                                   |
|----------------------------|------------------------------------------|
| Left-click chip            | Play / pause the active player           |
| Middle-click chip          | Next track                               |
| Right-click chip           | Open / close the track popup             |
| Scroll up on chip          | Previous track                           |
| Scroll down on chip        | Next track                               |
| Popup buttons              | Previous / play-pause / next             |
| Popup source list          | Switch the active player (when several)  |
| Hover chip                 | Full "title — artist" tooltip            |

## Source selection

With multiple players running, right-click the chip and pick a source in
the popup. Sources can also be cycled without the mouse through the
service's IPC: `sourceNext`, `sourcePrevious`, `sourceSwitch`, and
`sourceSwitchPrevious` (for example,
`omarchy-shell media sourceNext`). Playback can transfer to the newly
selected player as part of the switch.

## Media keys

The service registers the same `media` IPC target as the built-in plugin,
so Omarchy's stock media-key bindings (`playPause`, `next`, `previous`,
`play`, `pause`, plus `status` and `ping`) continue to work unchanged
while this plugin is enabled.

## Waveform

The chip draws a compact **temporal waveform**: nine columns holding a
short history of the active player's audio peak level, oldest to newest.
It reflects what the audio is actually doing right now — it is not a
looping decoration.

- **Native PipeWire peak monitor**: the service attaches one of
  Quickshell's `PwNodePeakMonitor` objects to the PipeWire playback
  stream that belongs to the active MPRIS player and samples its PCM
  peak every 40 ms. This is the shell's own monitor type, so the plugin
  adds no dependency and spawns no helper process.
- **One monitor, every bar**: the monitor lives in the headless service,
  and every bar instance on every monitor reads the same published
  levels — bars never instantiate their own monitors.

Each column is the stream's recent peak level over time, shaped by a
fast-attack / slow-release envelope (24 ms up, 110 ms down) so movement
reads naturally. Peaks below a small gate snap to zero. Silence drains the
short history and settles at rest; pausing or losing the matched stream
clears it immediately. In every case, the waveform stops moving at zero.

This is not an FFT and not a frequency-band display: the columns answer
"how strong was the signal, and when", not "which frequencies it
contained".

## Uninstall

```bash
omarchy plugin remove bitr0t.spotify-menu-chip
```

Because the plugin declares `omarchy.clonedFrom: omarchy.media`, removing
(or disabling) it restores the built-in Omarchy media widget, keeping your
bar position and media-key bindings intact.

## Files

| File                      | Purpose                                                          |
|---------------------------|------------------------------------------------------------------|
| `manifest.json`           | Plugin identity, entrypoints, widget metadata, replacement rules |
| `Service.qml`             | Headless MPRIS service: player tracking, actions, `media` IPC     |
| `BarWidget.qml`           | The bar chip, marquee, tooltip, and track/source popup            |
| `MediaModel.js`           | Pure helpers shared by the service and widget                     |
| `AudioVisualizerModel.js` | Pure peak-envelope and waveform-history math for the service      |

## Development

After editing, check the plugin still validates:

```bash
omarchy plugin validate .
```

The waveform's pure logic (`AudioVisualizerModel.js`) has a focused,
dependency-free test:

```bash
node tests/AudioVisualizerModel.test.js
```

Reload live with `omarchy-shell shell rescanPlugins`.

## License

[MIT](LICENSE). Derived from Omarchy's built-in media plugin; runtime code
Copyright (c) David Heinemeier Hansson and the Omarchy project, with 2026
modifications by Ryan Macy.
