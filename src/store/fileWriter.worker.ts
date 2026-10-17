// Safari 的 OPFS 同步句柄只在 Dedicated Worker 内可用。
// Blob 按块读取，避免将 GB 级视频一次性加载到内存。
export {};

interface SyncHandle {
  write(data: Uint8Array, options: { at: number }): number;
  truncate(size: number): void | Promise<void>;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}

self.onmessage = async (event: MessageEvent<{ handle: FileSystemFileHandle; blob: Blob }>) => {
  const { handle, blob } = event.data;
  let access: SyncHandle | undefined;
  try {
    const syncFile = handle as FileSystemFileHandle & {
      createSyncAccessHandle?: () => Promise<SyncHandle>;
    };
    if (typeof syncFile.createSyncAccessHandle !== 'function') {
      self.postMessage({ type: 'unsupported' });
      return;
    }
    try {
      access = await syncFile.createSyncAccessHandle();
    } catch (error) {
      if ((error as Error).name !== 'NotSupportedError') throw error;
      self.postMessage({ type: 'unsupported' });
      return;
    }
    await access.truncate(0);
    const chunkSize = 8 * 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
      let written = 0;
      while (written < bytes.length) {
        const count = access.write(bytes.subarray(written), { at: offset + written });
        if (count <= 0) throw new Error('文件写入未能继续，请重新导入。');
        written += count;
      }
      self.postMessage({ type: 'progress', ratio: Math.min(0.99, (offset + written) / blob.size) });
    }
    await access.flush();
    await access.close();
    access = undefined;
    self.postMessage({ type: 'done' });
  } catch (error) {
    try { await access?.close(); } catch { /* 保留原始错误 */ }
    const e = error as Error;
    self.postMessage({ type: 'error', name: e.name, message: e.message });
  }
};
