import * as React from "react"

const MOBILE_BREAKPOINT = 768

/**
 * The viewport is an external store, so it is read through
 * useSyncExternalStore rather than mirrored into state from an effect. That
 * keeps the first render in step with the actual window width instead of
 * reporting `false` for one frame, and it is the pattern React's
 * set-state-in-effect rule points at for exactly this case.
 */
const subscribeToBreakpoint = (onStoreChange: () => void) => {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", onStoreChange)

  return () => mql.removeEventListener("change", onStoreChange)
}

const getIsMobile = () => window.innerWidth < MOBILE_BREAKPOINT

const getIsMobileOnServer = () => false

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribeToBreakpoint,
    getIsMobile,
    getIsMobileOnServer
  )
}
