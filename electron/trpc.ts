import { initTRPC } from "@trpc/server";
import { PrismaClient } from "@prisma/client";

// Initialize Prisma Client
const prisma = new PrismaClient();

// Define the context for tRPC procedures
// This context will be available in all resolvers
export const createContext = async () => ({
  prisma,
});

// Define the type of the context
type Context = Awaited<ReturnType<typeof createContext>>;

// Initialize tRPC
const t = initTRPC.context<Context>().create();

// Export reusable router and procedure helpers
export const router = t.router;
export const publicProcedure = t.procedure;
