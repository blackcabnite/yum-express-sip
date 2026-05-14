import { createFileRoute } from '@tanstack/react-router'

// TEMPORARY one-off endpoint to reveal the service role key after rotation.
// DELETE this file immediately after copying the value.
export const Route = createFileRoute('/api/public/reveal-srk')({
  server: {
    handlers: {
      GET: async () => {
        return new Response(process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'MISSING', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        })
      },
    },
  },
})