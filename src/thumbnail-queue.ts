/** Only one thumbnail document may load at a time. Yield between documents,
 * and postpone new work while the user scrolls or navigates. */
export class ThumbnailQueue {
  private waiting: Array<{ start: (done: () => void) => void }> = [];
  private active?: { start: (done: () => void) => void };
  private cancelScheduled?: () => void;
  constructor(private defer: (run: () => void) => () => void) {}
  enqueue(start: (done: () => void) => void) {
    const job = { start };
    this.waiting.push(job); this.pump();
    return () => {
      this.waiting = this.waiting.filter(item => item !== job);
      if (this.active === job) this.active = undefined;
      this.pump();
    };
  }
  pause() {
    this.cancelScheduled?.(); this.cancelScheduled = undefined;
    this.pump();
  }
  private pump() {
    if (this.active || this.cancelScheduled) return;
    if (!this.waiting.length) return;
    this.cancelScheduled = this.defer(() => {
      this.cancelScheduled = undefined;
      const job = this.waiting.shift();
      if (!job) return;
      this.active = job;
      job.start(() => {
        if (this.active !== job) return;
        this.active = undefined; this.pump();
      });
    });
  }
}

export const thumbnailQueue = new ThumbnailQueue(run => {
  let idle: number | undefined;
  const timer = setTimeout(() => {
    if ('requestIdleCallback' in window) idle = window.requestIdleCallback(run);
    else run();
  }, 180);
  return () => { clearTimeout(timer); if (idle !== undefined) window.cancelIdleCallback(idle); };
});
