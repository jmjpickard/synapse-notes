import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, clientConfig } from "./trpc"; // Import trpc hook and client config
import { useState } from "react"; // Import useState for client creation

function Root() {
  // Create state for clients to ensure they are only created once
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: clientConfig.links, // Use the exported IPC link config
    })
  );

  return (
    <React.StrictMode>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </trpc.Provider>
    </React.StrictMode>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Root />);

// Use contextBridge (keep existing listener if needed)
window.ipcRenderer.on("main-process-message", (_event, message) => {
  console.log(message);
});
