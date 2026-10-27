import type { WorkerReq } from './parse.worker.ts';
import { scriptURL } from './policy.ts';
import { workerUrl } from './worker-url.ts';

export const TIMEOUT_MS = 60_000;

// One worker per job: a hung parser is simply terminated.
export function runWorker<T>(msg: WorkerReq, transfer: Transferable[] = []): { promise: Promise<T>; cancel: () => void } {
  let worker: Worker | undefined;
  let fail: (e: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    fail = reject;
    worker = new Worker(scriptURL(workerUrl()), { type: import.meta.env.MODE === 'single' ? 'classic' : 'module' });
    const stop = () => {
      clearTimeout(timer);
      worker?.terminate();
    };
    const timer = setTimeout(() => (stop(), reject(new Error('That file took too long. Try a smaller section or paste the text.'))), TIMEOUT_MS);
    worker.onmessage = (e: MessageEvent<{ ok: true; result: T } | { ok: false; error: string }>) => {
      if (typeof e.data?.ok !== 'boolean') return; // not ours
      stop();
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    worker.onerror = ev => {
      ev.preventDefault();
      stop();
      reject(new Error('Something went wrong reading that. Try a smaller section or paste the text.'));
    };
    worker.postMessage(msg, transfer);
  });
  return {
    promise,
    cancel: () => {
      worker?.terminate();
      fail(new Error('Cancelled.'));
    },
  };
}
