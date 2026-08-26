// Pure visualizer math for the nine-band FFT spectrum. No Quickshell types
// here: every function is plain deterministic JS over raw Cava ASCII frames
// so the service and unit tests share identical behavior.

// A raw band value: unsigned decimal digits only. Rejects NaN, Infinity,
// negative values, exponents, and empty or padded tokens before any numeric
// coercion can quietly coerce them.
var BAND_PATTERN = /^\d+(?:\.\d+)?$/

// Normalized band energy below this floor is digital silence, snapped to
// exact zero so an idle monitor renders clean zeros instead of noise.
var SILENCE_FLOOR = 0.008

// Perceptual scaling exponent. Mastered audio concentrates energy in the low
// bands; a sublinear gamma spreads it across the visual range using pure
// per-frame math — no smoothing, no time constants, no hidden state.
var BAND_GAMMA = 0.72

// Silence threshold for the aggregated peak, in scaled units.
var LIVE_THRESHOLD = 0.02

function zeroLevels(count) {
  var levels = []
  var n = Math.max(0, Math.floor(count) || 0)
  for (var i = 0; i < n; i++) levels.push(0)
  return levels
}

function clampUnit(value) {
  var n = Number(value)
  if (!isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

// Parses one raw Cava frame ("0;128;900;...;" with an optional trailing
// delimiter) into exactly `count` band levels in 0..maxRange units.
// Band order is preserved: levels[0] is the lowest frequency band and
// levels[count - 1] the highest. Values above maxRange clamp to it, values
// below the silence floor snap to zero, and survivors are gamma-scaled.
// Returns a JSON-safe { levels, peak, energy, live } where peak is the
// maximum level, energy the mean level, and live whether peak crosses the
// live threshold — or null for malformed, nonfinite, negative, or
// wrong-band-count frames.
function parseSpectrumFrame(line, count, maxRange) {
  if (typeof line !== "string") return null

  var n = Math.max(0, Math.floor(count) || 0)
  if (n < 1) return null

  var range = Number(maxRange)
  if (!isFinite(range) || range <= 0) return null

  var frame = line.replace(/\r?\n$/, "").trim()
  if (frame.length === 0) return null
  if (frame.charAt(frame.length - 1) === ";") frame = frame.slice(0, -1)

  var tokens = frame.split(";")
  if (tokens.length !== n) return null

  var levels = []
  var peak = 0
  var sum = 0
  for (var i = 0; i < n; i++) {
    var token = tokens[i]
    if (token.trim() !== token || !BAND_PATTERN.test(token)) return null
    var raw = Number(token)
    if (!isFinite(raw) || raw < 0) return null
    var normalized = Math.min(1, raw / range)
    var level = normalized < SILENCE_FLOOR ? 0 : Math.pow(normalized, BAND_GAMMA)
    levels.push(level)
    if (level > peak) peak = level
    sum += level
  }

  return {
    levels: levels,
    peak: peak,
    energy: sum / n,
    live: peak > LIVE_THRESHOLD
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    zeroLevels: zeroLevels,
    clampUnit: clampUnit,
    parseSpectrumFrame: parseSpectrumFrame
  }
}
