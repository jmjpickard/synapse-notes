"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("ipcRenderer", {
  on(...args) {
    const [channel, listener] = args;
    return electron.ipcRenderer.on(
      channel,
      (event, ...args2) => listener(event, ...args2)
    );
  },
  off(...args) {
    const [channel, ...omit] = args;
    return electron.ipcRenderer.off(channel, ...omit);
  },
  send(...args) {
    const [channel, ...omit] = args;
    return electron.ipcRenderer.send(channel, ...omit);
  },
  invoke(...args) {
    const [channel, ...omit] = args;
    return electron.ipcRenderer.invoke(channel, ...omit);
  }
  // You can expose other APTs you need here.
  // ...
});
electron.contextBridge.exposeInMainWorld("electronAPI", {
  // Function to request opening a URL in the default browser
  openExternalUrl: (url) => {
    if (typeof url === "string" && (url.startsWith("http:") || url.startsWith("https:"))) {
      electron.ipcRenderer.send("open-external-url", url);
    } else {
      console.error("Invalid URL passed to openExternalUrl:", url);
    }
  }
  // Add other specific functions here if needed
});
electron.contextBridge.exposeInMainWorld("electronTRPC", {
  // Define the invoke function matching the expected structure
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (args) => electron.ipcRenderer.invoke("trpc-invoke", args)
  // Note: Subscriptions would require a different setup using send/on
});
