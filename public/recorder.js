// Elements
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");

// State
let ws = null;
let mediaRecorder = null;
let audioChunks = [];
let micStream = null;
let screenStream = null;
let audioContext = null;
let mixedStreamDestination = null;
let micSource = null;
let screenSource = null;

function updateStatus(text, type = "idle") {
  console.log("Status:", text);
  if (statusEl) {
    statusEl.textContent = `Status: ${text}`;
    statusEl.className = `status ${type}`;
  }
}

function displayError(message) {
  console.error("Error:", message);
  if (errorEl) {
    errorEl.textContent = `Error: ${message}`;
  }
  // Also send error back to Electron app
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendMessage("error", message);
  }
}

function sendMessage(type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("WebSocket not open, cannot send message:", type);
    return;
  }
  try {
    const message = JSON.stringify({ type, payload });
    ws.send(message);
  } catch (err) {
    console.error("Failed to send WebSocket message:", err);
  }
}

function connectWebSocket() {
  // Determine WebSocket protocol (ws or wss) - typically ws for localhost
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}`; // Connect to the same host/port serving the page
  console.log(`Attempting to connect WebSocket to: ${wsUrl}`);
  updateStatus("Connecting to host app...", "processing");

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("WebSocket connection established.");
    updateStatus("Connected, waiting for command...", "idle");
    sendMessage("status", "Recorder page connected and ready.");
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log("Received command:", message);
      if (message.type === "command") {
        if (message.payload === "start") {
          startRecording();
        } else if (message.payload === "stop") {
          stopRecording();
        }
      }
    } catch (err) {
      displayError(`Failed to parse command: ${err.message}`);
    }
  };

  ws.onerror = (error) => {
    displayError(`WebSocket error: ${error.message || "Unknown error"}`);
    updateStatus("WebSocket connection error", "error");
  };

  ws.onclose = () => {
    console.log("WebSocket connection closed.");
    updateStatus("Disconnected from host app", "error");
    // Optionally try to reconnect?
    ws = null;
  };
}

async function startRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    console.warn("Already recording.");
    return;
  }
  updateStatus("Requesting permissions...", "processing");
  errorEl.textContent = ""; // Clear previous errors
  audioChunks = [];

  try {
    // 1. Get Microphone Stream
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Optional: Add constraints like echoCancellation if needed
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    updateStatus("Microphone access granted.", "processing");

    // 2. Get Screen Audio Stream (requires user interaction/prompt)
    // Note: Capturing screen *audio* specifically can be tricky and browser/OS dependent.
    // getDisplayMedia primarily captures video, but *can* include system audio if selected by the user.
    // We request audio here, but success depends on user choice and browser support.
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // Often required even if only audio is desired
      audio: true, // Request audio capture
      // selfBrowserSurface: "include", // Might be needed in some contexts
      // systemAudio: "include", // Newer property, might be more direct
    });
    updateStatus("Screen access granted.", "processing");

    // 3. Mix Audio Streams using AudioContext
    audioContext = new AudioContext();
    mixedStreamDestination = audioContext.createMediaStreamDestination();

    let hasMicAudio = false;
    if (micStream && micStream.getAudioTracks().length > 0) {
      micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(mixedStreamDestination);
      hasMicAudio = true;
      console.log("Microphone stream connected to mixer.");
    } else {
      console.warn("Mic stream has no audio tracks.");
    }

    let hasScreenAudio = false;
    if (screenStream && screenStream.getAudioTracks().length > 0) {
      screenSource = audioContext.createMediaStreamSource(screenStream);
      screenSource.connect(mixedStreamDestination);
      hasScreenAudio = true;
      console.log("Screen audio stream connected to mixer.");
    } else {
      console.warn(
        "Screen stream has no audio tracks. Only mic audio will be recorded."
      );
      // If screen audio fails, we might want to inform the user or Electron app.
      sendMessage(
        "status",
        "Screen audio not detected or selected. Recording mic only."
      );
    }

    if (!hasMicAudio && !hasScreenAudio) {
      throw new Error(
        "No audio tracks available from mic or screen to record."
      );
    }

    // 4. Create MediaRecorder with the mixed stream
    const mixedStream = mixedStreamDestination.stream;
    // Determine supported MIME type - 'audio/wav' is often desired but less universally supported by MediaRecorder
    // 'audio/webm;codecs=opus' or 'audio/ogg;codecs=opus' are more common and usually work well.
    // The Electron side might need FFmpeg later if a specific format like WAV is strictly required.
    const options = { mimeType: "audio/webm;codecs=opus" };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      console.warn(`${options.mimeType} not supported, trying default.`);
      options.mimeType = ""; // Let the browser choose default
    }

    mediaRecorder = new MediaRecorder(mixedStream, options);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
        console.log(`Received audio chunk size: ${event.data.size}`);
        // Optional: Send chunks via WebSocket if needed for real-time processing
        // sendMessage('audioChunk', event.data); // Requires handling ArrayBuffer on server
      }
    };

    mediaRecorder.onstop = async () => {
      console.log("MediaRecorder stopped.");
      updateStatus("Processing audio...", "processing");

      // Combine chunks into a single Blob
      const audioBlob = new Blob(audioChunks, {
        type: mediaRecorder.mimeType || "audio/webm",
      });
      console.log(
        `Final audio blob size: ${audioBlob.size}, type: ${audioBlob.type}`
      );
      audioChunks = []; // Clear chunks

      // Convert Blob to ArrayBuffer to send via WebSocket
      // Sending as ArrayBuffer might be easier for Node.js Buffer conversion
      try {
        const arrayBuffer = await audioBlob.arrayBuffer();
        console.log(`Converted to ArrayBuffer size: ${arrayBuffer.byteLength}`);

        // Send the ArrayBuffer back to Electron main process
        // We need to wrap it in a structure that the server expects
        // The server code expects { type: 'audioBlob', payload: { data: [...] } }
        // where data is an array of numbers.
        const dataArray = Array.from(new Uint8Array(arrayBuffer));
        sendMessage("audioBlob", { data: dataArray });

        updateStatus("Audio sent to host app.", "processing");

        // Optional: Provide download link for debugging
        // const url = URL.createObjectURL(audioBlob);
        // const a = document.createElement('a');
        // a.style.display = 'none';
        // a.href = url;
        // a.download = 'recording.webm';
        // document.body.appendChild(a);
        // a.click();
        // window.URL.revokeObjectURL(url);
      } catch (err) {
        displayError(`Error processing or sending audio blob: ${err.message}`);
        updateStatus("Error processing audio", "error");
      } finally {
        // Clean up streams and context *after* processing is done
        cleanupStreams();
        updateStatus("Recording stopped. Ready for new command.", "idle");
      }
    };

    mediaRecorder.onerror = (event) => {
      displayError(
        `MediaRecorder error: ${event.error.message || event.error.name}`
      );
      updateStatus("Recording error", "error");
      cleanupStreams();
    };

    // 5. Start Recording
    mediaRecorder.start(1000); // Trigger ondataavailable every 1000ms (1 second)
    console.log("MediaRecorder started.");
    updateStatus("Recording...", "recording");
    sendMessage("status", "Recording started.");
  } catch (err) {
    displayError(`Failed to start recording: ${err.message}`);
    updateStatus("Failed to start recording", "error");
    cleanupStreams(); // Clean up any streams that might have been partially acquired
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    console.warn("Not recording or already stopped.");
    // If we somehow got a stop command without starting, inform Electron
    sendMessage("status", "Received stop command but was not recording.");
    updateStatus("Waiting for command...", "idle"); // Reset status
    return;
  }
  console.log("Stopping MediaRecorder...");
  updateStatus("Stopping recording...", "processing");
  mediaRecorder.stop(); // This will trigger the 'onstop' event handler
  sendMessage("status", "Recording stopping.");
}

function cleanupStreams() {
  console.log("Cleaning up media streams and audio context...");
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop(); // Ensure recorder is stopped
    } catch (e) {
      console.warn("Error stopping media recorder during cleanup:", e);
    }
  }
  mediaRecorder = null;

  // Stop all tracks on the original streams
  micStream?.getTracks().forEach((track) => track.stop());
  screenStream?.getTracks().forEach((track) => track.stop());
  console.log("Media tracks stopped.");
  micStream = null;
  screenStream = null;

  // Disconnect sources and close AudioContext
  micSource?.disconnect();
  screenSource?.disconnect();
  micSource = null;
  screenSource = null;

  if (audioContext && audioContext.state !== "closed") {
    audioContext.close().then(() => console.log("AudioContext closed."));
  }
  audioContext = null;
  mixedStreamDestination = null;

  audioChunks = []; // Clear any residual chunks
}

// --- Initialization ---
connectWebSocket();

// Optional: Add a listener for page unload to ensure cleanup
window.addEventListener("beforeunload", () => {
  sendMessage("status", "Recorder page closing.");
  cleanupStreams();
  ws?.close();
});
