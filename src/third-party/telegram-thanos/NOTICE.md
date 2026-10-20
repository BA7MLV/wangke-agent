# Telegram Android Thanos effect — GPL-2.0

Copyright Telegram contributors. No warranty; see the complete GPL-2.0 text in
`public/licenses/telegram-thanos-GPL-2.0.txt` (served at `/licenses/telegram-thanos-GPL-2.0.txt`).

Upstream: https://github.com/DrKLO/Telegram
Pinned commit: `68c6775ac373f4bdb30ae9986282dd5ec0407756`

| Local file | Original file | Upstream Git blob SHA-1 |
| --- | --- | --- |
| `thanos_vertex.glsl` | `TMessagesProj/src/main/res/raw/thanos_vertex.glsl` | `d592871acc68a4494085a955fc34ef876f234287` |
| `thanos_fragment.glsl` | `TMessagesProj/src/main/res/raw/thanos_fragment.glsl` | `0e9afc1d977429b85277b88021e9d3b54f97be23` |
| `renderer.ts` | `TMessagesProj/src/main/java/org/telegram/ui/Components/ThanosEffect.java` | `9d7ace888fd6082a6b207c2dcf0848a907158a7e` |

Shaders are verbatim upstream content except for a final newline. No changes to
formulas, random number generation, texture sampling, alpha, point size or GLSL precision.

`renderer.ts` is a modified/translated work, 2026-10-20: Android GLES host code
ported to TypeScript/WebGL2; DOM snapshots replace Android Bitmaps, CSS pixels map
to dp, devicePixelRatio maps to display density, one animation uses grid part=1 and
the upstream high-performance budget. Added explicit context/resource disposal,
context-loss handling and deterministic frame stepping. No CPU particle renderer.

This directory is **not MIT licensed**. The existing root MIT notice still applies
to the independently authored portions it covers; it does not relicense this code.
Distribution of the combined application must comply with GPL-2.0, including
complete corresponding source, license/copyright notices and build scripts.
Merely shipping this notice or linking to Telegram is not a substitute for making
the combined application's corresponding source available.
