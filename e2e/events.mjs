/**
 * Waiting for state, never for time (test-core flaky rules): the journeys wait
 * for the event that proves a step happened. The deadline is only a failure
 * message, never a pause.
 */

/** Resolves with the arguments of the first event `subscribe` delivers that passes `accept`. */
export function nextEvent(subscribe, accept = () => true, what = 'an event', ms = 5000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const deadline = setTimeout(() => { done = true; reject(new Error(`timed out waiting for ${what}`)); }, ms);
    subscribe((...args) => {
      if (done || !accept(...args)) return;
      done = true;
      clearTimeout(deadline);
      resolve(args);
    });
  });
}

/** Every event `subscribe` delivers, in order (an array that fills itself). */
export function record(subscribe) {
  const seen = [];
  subscribe((...args) => seen.push(args));
  return seen;
}

/**
 * Resolves once `check()` is true, re-checked on every event the `subscribers` deliver
 * (each a function taking a listener); rejects with `what` after `ms`.
 */
export function untilEvents(subscribers, check, what = 'a condition', ms = 8000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const deadline = setTimeout(() => { done = true; reject(new Error(`timed out waiting for ${what()}`)); }, ms);
    const test = () => { if (!done && check()) { done = true; clearTimeout(deadline); resolve(); } };
    for (const subscribe of subscribers) subscribe(test);
    test();
  });
}
