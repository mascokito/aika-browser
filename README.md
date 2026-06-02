# victoria-engine

> 2D character rendering engine for **Victoria Rois** — synthetic AI news anchor  
> Victorian-gothic aesthetic · ASCII/glitch WebGL2 shaders · Audio-driven lip sync

---

## Overview

`victoria-engine` is a standalone JavaScript/Node.js rendering engine that produces
broadcast-quality video of Victoria Rois — a synthetic anchor rendered in an ASCII/glitch
aesthetic. It is called as a subprocess by `victoria-core` (the Python news pipeline):

```
node runtime.js --audio bulletin.wav --output bulletin.mp4
```

---

## Project Structure

```
victoria-engine/
├── renderer/
│   ├── character.js     # Layered sprite system (7 layers)
│   ├── shader.js        # WebGL2 shader compiler & manager
│   └── compositor.js    # Combines layers into final frame
├── animation/
│   ├── viseme.js        # 12 viseme mouth shape definitions
│   ├── blink.js         # Procedural eye blink controller
│   ├── idle.js          # Subtle head/body idle motion
│   └── expression.js    # Emotional state layer
├── audio/
│   ├── analyzer.js      # Web Audio API FFT analysis
│   ├── phoneme.js       # FFT bands → viseme index
│   └── sync.js          # Frame-accurate lip sync
├── capture/
│   └── recorder.js      # Canvas → MP4 via MediaRecorder
├── assets/
│   ├── victoria_base.jpg  # Source face (placeholder)
│   └── sprites/           # Mouth viseme frames, layer PNGs
├── shaders/
│   ├── ascii.glsl         # Brightness → ASCII character mapping
│   └── glitch.glsl        # Data stream background shader
├── runtime.js             # Main entry point (headless + Puppeteer)
├── preview.html           # Browser dev preview (full engine)
└── package.json
```

---

## Quick Start

### Browser preview (development)
```bash
npm run preview     # starts a local server
# open preview.html in any browser with WebGL2
```

### Headless render (requires Puppeteer + ffmpeg)
```bash
npm install
node runtime.js --audio path/to/audio.wav --output output/bulletin.mp4
```

---

## Build Phases

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ **Active** | Project scaffold · ASCII shader · Data stream background · Placeholder character |
| 2 | ⏳ Planned | Audio analyzer · FFT viseme lip sync |
| 3 | ⏳ Planned | Procedural blink · Idle animation · Expression layer |
| 4 | ⏳ Planned | MediaRecorder capture pipeline |
| 5 | ⏳ Planned | Node.js headless mode (Puppeteer + WS bridge) |
| 6 | ⏳ Planned | Real-time Twitch/YouTube Live mode |

---

## Victoria Rois — Character Spec

| Attribute | Value |
|-----------|-------|
| Hair | Straight blunt bangs, dark black, shoulder length |
| Costume | High Victorian collar, deep viridian velvet |
| Primary color | Viridian `#2E7D6B` |
| Secondary color | Midnight blue `#1B3A6B` |
| Background | Deep `#1A1A2E` |
| Accent | Antique gold `#B8963E` |
| Style | ASCII/character art · viridian tint · animated data stream |

---

## Layer System

```
Layer 6  Hair front strands (idle physics)
Layer 5  Eyes (blink, procedural gaze)
Layer 4  Mouth (12 viseme frames, audio-driven)
Layer 3  Face base (expression modulation)
Layer 2  Collar and costume
Layer 1  Data stream shader (WebGL2, animated)
Layer 0  Deep background #1A1A2E
```

---

## Viseme Reference

| Index | Name | Description |
|-------|------|-------------|
| 0  | silence | Resting, closed |
| 1  | AH      | Open jaw, wide |
| 2  | AE      | Open, spread |
| 3  | OH      | Round, mid-open |
| 4  | OO      | Round, tight |
| 5  | EE      | Wide, barely open |
| 6  | IH      | Neutral speech |
| 7  | F/V     | Lower lip against teeth |
| 8  | TH      | Tongue tip visible |
| 9  | M/B/P   | Closed |
| 10 | L/N     | Mid-open, neutral |
| 11 | R       | Slightly rounded |

---

## Hardware Target

- Windows 11 · GTX 1650 (4 GB VRAM)
- 90-second bulletin renders in < 10 minutes (headless)
- Real-time 30fps target for future live streaming

---

## victoria-core Interface

```
# Called by victoria-core Python subprocess
node runtime.js --audio <path.wav> --output <path.mp4> [--duration 90]

# Exit codes
0  — success, MP4 written to --output
1  — error (check stderr)
```
