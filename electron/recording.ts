import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url"; // Import fileURLToPath
import fs from "fs/promises";
import os from "os";
import { shell } from "electron";
import getPort from "get-port";

// Define types for messages
interface WebSocketMessage {
  type: "status" | "audioChunk" | "audioBlob" | "error";
  payload: unknown;
}

interface StartCommand {
  type: "command";
  payload: "start" | "stop";
}

// State variables
let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
let recordingSocket: WebSocket | null = null;
let currentPort: number | null = null;
let audioFilePath: string | null = null;
let resolveAudioPromise: ((path: string | null) => void) | null = null;
let rejectAudioPromise: ((reason?: any) => void) | null = null;

const app = express();

// Serve the static HTML/JS for the recorder
// Assuming recorder.html and recorder.js are in the 'public' directory
// relative to the project root during development, and copied to the app's
// resources directory in production. We need to handle path resolution carefully.
// For now, let's assume 'public' is accessible relative to the main process entry point.
// A more robust solution might involve copying these files during the build process.

// ESM-compatible way to get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicPath = path.join(__dirname, "..", "public"); // Path relative to the *built* main.js
console.log(`Serving static files from: ${publicPath}`);
app.use(express.static(publicPath));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicPath, "recorder.html"));
});

// Function to start the server
export async function startRecordingServer(): Promise<{
  port: number;
  serverUrl: string;
}> {
  if (server?.listening) {
    console.log(`Server already running on port ${currentPort}`);
    if (!currentPort) throw new Error("Server running but port unknown");
    return { port: currentPort, serverUrl: `http://localhost:${currentPort}` };
  }

  // Find an available port within the specified range
  currentPort = await getPort({ port: [9000, 9100] });
  server = http.createServer(app);

  wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log("Recorder page connected via WebSocket");
    if (recordingSocket) {
      console.warn("New WebSocket connection received, closing previous one.");
      recordingSocket.close();
    }
    recordingSocket = ws;

    ws.on("message", async (message) => {
      try {
        const parsedMessage = JSON.parse(
          message.toString()
        ) as WebSocketMessage;
        console.log("Received message from recorder:", parsedMessage.type);

        if (parsedMessage.type === "status") {
          console.log("Recorder status:", parsedMessage.payload);
          // Handle status updates if needed (e.g., update UI via main process event)
        } else if (
          parsedMessage.type === "audioBlob" &&
          parsedMessage.payload instanceof Object &&
          "data" in parsedMessage.payload
        ) {
          // Assuming payload is { data: ArrayBuffer } or similar structure sent from client
          // Need to adjust based on how recorder.js sends the data
          console.log("Received audio blob message");
          const bufferData = parsedMessage.payload.data; // Adjust based on actual payload structure

          if (bufferData instanceof Array) {
            // Check if it's an array of numbers (likely from Array.from(new Uint8Array(...)))
            const buffer = Buffer.from(bufferData);
            await saveAudioData(buffer);
          } else {
            console.error(
              "Received audio data is not in expected Array format:",
              bufferData
            );
            if (rejectAudioPromise)
              rejectAudioPromise("Invalid audio data format received");
          }
        } else if (parsedMessage.type === "error") {
          console.error(
            "Error reported from recorder page:",
            parsedMessage.payload
          );
          if (rejectAudioPromise) rejectAudioPromise(parsedMessage.payload);
        }
      } catch (error) {
        console.error(
          "Failed to process WebSocket message or save audio:",
          error
        );
        // Handle raw buffer data if JSON parsing fails (might be direct binary audio)
        if (message instanceof Buffer) {
          console.log("Received raw audio buffer.");
          await saveAudioData(message);
        } else {
          console.error(
            "Received non-buffer message that failed JSON parsing:",
            message
          );
          if (rejectAudioPromise)
            rejectAudioPromise("Invalid message format received");
        }
      }
    });

    ws.on("close", () => {
      console.log("Recorder page WebSocket disconnected");
      if (ws === recordingSocket) {
        recordingSocket = null;
      }
      // Optionally stop the server if the socket closes unexpectedly? Or wait for explicit stop command?
    });

    ws.on("error", (error) => {
      console.error("Recorder page WebSocket error:", error);
      if (ws === recordingSocket) {
        recordingSocket = null;
      }
      if (rejectAudioPromise) rejectAudioPromise(error);
    });
  });

  return new Promise((resolve, reject) => {
    server
      ?.listen(currentPort, () => {
        console.log(
          `Recording server started on http://localhost:${currentPort}`
        );
        resolve({
          port: currentPort!,
          serverUrl: `http://localhost:${currentPort!}`,
        });
      })
      .on("error", (err) => {
        console.error("Failed to start server:", err);
        reject(err);
      });
  });
}

// Function to save received audio data
async function saveAudioData(buffer: Buffer) {
  try {
    // Define a temporary path for the audio file
    const tempDir = path.join(os.tmpdir(), "daily-sync-recordings");
    await fs.mkdir(tempDir, { recursive: true });
    audioFilePath = path.join(tempDir, `recording-${Date.now()}.wav`); // Assuming WAV format

    console.log(`Saving audio to: ${audioFilePath}`);
    await fs.writeFile(audioFilePath, buffer);
    console.log("Audio file saved successfully.");

    if (resolveAudioPromise) {
      resolveAudioPromise(audioFilePath);
    } else {
      console.warn("Audio saved but no promise resolver was waiting.");
    }
  } catch (error) {
    console.error("Error saving audio file:", error);
    audioFilePath = null;
    if (rejectAudioPromise) {
      rejectAudioPromise(error);
    }
  } finally {
    // Reset promise handlers
    resolveAudioPromise = null;
    rejectAudioPromise = null;
  }
}

// Function to open the recording page and wait for audio
export async function startRecordingSession(): Promise<string | null> {
  const { serverUrl } = await startRecordingServer();
  console.log(`Opening recorder URL: ${serverUrl}`);
  await shell.openExternal(serverUrl);

  // Wait for WebSocket connection (add timeout?)
  await new Promise<void>((resolve, reject) => {
    let checks = 0;
    const interval = setInterval(() => {
      if (recordingSocket) {
        clearInterval(interval);
        resolve();
      } else if (checks++ > 20) {
        // ~10 seconds timeout
        clearInterval(interval);
        reject(new Error("Timeout waiting for recorder WebSocket connection"));
      }
    }, 500);
  });

  console.log("Sending start command to recorder page");
  const command: StartCommand = { type: "command", payload: "start" };
  recordingSocket?.send(JSON.stringify(command));

  // Return a promise that resolves when audio is received and saved
  return new Promise<string | null>((resolve, reject) => {
    resolveAudioPromise = resolve;
    rejectAudioPromise = reject;
    // Set a timeout for the recording itself?
  });
}

// Function to stop the recording
export function stopRecordingSession() {
  if (!recordingSocket) {
    console.warn("Stop command sent but no active WebSocket connection.");
    // Should we still try to clean up the server?
    if (rejectAudioPromise) rejectAudioPromise("No active connection to stop.");
    return;
  }

  console.log("Sending stop command to recorder page");
  const command: StartCommand = { type: "command", payload: "stop" };
  recordingSocket.send(JSON.stringify(command));

  // The actual audio saving and promise resolution happens
  // when the 'audioBlob' message is received in the 'message' handler.
}

// Function to stop the server completely
export function stopRecordingServer(): Promise<void> {
  return new Promise((resolve) => {
    if (wss) {
      console.log("Closing WebSocket server...");
      wss.close(() => {
        console.log("WebSocket server closed.");
        wss = null;
        recordingSocket = null; // Ensure socket reference is cleared
      });
    }
    if (server) {
      console.log("Stopping HTTP server...");
      server.close(() => {
        console.log("HTTP server stopped.");
        server = null;
        currentPort = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// Clean up on exit
process.on("exit", () => {
  stopRecordingServer();
});
