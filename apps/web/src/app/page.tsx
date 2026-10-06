import Link from "next/link";
import { AuditEntry } from "./audit-entry";

export const dynamic = "force-dynamic";

function hasConnectedApi() {
  const value = process.env.API_URL;
  if (!value) return false;

  try {
    const url = new URL(value);
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return false;
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function BrandMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 40 40" fill="none">
      <path d="M6 28.5 15.5 10l5.1 10.2L26 12l8 16.5H6Z" fill="currentColor" />
      <path d="M8.5 31h23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="29.5" cy="9" r="3" fill="currentColor" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
      <path d="M4 10h11M10 4l6 6-6 6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function ProofBoard() {
  return (
    <div className="proof-board" aria-label="Illustration of the WinSEO evidence workflow">
      <div className="proof-board-top">
        <div className="board-title">
          <span className="board-mark">
            <BrandMark />
          </span>
          <span>
            <strong>THE PROOF LOOP</strong>
            <small>WINSEO / WORKFLOW MODEL</small>
          </span>
        </div>
        <span className="board-label">ILLUSTRATION</span>
      </div>

      <div className="board-content">
        <div className="board-orbit" aria-hidden="true">
          <span className="orbit-ring orbit-ring-one" />
          <span className="orbit-ring orbit-ring-two" />
          <span className="orbit-core">
            <BrandMark />
          </span>
          <span className="orbit-node orbit-node-a">01</span>
          <span className="orbit-node orbit-node-b">02</span>
          <span className="orbit-node orbit-node-c">03</span>
          <span className="orbit-node orbit-node-d">04</span>
        </div>
        <div className="board-intro">
          <p className="mono-label">A CHANGE, WITH A CHAIN OF CUSTODY</p>
          <h2>
            Nothing ships
            <br />
            on a hunch.
          </h2>
          <p className="board-caption">
            Each state is tied to an observation, an exact diff, and a way back.
          </p>
        </div>
      </div>

      <div className="proof-steps">
        <div className="proof-step">
          <span className="step-number">01</span>
          <span className="step-copy">
            <strong>Capture</strong>
            <small>Raw + rendered page</small>
          </span>
          <span className="step-state">HASHED</span>
        </div>
        <div className="proof-step">
          <span className="step-number">02</span>
          <span className="step-copy">
            <strong>Approve</strong>
            <small>Exact change, human signed</small>
          </span>
          <span className="step-state">BOUND</span>
        </div>
        <div className="proof-step">
          <span className="step-number">03</span>
          <span className="step-copy">
            <strong>Verify</strong>
            <small>Browser × Googlebot</small>
          </span>
          <span className="step-state">OBSERVED</span>
        </div>
        <div className="proof-step">
          <span className="step-number">04</span>
          <span className="step-copy">
            <strong>Restore</strong>
            <small>Original state checked</small>
          </span>
          <span className="step-state">REVERSIBLE</span>
        </div>
      </div>
      <div className="board-footer">
        <span>PROOF BEFORE SCALE</span>
        <span>
          01 — 04 <i>●</i>
        </span>
      </div>
    </div>
  );
}

function WorkflowSection() {
  const steps = [
    {
      number: "01",
      title: "Find the signal",
      detail: "Start with a reproducible page or media finding, not a score with no source.",
      tag: "CRAWL + EVIDENCE",
    },
    {
      number: "02",
      title: "Shape one change",
      detail: "See the before and after. The approved hash locks the exact content in scope.",
      tag: "PATCH + PREVIEW",
    },
    {
      number: "03",
      title: "Check the live page",
      detail:
        "A deployment is only a start. Verify the result, compare it, and keep rollback ready.",
      tag: "VERIFY + RESTORE",
    },
    {
      number: "04",
      title: "Measure the effect",
      detail:
        "Separate observed changes from impact. Use a comparable control before claiming lift.",
      tag: "SEARCH CONSOLE + CONTROL",
    },
  ];

  return (
    <section className="workflow-section" id="proof-loop">
      <div className="content-wrap">
        <div className="section-heading">
          <div>
            <p className="section-kicker">
              <span>01</span> THE WINSEO STANDARD
            </p>
            <h2>
              From finding
              <br />
              to <em>proof.</em>
            </h2>
          </div>
          <p className="section-deck">
            Search work should leave a trail you can inspect. WinSEO is built around evidence, human
            approval, live verification, and a measured outcome.
          </p>
        </div>
        <div className="workflow-grid">
          {steps.map((step) => (
            <article className="workflow-card" key={step.number}>
              <div className="workflow-card-top">
                <span className="workflow-number">{step.number}</span>
                <span className="workflow-arrow">
                  <ArrowIcon />
                </span>
              </div>
              <h3>{step.title}</h3>
              <p>{step.detail}</p>
              <span className="workflow-tag">{step.tag}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function MultimodalSection() {
  return (
    <section className="multimodal-section" id="multimodal">
      <div className="content-wrap multimodal-layout">
        <div className="multimodal-copy">
          <p className="section-kicker">
            <span>02</span> SEARCH IS NOT TEXT-ONLY
          </p>
          <h2>
            Make every
            <br />
            surface <em>legible.</em>
          </h2>
          <p>
            Images, video, and structured data deserve the same evidence standard as titles and
            pages. WinSEO puts multimodal visibility at the center of the product roadmap.
          </p>
          <Link className="text-link" href="/methodology">
            Read the methodology <ArrowIcon />
          </Link>
        </div>
        <div className="media-grid" aria-label="Multimodal search surfaces">
          <article className="media-card media-card-image">
            <div className="media-illustration image-illustration" aria-hidden="true">
              <span className="image-sun" />
              <span className="image-hill image-hill-back" />
              <span className="image-hill image-hill-front" />
              <span className="image-frame" />
            </div>
            <div className="media-card-meta">
              <span>01 / IMAGE</span>
              <span>CONTEXT · ALT · ACCESS</span>
            </div>
          </article>
          <article className="media-card media-card-video">
            <div className="media-illustration video-illustration" aria-hidden="true">
              <span className="video-play">
                <span />
              </span>
              <span className="video-line video-line-one" />
              <span className="video-line video-line-two" />
              <span className="video-line video-line-three" />
            </div>
            <div className="media-card-meta">
              <span>02 / VIDEO</span>
              <span>TRANSCRIPT · SCHEMA</span>
            </div>
          </article>
          <div className="media-note">
            <span className="media-note-star">✳</span>
            <span>
              <strong>One evidence model.</strong>
              <small>Across every search surface.</small>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function HomePage() {
  const apiConfigured = hasConnectedApi();
  const previewAuditEnabled =
    !process.env.API_URL &&
    (process.env.NODE_ENV !== "production" || process.env.VERCEL_ENV === "preview");
  const auditServiceAvailable =
    apiConfigured || (process.env.NODE_ENV !== "production" && Boolean(process.env.API_URL));

  return (
    <main className="winseo-home">
      <div className="home-grid-glow" aria-hidden="true" />
      <header className="site-header content-wrap">
        <Link className="brand-lockup" href="/" aria-label="WinSEO home">
          <span className="brand-icon">
            <BrandMark />
          </span>
          <span className="brand-wordmark">WINSEO</span>
          <span className="brand-divider" />
          <span className="brand-descriptor">
            SEARCH
            <br />
            INTELLIGENCE
          </span>
        </Link>
        <nav className="main-nav" aria-label="Main navigation">
          <a href="#proof-loop">The method</a>
          <a href="#multimodal">Multimodal</a>
          <Link href="/pricing">Pricing</Link>
        </nav>
        <div className="header-action">
          {apiConfigured ? (
            <Link className="header-login" href="/login">
              Sign in <ArrowIcon />
            </Link>
          ) : (
            <span className="preview-status">
              <span /> PREVIEW
            </span>
          )}
        </div>
      </header>

      <section className="hero-section content-wrap">
        <div className="hero-copy">
          <p className="hero-kicker">
            <span className="kicker-line" /> SEARCH OPERATIONS, WITH RECEIPTS
          </p>
          <h1>
            Every search fix
            <br />
            should <em>prove itself.</em>
          </h1>
          <p className="hero-description">
            Audit technical SEO, connect first-party search performance, turn evidence into a
            decision queue, and measure AI-answer visibility without inventing a score.
          </p>
          <AuditEntry
            apiConfigured={auditServiceAvailable}
            previewAuditEnabled={previewAuditEnabled}
          />
          <div className="hero-assurance">
            <span>
              <i>✓</i> Observed facts
            </span>
            <span>
              <i>✓</i> First-party measurements
            </span>
            <span>
              <i>✓</i> Human-approved changes
            </span>
          </div>
        </div>
        <div className="hero-visual">
          <ProofBoard />
        </div>
        <div className="hero-index" aria-hidden="true">
          <span>W / 01</span>
          <span>PROOF OVER PROMISE</span>
        </div>
      </section>

      <div className="signal-ribbon" aria-label="WinSEO product areas">
        <div className="content-wrap signal-ribbon-inner">
          <span>TECHNICAL SEO</span>
          <i />
          <span>SEARCH CONSOLE</span>
          <i />
          <span>DECISION CENTER</span>
          <i />
          <span>AI ANSWER VISIBILITY</span>
          <i />
          <span>VERIFIED CHANGE</span>
        </div>
      </div>

      <WorkflowSection />
      <MultimodalSection />

      <footer className="site-footer content-wrap">
        <Link className="footer-brand" href="/">
          <span className="footer-mark">
            <BrandMark />
          </span>{" "}
          WINSEO
        </Link>
        <p>Search visibility, with a chain of proof.</p>
        <div className="footer-links">
          <Link href="/methodology">Methodology</Link>
          <Link href="/pricing">Pricing</Link>
          {apiConfigured && <Link href="/login">Sign in</Link>}
        </div>
        <span className="footer-note">
          {auditServiceAvailable
            ? "Evidence-first search operations. No synthetic scores."
            : previewAuditEnabled
              ? "Preview audit · real public page fetch · one page · not persisted."
              : "The public audit service is not connected in this environment."}
        </span>
      </footer>
    </main>
  );
}
