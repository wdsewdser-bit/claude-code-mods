declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': {
      bar: string
      /** The main conversation's prompt cache as the keeper has it, for other mods to read. */
      cache: {
        /** When the last request or keepalive that touched the cache started, in ms. */
        lastActivityAt: number | null
        ttl: '5m' | '1h' | null
        /** `lastActivityAt` plus the TTL: past it the cache is cold. */
        expiresAt: number | null
        cachedPrefixTokens: number
        isEnabled: boolean
        pausedReason: string | null
        /** `wrapped`: the wrap-up was sent and the session waits for the 5-hour reset. */
        bridgePhase: 'idle' | 'wrapped'
      }
      /**
       * What the last keepalive of an idle stretch saw still open in the main
       * conversation, for a mod that will hand the work to a new window.
       */
      snapshot: {
        /** When the request that asked for it started, in ms; null before the first one. */
        at: number | null
        entries: {
          task_id: string
          title: string
          status: 'in_progress' | 'blocked'
          text: string
          next_step?: string
        }[]
      }
    }
  }
}
