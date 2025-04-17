import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../electron/router"; // Corrected path
import { TRPCLink, TRPCClientError } from "@trpc/client";
import { observable } from "@trpc/server/observable"; // Needed for link definition

// Define the type for the exposed invoker (optional but good practice)
interface ElectronTRPC {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (args: { path: string; input?: any }) => Promise<any>;
}

// Augment the window interface to include electronTRPC
declare global {
  interface Window {
    electronTRPC: ElectronTRPC;
  }
}

// Custom tRPC link using the exposed IPC invoker
const ipcLink: TRPCLink<AppRouter> = () => {
  return ({ op }) =>
    observable((observer) => {
      window.electronTRPC
        .invoke({ path: op.path, input: op.input })
        .then((response) => {
          // The main process handler returns { ok: boolean, result/error }
          if (response.ok) {
            observer.next({ result: { data: response.result } });
            observer.complete();
          } else {
            // Reconstruct TRPCError from the serialized error info
            observer.error(TRPCClientError.from(response.error));
          }
        })
        .catch((cause) => {
          // Handle potential errors during the invoke call itself
          observer.error(TRPCClientError.from(cause));
        });

      // Cleanup function (not strictly needed for invoke, but good practice)
      return () => {};
    });
};

// Create the tRPC client hook, now configured with the custom link
export const trpc = createTRPCReact<AppRouter>();

// Export the link separately if needed elsewhere, or configure client directly
export const clientConfig = { links: [ipcLink] };
