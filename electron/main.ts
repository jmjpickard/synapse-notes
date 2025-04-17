import dotenv from "dotenv";
import { app, BrowserWindow, ipcMain, shell } from "electron"; // Import shell
import { appRouter } from "./router";
import { createContext } from "./trpc";
import { TRPCError } from "@trpc/server";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load environment variables from .env file
dotenv.config();

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, "..");

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

let win: BrowserWindow | null;

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true, // Ensure context isolation is enabled for contextBridge
      nodeIntegration: false, // Best practice: disable nodeIntegration for security
    },
  });

  // Test active push message to Renderer-process.
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", new Date().toLocaleString());
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(async () => {
  // Make async for createContext
  createWindow();

  // --- tRPC IPC Handler ---
  const tRPCHandler = async (
    _event: Electron.IpcMainInvokeEvent,
    args: { path: string; input: unknown }
  ) => {
    const { path, input } = args;
    const procedurePath = path.split("."); // e.g., ['example', 'hello']

    try {
      const context = await createContext(); // Create context for each request
      const caller = appRouter.createCaller(context);

      // Dynamically access the procedure on the caller
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let proc: any = caller;
      for (const part of procedurePath) {
        if (proc[part] === undefined) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Procedure '${path}' not found`,
          });
        }
        proc = proc[part];
      }

      // Check if it's a function (procedure) before calling
      if (typeof proc !== "function") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Path '${path}' did not resolve to a procedure`,
        });
      }

      const result = await proc(input);
      return { ok: true, result }; // Indicate success
    } catch (error) {
      console.error(`tRPC Error on path '${path}':`, error);
      // We need to serialize the error properly for IPC
      // For now, just sending basic info. Consider using superjson or similar if complex errors are needed.
      if (error instanceof TRPCError) {
        return {
          ok: false,
          error: { code: error.code, message: error.message },
        };
      }
      return {
        ok: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unknown error occurred",
        },
      };
    }
  };

  ipcMain.handle("trpc-invoke", tRPCHandler);
  console.log("tRPC IPC handler registered on channel: trpc-invoke");
  // --- End tRPC IPC Handler ---

  // --- IPC Handler for opening external URLs ---
  ipcMain.on("open-external-url", (_event, url: string) => {
    console.log(`Received request to open external URL: ${url}`);
    // Basic validation for security
    if (url && (url.startsWith("http:") || url.startsWith("https:"))) {
      shell.openExternal(url);
    } else {
      console.error(`Blocked attempt to open invalid external URL: ${url}`);
    }
  });
  console.log("IPC handler registered for channel: open-external-url");
  // --- End IPC Handler ---
});
