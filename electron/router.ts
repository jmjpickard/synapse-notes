import { router } from "./trpc";
import { authRouter } from "./auth"; // Import auth router
import { calendarRouter } from "./calendar"; // Import calendar router
// import { z } from "zod"; // z is not used here anymore

// Example router removed as we are adding specific routers

// Combine all routers into the main App Router
export const appRouter = router({
  auth: authRouter, // Add auth router under 'auth' namespace
  calendar: calendarRouter, // Add calendar router under 'calendar' namespace
  // Add other routers here as needed:
  // settings: settingsRouter,
  // meetings: meetingsRouter,
});

// Export the type of the App Router for the client
export type AppRouter = typeof appRouter;
