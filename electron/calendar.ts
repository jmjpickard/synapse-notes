import { google, calendar_v3 } from "googleapis"; // Import calendar_v3 specifically
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "./trpc";
import { getAuthenticatedClient } from "./auth"; // Import the function to get an authenticated client

// --- Calendar Logic ---

async function listCalendarEvents(
  timeMin?: string,
  timeMax?: string
): Promise<calendar_v3.Schema$Event[]> {
  try {
    const authClient = await getAuthenticatedClient(); // Get authenticated client (handles refresh)
    const calendar = google.calendar({ version: "v3", auth: authClient });

    const response = await calendar.events.list({
      calendarId: "primary", // Use the primary calendar
      timeMin: timeMin || new Date().toISOString(), // Default to now if not provided
      timeMax: timeMax, // Optional end time
      singleEvents: true, // Expand recurring events into single instances
      orderBy: "startTime", // Order by start time
      maxResults: 50, // Limit results for performance
    });

    const events = response.data.items;
    if (!events || events.length === 0) {
      console.log("No upcoming events found.");
      return [];
    }

    console.log(`Fetched ${events.length} events.`);
    // Optional: Log event summaries
    // events.forEach((event) => {
    //   const start = event.start?.dateTime || event.start?.date;
    //   console.log(`${start} - ${event.summary}`);
    // });

    return events;
  } catch (error: any) {
    console.error("Error fetching calendar events:", error);
    if (error instanceof TRPCError && error.code === "UNAUTHORIZED") {
      // Re-throw specific auth errors
      throw error;
    }
    // Throw a generic error for other issues
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Failed to fetch calendar events: ${error.message}`,
      cause: error,
    });
  }
}

// --- tRPC Router ---

export const calendarRouter = router({
  getEvents: publicProcedure
    .meta({ description: "Fetches events from the primary Google Calendar." })
    .input(
      z
        .object({
          // Optional date range inputs (ISO string format)
          timeMin: z.string().datetime().optional(),
          timeMax: z.string().datetime().optional(),
        })
        .optional() // Make the whole input object optional
    )
    .query(async ({ input }) => {
      // Pass optional timeMin and timeMax from input
      const events = await listCalendarEvents(input?.timeMin, input?.timeMax);
      // We might want to map the result to a simpler structure for the frontend
      // For now, return the raw Google Calendar event objects
      return events;
    }),
});

export type CalendarRouter = typeof calendarRouter;
