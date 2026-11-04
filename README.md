# Swara Lab: a personal singing trainer for any song

A free, browser-only singing coach for any style: pop, rock, soul, musical theatre, Indian film or classical. You sing; it shows your pitch as a live line against the target melody. Notes are named C D E by default; switch Settings → Music style to Indian sargam (Hindustani or Carnatic) if you prefer. Everything runs locally: nothing you sing or record leaves the browser.

**Open the app:** https://kirubes27.github.io/swara-lab/ (Chrome or Edge on desktop recommended; wired headphones)

Free and open source, with no accounts: everyone's songs, recordings and progress stay in their own browser.

## What's inside

| Page | What it does |
|---|---|
| **Today** | A ~20-minute daily practice plan: warm-up → pitch-match → focus drill (picked from your weak spots) → song → cool-down. Streak and minutes. |
| **Warm-up** | Breath hiss (timed by the mic), Sa sadhana, lip-trill sirens, 5-note scale moving up, aroha/avaroha, meend, cool-down. |
| **Song Studio** | Paste a YouTube link (or upload audio / record another tab such as Spotify). The app **extracts the vocal melody from the full mix**, finds the song's Sa, splits it into lines with an approximate **sargam transcription** (meend `~`, gamak `*`, kan `(x)`), and lets you loop a line, slow it to 0.5×, add a guide tone, mute the song, transpose (practice copy), and sing against the reference. Each pass is scored with diagnoses: flat high notes, wobble, flattened ornaments, scooping, timing, per-swara microtone bias. |
| **Drills** | Long tones, scale patterns in 14 scales (major/minor/pentatonic/blues/modes, plus Indian thaats), slides, vibrato, grace notes, trills, runs & riffs, register flips (chest ↔ head), interval jumps, a pitch-match game, and the **Note Pad**, where you type any line (`1 2 b3 5` or sargam) and drill it. |
| **Free sing** | An open pitch monitor: sing anything and see every note, slide and wobble, with your lowest/highest held notes. |
| **Range** | Finds your comfortable low/high (only notes held ~1 s count) and suggests a key for exercises; Song Studio uses it to suggest a key for each song. |
| **Learn** | How to learn singing on your own, backed by research (with citations), fixes for common problems (high notes, breaks, falsetto, vibrato, riffs), and a glossary of Indian music terms. |
| **Progress** | Minutes per day, score trend, and a **tuning map** showing where each scale degree lands for you (sharp/flat). |

## How it works (technical)

- **Live pitch:** YIN (de Cheveigné & Kawahara 2002) on the mic, with median smoothing and display hysteresis.
- **Voice separation:** the song is first split into voice and accompaniment with Deezer's [Spleeter](https://github.com/deezer/spleeter) 2-stem model (MIT; ONNX export from [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)), run in the browser with onnxruntime-web (`js/sep-worker.js`, model in `models/`). This also powers *Voice only* and *Backing track* playback.
- **Melody tracking:** harmonic-summation salience over 10-cent bins, Viterbi tracking with jump penalties and a voicing state, and octave-error repair, in the spirit of Salamon & Gómez (2012, "Melodia"), run on the isolated voice (`js/melody.js`). YouTube songs are captured from the tab (`getDisplayMedia`), separated after capture, and mapped back onto the video's timeline.
- **Measured on 50 real songs** (MUSDB18 7-second excerpts, against the true isolated vocal): tracking from the mix gets 55% of sung frames within 50 cents with 83% false melody in non-singing parts. With separation first: 72% and 12%.
- **Transposition:** offline resample (pitch + speed), then the browser's pitch-preserving time-stretch restores the tempo.
- **Drone:** a soft pad (root + fifth), or a tanpura made with additive synthesis and a moving "jawari" formant sweep, both looped seamlessly.
- **Storage:** settings and progress in `localStorage`; melodies and audio in IndexedDB.

Song Studio also has tools to fix octave errors or erase stretches that aren't the singer.

## Run locally

Any static server works (ES modules need http, not `file://`):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Limits

- Tab-audio capture (for YouTube melody extraction and recording other tabs) works in Chromium browsers on desktop only.
- Some videos can't be embedded; use *Record from another tab* for those.
- Captured audio is kept only in your browser, for your personal practice.
