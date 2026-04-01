type TaskCallback<T> = () => T | Promise<T>;
type Subscription<T> = (data: T) => void;

interface TaskDescriptor<T> {
  descriptor: ReturnType<typeof setInterval>;
  cb: TaskCallback<T>;
  subscriptions: Subscription<T>[];
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
    this.tasks[name] = { descriptor, cb: cb as TaskCallback<unknown>, subscriptions: [] };
  }

  stop(name: string): void {
    clearInterval(this.tasks[name].descriptor);
    delete this.tasks[name];
  }

  execute(name: string): void {
    Promise.resolve(this.tasks[name].cb())
      .then((data) => this.tasks[name].subscriptions.forEach((sub) => sub(data)));
  }
}
