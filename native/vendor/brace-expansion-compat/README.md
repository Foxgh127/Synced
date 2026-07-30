# brace-expansion compatibility facade

`electron-builder` still pulls several old `minimatch` releases whose
CommonJS code expects `require("brace-expansion")` to return a callable
function. The security-fixed `brace-expansion` 5.0.8 release exposes a named
`expand` function instead.

This private package forwards both interfaces to the official 5.0.8
implementation. It contains no expansion algorithm of its own. The root npm
override makes every transitive consumer use this facade, so the bounded
expansion implementation is shared by old and current `minimatch` versions.

Remove the facade once the Windows packaging tree no longer contains a
`minimatch` version that requires the legacy callable export.
