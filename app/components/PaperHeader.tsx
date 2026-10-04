/* eslint-disable @next/next/no-html-link-for-pages -- the logo link matches the other paper shell pages (plain <a>, full navigation) */
import { BrandMark } from "./BrandMark";
import { ThemeToggle } from "./ThemeToggle";

/** Header shared by every public page (landing, sign in/up, pay, legal, 404, error, loading): logo tile, light-theme toggle, one text action. */
export function PaperHeader({ action, scrolled = false }: { action?: { href: string; label: string }; scrolled?: boolean }) {
  return <header className={scrolled ? "paper-header is-scrolled" : "paper-header"}>
    <div className="paper-wrap paper-header-inner">
      <a className="paper-wordmark" href="/" aria-label="FPL Edge home"><BrandMark/></a>
      <div className="paper-header-tools">
        <ThemeToggle compact/>
        {action ? <a className="paper-signin" href={action.href}>{action.label}</a> : null}
      </div>
    </div>
  </header>;
}
