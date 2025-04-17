import { google, Auth } from "googleapis"; // Import Auth namespace
import crypto from "node:crypto";
import http from "node:http";
import url from "node:url";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "./trpc"; // Assuming trpc setup is in './trpc'

// Ensure environment variables are loaded (main.ts should handle this)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

// Basic check at module load time
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  console.error(
    "CRITICAL: Missing Google OAuth environment variables (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI). Authentication will fail."
  );
}

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// --- PKCE Helpers ---
function base64URLEncode(str: Buffer): string {
  return str
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function sha256(buffer: string): Buffer {
  return crypto.createHash("sha256").update(buffer).digest();
}

function generateCodeVerifier(): string {
  return base64URLEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64URLEncode(sha256(verifier));
}
// --- End PKCE Helpers ---

// Temporary storage for verifier and state during auth flow
// In a real app, associate this with a user session or state parameter more robustly
let tempVerifier: string | null = null;
let tempAuthState: string | null = null;
let resolveAuthPromise: ((code: string) => void) | null = null;
let rejectAuthPromise: ((reason?: any) => void) | null = null;
let callbackServer: http.Server | null = null;

// Placeholder for token storage/retrieval - replace with Prisma later
let storedRefreshToken: string | null = null; // In-memory storage for now

async function storeRefreshToken(token: string | null): Promise<void> {
  console.log("Storing refresh token (in memory):", token ? "********" : null);
  storedRefreshToken = token;
  // TODO: Replace with Prisma call to securely store/clear the token
  // Example:
  // if (token) {
  //   const encryptedToken = encrypt(token); // Implement encryption
  //   await prisma.settings.upsert({ where: { key: 'googleRefreshToken' }, update: { value: encryptedToken }, create: { key: 'googleRefreshToken', value: encryptedToken } });
  // } else {
  //   await prisma.settings.delete({ where: { key: 'googleRefreshToken' } }).catch(() => {}); // Ignore if not found
  // }
}

async function getStoredRefreshToken(): Promise<string | null> {
  console.log("Retrieving refresh token (from memory)");
  // TODO: Replace with Prisma call to retrieve and decrypt the token
  // Example:
  // const setting = await prisma.settings.findUnique({ where: { key: 'googleRefreshToken' } });
  // return setting ? decrypt(setting.value) : null; // Implement decryption
  return storedRefreshToken;
}

// --- Auth Logic ---

async function getGoogleAuthUrl(): Promise<string> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Google OAuth credentials not configured.",
    });
  }
  if (callbackServer) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Authentication process already in progress.",
    });
  }

  tempVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(tempVerifier);
  tempAuthState = crypto.randomBytes(16).toString("hex"); // Basic CSRF protection

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // Request refresh token
    scope: ["https://www.googleapis.com/auth/calendar.readonly"],
    prompt: "consent", // Force consent screen for refresh token (important for getting refresh token on subsequent auths)
    code_challenge: codeChallenge,
    // Revert to plain string literal, removing explicit cast
    code_challenge_method: "S256" as Auth.CodeChallengeMethod,
    state: tempAuthState,
  });

  return authUrl;
}

function closeCallbackServer() {
  if (callbackServer) {
    callbackServer.close(() => {
      console.log("OAuth callback server closed.");
      callbackServer = null;
      resolveAuthPromise = null;
      rejectAuthPromise = null;
      // Don't clear verifier/state here, handleCallback needs them briefly
    });
  } else {
    // Ensure promises are cleared even if server wasn't running or closed abruptly
    resolveAuthPromise = null;
    rejectAuthPromise = null;
  }
}

// This function starts a temporary server to listen for the callback
// It returns a promise that resolves with the authorization code
function listenForAuthCode(redirectUri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (callbackServer) {
      reject(new Error("Callback server already running."));
      return;
    }

    resolveAuthPromise = resolve; // Store resolve/reject for the server handler
    rejectAuthPromise = reject;

    const parsedRedirectUri = new url.URL(redirectUri);
    const port =
      parsedRedirectUri.port ||
      (parsedRedirectUri.protocol === "https:" ? 443 : 80);
    const hostname = parsedRedirectUri.hostname;

    callbackServer = http.createServer((req, res) => {
      const requestUrl = new url.URL(
        req.url ?? "",
        `http://${req.headers.host}`
      );
      const queryParams = requestUrl.searchParams;
      const code = queryParams.get("code");
      const state = queryParams.get("state");
      const error = queryParams.get("error");

      // Immediately capture state and verifier before potential async operations
      const receivedState = state;
      const expectedState = tempAuthState;

      // Clean up state/verifier immediately after checking/capturing
      const currentVerifier = tempVerifier; // Capture before clearing
      tempVerifier = null;
      tempAuthState = null;

      if (error) {
        console.error("OAuth Error received:", error);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Authentication failed: ${error}. You can close this window.`);
        rejectAuthPromise?.(new Error(`OAuth Error: ${error}`));
        closeCallbackServer();
        return;
      }

      if (receivedState !== expectedState) {
        console.error(
          "OAuth State mismatch. Expected:",
          expectedState,
          "Received:",
          receivedState
        );
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(
          "Authentication failed: Invalid state parameter. Security check failed. You can close this window."
        );
        rejectAuthPromise?.(new Error("OAuth state mismatch"));
        closeCallbackServer();
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        // Provide slightly better user feedback
        res.end(
          "<html><body><h1>Authentication successful!</h1><p>You can close this window now.</p><script>window.close();</script></body></html>"
        );
        // Pass the captured verifier along with the code
        resolveAuthPromise?.(code); // Resolve the promise with the code
        closeCallbackServer();
      } else {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(
          "Authentication failed: No authorization code received. You can close this window."
        );
        rejectAuthPromise?.(new Error("No authorization code received."));
        closeCallbackServer();
      }
    });

    callbackServer.on("error", (err) => {
      console.error("Callback server error:", err);
      rejectAuthPromise?.(err);
      closeCallbackServer();
      tempVerifier = null; // Clear verifier on server error too
      tempAuthState = null;
    });

    // Timeout for the auth process
    const timeoutHandle = setTimeout(() => {
      if (callbackServer) {
        console.error("OAuth callback timed out.");
        rejectAuthPromise?.(new Error("OAuth callback timed out."));
        closeCallbackServer();
        tempVerifier = null; // Clear verifier on timeout
        tempAuthState = null;
      }
    }, 3 * 60 * 1000); // 3 minutes timeout

    callbackServer.on("close", () => {
      clearTimeout(timeoutHandle); // Clear timeout if server closes normally
    });

    callbackServer.listen(Number(port), hostname, () => {
      console.log(`OAuth callback server listening on ${redirectUri}`);
    });
  });
}

async function handleGoogleCallback(): Promise<{
  success: boolean;
  message?: string;
}> {
  if (!GOOGLE_REDIRECT_URI) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Redirect URI not configured.",
    });
  }
  // The verifier is now captured within listenForAuthCode's server handler
  // and passed along with the code when the promise resolves.
  // We retrieve it *after* listenForAuthCode resolves/rejects.

  const currentVerifier = tempVerifier; // Grab verifier *before* starting listener
  if (!currentVerifier) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Authentication flow not initiated correctly or verifier missing.",
    });
  }

  try {
    const code = await listenForAuthCode(GOOGLE_REDIRECT_URI);

    // Now exchange the code using the verifier we captured *before* starting the listener
    // Corrected: Pass options object with camelCase codeVerifier
    const { tokens } = await oauth2Client.getToken({
      code: code,
      codeVerifier: currentVerifier, // Use the stored verifier for PKCE
    });

    console.log("Tokens received:", {
      ...tokens,
      refresh_token: tokens.refresh_token ? "******" : undefined,
    });

    if (tokens.refresh_token) {
      await storeRefreshToken(tokens.refresh_token);
      oauth2Client.setCredentials(tokens); // Set credentials for immediate use
      return {
        success: true,
        message: "Authentication successful, refresh token stored.",
      };
    } else {
      // If no *new* refresh token, check if we already have one stored.
      const existingToken = await getStoredRefreshToken();
      if (existingToken) {
        // Use existing refresh token with new access token etc.
        oauth2Client.setCredentials({
          ...tokens,
          refresh_token: existingToken,
        });
        console.log("Authentication successful, using existing refresh token.");
        return {
          success: true,
          message: "Authentication successful (used existing refresh token).",
        };
      } else {
        // This is unusual if prompt=consent was used, but handle it.
        console.warn(
          "Authentication successful, but NO refresh token received and none stored. User might need to re-grant offline access."
        );
        oauth2Client.setCredentials(tokens); // Still set the credentials we got
        return {
          success: false,
          message:
            "Authentication successful, but no offline access (refresh token) granted. Some features might require re-authentication later.",
        };
      }
    }
  } catch (error: any) {
    console.error("Error handling Google callback:", error);
    // Ensure server is closed and state is cleared on error
    closeCallbackServer();
    tempVerifier = null;
    tempAuthState = null;
    await storeRefreshToken(null); // Clear any potentially partially stored token on error
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Failed to exchange authorization code: ${error.message}`,
    });
  } finally {
    // Final cleanup, though closeCallbackServer should handle most
    tempVerifier = null;
    tempAuthState = null;
  }
}

// Corrected: Use imported Auth.OAuth2Client type
export async function getAuthenticatedClient(): Promise<Auth.OAuth2Client> {
  const refreshToken = await getStoredRefreshToken();
  if (!refreshToken) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User not authenticated. Please sign in.",
    });
  }

  // Create a new client instance for this request to ensure it has the latest credentials
  // and avoid potential race conditions if the global instance is modified elsewhere.
  const client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: refreshToken });

  // Test if the refresh token is valid by getting an access token.
  // The library handles refreshing automatically if needed.
  try {
    const tokenInfo = await client.getAccessToken();
    if (!tokenInfo.token) {
      throw new Error("Failed to refresh access token.");
    }
    console.log("Successfully obtained access token using refresh token.");
    return client; // Return the client ready for API calls
  } catch (error: any) {
    console.error(
      "Error refreshing access token:",
      error.response?.data || error.message
    );
    // If refresh fails (e.g., token revoked by user), clear the stored token
    await storeRefreshToken(null); // Clear the invalid token
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication expired or revoked. Please sign in again.",
    });
  }
}

// --- tRPC Router ---

export const authRouter = router({
  getAuthUrl: publicProcedure
    .meta({
      description: "Generates the Google OAuth consent screen URL with PKCE.",
    })
    .query(async () => {
      return getGoogleAuthUrl();
    }),

  // This procedure is triggered by the UI *after* the user is redirected back from Google.
  // It initiates the local server to listen for the actual callback request containing the code.
  handleCallback: publicProcedure
    .meta({
      description:
        "Handles the OAuth callback, exchanges code for tokens using PKCE.",
    })
    .mutation(async () => {
      // The core logic is now inside handleGoogleCallback which starts the listener
      // and resolves when the callback is hit and tokens are processed.
      return handleGoogleCallback();
      // Note: The UI should call this *once* after the redirect is detected.
      // It should probably show a "Processing authentication..." state.
    }),

  getAuthStatus: publicProcedure
    .meta({ description: "Checks if a refresh token is stored." })
    .query(async () => {
      const token = await getStoredRefreshToken();
      return { isAuthenticated: !!token };
    }),

  logout: publicProcedure
    .meta({ description: "Clears the stored refresh token." })
    .mutation(async () => {
      await storeRefreshToken(null); // Clear the token
      oauth2Client.setCredentials({}); // Clear credentials from the global client instance
      console.log("User logged out, refresh token cleared.");
      return { success: true };
    }),
});

export type AuthRouter = typeof authRouter;
