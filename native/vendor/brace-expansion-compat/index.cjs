"use strict";

// brace-expansion 1.x/2.x exported the expansion function directly, while
// patched 5.x exposes it as a named export. electron-builder still contains
// transitive minimatch versions that expect both shapes. Keep the old callable
// interface without copying the vulnerable implementation.
const secure = require("brace-expansion-secure");
const expand = secure.expand;

function expandCompat(pattern, options) {
  return expand(pattern, options);
}

module.exports = expandCompat;
module.exports.expand = expand;
module.exports.EXPANSION_MAX = secure.EXPANSION_MAX;
module.exports.EXPANSION_MAX_LENGTH = secure.EXPANSION_MAX_LENGTH;
