// Pure visualizer math for the temporal waveform. No Quickshell types here:
// every function is plain JS over native PCM peak samples so the service and
// unit tests share identical behavior.

// Envelope time constants. Attack must be fast enough to catch a 40ms sample
// window; release slow enough that the waveform decays smoothly between frames.
var ATTACK_MS = 24
var RELEASE_MS = 110

// An exponentially released value never reaches zero, so silent tails below
// this threshold snap to true zero for a clean idle state.
var ZERO_SNAP = 0.012

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

// Advances the waveform one 40ms frame from the coalesced native peak.
// levels is the previous history (oldest -> newest); the returned object
// carries the clamped instantaneous peak, the enveloped energy, whether audio
// is actually flowing, and a fresh history array of exactly `count` entries
// with energy appended as the newest value.
function advance(levels, rawPeak, energy, elapsedMs, count) {
  var target = clampUnit(rawPeak)
  // Gate the noise floor: a target below the snap threshold is silence.
  if (target < ZERO_SNAP) target = 0
  var previous = clampUnit(energy)
  var elapsed = isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0

  var tau = target > previous ? ATTACK_MS : RELEASE_MS
  var alpha = elapsed > 0 ? 1 - Math.exp(-elapsed / tau) : 0
  var next = previous + alpha * (target - previous)
  if (target === 0 && next < ZERO_SNAP) next = 0

  var n = Math.max(0, Math.floor(count) || 0)
  var history = Array.isArray(levels) ? levels.slice() : []
  history.push(next)
  while (history.length > n) history.shift()
  while (history.length < n) history.unshift(0)

  return {
    peak: target,
    energy: next,
    live: next >= ZERO_SNAP,
    levels: history
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    zeroLevels: zeroLevels,
    clampUnit: clampUnit,
    advance: advance
  }
}
