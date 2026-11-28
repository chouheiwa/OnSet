# Attribution & License

This built-in style plugin bundles adapted runtime libraries from two MIT-licensed open-source projects:

1. **xikhar/papercraft**
   - Upstream: https://github.com/xikhar/papercraft
   - Version: `0.7.0`
   - Pinned commit: `30e9aaff8aa244e2237f3ea8921952dcd2e8cda8`
   - License: MIT License (Copyright (c) 2026 Shikhar, see `LICENSE`)
   - Kept: `paperkit-2d.js`, `paperkit-3d.js`, `paper-motion.js`, `paper-life.js`, `lights.json`
   - Removed: `paper-sound.js`, `paper-music.js` (OnSet scene outputs are strictly silent; audio is handled by OnSet's voice/SFX/mix pipeline), gallery JPEGs, and Python capture scripts.
   - Local modifications:
     - Removed two optional `performance.now()` profiling calls inside `printCard()` in `paperkit-2d.js` so static determinism verification passes with zero real-clock reads.
     - Added deterministic HyperFrames seek adapters (`onset-papercraft-2d.js`, `onset-papercraft-3d.js`) and relative-path scene templates (`template-2d.html`, `template-3d.html`).

2. **three.js**
   - Upstream: https://github.com/mrdoob/three.js
   - Version: `0.187.0`
   - License: MIT License (see `papercraft/vendor/three/LICENSE`)
   - Bundled offline as `papercraft/vendor/three/three.module.js` (single ESM file combining `build/three.module.js` and `build/three.core.js`) to guarantee zero-CDN offline rendering and compatibility with Electron packaging.
