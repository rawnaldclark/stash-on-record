/*
 * Inside the player's frame the player owns navigation. A same-origin frame shares the tab's history, so every entry On Record
 * pushes (one for the phone deck, one per card stepped back, one for The Long Play, one per #section link) would be a press of
 * the player's back button that does nothing the listener can see. So inside Stash the record keeps no history of its own:
 *
 * - `history.pushState` does nothing. The deck and The Long Play check `history.state` for their own entry before they step back,
 *   find none, and so never call `history.back()` either: the player's back leaves Your record in one press.
 * - A popstate that still reaches the frame isn't the record's (it pushed nothing), so it stops here. That also keeps the deck's
 *   back-from-the-first-card, which on the site goes to the start page, from opening Stash's import sheet.
 * - A link to a section (#eras) scrolls there without a history entry.
 *
 * Only main-embed.tsx calls this, and only when EMBEDDED; On Record on its own keeps its history as upstream has it.
 */

export function keepNoHistory(): void {
  history.pushState = () => {}
  window.addEventListener('popstate', (e) => e.stopImmediatePropagation(), { capture: true })
  // Bubble phase on window, so a link whose own handler already took the click (the deck's tracklist) is left alone
  window.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const link = (e.target as Element | null)?.closest?.('a[href^="#"]')
    if (!link) return
    e.preventDefault()
    const id = decodeURIComponent(link.getAttribute('href')!.slice(1))
    const target = id ? document.getElementById(id) : null
    // #top and other targets that aren't there go to the top, as the browser would
    if (target) target.scrollIntoView({ block: 'start' })
    else window.scrollTo({ top: 0 })
  })
}
