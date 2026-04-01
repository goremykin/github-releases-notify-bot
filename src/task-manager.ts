type TaskCallback<T> = () => T | Promise<T>;
type Subscription<T> = (data: T) => void;

interface TaskDescriptor<T> {
  descriptor: ReturnType<typeof setInterval>;
  cb: TaskCallback<T>;
  subscriptions: Subscription<T>[];
  running: Promise<void> | null;
}

export class TaskManager {
  private tasks: Record<string, TaskDescriptor<unknown>> = {};

  subscribe<T>(name: string, cb: Subscription<T>): void {
    if (this.tasks[name]) {
      this.tasks[name].subscriptions.push(cb as Subscription<unknown>);
    }
  }

  add<T>(name: string, cb: TaskCallback<T>, interval: number): void {
    const descriptor = setInterval(() => this.execute(name), interval * 1000);
    this.tasks[name] = { descriptor, cb: cb as TaskCallback<unknown>, subscriptions: [], running: null };
  }

  async stop(name: string): Promise<void> {
    clearInterval(this.tasks[name].descriptor);
    if (this.tasks[name].running) await this.tasks[name].running;
    delete this.tasks[name];
  }

  execute(name: string): void {
    const task = this.tasks[name];
    const promise = Promise.resolve(task.cb())
      .then((data) => task.subscriptions.forEach((sub) => sub(data)))
      .finally(() => { task.running = null; });
    task.running = promise;
  }

  trigger(name: string): Promise<void> {
    return new Promise((resolve) => {
      Promise.resolve(this.tasks[name].cb())
        .then((data) => {
          this.tasks[name].subscriptions.forEach((sub) => sub(data));
          resolve();
        });
    });
  }
}
