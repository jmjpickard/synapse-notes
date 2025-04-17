import { ipcRenderer, contextBridge } from "electron"; // Removed shell import

// --------- Expose standard IPC functions (optional but can be useful) ---------
contextBridge.exposeInMainWorld("ipcRenderer", {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args;
    return ipcRenderer.on(channel, (event, ...args) =>
      listener(event, ...args)
    );
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args;
    return ipcRenderer.off(channel, ...omit);
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args;
    return ipcRenderer.send(channel, ...omit);
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args;
    return ipcRenderer.invoke(channel, ...omit);
  },

  // You can expose other APTs you need here.
  // ...
});

// --------- Expose specific safe APIs via contextBridge ---------
contextBridge.exposeInMainWorld("electronAPI", {
  // Function to request opening a URL in the default browser
  openExternalUrl: (url: string) => {
    // Send the URL to the main process via IPC
    // Basic validation can happen here too, but main process should re-validate
    if (
      typeof url === "string" &&
      (url.startsWith("http:") || url.startsWith("https:"))
    ) {
      ipcRenderer.send("open-external-url", url);
    } else {
      console.error("Invalid URL passed to openExternalUrl:", url);
    }
  },
  // Add other specific functions here if needed
});

// --------- Expose tRPC invoker to the Renderer process ---------
contextBridge.exposeInMainWorld("electronTRPC", {
  // Define the invoke function matching the expected structure
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (args: { path: string; input?: any }) =>
    ipcRenderer.invoke("trpc-invoke", args),
  // Note: Subscriptions would require a different setup using send/on
});
