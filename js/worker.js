// Offline melody extraction worker.
import { analyzeSignal } from './melody.js';

self.onmessage = (e) => {
  const { L, R, sr } = e.data;
  try {
    const mel = analyzeSignal(L, R, sr, { onProgress: (p) => self.postMessage({ progress: p }) });
    self.postMessage({ done: true, mel: { hop: mel.hop, t0: mel.t0, cents: mel.cents } }, [mel.cents.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
