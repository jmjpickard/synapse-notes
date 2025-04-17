// import { useState } from "react"; // Commented out for tRPC test
import { useState, useEffect, useCallback } from "react"; // Added useCallback
// import reactLogo from "./assets/react.svg"; // Logo unused for now
// import viteLogo from "/electron-vite.animate.svg"; // Logo unused for now
import "./App.css"; // Keep base CSS if needed
import { trpc } from "./trpc"; // Import the tRPC hook

// Define the type for window.electronAPI exposed via preload
declare global {
  interface Window {
    electronAPI: {
      openExternalUrl: (url: string) => void;
      // Add other functions exposed in preload.ts here
    };
    // Keep electronTRPC if still needed directly, or remove if unused
    electronTRPC: {
      invoke: (args: { path: string; input?: any }) => Promise<any>;
    };
  }
}

function AuthSection() {
  const utils = trpc.useUtils(); // Get tRPC utils for cache invalidation
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Query to check current auth status
  const authStatusQuery = trpc.auth.getAuthStatus.useQuery();

  // Query to get the auth URL (manual trigger)
  const authUrlQuery = trpc.auth.getAuthUrl.useQuery(undefined, {
    enabled: false, // Don't fetch automatically
    retry: false,
  });

  // Mutation to handle the callback process
  const handleCallbackMutation = trpc.auth.handleCallback.useMutation({
    onSuccess: () => {
      console.log("handleCallback success");
      utils.auth.getAuthStatus.invalidate(); // Refetch status after callback attempt
      setIsAuthenticating(false);
    },
    onError: (error) => {
      console.error("handleCallback error:", error);
      alert(`Authentication failed: ${error.message}`); // Simple error feedback
      setIsAuthenticating(false);
      // Optionally invalidate status query even on error
      utils.auth.getAuthStatus.invalidate();
    },
  });

  // Mutation for logging out
  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      console.log("Logout successful");
      utils.auth.getAuthStatus.invalidate(); // Refetch status after logout
      utils.calendar.getEvents.invalidate(); // Clear calendar events on logout
    },
    onError: (error) => {
      console.error("Logout error:", error);
      alert(`Logout failed: ${error.message}`);
    },
  });

  const handleSignIn = async () => {
    setIsAuthenticating(true);
    try {
      // 1. Fetch the Auth URL
      const result = await authUrlQuery.refetch(); // Manually trigger the query
      if (!result.data || result.isError) {
        throw new Error(result.error?.message || "Failed to get auth URL");
      }
      const authUrl = result.data;
      console.log("Obtained auth URL:", authUrl);

      // 2. Trigger the backend listener *before* opening the external URL
      //    This starts the local server waiting for the redirect.
      handleCallbackMutation.mutate(); // No args needed

      // 3. Open the external URL for user consent via IPC
      window.electronAPI.openExternalUrl(authUrl);
      console.log("Requested main process to open external auth URL.");
      // UI remains in 'isAuthenticating' state until handleCallbackMutation resolves/rejects
    } catch (error: any) {
      console.error("Sign-in process error:", error);
      alert(`Sign-in failed: ${error.message}`);
      setIsAuthenticating(false);
    }
  };

  if (authStatusQuery.isLoading) {
    return <p className="text-sm text-gray-500">Checking auth status...</p>;
  }

  if (authStatusQuery.data?.isAuthenticated) {
    return (
      <button
        onClick={() => logoutMutation.mutate()}
        disabled={logoutMutation.isPending} // Changed isLoading to isPending
        className="px-3 py-1.5 text-sm bg-red-100 text-red-700 rounded-md hover:bg-red-200 disabled:opacity-50"
      >
        {logoutMutation.isPending ? "Logging out..." : "Sign Out"}{" "}
        {/* Changed isLoading to isPending */}
      </button>
    );
  }

  return (
    <button
      onClick={handleSignIn}
      disabled={isAuthenticating || authUrlQuery.isFetching}
      className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
    >
      {isAuthenticating
        ? "Authenticating..."
        : authUrlQuery.isFetching
        ? "Getting URL..."
        : "Sign In with Google"}
    </button>
  );
}

// --- Recording Controls Component ---
type RecordingState =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "processing" // State after stop is sent, before file path is received
  | "error";

function RecordingControls() {
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [audioFilePath, setAudioFilePath] = useState<string | null>(null); // To store the path for next phase

  // Mutation to start the recording session
  // This promise resolves *after* recording stops and the file is saved
  const startMutation = trpc.recording.startSession.useMutation({
    onMutate: () => {
      console.log("RecordingControls: Starting session...");
      setRecordingState("starting");
      setErrorMsg(null);
      setAudioFilePath(null);
    },
    onSuccess: (data) => {
      console.log("RecordingControls: startSession succeeded", data);
      if (data.success && "filePath" in data) {
        // Check for success AND filePath property
        if (typeof data.filePath === "string") {
          // Ensure filePath is a string
          setAudioFilePath(data.filePath);
          setRecordingState("idle");
          console.log("Audio file ready at:", data.filePath);
          alert(`Recording saved to: ${data.filePath}`);
        } else {
          // Success was true, but filePath was null or not a string
          console.warn(
            "startSession succeeded but returned null or invalid file path."
          );
          setErrorMsg(
            "Recording finished but the file path was missing or invalid."
          );
          setRecordingState("error");
        }
      } else if (!data.success && "error" in data) {
        // Check for failure AND error property
        const errorMessage =
          data.error instanceof Error
            ? data.error.message
            : typeof data.error === "string"
            ? data.error
            : "Recording finished with an unspecified error.";
        setErrorMsg(errorMessage);
        setRecordingState("error");
      } else {
        // Unexpected case: success/failure doesn't match properties
        console.error("Unexpected response structure from startSession:", data);
        setErrorMsg(
          "Received an unexpected response from the recording server."
        );
        setRecordingState("error");
      }
    },
    onError: (error) => {
      console.error("RecordingControls: startSession error:", error);
      setErrorMsg(error.message || "Failed to start or complete recording.");
      setRecordingState("error");
    },
  });

  // Mutation to send the stop command
  const stopMutation = trpc.recording.stopSession.useMutation({
    onMutate: () => {
      console.log("RecordingControls: Stopping session...");
      setRecordingState("stopping"); // Indicate stop command sent
    },
    onSuccess: (data) => {
      console.log("RecordingControls: stopSession succeeded", data);
      if (data.success) {
        // Check for success property (no extra data expected on success here)
        // Now we wait for the startMutation promise to resolve with the file path
        setRecordingState("processing");
      } else if (!data.success && "error" in data) {
        // Check for failure AND error property
        const errorMessage =
          data.error instanceof Error
            ? data.error.message
            : typeof data.error === "string"
            ? data.error
            : "Failed to send stop command.";
        setErrorMsg(errorMessage);
        setRecordingState("error"); // Revert to error state if stop command failed
      } else {
        // Unexpected case
        console.error("Unexpected response structure from stopSession:", data);
        setErrorMsg("Received an unexpected response when stopping recording.");
        setRecordingState("error");
      }
    },
    onError: (error) => {
      console.error("RecordingControls: stopSession error:", error);
      setErrorMsg(error.message || "Failed to stop recording.");
      setRecordingState("error");
      // If stop fails, the startMutation might still be pending.
      // Consider how to handle this - maybe try stopping the server directly?
    },
  });

  const handleStartRecording = useCallback(() => {
    if (recordingState === "idle" || recordingState === "error") {
      startMutation.mutate();
      // State transitions handled within onMutate/onSuccess/onError
    }
  }, [recordingState, startMutation]);

  const handleStopRecording = useCallback(() => {
    if (recordingState === "recording") {
      // Only allow stopping if actually recording
      stopMutation.mutate();
      // State transitions handled within onMutate/onSuccess/onError
    }
  }, [recordingState, stopMutation]);

  // Update internal state when startMutation indicates recording has actually started
  // This requires coordination as startSession opens browser, waits for WS, then sends start command.
  // For simplicity now, we assume 'starting' covers this phase until the promise resolves/rejects.
  // A more refined approach might involve status messages via WebSocket back to Electron, then to renderer.
  // Let's add a temporary effect to simulate moving to 'recording' after a short delay for demo purposes.
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    if (recordingState === "starting") {
      // Simulate time taken for browser page to connect and start
      timer = setTimeout(() => {
        // Check if still in 'starting' state before changing
        // (it might have errored out already)
        if (recordingState === "starting") {
          setRecordingState("recording");
        }
      }, 3000); // Adjust delay as needed
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [recordingState]);

  return (
    <div className="mt-6 p-4 border rounded-lg bg-white shadow">
      <h2 className="text-md font-semibold text-gray-700 mb-3">Recording</h2>
      <div className="flex items-center space-x-4">
        <button
          onClick={handleStartRecording}
          disabled={recordingState !== "idle" && recordingState !== "error"}
          className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Start Recording
        </button>
        <button
          onClick={handleStopRecording}
          disabled={recordingState !== "recording"}
          className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Stop Recording
        </button>
      </div>
      <div className="mt-3 text-sm">
        Status:{" "}
        <span
          className={`font-medium ${
            recordingState === "error"
              ? "text-red-600"
              : recordingState === "recording"
              ? "text-blue-600"
              : recordingState === "processing" ||
                recordingState === "stopping" ||
                recordingState === "starting"
              ? "text-yellow-600"
              : "text-gray-600"
          }`}
        >
          {recordingState}
        </span>
        {errorMsg && <p className="text-red-600 mt-1">Error: {errorMsg}</p>}
        {audioFilePath && (
          <p className="text-green-600 mt-1">Audio saved: {audioFilePath}</p>
        )}
      </div>
    </div>
  );
}

function CalendarEvents() {
  // Only fetch events if authenticated (check done in parent or via enabled flag)
  const eventsQuery = trpc.calendar.getEvents.useQuery(
    undefined, // No specific date range for now
    {
      // enabled: !!authStatusQuery.data?.isAuthenticated, // Can enable based on auth status
      // Note: We'll render this component conditionally, so enabled might be redundant
      staleTime: 5 * 60 * 1000, // Cache events for 5 minutes
    }
  );

  if (eventsQuery.isLoading) {
    return <p className="text-sm text-gray-500 mt-4">Loading events...</p>;
  }

  if (eventsQuery.error) {
    return (
      <p className="text-sm text-red-600 mt-4">
        Error loading events: {eventsQuery.error.message}
      </p>
    );
  }

  if (!eventsQuery.data || eventsQuery.data.length === 0) {
    return <p className="text-sm text-gray-500 mt-4">No upcoming events.</p>;
  }

  return (
    <div className="mt-4">
      <h2 className="text-lg font-semibold text-gray-700 mb-2">
        Upcoming Events
      </h2>
      <ul className="space-y-2">
        {eventsQuery.data.map((event) => (
          <li key={event.id} className="p-2 border rounded-md bg-gray-50">
            <p className="font-medium text-gray-800">{event.summary}</p>
            <p className="text-xs text-gray-600">
              {event.start?.dateTime
                ? new Date(event.start.dateTime).toLocaleString()
                : event.start?.date}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function App() {
  // Use status query to conditionally render
  const authStatusQuery = trpc.auth.getAuthStatus.useQuery();

  return (
    <div className="flex flex-col min-h-screen bg-gray-100">
      {/* Header/Navbar Placeholder */}
      <header className="p-3 bg-white shadow-sm flex justify-between items-center">
        <h1 className="text-lg font-semibold text-gray-800">Daily Sync</h1>
        <AuthSection />
      </header>

      {/* Main Content Area */}
      <main className="flex-grow p-4">
        {authStatusQuery.isLoading ? (
          <p className="text-center text-gray-500">Loading...</p>
        ) : authStatusQuery.data?.isAuthenticated ? (
          <>
            <CalendarEvents />
            <RecordingControls /> {/* Add Recording Controls here */}
          </>
        ) : (
          <p className="text-center text-gray-500">
            Please sign in to view your calendar events and recording controls.
          </p>
        )}
      </main>

      {/* Footer Placeholder */}
      <footer className="p-2 bg-gray-200 text-center text-xs text-gray-600">
        Status:{" "}
        {authStatusQuery.isLoading
          ? "Loading..."
          : authStatusQuery.data?.isAuthenticated
          ? "Authenticated"
          : "Not Authenticated"}
      </footer>
    </div>
  );
}

export default App;
