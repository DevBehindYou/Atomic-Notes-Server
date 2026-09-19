import { AsyncLocalStorage } from 'node:async_hooks';

/** Time spent in Google Drive calls during one request. Mongo time is total minus this minus overhead. */
export type RequestPerf = { driveCalls: number; driveMs: number };

const store = new AsyncLocalStorage<RequestPerf>();

/** Every command sent to MongoDB by this process. Tests read it to guard the round trips per operation. */
export const mongoCommands = { started: 0 };

export const runWithPerf = <T>(fn: () => Promise<T>): Promise<T> => store.run({ driveCalls: 0, driveMs: 0 }, fn);
export const currentPerf = (): RequestPerf | undefined => store.getStore();

/** Times one Drive call and adds it to the current request's totals. */
export async function timedDrive<T>(call: () => Promise<T>): Promise<T> {
  const perf = store.getStore();
  const started = performance.now();
  try {
    return await call();
  } finally {
    if (perf) { perf.driveCalls++; perf.driveMs += performance.now() - started; }
  }
}
