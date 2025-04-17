// import { useState } from "react"; // Commented out for tRPC test
import { useState, useEffect } from "react";
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
          <CalendarEvents />
        ) : (
          <p className="text-center text-gray-500">
            Please sign in to view your calendar events.
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
