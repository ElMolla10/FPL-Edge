import { Wordmark } from "./components/Wordmark";

export default function NotFound() {
  return <main className="paper paper-form-page">
    <header className="paper-header">
      <div className="paper-wrap paper-header-inner">
        <a className="paper-wordmark" href="/" aria-label="FPL Edge home"><Wordmark/></a>
        <a className="paper-signin" href="/signin?return_to=%2F%3Fapp%3D1">Sign in</a>
      </div>
    </header>
    <div className="paper-wrap paper-form-wrap">
      <section className="paper-form">
        <p className="paper-label">Page not found</p>
        <h1 className="paper-form-title">This page is offside.</h1>
        <p className="paper-form-lead">The link may be old or mistyped. Your decision desk is one tap away.</p>
        <div className="paper-form-actions"><a className="paper-btn" href="/">Back to home</a></div>
      </section>
    </div>
  </main>;
}
