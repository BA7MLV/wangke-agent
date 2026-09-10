/** 任务取消的信号错误：与「失败」区分开，取消不该弹错误、不该把视频标成 error */
export class CancelError extends Error {
  constructor(message = '已取消') {
    super(message);
    this.name = 'CancelError';
  }
}

export function isCancel(e: unknown): boolean {
  return e instanceof CancelError || (e as { name?: string })?.name === 'CancelError';
}
