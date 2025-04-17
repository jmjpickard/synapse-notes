import { router, publicProcedure } from "./trpc"; // Import publicProcedure as well
import { authRouter } from "./auth"; // Import auth router
import { calendarRouter } from "./calendar"; // Import calendar router
import {
  startRecordingSession,
  stopRecordingSession,
  stopRecordingServer, // Optional: maybe a procedure to force stop the server?
} from "./recording"; // Import recording functions

// Create a router for recording controls
const recordingRouter = router({
  startSession: publicProcedure.mutation(async () => {
    console.log("tRPC: Received startSession request");
    try {
      // This returns a promise that resolves with the audio file path when recording stops and audio is saved
      const audioFilePath = await startRecordingSession();
      console.log(
        "tRPC: startRecordingSession resolved with path:",
        audioFilePath
      );
      return { success: true, filePath: audioFilePath };
    } catch (error: any) {
      console.error("tRPC: Error in startSession:", error);
      // Ensure the server is stopped if starting failed badly
      await stopRecordingServer();
      // Rethrow or return a structured error for the client
      // Using TRPCError is recommended for proper error handling client-side
      // throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Failed to start recording session' });
      return {
        success: false,
        error: error.message || "Failed to start recording session",
      };
    }
  }),
  stopSession: publicProcedure.mutation(() => {
    console.log("tRPC: Received stopSession request");
    try {
      // This just sends the stop command via WebSocket.
      // The actual result (audio path) is handled by the promise returned from startSession.
      stopRecordingSession();
      console.log("tRPC: stopRecordingSession called");
      return { success: true };
    } catch (error: any) {
      console.error("tRPC: Error in stopSession:", error);
      // throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Failed to stop recording session' });
      return {
        success: false,
        error: error.message || "Failed to stop recording session",
      };
    }
  }),
  // Optional: Add a procedure to explicitly stop the server if needed for cleanup
  // forceStopServer: publicProcedure.mutation(async () => {
  //   await stopRecordingServer();
  //   return { success: true };
  // })
});

// Combine all routers into the main App Router
export const appRouter = router({
  auth: authRouter, // Add auth router under 'auth' namespace
  calendar: calendarRouter, // Add calendar router under 'calendar' namespace
  recording: recordingRouter, // Add recording router under 'recording' namespace
  // Add other routers here as needed:
  // settings: settingsRouter,
  // meetings: meetingsRouter,
});

// Export the type of the App Router for the client
export type AppRouter = typeof appRouter;
