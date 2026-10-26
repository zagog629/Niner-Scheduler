import { generate } from './engine.js';

self.onmessage = (e) => {
  const { id, input } = e.data;
  try {
    self.postMessage({ id, ok: true, out: generate(input) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
