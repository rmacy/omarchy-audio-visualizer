# Audio Visualizer

A now-playing media chip for the [Omarchy](https://omarchy.org) bar, with
playback controls, a live nine-band audio spectrum, a track popup with a
spinning record-style album-art disk, and multi-player source switching
over MPRIS.

The chip is a **generic MPRIS client**: any MPRIS-capable player works —
mpv, Firefox, Chromium, Rhythmbox, Elisa, Audacious, and friends all show
up and can be controlled. There is no login, and no credentials or API
keys — if your desktop can show a media overlay for it, this chip can
display it.

The spectrum is computed by Cava from the default PipeWire output mix, so
it responds to **all audio on the default output**, independent of which
MPRIS source supplies metadata and controls.

## Features

- **Now-playing chip** in the bar: play/pause glyph, a live nine-band
  spectrum while playing, and a scrolling title · artist marquee.
- **Live FFT spectrum**: nine low-to-high frequency bands computed by
  Cava from the default PipeWire output — real signal data, not a
  looping animation (see [Spectrum](#spectrum)).
- **Quick controls from the bar** without opening anything (see
  [Controls](#controls)).
- **Track popup** with album art, title, artist, album, and
  previous / play-pause / next buttons. The popup shows the player's
  real album art masked into a circular record-style disk that spins
  only while the popup is open and the active player is playing; it
  sits still when playback is paused, the popup is closed, or no art
  is available.
- **Multi-player source selection**: when several MPRIS players are
  running, the popup lists them all so you can pick which one the chip
  follows.
- **Standard media keys keep working**: the service keeps Omarchy's stock
  `media` IPC target, so your existing media-key bindings and scripts need
  no changes.

## Requirements

- [Omarchy](https://omarchy.org) 4.x with `omarchy-shell`.
- [Cava](https://github.com/karlstav/cava) (0.10.x) computes the
  spectrum from PipeWire's default output monitor. Install it with
  `omarchy pkg add cava`.
- Any MPRIS-capable player: the plugin only reads and controls what the
  player exposes over MPRIS.

## Install

From any Omarchy machine:

```bash
omarchy plugin add https://github.com/rmacy/omarchy-audio-visualizer.git --enable
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

## Spectrum

The chip draws a compact **frequency spectrum**: nine bars spanning low
to high frequencies (60 Hz to 12 kHz), computed by a real FFT of the
default PipeWire output mix. It reflects what the audio is actually
doing right now — it is not a looping decoration.

- **FFT via Cava**: the headless service runs one `cava` process driven
  by the bundled `cava.conf` — PipeWire's default output monitor, nine
  bands from 60 Hz to 12 kHz at 25 fps. Cava is a runtime dependency;
  the service looks for it at `/usr/bin/cava`.
- **One process, every bar**: the Cava process lives in the headless
  service, and every bar instance on every monitor reads the same
  published levels — bars never spawn their own analyzers.
- **Runs only while playing**: the process starts when the active
  player is actually playing and stops the moment playback pauses or
  stops. After one second of silent output, Cava's sleep timer suspends
  FFT work until audio returns. Unexpected exits restart after 2 seconds.

Because the FFT taps the default PipeWire output mix rather than one
player's private stream, the bands show whatever is audible — with
several players running, the spectrum reflects the whole mix, not the
selected player alone. Silence or pause settles every band at zero.

Each bar's height is its band's current energy, shaped by a gentle
`pow(level, 0.72)` curve so quiet material still reads visually.

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
| `Service.qml`             | Headless MPRIS service: players, actions, `media` IPC, Cava child |
| `BarWidget.qml`           | The bar chip, spectrum, marquee, tooltip, and track/source popup  |
| `MediaModel.js`           | Pure helpers shared by the service and widget                     |
| `AudioVisualizerModel.js` | Pure spectrum-frame parser and band math for the service          |
| `cava.conf`               | Bundled Cava config: PipeWire output monitor, 9 bands, 25 fps     |

## Development

After editing, check the plugin still validates:

```bash
omarchy plugin validate .
```

The spectrum parser's pure logic (`AudioVisualizerModel.js`) has a
focused, dependency-free test:

```bash
node tests/AudioVisualizerModel.test.js
```

Reload live with `omarchy-shell shell rescanPlugins`.

## License

[MIT](LICENSE). Derived from Omarchy's built-in media plugin; runtime code
Copyright (c) David Heinemeier Hansson and the Omarchy project, with 2026
modifications by Ryan Macy.
