"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Spectrum = require("../AudioVisualizerModel.js");

const SILENCE_FLOOR = 0.008;
const GAMMA = 0.72;
const LIVE_THRESHOLD = 0.02;
const EPSILON = 1e-9;

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= EPSILON,
    `${message}: expected ${expected}, got ${actual}`);
}

function expectedLevel(raw, range) {
  const normalized = Math.min(1, raw / range);
  return normalized < SILENCE_FLOOR ? 0 : Math.pow(normalized, GAMMA);
}

function decimal(value) {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

const zeroLevelCases = [
  [undefined, 0],
  [null, 0],
  [false, 0],
  [true, 1],
  [NaN, 0],
  [-10, 0],
  [-1, 0],
  [-0.1, 0],
  [0, 0],
  [0.1, 0],
  [0.99, 0],
  [1, 1],
  [1.01, 1],
  [2.99, 2],
  [9, 9],
  ["3", 3],
  ["3.9", 3],
  ["invalid", 0]
];

zeroLevelCases.forEach(([input, expected], index) => {
  test(`zeroLevels case=${index} input=${String(input)}`, () => {
    const levels = Spectrum.zeroLevels(input);
    assert.equal(levels.length, expected);
    assert.deepEqual(levels, Array(expected).fill(0));
    if (levels.length > 0) {
      levels[0] = 1;
      assert.deepEqual(Spectrum.zeroLevels(input), Array(expected).fill(0),
        "each call must return independent storage");
    }
  });
});

const clampCases = [
  [undefined, 0],
  [null, 0],
  [false, 0],
  [true, 1],
  [NaN, 0],
  [Infinity, 0],
  [-Infinity, 0],
  [-100, 0],
  [-1, 0],
  [-Number.MIN_VALUE, 0],
  [0, 0],
  [Number.MIN_VALUE, Number.MIN_VALUE],
  [0.001, 0.001],
  [0.25, 0.25],
  [0.5, 0.5],
  [0.999, 0.999],
  [1, 1],
  [1.001, 1],
  [100, 1],
  ["0.5", 0.5],
  ["2", 1],
  ["invalid", 0],
  ["", 0]
];

clampCases.forEach(([input, expected], index) => {
  test(`clampUnit case=${index} input=${String(input)}`, () => {
    assert.equal(Spectrum.clampUnit(input), expected);
  });
});

const profiles = [
  {
    name: "silence",
    values(count, range) { return Array(count).fill(0); }
  },
  {
    name: "below-floor",
    values(count, range) { return Array(count).fill(range * 0.007); }
  },
  {
    name: "at-floor",
    values(count, range) { return Array(count).fill(range * SILENCE_FLOOR); }
  },
  {
    name: "quarter",
    values(count, range) { return Array(count).fill(range * 0.25); }
  },
  {
    name: "half",
    values(count, range) { return Array(count).fill(range * 0.5); }
  },
  {
    name: "maximum",
    values(count, range) { return Array(count).fill(range); }
  },
  {
    name: "above-maximum",
    values(count, range) { return Array(count).fill(range * 1.5); }
  },
  {
    name: "ordered-ramp",
    values(count, range) {
      return Array.from({ length: count }, (_, index) =>
        range * (index + 1) / count);
    }
  }
];

for (const count of [1, 2, 3, 9, 16]) {
  for (const range of [10, 1000]) {
    profiles.forEach(profile => {
      test(`parse valid count=${count} range=${range} profile=${profile.name}`, () => {
        const rawValues = profile.values(count, range);
        const frame = rawValues.map(decimal).join(";") + ";";
        const result = Spectrum.parseSpectrumFrame(frame, count, range);
        assert.notEqual(result, null);
        assert.equal(result.levels.length, count);

        const expectedLevels = rawValues.map(raw => expectedLevel(raw, range));
        expectedLevels.forEach((expected, index) => {
          close(result.levels[index], expected, `band ${index}`);
        });
        const expectedPeak = Math.max(...expectedLevels);
        const expectedEnergy = expectedLevels.reduce((sum, value) => sum + value, 0) / count;
        close(result.peak, expectedPeak, "peak");
        close(result.energy, expectedEnergy, "energy");
        assert.equal(result.live, expectedPeak > LIVE_THRESHOLD);
      });
    });
  }
}

for (const count of [1, 2, 3, 9, 16]) {
  const base = Array.from({ length: count }, (_, index) => String(index + 1)).join(";");
  const forms = [
    { name: "plain", line: base },
    { name: "trailing-delimiter", line: base + ";" },
    { name: "newline", line: base + "\n" },
    { name: "crlf-and-delimiter", line: base + ";\r\n" },
    { name: "outer-whitespace", line: "  " + base + ";  " }
  ];
  forms.forEach(form => {
    test(`delimiter form count=${count} form=${form.name}`, () => {
      assert.notEqual(Spectrum.parseSpectrumFrame(form.line, count, 1000), null);
    });
  });
}

const malformedTokens = [
  "",
  " ",
  "-1",
  "+1",
  ".5",
  "1.",
  "1e2",
  "1E2",
  "NaN",
  "Infinity",
  "0x10",
  "1_000",
  " 1",
  "1 ",
  "1\t",
  "true",
  "null",
  "--1",
  "1,5",
  "∞"
];

malformedTokens.forEach((token, index) => {
  test(`malformed band token index=${index} token=${JSON.stringify(token)}`, () => {
    const frame = ["1", token, "2"].join(";");
    assert.equal(Spectrum.parseSpectrumFrame(frame, 3, 1000), null);
  });
});

const malformedFrames = [
  { name: "non-string null", line: null, count: 1, range: 1000 },
  { name: "non-string number", line: 1, count: 1, range: 1000 },
  { name: "non-string array", line: ["1"], count: 1, range: 1000 },
  { name: "empty", line: "", count: 1, range: 1000 },
  { name: "whitespace", line: "   ", count: 1, range: 1000 },
  { name: "only delimiter", line: ";", count: 1, range: 1000 },
  { name: "double delimiter", line: "1;;2", count: 3, range: 1000 },
  { name: "too few", line: "1;2", count: 3, range: 1000 },
  { name: "too many", line: "1;2;3;4", count: 3, range: 1000 },
  { name: "zero count", line: "1", count: 0, range: 1000 },
  { name: "negative count", line: "1", count: -1, range: 1000 },
  { name: "NaN count", line: "1", count: NaN, range: 1000 },
  { name: "zero range", line: "1", count: 1, range: 0 },
  { name: "negative range", line: "1", count: 1, range: -1 },
  { name: "NaN range", line: "1", count: 1, range: NaN },
  { name: "Infinity range", line: "1", count: 1, range: Infinity },
  { name: "string zero range", line: "1", count: 1, range: "0" },
  { name: "embedded newline", line: "1\n;2", count: 2, range: 1000 }
];

malformedFrames.forEach(row => {
  test(`malformed frame: ${row.name}`, () => {
    assert.equal(
      Spectrum.parseSpectrumFrame(row.line, row.count, row.range),
      null
    );
  });
});

for (const count of [1, 2, 3, 4, 9, 16]) {
  const tokenCounts = new Set(
    [-2, -1, 1, 2].map(delta => Math.max(0, count + delta)));
  for (const tokenCount of tokenCounts) {
    test(`wrong band count expected=${count} actual=${tokenCount}`, () => {
      const frame = Array(tokenCount).fill("1").join(";");
      assert.equal(Spectrum.parseSpectrumFrame(frame, count, 1000), null);
    });
  }
}

test("band order is positional and never sorted", () => {
  const result = Spectrum.parseSpectrumFrame("1000;0;500;250", 4, 1000);
  assert.notEqual(result, null);
  const expected = [1, 0, Math.pow(0.5, GAMMA), Math.pow(0.25, GAMMA)];
  expected.forEach((value, index) => close(result.levels[index], value, `band ${index}`));
});

test("silence and repeated frames are deterministic and allocation-independent", () => {
  const first = Spectrum.parseSpectrumFrame("0;0;0;", 3, 1000);
  const second = Spectrum.parseSpectrumFrame("0;0;0;", 3, 1000);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.levels, second.levels);
  first.levels[0] = 1;
  assert.deepEqual(second.levels, [0, 0, 0]);
});

test("live state flips at the first non-silent floor value", () => {
  const belowFloor = Spectrum.parseSpectrumFrame("7.999", 1, 1000);
  assert.notEqual(belowFloor, null);
  assert.equal(belowFloor.peak, 0);
  assert.equal(belowFloor.live, false);

  const atFloor = Spectrum.parseSpectrumFrame("8", 1, 1000);
  assert.notEqual(atFloor, null);
  close(atFloor.peak, Math.pow(SILENCE_FLOOR, GAMMA), "floor peak");
  assert.equal(atFloor.peak > LIVE_THRESHOLD, true);
  assert.equal(atFloor.live, true);
});
