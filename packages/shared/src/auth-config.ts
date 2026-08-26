import type { NextAuthConfig } from 'next-auth';

// Routes that require authentication
const protectedRoutes = ['/matrix', '/dashboard'];

// Routes that should redirect to /matrix if already authenticated
const authRoutes = ['/login', '/register'];

/**
 * Edge-compatible auth config (no bcrypt, no database imports)
 * This is used by middleware which runs in Edge Runtime
 *
 * Consumed by TWO components, and both need the NextAuth environment:
 *
 *   - Core API (auth.ts) mints the session JWT via the Credentials provider
 *   - Web UI (middleware.ts) validates that JWT to protect /matrix and /dashboard
 *
 * Both therefore require `AUTH_SECRET` (identical values, or the signature check
 * fails) and `AUTH_TRUST_HOST=true`. Omitting AUTH_TRUST_HOST on the Web UI side
 * produces `UntrustedHost: Host must be trusted` from middleware, which presents
 * as a redirect loop back to /login *after* a successful sign-in — the session
 * exists, but middleware refuses to evaluate it.
 *
 * It is set by environment rather than hardcoded here because trusting the Host
 * header is only safe behind a known proxy — which is true for this app (ingress
 * routes / to Web UI and /api/* to Core API) but should stay an explicit
 * deployment decision.
 */
export const authConfig = {
  pages: {
    signIn: '/login',
    error: '/login',
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;

      const isProtectedRoute = protectedRoutes.some(route =>
        nextUrl.pathname.startsWith(route)
      );

      const isAuthRoute = authRoutes.some(route =>
        nextUrl.pathname === route
      );

      // Allow anonymous access to /matrix if token param is present
      const hasTokenParam = nextUrl.searchParams.has('token');
      if (nextUrl.pathname === '/matrix' && hasTokenParam) {
        return true; // Allow anonymous access with token param
      }

      // If trying to access protected route without auth, redirect to login
      if (isProtectedRoute && !isLoggedIn) {
        return false; // Will redirect to signIn page
      }

      // If logged in and trying to access auth routes, redirect to matrix
      if (isAuthRoute && isLoggedIn) {
        return Response.redirect(new URL('/matrix', nextUrl.origin));
      }

      return true;
    },
    async jwt({ token, user }) {
      // Initial sign in - add user data to token
      if (user) {
        token.id = user.id;
        token.companyId = (user as { companyId?: string }).companyId;
      }
      return token;
    },
    async session({ session, token }) {
      // Add user data to session
      if (session.user) {
        session.user.id = token.id as string;
        session.user.companyId = token.companyId as string | null;
      }
      return session;
    },
  },
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  providers: [], // Providers are added in auth.ts (Node.js only)
} satisfies NextAuthConfig;

// Session/User augmentation lives here rather than in Core API's auth.ts,
// because the callbacks above depend on it and Web UI's middleware imports this
// module too. Keeping it next to the config means both consumers see it.
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      companyId: string | null;
    };
  }

  interface User {
    companyId?: string | null;
  }
}
